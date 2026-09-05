/**
 * GET /api/profile?did=did:key:z6Mk...
 *
 * One identity's archive figures, read from the repository rather than from
 * this deployment.
 *
 * WHY THIS EXISTS
 *
 * The archive is committed to git and the site serves it as static files, so
 * a card could only ever be as fresh as the last DEPLOY — and the archiver
 * publishes twice an hour, not every pass. Measured: a message collected at
 * 13:25 was still missing from a card because the running deployment had been
 * built at 13:21. Nothing was broken; the number simply had to wait for a
 * build that had nothing to do with it.
 *
 * Reading the same file straight from raw.githubusercontent.com cuts that
 * out. The archiver commits every ~5 minutes, so a card now trails the network
 * by about that, instead of by up to half an hour.
 *
 * The static file under /data stays exactly where it is and stays the
 * fallback: if GitHub is unreachable or rate-limits us, the page still has a
 * real answer, just an older one. A slightly stale number beats an error.
 */

export const config = { runtime: "edge" };

const OWNER = "PranjalBoraCrypto";
const REPO = "overheard";
const BRANCH = "main";

const json = (body, status = 200, ttl = 60) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": ttl
        ? `public, s-maxage=${ttl}, stale-while-revalidate=300`
        : "no-store",
    },
  });

/** Profiles are sharded by the first THREE hex characters of SHA-256(did) —
 *  the archiver's own rule, so this fetches one small file rather than the
 *  whole network.
 *
 *  It was two, and two put 10,650 identities and 3.2 MB in every file. Since
 *  git stores the file rather than the change, that made one identity posting
 *  one message cost 3.2 MB of repository, about seven gigabytes a day. Three
 *  is 4,096 shards of roughly 200 KB. The number lives in three places — here,
 *  scripts/archive.mjs and web/index.html — and all three have to agree or a
 *  profile is simply not found; see SHARD_CHARS in the archiver. */
async function shardOf(did) {
  const bytes = new TextEncoder().encode(did);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 4);
}

/** Every name this shard has ever had, newest first. The reader tries them
 *  in order because the archiver's layout moves ahead of the deployed copy
 *  by up to one publish pass, and because a widening that a static host
 *  refuses should degrade to the previous layout rather than to nothing. */
const shardNames = (shard) => [
  `${shard.slice(0, 2)}/${shard.slice(2)}.ndjson`,  // the log — current
  `${shard.slice(0, 2)}/${shard.slice(2)}.json`,    // 65,536, whole file
  `${shard.slice(0, 3)}.json`,                      // 4,096, flat
  `${shard.slice(0, 2)}.json`,                      // 256, flat
];

/* ── where this identity stands ───────────────────────────────────────────
 * Computed here rather than in the browser because standings.json describes
 * the whole population and there is no reason to ship it to every visitor.
 *
 * Every figure below is a COUNT, never an interpolation. `rank` is one plus
 * the number of identities that wrote strictly more original messages, so it
 * is the same answer a full sort would give. Ties share a rank, which is what
 * anyone comparing two cards would expect.
 *
 * Join is the one place resolution matters. The histogram is hourly, so two
 * identities in the same hour cannot be ordered — and rather than guess, this
 * reports only the two things that are certain: how many were already here
 * when your hour began, and how many arrived after it ended.
 * ─────────────────────────────────────────────────────────────────────── */
function standing(p, s) {
  if (!s || !Array.isArray(s.unique)) return null;

  const above = (pairs, mine) =>
    pairs.reduce((n, [value, count]) => (value > mine ? n + count : n), 0);

  const total = Number(s.identities) || 0;
  const unique = p.unique ?? 0;
  const rooms = Array.isArray(p.rooms) ? p.rooms.length : 0;
  const rank = above(s.unique, unique) + 1;

  const hour = String(p.first ?? "").slice(0, 13);
  const join = Array.isArray(s.join) ? s.join : [];
  let before = null, after = null;
  if (hour.length === 13 && join.length) {
    // Cumulative totals: the last hour strictly before yours, and yours.
    const earlier = join.filter(([h]) => h < hour);
    const upToYours = join.filter(([h]) => h <= hour);
    before = earlier.length ? earlier[earlier.length - 1][1] : 0;
    if (upToYours.length) after = total - upToYours[upToYours.length - 1][1];
  }

  const count = p.count ?? 0;
  return {
    identities: total,
    rank,
    percentile: total ? (rank / total) * 100 : null,
    rooms_rank: above(s.rooms, rooms) + 1,
    rooms_percentile: total ? ((above(s.rooms, rooms) + 1) / total) * 100 : null,
    joined_before: before,
    joined_after: after,
    // Share of this identity's own messages that were not copies of a text
    // posted all over the network. Null below the activity floor, where it
    // would only be measuring that somebody posted once.
    originality: count >= (s.active_min ?? 5) ? Math.round((unique / count) * 100) : null,
    active: s.active ?? null,
    active_min: s.active_min ?? 5,
    active_perfect: s.active_perfect ?? null,
    active_high: s.active_high ?? null,
    active_low: s.active_low ?? null,
  };
}

export default async function handler(request) {
  const url = new URL(request.url);
  const did = (url.searchParams.get("did") ?? "").trim();

  if (!/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/.test(did)) {
    return json({ error: "not a canonical Ed25519 did:key" }, 400, 0);
  }

  const shard = await shardOf(did);
  const raw = (p) => `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/web/data/${p}`;
  const grab = async (p) => {
    try {
      const res = await fetch(raw(p), { headers: { Accept: "application/json", "User-Agent": "overheard-profile/1.0" } });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  };

  // Both come from the same commit, so the rank and the figures it ranks
  // always describe the same moment.
  /* owners.json comes along for the ride. It is small, it is the only
     PERMANENT per-identity fact this network offers — a signed, first-come,
     never-expiring claim in /kv/room-owners — and unlike everything else
     here it reads the same today and in a year. */
  /* These two are always wanted and never conditional, so they go together
     and in parallel with the shard search below. */
  const side = Promise.all([grab("standings.json"), grab("owners.json")]);

  /* IN ORDER, AND IT STOPS AT THE FIRST HIT. Sequential rather than parallel
     on purpose: the current name answers essentially every time, and firing
     three requests at the repository to save a few milliseconds on the rare
     one would triple this endpoint's read volume against a shared allowance
     the archiver is also spending. */
  /* A shard is a LOG now: one record per line, the last line for a did
     winning. A line that will not parse is skipped rather than fatal — an
     append interrupted halfway leaves exactly one such line, at the end, and
     refusing to read the file would report everybody in it as never having
     spoken. */
  const grabLog = async (p) => {
    try {
      const res = await fetch(raw(p), { headers: { Accept: "text/plain", "User-Agent": "overheard-profile/1.0" } });
      if (!res.ok) return null;
      const out = {};
      for (const line of (await res.text()).split("\n")) {
        if (!line) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (!r || typeof r.did !== "string") continue;
        const { did: d, ...rest } = r;
        out[d] = rest;
      }
      return out;
    } catch { return null; }
  };

  let found = null, any = null;
  for (const n of shardNames(shard)) {
    const b = n.endsWith(".ndjson") ? await grabLog(`profiles/${n}`) : await grab(`profiles/${n}`);
    if (b && !any) any = b;                 // it answered, even if empty
    if (b?.[did]) { found = b; break; }
  }
  found = found ?? any;
  const [standings, owners] = await side;

  /* Unavailable means no name could be read at all — not that the
     identity is unknown, which is `p` below being null. */
  if (!found) {
    return json({ did, shard, source: "unavailable", profile: null,
                  note: "could not read the archive from the repository; the page falls back to the deployed copy" }, 200, 30);
  }

  const p = found[did] ?? null;
  const owns = Array.isArray(owners?.owners?.[did]) ? owners.owners[did] : [];
  return json({
    did,
    shard,
    source: "repository",
    standing: p && standing(p, standings),
    // Deliberately OUTSIDE `profile`: owning a room has nothing to do with
    // having been seen posting, and an identity with no archive record at all
    // can still own three rooms.
    owned: {
      rooms: owns,
      // The denominator for "how rare is this", counted over identities that
      // own anything at all rather than over the whole population.
      owners: owners?.owner_count ?? null,
      claimed: owners?.claimed ?? null,
      identities: standings?.identities ?? null,
    },
    // Named exactly as the archiver writes them, so there is one vocabulary:
    // `unique` excludes collapsed template spam, `count` does not.
    profile: p && {
      count: p.count ?? 0,
      unique: p.unique ?? 0,
      templates: p.templates ?? 0,
      rooms: Array.isArray(p.rooms) ? p.rooms : [],
      first: p.first ?? null,
      last: p.last ?? null,
      // The identity's own words. Passed through untouched apart from the
      // archiver's flattening — the card renders it on a canvas, where it is
      // pixels and can never be markup, and labels it as a quotation.
      last_text: typeof p.last_text === "string" ? p.last_text : null,
    },
    checked: new Date().toISOString(),
  });
}

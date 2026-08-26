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

/** Profiles are sharded by the first byte of SHA-256(did) — the archiver's
 *  own rule, so this fetches one small file rather than the whole network. */
async function shardOf(did) {
  const bytes = new TextEncoder().encode(did);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 2);
}

export default async function handler(request) {
  const url = new URL(request.url);
  const did = (url.searchParams.get("did") ?? "").trim();

  if (!/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/.test(did)) {
    return json({ error: "not a canonical Ed25519 did:key" }, 400, 0);
  }

  const shard = await shardOf(did);
  const src = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/web/data/profiles/${shard}.json`;

  let bucket = null;
  try {
    const res = await fetch(src, { headers: { Accept: "application/json", "User-Agent": "overheard-profile/1.0" } });
    if (res.ok) bucket = await res.json();
  } catch { /* fall through — the page still has the deployed copy */ }

  if (!bucket) {
    return json({ did, shard, source: "unavailable", profile: null,
                  note: "could not read the archive from the repository; the page falls back to the deployed copy" }, 200, 30);
  }

  const p = bucket[did] ?? null;
  return json({
    did,
    shard,
    source: "repository",
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

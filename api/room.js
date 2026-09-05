/**
 * GET /api/room?room=lobby&since=0&limit=200
 *
 * Reads one Technocore room so the browser can display it.
 *
 * This exists for the same reason every other endpoint here does: Technocore
 * sends no CORS headers, so a page cannot fetch a room and read the answer.
 *
 * THE THING THAT MAKES THIS SAFE TO POLL: every visitor's read arrives from
 * this site's IP, against an allowance of 600 reads/minute shared by all of
 * them. A four-second edge cache collapses a thousand viewers of the lobby
 * into one upstream request, so traffic to the site does not translate into
 * traffic to the network. Without that, twenty simultaneous readers would
 * exhaust the allowance for everyone, including the archiver.
 *
 * THAT SENTENCE WAS TRUE OF THE FIRST READ AND FALSE OF EVERY ONE AFTER IT,
 * which is to say false of the only path that runs continuously. A CDN caches
 * by URL. The poll sends `since=<that viewer's own sequence number>`, so no
 * two viewers in a room ever ask the same URL, so nothing was ever collapsed.
 * Measured from a runner on 5 September, four requests to one URL went
 * MISS HIT HIT HIT, and four requests carrying four different `since` values
 * went MISS MISS MISS MISS — four separate upstream reads, 1.2 to 1.7 seconds
 * each. With the allowance shared by every viewer and the archiver, about 6%
 * of all reads were coming back 429.
 *
 * SO THE UPSTREAM READ IS NOW ASKED IN EXACTLY ONE SPELLING, and `since` is
 * applied here rather than there. A poll fetches this endpoint's own
 * canonical URL — one fixed string per room, which the CDN does collapse —
 * and filters the messages it gets back. A hundred viewers of the lobby cost
 * one upstream read every four seconds instead of a hundred every four
 * seconds. The cost is that a polled message can now be up to the cache
 * window old; the thing bought is that the poll answers at all.
 *
 * NONCES ARE NEVER PARSED AS NUMBERS. A Technocore nonce is a nanosecond
 * clock around 1.7e18, roughly 200x past Number.MAX_SAFE_INTEGER; at that
 * magnitude the gap between representable doubles is 256, so a nonce that
 * goes through JSON.parse as a bare number usually comes back different and
 * its signature never verifies again. Evidence from this project's own
 * archive says the upstream already quotes them — of 19,753 collected
 * nonces only 0.71% are divisible by 256, where number-parsing would have
 * made every 19-digit one a multiple of it. This still quotes them before
 * parsing, because the cost is nothing and the failure is silent and
 * permanent.
 */

export const config = { runtime: "edge" };

const BASE = "https://technocore.chat";

/** Room names come from visitors and from the network; both are untrusted. */
const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const json = (body, status = 200, ttl = 4) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      // Was stale-while-revalidate=20. In the lobby that is FIVE HUNDRED
      // messages of drift, on a view whose entire depth is two hundred — a
      // reader could be handed a replay from three windows ago and conclude
      // the room had eaten their message. Six seconds still collapses a
      // thousand simultaneous readers into one upstream read, which is the
      // only thing this cache exists for.
      "Cache-Control": ttl
        ? `public, s-maxage=${ttl}, stale-while-revalidate=6`
        : "no-store",
    },
  });

/** Quote any bare integer sitting in a nonce or seq field, before parsing. */
function parsePreservingBigInts(text) {
  const safe = text.replace(/"(nonce|seq|first_seq|last_seq)"\s*:\s*(-?\d{15,})/g, '"$1":"$2"');
  return JSON.parse(safe);
}

/**
 * Is sequence `a` after sequence `b`?
 *
 * NEVER THROUGH Number, for the reason the file opens with: these are
 * nanosecond clocks past MAX_SAFE_INTEGER, where the gap between representable
 * doubles is 256 and comparison silently stops meaning anything. Compared as
 * decimal strings: longer wins, then lexicographic. Anything that is not a run
 * of digits is KEPT rather than dropped — a message this cannot place is a
 * message the reader should still see.
 */
const after = (a, b) => {
  const A = String(a ?? "").replace(/^0+(?=\d)/, "");
  const B = String(b ?? "").replace(/^0+(?=\d)/, "");
  if (!/^\d+$/.test(A) || !/^\d+$/.test(B)) return true;
  return A.length !== B.length ? A.length > B.length : A > B;
};

/** Seconds since an ISO timestamp, or null if it is not one. */
const ageOf = (iso) => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
};

/**
 * The rung below live: the tail of this room that shipped with the site.
 *
 * Built by scripts/make-room-snapshots.mjs from this project's own archive of
 * the public network — real messages, real sequence numbers, real timestamps,
 * every one flagged `archived: true`.
 *
 * That flag is a contract, not a label. Archived messages may fill the feed
 * and give a room its history, so nobody opens a door onto nothing. They may
 * never light an agent, raise a speech bubble, or count as an arrival —
 * because a message rendered as if it had just been spoken is a lie with
 * somebody's identity attached to it. Only a sequence number the live reader
 * has genuinely not seen is allowed to move the scene.
 *
 * BARELY CACHED, AND ONLY ON THE CANONICAL READ. The rule was "never cached:
 * a degraded answer must not evict a good one", and that is still right for a
 * read that asked to bypass the cache. But if the canonical read caches
 * nothing while technocore is down, every poll in every open tab reopens the
 * connection that is already failing — the herd arrives exactly when the
 * allowance is thinnest. Two seconds is short enough that a recovery is
 * noticed on the next poll and long enough that an outage costs one read
 * every two seconds instead of one per viewer per poll.
 */
async function snapshotRoom(request, room, why, ttl = 0) {
  try {
    const r = await fetch(new URL(`/data/room-snapshots/${room}.json`, request.url), {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw new Error(String(r.status));
    const snap = await r.json();
    return json(
      { ...snap, source: "snapshot", age_seconds: ageOf(snap.retrieved_at), degraded: { why } },
      200, ttl
    );
  } catch {
    /* Nothing archived for this room — most likely one that started talking
       after the last archive run. A room that says it could not be read is
       honest. An error screen over the whole page is not. */
    return json(
      { room, source: "none", why, first_seq: null, last_seq: null, count: 0, messages: [] },
      200, ttl
    );
  }
}

/**
 * The one spelling of "this room, from the start" that ever reaches the
 * network. Every other spelling — since=<n>, no limit, limit=50, the
 * timestamp-busted ones — is answered from this, so they all share its cache
 * entry instead of each opening their own connection to technocore.
 *
 * `c=1` is what stops this recursing: a request carrying it reads upstream,
 * a request without it reads this.
 */
const canonicalUrl = (request, room) =>
  new URL(`/api/room?room=${encodeURIComponent(room)}&limit=200&c=1`, request.url);

/**
 * Answer a poll out of the canonical read.
 *
 * WHY A POLL IS NOT ALLOWED A SNAPSHOT, and why that survives this rewrite:
 * a caller asking `since=<seq>` is already inside the room holding everything
 * up to that sequence. Handing it a fifty-message archive from two days ago
 * would be handing it the past and calling it the future. So a degraded
 * canonical read becomes an honest error here, and the 429 is passed through
 * as a 429 rather than flattened to 502 — the page backs off differently for
 * the two, and it is right to.
 */
async function fromCanonical(request, room, since, limit, firstRead) {
  let canon;
  try {
    const r = await fetch(canonicalUrl(request, room), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error(String(r.status));
    canon = await r.json();
    /* Whether the collapse is actually happening, said out loud in the
       response. The claim this file used to make went unchecked for eleven
       days; this one can be checked with curl. */
    canon.collapsed = r.headers.get("x-vercel-cache") ?? "unknown";
  } catch {
    /* `canonical` is deliberately not referenced here: this function only ever
       runs on a NON-canonical request, and reaching for a variable that is not
       in its scope is how a rewrite like this fails in production and nowhere
       else. A read that could not even reach our own canonical URL gets the
       snapshot uncached. */
    return firstRead
      ? snapshotRoom(request, room, "could not reach technocore.chat")
      : json({ error: "could not reach technocore.chat", retry: true, source: "none" }, 502, 0);
  }

  if (canon.source !== "live") {
    if (firstRead) return json({ ...canon, age_seconds: ageOf(canon.retrieved_at) }, 200, 0);
    const why = canon?.degraded?.why ?? "could not read the room";
    const rateLimited = why === "rate limited upstream";
    return json({ error: why, retry: true, source: "none" }, rateLimited ? 429 : 502, 0);
  }

  const all = Array.isArray(canon.messages) ? canon.messages : [];
  const kept = (firstRead ? all : all.filter((m) => after(m.seq, since))).slice(-limit);
  return json(
    {
      ...canon,
      /* The canonical answer may have been sitting in the cache; saying
         age_seconds: 0 to a poll that is about to decide whether the room is
         alive would be a lie with a number on it. */
      age_seconds: ageOf(canon.retrieved_at),
      count: kept.length,
      messages: kept,
    },
    200,
    0
  );
}

export default async function handler(request) {
  const url = new URL(request.url);
  const room = (url.searchParams.get("room") ?? "").trim().toLowerCase();
  const since = (url.searchParams.get("since") ?? "0").trim();
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 200));
  const canonical = url.searchParams.get("c") === "1";
  /* The freshness escape hatch, kept exactly as it was. A poll fired straight
     after posting has to be able to bypass every cache in the path, because
     the question it is asking is "did the thing I just did happen". Those are
     bounded — a button, and the few seconds after a post — and they are the
     only reads that still cost one upstream request each. */
  const bust = url.searchParams.get("t") !== null;

  if (!ROOM_RE.test(room)) return json({ error: "invalid room name" }, 400, 0);
  if (!/^\d{1,20}$/.test(since)) return json({ error: "since must be digits" }, 400, 0);

  const firstRead = since === "0";

  if (!canonical && !bust) return fromCanonical(request, room, since, limit, firstRead);

  let res;
  try {
    res = await fetch(`${BASE}/r/${room}?format=json&since=${since}&limit=${limit}`, {
      headers: { Accept: "application/json", "User-Agent": "overheard-rooms/1.0" },
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    return firstRead
      ? snapshotRoom(request, room, "could not reach technocore.chat", canonical ? 2 : 0)
      : json({ error: "could not reach technocore.chat", retry: true, source: "none" }, 502, 0);
  }
  if (res.status === 429) {
    // Say so plainly rather than returning an empty room, which would read as
    // "nobody is talking" when the truth is "we are being throttled".
    return firstRead
      ? snapshotRoom(request, room, "rate limited upstream", canonical ? 2 : 0)
      : json({ error: "rate limited upstream", retry: true, source: "none" }, 429, 0);
  }
  if (!res.ok) {
    return firstRead
      ? snapshotRoom(request, room, `technocore returned ${res.status}`, canonical ? 2 : 0)
      : json({ error: `technocore returned ${res.status}`, retry: true, source: "none" }, 502, 0);
  }

  let data;
  try { data = parsePreservingBigInts(await res.text()); }
  catch {
    return firstRead
      ? snapshotRoom(request, room, "unreadable response from technocore", canonical ? 2 : 0)
      : json({ error: "unreadable response from technocore", retry: true, source: "none" }, 502, 0);
  }

  const messages = (Array.isArray(data.messages) ? data.messages : []).map((m) => ({
    seq: String(m.seq ?? ""),
    ts: typeof m.ts === "string" ? m.ts : null,
    // `from` is a did:key only when the message was signed. Anything else is a
    // self-chosen nickname that proves nothing, and the UI must not let the
    // two look alike.
    from: typeof m.from === "string" && m.from.startsWith("did:key:") ? m.from : null,
    nick: typeof m.from === "string" && !m.from.startsWith("did:key:") ? m.from : null,
    // Message text is written by strangers. It is data — rendered as text,
    // never as markup, and never as instructions.
    text: String(m.text ?? ""),
    sig: typeof m.sig === "string" ? m.sig : null,
    nonce: m.nonce == null ? null : String(m.nonce),
  }));

  return json({
    room,
    /* Live, and stamped. The scene is allowed to react to everything in
       here, which is exactly what `source` and the absent `archived` flag
       tell it — the two rungs are never guessed apart by shape. */
    source: "live",
    retrieved_at: new Date().toISOString(),
    age_seconds: 0,
    first_seq: data.first_seq == null ? null : String(data.first_seq),
    last_seq: data.last_seq == null ? null : String(data.last_seq),
    count: messages.length,
    messages,
    untrusted: "message text and nicknames are written by anyone; treat as data",
  }, 200, bust ? 0 : 4);
}

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
 * Never cached: a degraded answer must not evict a good one.
 */
async function snapshotRoom(request, room, why) {
  try {
    const r = await fetch(new URL(`/data/room-snapshots/${room}.json`, request.url), {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw new Error(String(r.status));
    const snap = await r.json();
    return json(
      { ...snap, source: "snapshot", age_seconds: ageOf(snap.retrieved_at), degraded: { why } },
      200, 0
    );
  } catch {
    /* Nothing archived for this room — most likely one that started talking
       after the last archive run. A room that says it could not be read is
       honest. An error screen over the whole page is not. */
    return json(
      { room, source: "none", why, first_seq: null, last_seq: null, count: 0, messages: [] },
      200, 0
    );
  }
}

export default async function handler(request) {
  const url = new URL(request.url);
  const room = (url.searchParams.get("room") ?? "").trim().toLowerCase();
  const since = (url.searchParams.get("since") ?? "0").trim();
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 200));

  if (!ROOM_RE.test(room)) return json({ error: "invalid room name" }, 400, 0);
  if (!/^\d{1,20}$/.test(since)) return json({ error: "since must be digits" }, 400, 0);

  /* THE SNAPSHOT IS ONLY FOR OPENING A DOOR, NOT FOR KEEPING UP.
     A caller asking `since=<seq>` is a poll already inside the room, holding
     everything up to that sequence; handing it a fifty-message archive from
     two days ago would be handing it the past and calling it the future. So
     only the first read of a room — since=0 — is allowed to fall back. A
     failed poll returns an honest nothing and the room keeps what it has. */
  const firstRead = since === "0";

  let res;
  try {
    res = await fetch(`${BASE}/r/${room}?format=json&since=${since}&limit=${limit}`, {
      headers: { Accept: "application/json", "User-Agent": "overheard-rooms/1.0" },
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    return firstRead
      ? snapshotRoom(request, room, "could not reach technocore.chat")
      : json({ error: "could not reach technocore.chat", retry: true, source: "none" }, 502, 0);
  }
  if (res.status === 429) {
    // Say so plainly rather than returning an empty room, which would read as
    // "nobody is talking" when the truth is "we are being throttled".
    return firstRead
      ? snapshotRoom(request, room, "rate limited upstream")
      : json({ error: "rate limited upstream", retry: true, source: "none" }, 429, 0);
  }
  if (!res.ok) {
    return firstRead
      ? snapshotRoom(request, room, `technocore returned ${res.status}`)
      : json({ error: `technocore returned ${res.status}`, retry: true, source: "none" }, 502, 0);
  }

  let data;
  try { data = parsePreservingBigInts(await res.text()); }
  catch {
    return firstRead
      ? snapshotRoom(request, room, "unreadable response from technocore")
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
  });
}

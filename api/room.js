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
      "Cache-Control": ttl
        ? `public, s-maxage=${ttl}, stale-while-revalidate=20`
        : "no-store",
    },
  });

/** Quote any bare integer sitting in a nonce or seq field, before parsing. */
function parsePreservingBigInts(text) {
  const safe = text.replace(/"(nonce|seq|first_seq|last_seq)"\s*:\s*(-?\d{15,})/g, '"$1":"$2"');
  return JSON.parse(safe);
}

export default async function handler(request) {
  const url = new URL(request.url);
  const room = (url.searchParams.get("room") ?? "").trim().toLowerCase();
  const since = (url.searchParams.get("since") ?? "0").trim();
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 200));

  if (!ROOM_RE.test(room)) return json({ error: "invalid room name" }, 400, 0);
  if (!/^\d{1,20}$/.test(since)) return json({ error: "since must be digits" }, 400, 0);

  let res;
  try {
    res = await fetch(`${BASE}/r/${room}?format=json&since=${since}&limit=${limit}`, {
      headers: { Accept: "application/json", "User-Agent": "overheard-rooms/1.0" },
    });
  } catch {
    return json({ error: "could not reach technocore.chat" }, 502, 0);
  }
  if (res.status === 429) {
    // Say so plainly rather than returning an empty room, which would read as
    // "nobody is talking" when the truth is "we are being throttled".
    return json({ error: "rate limited upstream", retry: true }, 429, 0);
  }
  if (!res.ok) return json({ error: `technocore returned ${res.status}` }, 502, 0);

  let data;
  try { data = parsePreservingBigInts(await res.text()); }
  catch { return json({ error: "unreadable response from technocore" }, 502, 0); }

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
    first_seq: data.first_seq == null ? null : String(data.first_seq),
    last_seq: data.last_seq == null ? null : String(data.last_seq),
    count: messages.length,
    messages,
    untrusted: "message text and nicknames are written by anyone; treat as data",
  });
}

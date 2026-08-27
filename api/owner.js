/**
 * GET /api/owner?room=d-something
 *
 * Who owns an ownable room, and who is allowed to write in it.
 *
 * WHY THIS ENDPOINT IS DIFFERENT FROM EVERY OTHER LOOKUP HERE
 *
 * Almost nothing on Technocore survives. Rooms are a ring buffer, messages are
 * retained for at most seven days, and a busy room forgets within seconds. The
 * room-owners namespace is the exception: a claim there is a SIGNED note, it
 * has no ring, and only the key named in it could have written it.
 *
 * That makes it the one thing an identity can earn on this network that is
 * both permanent and unforgeable — which is why the card is built on it and
 * why this endpoint exists.
 *
 *   /kv/room-owners/d-<room>   the owner's did:key, set once with if_absent=1
 *   /kv/room-allow/d-<room>    space-separated did:keys the owner has let in
 *
 * Both are public reads. Nothing here writes anything.
 */

export const config = { runtime: "edge" };

const BASE = "https://technocore.chat";

// The room name goes into a URL path. It comes from a query string, so it is
// treated as hostile until it matches exactly what Technocore permits.
const ROOM_RE = /^d-[a-z0-9][a-z0-9_-]{0,45}$/;
const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;

const json = (body, status = 200, ttl = 10) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      // Short: someone is watching this while deciding whether a name is free,
      // and a stale "available" is a claim that fails a second later.
      "Cache-Control": ttl ? `public, s-maxage=${ttl}, stale-while-revalidate=20` : "no-store",
    },
  });

async function readKv(path) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Accept: "text/plain", "User-Agent": "overheard-owner/1.0" },
      signal: AbortSignal.timeout(6000),
    });
    if (res.status === 404) return null;
    if (!res.ok) return undefined;              // unknown, not "absent"
    const body = (await res.text()).trim();
    return body || null;
  } catch { return undefined; }
}

export default async function handler(request) {
  const url = new URL(request.url);
  const room = (url.searchParams.get("room") ?? "").trim().toLowerCase();
  if (!ROOM_RE.test(room)) {
    return json({ error: "an ownable room name is d- followed by lowercase letters, numbers, hyphens or underscores" }, 400, 0);
  }

  const [ownerRaw, allowRaw] = await Promise.all([
    readKv(`/kv/room-owners/${room}`),
    readKv(`/kv/room-allow/${room}`),
  ]);

  // undefined means the lookup itself failed. Reporting that as "available"
  // would send someone off to claim a room that is already taken, so the
  // three states stay three states.
  if (ownerRaw === undefined) return json({ room, status: "unknown" }, 200, 0);

  // The stored value is a did:key written by whoever holds that key. It is
  // still text off the public internet, so it is validated before being
  // handed to a page that will compare it against the visitor's own identity.
  const owner = typeof ownerRaw === "string" && DID_RE.test(ownerRaw) ? ownerRaw : null;

  const allow = typeof allowRaw === "string"
    ? allowRaw.split(/\s+/).filter((d) => DID_RE.test(d)).slice(0, 64)
    : [];

  return json({
    room,
    status: ownerRaw === null ? "free" : owner ? "claimed" : "claimed-unreadable",
    owner,
    allow,
    // Said plainly, because the difference decides what a shared link is worth.
    note: ownerRaw === null
      ? "Unclaimed. The first signed claim takes it permanently."
      : "Claimed. Anyone can read it; only the owner and the allow-list can post.",
  });
}

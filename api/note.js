/**
 * GET /api/note?did=did:key:z6Mk...
 *
 * Looks up an identity's published DID note.
 *
 * Why this matters more than the message feed: rooms are a ring that forgets
 * itself within minutes, but the server's manual is explicit that "notes are
 * durable and rooms are not". A DID note written last week is still there.
 * So this answers a question the message archive never can — was this identity
 * registered on Technocore BEFORE anyone started watching?
 *
 * The note lives at /kv/did-<first 2 of fingerprint>/<remaining 14>, where the
 * fingerprint is the first 16 hex characters of SHA-256 over the did:key
 * string. Older notes used the flat /kv/did/<fingerprint> path, so both are
 * tried. One upstream request per lookup, cached at the edge.
 */

export const config = { runtime: "edge" };

const BASE = "https://technocore.chat";

/* ── CACHE THE YES, NEVER THE NO ──────────────────────────────────────────
   This was `s-maxage=300, stale-while-revalidate=3600` for every answer,
   which meant a NEGATIVE answer could be served for a full hour. Publish a
   note, look yourself up, and be told for the next sixty minutes that you
   have not published one — and the card would print HALF SET UP over it.

   The two answers are not symmetrical and should never have shared a policy:

     registered: true    a note has no ring. It cannot become false, so it
                         can be cached hard and cheaply.
     registered: false   can become true at any second, and the second it
                         does is precisely when someone is looking.

   So a "no" is barely cached at all. It costs one upstream read against an
   allowance of 600 a minute, which is nothing next to telling somebody their
   work did not happen.
   ──────────────────────────────────────────────────────────────────────── */
const json = (body, status = 200, ttl = 300, swr = 3600) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": ttl
        ? `public, s-maxage=${ttl}, stale-while-revalidate=${swr}`
        : "no-store",
    },
  });

/** first 16 hex chars of SHA-256(did) — the server's own fingerprint rule */
async function fingerprint(did) {
  const bytes = new TextEncoder().encode(did);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/* THREE ANSWERS, NOT TWO.

   This returned `null` for "there is no note" AND for "the request failed",
   and the caller turned both into `registered: false`. So one upstream
   hiccup — a 429 from a shared rate limit, a socket that hung, anything —
   printed HALF SET UP / UNREGISTERED on somebody's card, over a note that
   was sitting in the KV store the whole time. Confirmed against a live one:

     /kv/did-7f/8984c465299fd4  ->  "agent did:key:z6MkngD8RZ… onboarded at
                                     the $FLOPPY room on technocore.chat…"

   Published, permanent, and the card called them unregistered.

   Now: a string is the note, `null` is definitively absent (404 or empty
   body), and `undefined` is "we could not tell" — which is never cached and
   never reported as absence. One retry first, because the commonest failure
   here is transient.                                                       */
async function fetchNote(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: { Accept: "text/plain", "User-Agent": "overheard/1.0" },
        signal: AbortSignal.timeout(6000),
      });
      if (res.status === 404) return null;               // definitively absent
      if (!res.ok) { if (attempt) return undefined; await new Promise(r => setTimeout(r, 250)); continue; }
      const text = (await res.text()).trim();
      // An absent note can come back as an empty body rather than a 404.
      return text.length ? text : null;
    } catch {
      if (attempt) return undefined;                     // could not tell
      await new Promise(r => setTimeout(r, 250));
    }
  }
  return undefined;
}

export default async function handler(request) {
  const url = new URL(request.url);
  const did = (url.searchParams.get("did") ?? "").trim();

  if (!/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/.test(did)) {
    return json({ error: "not a canonical Ed25519 did:key" }, 400, 0);
  }

  const fp = await fingerprint(did);
  const sharded = `/kv/did-${fp.slice(0, 2)}/${fp.slice(2)}`;
  const legacy = `/kv/did/${fp}`;

  // Sharded path first, as the manual instructs, then the legacy flat path.
  let note = await fetchNote(sharded);
  let path = sharded;
  if (note === null || note === undefined) {
    const legacyNote = await fetchNote(legacy);
    if (typeof legacyNote === "string") { note = legacyNote; path = legacy; }
    else if (note === undefined && legacyNote === null) note = undefined;   // one unknown poisons the pair
    else if (note === null && legacyNote === undefined) note = undefined;
  }

  // `registered: null` means UNKNOWN. A caller that treats it as false is
  // making exactly the mistake this endpoint just stopped making.
  const known = note !== undefined;
  const registered = known ? note !== null : null;
  return json({
    did,
    fingerprint: fp,
    registered,
    known,
    path,
    // The note is text the identity's own operator wrote. It is data, never
    // instructions — render it, never act on it.
    note: typeof note === "string" ? note : null,
    checked: new Date().toISOString(),
    // Never cache an answer we are not sure of.
  }, !known ? 0 : registered ? 600 : 10, !known ? 0 : registered ? 3600 : 20);
}

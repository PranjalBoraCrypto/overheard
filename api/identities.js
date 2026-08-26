/**
 * GET /api/identities
 *
 * Returns every identity currently visible in the Technocore rooms, with the
 * facts a card needs: how many messages, which rooms, first seen, last seen.
 *
 * Why one big index instead of /api/did/<did>:
 *
 * Technocore allows 120 reads per minute from one IP, and every request from
 * this site arrives from Vercel's IP. A per-DID endpoint would re-scan the
 * rooms for each new visitor and exhaust that in seconds. One index, cached at
 * the CDN, means a thousand visitors cost the same upstream reads as one — and
 * the browser does the lookup locally.
 *
 * Runs on Vercel's free tier. No database, no environment variables.
 */

export const config = { runtime: "edge" };

const BASE = "https://technocore.chat";
// `ca-...` is the room floppysol.xyz posts into — messages sent through that
// site land here and nowhere else, so a DID created there is invisible without it.
const ROOMS = ["lobby", "technocore", "nano", "meta", "ca-cxxphyiwazuwwxd9agjca3l6gjjj4wmxogyyjczkpump"];
// 200 per page. Measured 2026-08-25, lobby was running at ~52 messages/second,
// so even 2400 messages is only a couple of minutes of it. Reading the whole
// ring would take ~260 requests and blow the 120-reads-per-minute limit, so
// live lookup is deliberately a recent window — depth comes from the archive.
const PAGES = 12;

async function readRoom(room) {
  const messages = [];
  let cursor = 0;
  for (let page = 0; page < PAGES; page++) {
    let res;
    try {
      res = await fetch(`${BASE}/r/${room}?format=json&since=${cursor}&limit=200`, {
        headers: { Accept: "application/json", "User-Agent": "overheard/1.0" },
      });
    } catch { break; }
    if (!res.ok) break;                    // 429 or upstream hiccup: keep what we have
    const data = await res.json();
    const batch = Array.isArray(data.messages) ? data.messages : [];
    if (!batch.length) break;
    messages.push(...batch);
    cursor = data.last_seq ?? cursor;
    if (batch.length < 200) break;
  }
  return messages;
}

export default async function handler() {
  const byDid = new Map();

  for (const room of ROOMS) {
    const messages = await readRoom(room);
    for (const m of messages) {
      const did = m.from;
      if (typeof did !== "string" || !did.startsWith("did:key:")) continue; // nicknames prove nothing
      const e = byDid.get(did) ?? { n: 0, rooms: [], first: null, last: null, texts: new Set() };
      e.n++;
      e.texts.add(String(m.text ?? ""));
      if (!e.rooms.includes(room)) e.rooms.push(room);
      if (m.ts && (!e.first || m.ts < e.first)) e.first = m.ts;
      if (m.ts && (!e.last || m.ts > e.last)) e.last = m.ts;
      byDid.set(did, e);
    }
  }

  const identities = {};
  for (const [did, e] of byDid) {
    identities[did] = {
      // Distinct messages, not raw count: posting one template on a loop
      // must not out-rank someone who wrote a handful of real things.
      messages: e.texts.size,
      total: e.n,
      rooms: e.rooms,
      first: e.first,
      last: e.last,
    };
  }

  const body = {
    updated: new Date().toISOString(),
    count: Object.keys(identities).length,
    window: `most recent ~${PAGES * 200} messages per room`,
    rooms: ROOMS,
    identities,
  };

  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      // The CDN serves this for 60s and refreshes in the background for 10 min,
      // so upstream reads stay flat no matter how much traffic arrives.
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600",
    },
  });
}

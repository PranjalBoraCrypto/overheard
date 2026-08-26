/**
 * GET /api/identities
 *
 * Returns every identity currently visible in the Technocore rooms, with the
 * facts a card needs: how many messages, which rooms, first seen, last seen.
 *
 * Why one big index instead of /api/did/<did>:
 *
 * Every request from this site arrives from Vercel's IP, so a per-DID endpoint
 * would re-scan the rooms for each new visitor and burn the read allowance in
 * seconds. One index, cached at the CDN, means a thousand visitors cost the
 * same upstream reads as one — and the browser does the lookup locally.
 *
 * WHY THE ROOM LIST IS NO LONGER HARDCODED
 *
 * It used to name five rooms. Measured 2026-08-26: GET /rooms reports 8,518
 * rooms on the network, ~450 of them listed in one response. Someone posting
 * anywhere outside those five was invisible here no matter how often they
 * posted — the commonest reason a valid DID showed nothing at all.
 *
 * One roster read now names every active room AND ranks it, using the quality
 * figures the server already computes (`nick_diversity`,
 * `zero_response_share`). Breadth goes where the conversation is, without
 * reading a single message body to decide.
 *
 * The budget is spent deliberately: DEPTH on the busy rooms, BREADTH across
 * the rest. The lobby has been measured at ~52 messages/second, so ten pages
 * of it is under a minute of traffic — depth beyond that belongs to the
 * archive, not to a live scan.
 *
 * Runs on Vercel's free tier. No database, no environment variables.
 */

export const config = { runtime: "edge" };

const BASE = "https://technocore.chat";

// Priority rooms, always read and always read deeply. `ca-...` is the room
// floppysol.xyz posts into — messages sent through that site land there and
// nowhere else, so a DID created there is invisible without it.
const CORE = ["lobby", "technocore", "nano", "meta", "ca-cxxphyiwazuwwxd9agjca3l6gjjj4wmxogyyjczkpump"];

const CORE_PAGES = 10;   // ~2,000 recent messages each
const OTHER_PAGES = 1;   // ~200 recent messages each
const OTHER_ROOMS = 28;  // breadth across the rest of the network
const ROSTER_LIMIT = 300;
const READ_CEILING = 90; // hard cap on upstream reads per cache miss

// Room names come from the network and the roster response labels its own
// contents untrusted. This name is interpolated into a URL path, so anything
// that is not a plain room name is dropped rather than requested.
const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

let reads = 0;

async function getJson(url) {
  if (reads >= READ_CEILING) return null;
  reads++;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "overheard/2.0" },
    });
    if (!res.ok) return null;            // 429 or upstream hiccup: keep what we have
    return await res.json();
  } catch {
    return null;
  }
}

/** quality x confidence x recency — the same shape the archiver ranks with. */
function score(r) {
  const diversity = Number.isFinite(r.nick_diversity) ? r.nick_diversity : 0;
  const silence = Number.isFinite(r.zero_response_share) ? r.zero_response_share : 1;
  const quality = Math.max(0, diversity) * (1 - Math.min(1, Math.max(0, silence)));
  const confidence = Math.min(1, (Number(r.window) || 0) / 50);
  const recency = 0.5 ** ((Number(r.idle_seconds) || 0) / 21600);
  return quality * confidence * recency;
}

async function pickRooms() {
  const data = await getJson(`${BASE}/rooms?format=json&limit=${ROSTER_LIMIT}`);
  const rows = Array.isArray(data?.rooms) ? data.rooms : [];
  const others = rows
    .filter((r) => ROOM_RE.test(String(r?.room ?? "")) && !CORE.includes(r.room))
    .map((r) => ({ room: r.room, score: score(r) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, OTHER_ROOMS)
    .map((r) => r.room);

  return {
    plan: [
      ...CORE.map((room) => ({ room, pages: CORE_PAGES })),
      ...others.map((room) => ({ room, pages: OTHER_PAGES })),
    ],
    listed: rows.length,
    networkTotal: Number(data?.total) || null,
  };
}

async function readRoom(room, pages) {
  const messages = [];
  let cursor = 0;
  for (let page = 0; page < pages; page++) {
    const data = await getJson(`${BASE}/r/${room}?format=json&since=${cursor}&limit=200`);
    if (!data) break;
    const batch = Array.isArray(data.messages) ? data.messages : [];
    if (!batch.length) break;
    messages.push(...batch);
    cursor = data.last_seq ?? cursor;
    if (batch.length < 200) break;
  }
  return messages;
}

export default async function handler() {
  reads = 0;
  const { plan, listed, networkTotal } = await pickRooms();
  const byDid = new Map();
  const scanned = [];

  for (const { room, pages } of plan) {
    if (reads >= READ_CEILING) break;
    const messages = await readRoom(room, pages);
    if (!messages.length) continue;
    scanned.push(room);
    for (const m of messages) {
      const did = m.from;
      if (typeof did !== "string" || !did.startsWith("did:key:")) continue; // nicknames prove nothing
      const e = byDid.get(did) ?? { n: 0, rooms: [], first: null, last: null, texts: new Set(), lastText: null };
      e.n++;
      const body = String(m.text ?? "");
      e.texts.add(body);
      if (!e.rooms.includes(room)) e.rooms.push(room);
      if (m.ts && (!e.first || m.ts < e.first)) e.first = m.ts;
      if (m.ts && (!e.last || m.ts >= e.last)) {
        e.last = m.ts;
        // Flattened the same way the archiver does, so the card quotes the
        // same string whichever source answered first.
        e.lastText = body.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 180);
      }
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
      last_text: e.lastText || null,
    };
  }

  const body = {
    updated: new Date().toISOString(),
    count: Object.keys(identities).length,
    window: `${CORE_PAGES * 200} recent messages in each priority room, ${OTHER_PAGES * 200} in the rest`,
    rooms_scanned: scanned.length,
    rooms_listed: listed,
    network_rooms: networkTotal,
    upstream_reads: reads,
    rooms: scanned,
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

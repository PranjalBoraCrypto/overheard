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
 * WHY THERE IS NO LONGER ANY "DEPTH"
 *
 * This used to read ten pages of each priority room and describe itself as a
 * 2,000-message window. MEASURED 2026-08-26: it never was. Technocore's
 * `since` does not page backwards — asked for `since=518000` with ~950
 * messages of backlog, the server returned seq 518753..518952, the newest 200,
 * exactly as it does for `since=0`. So page 2 started from a cursor that was
 * already the head, came back with a handful, and stopped. Nine of every ten
 * reads bought nothing and the window was 200 messages: 25 seconds of
 * technocore, 8 seconds of the lobby.
 *
 * A live scan therefore cannot be deep, and pretending otherwise cost reads
 * that are better spent on BREADTH. Depth is the archiver's job now, and it
 * does it by returning to each room before 200 more messages land there.
 *
 * Runs on Vercel's free tier. No database, no environment variables.
 */

export const config = { runtime: "edge" };

const BASE = "https://technocore.chat";

// Priority rooms, always read and always read deeply. `ca-...` is the room
// floppysol.xyz posts into — messages sent through that site land there and
// nowhere else, so a DID created there is invisible without it.
const CORE = ["lobby", "technocore", "nano", "meta", "ca-cxxphyiwazuwwxd9agjca3l6gjjj4wmxogyyjczkpump"];

// One read per room, because one read per room is all there is. The whole
// budget therefore goes on how MANY rooms get looked at.
const OTHER_ROOMS = 44;  // breadth across the rest of the network
const ROSTER_LIMIT = 300;
const READ_CEILING = 60; // hard cap on upstream reads per cache miss

// Room names come from the network and the roster response labels its own
// contents untrusted. This name is interpolated into a URL path, so anything
// that is not a plain room name is dropped rather than requested.
const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

let reads = 0;

async function getJson(url, deadlineMs = 6000) {
  if (reads >= READ_CEILING) return null;
  reads++;
  try {
    // A per-read deadline, because without one a single room that hangs takes
    // the whole scan down with it — and a scan that returns nothing is
    // indistinguishable from an identity that has posted nothing.
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "overheard/2.0" },
      signal: AbortSignal.timeout(deadlineMs),
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
  /* The roster is one big response describing hundreds of rooms and it is
     reliably the slowest read here — measured returning nothing under the
     6-second per-read deadline, which quietly reduced the whole scan to the
     five core rooms. It gets its own, longer deadline. */
  const data = await getJson(`${BASE}/rooms?format=json&limit=${ROSTER_LIMIT}`, 14000);
  const rows = Array.isArray(data?.rooms) ? data.rooms : [];
  const others = rows
    .filter((r) => ROOM_RE.test(String(r?.room ?? "")) && !CORE.includes(r.room))
    .map((r) => ({ room: r.room, score: score(r) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, OTHER_ROOMS)
    .map((r) => r.room);

  return {
    plan: [...CORE, ...others],
    listed: rows.length,
    networkTotal: Number(data?.total) || null,
  };
}

/** The newest page of a room. There is no second page to ask for. */
async function readRoom(room) {
  const data = await getJson(`${BASE}/r/${room}?format=json&since=0&limit=200`);
  return Array.isArray(data?.messages) ? data.messages : [];
}

export default async function handler() {
  reads = 0;
  const { plan, listed, networkTotal } = await pickRooms();
  const byDid = new Map();
  const scanned = [];

  /* ── read the rooms in parallel ────────────────────────────────────────
     One at a time, ~50 rooms at a few hundred milliseconds each ran past the
     edge function's limit and the request TIMED OUT — which the page reads
     as "the live scan found nothing", which the panel reads as "this
     identity is not on the record". The slowest possible answer and the
     wrongest possible answer were the same answer.

     Eight at a time turns half a minute into a few seconds. The rooms are
     independent, and the upstream allowance is per minute, not per instant.
     ──────────────────────────────────────────────────────────────────── */
  const LANES = 8;
  const batches = [];
  for (let i = 0; i < plan.length; i += LANES) batches.push(plan.slice(i, i + LANES));

  for (const batch of batches) {
    if (reads >= READ_CEILING) break;
    const got = await Promise.all(batch.map(async (room) => ({ room, messages: await readRoom(room) })));
    for (const { room, messages } of got) {
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
    window: "the newest 200 messages in each room — about 8 seconds of the lobby and 25 of technocore. Anything older is in the archive, not here.",
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
      // Was 60s fresh with a TEN MINUTE stale window, which meant a visitor
      // who had just posted could be handed an index built before they did —
      // and then be told their identity was not on the record. The window a
      // scan covers is 200 messages; serving it for longer than that window
      // lasts is serving an answer that was already wrong when it was cached.
      "Cache-Control": "public, s-maxage=20, stale-while-revalidate=40",
    },
  });
}

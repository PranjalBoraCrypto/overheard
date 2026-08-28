/**
 * GET /api/capacity
 *
 * How much room the network has left, so a page can say "this will be
 * refused" BEFORE somebody signs something and finds out.
 *
 * WHY THIS EXISTS
 *
 * Reported: an open room was created, the page said fine, and the refusal
 * only appeared later — on the first message, in a room the person had
 * already been sent to. Technocore knew the answer the whole time. Its room
 * roster carries the counts in the same response as the list:
 *
 *   total 19116 / capacity 20480          rooms that exist, and the ceiling
 *   notes.total 655360 / capacity 655360  the permanent-note store
 *   notes.capacity_per_namespace 50960    and the per-namespace cap
 *
 * Both matter here and they are DIFFERENT walls. Opening a room spends a room
 * slot. Claiming one spends a NOTE — a signed entry in the room-owners
 * namespace — so a full note store refuses every claim on the network while
 * leaving open rooms perfectly possible, and the two failures must never be
 * reported in each other's words.
 *
 * `limit=1` because the list is not wanted, only the counters that come with
 * it; a 60-second edge cache means a thousand visitors typing a room name
 * cost one upstream read, against an allowance of 600 a minute shared by
 * everything this site does.
 */

export const config = { runtime: "edge" };

const BASE = "https://technocore.chat";

const json = (body, status = 200, ttl = 60) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": ttl
        ? `public, s-maxage=${ttl}, stale-while-revalidate=120`
        : "no-store",
    },
  });

/** A number, or null. Never a guess: a missing counter must read as "we do
 *  not know", because the caller's whole job is deciding whether to warn. */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export default async function handler() {
  let data;
  try {
    const r = await fetch(`${BASE}/rooms?format=json&limit=1`, {
      headers: { Accept: "application/json", "User-Agent": "overheard-capacity/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 429) return json({ known: false, why: "rate limited upstream" }, 200, 0);
    if (!r.ok) return json({ known: false, why: `technocore returned ${r.status}` }, 200, 0);
    data = await r.json();
  } catch {
    return json({ known: false, why: "could not reach technocore.chat" }, 200, 0);
  }

  const rooms = { total: num(data?.total), capacity: num(data?.capacity) };
  const notes = {
    total: num(data?.notes?.total),
    capacity: num(data?.notes?.capacity),
    per_namespace: num(data?.notes?.capacity_per_namespace),
  };
  const left = (o) => (o.total == null || o.capacity == null ? null : Math.max(0, o.capacity - o.total));

  return json({
    known: rooms.total != null || notes.total != null,
    rooms: { ...rooms, left: left(rooms), full: left(rooms) === 0 },
    notes: { ...notes, left: left(notes), full: left(notes) === 0 },
    at: new Date().toISOString(),
    note: "Both stores release entries after 7 days without a write, so a full one is temporary.",
  });
}

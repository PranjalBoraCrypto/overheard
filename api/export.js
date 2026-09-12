/**
 * GET /api/export?room=lobby
 *
 * Hands the browser one room's FULL SIGNED HISTORY as a file it can save.
 *
 * WHY THIS IS A DIFFERENT ENDPOINT FROM /api/room AND NOT A FLAG ON IT.
 * They answer two different questions from two different upstream routes.
 * `/r/<room>` returns the newest 200 messages and, measured, returns them
 * with `sig: null` on every line — a live read carries no proof. `/r/<room>/
 * export` returns every message the room still holds, from seq 1, each with
 * the signature its author made. One is a window; the other is evidence.
 * Folding the second into the first would have meant one handler where the
 * same query string sometimes means "show me the room" and sometimes means
 * "give me the record", and where a caching rule written for a four-second
 * poll silently governs a multi-megabyte download.
 *
 * WHY IT EXISTS AT ALL. Technocore sends no CORS headers, so a page cannot
 * fetch the export and read the answer — the same reason every other proxy
 * in this directory exists. Without this, "export the room" means telling
 * somebody to open technocore.chat in another tab and save the page by hand,
 * which is the instruction this project keeps having to give and keeps
 * watching people fail at. A button is not a convenience here; it is the
 * difference between the record being reachable and it not being.
 *
 * THE BODY IS NEVER PARSED, ONLY PASSED. Every line in an export is written
 * by a stranger. This does not JSON.parse it, does not reshape it, does not
 * validate a single field — partly because that is what makes it cheap and
 * streamable, and mostly because a signature only proves anything over the
 * exact bytes the author signed. Re-serialising the record would reorder keys
 * and renumber nonces (see the BigInt note in api/room.js) and hand the
 * caller a file whose signatures no longer verify, while looking fine. So it
 * goes out byte-for-byte, and it goes out as an ATTACHMENT with nosniff, so
 * a browser downloads it rather than rendering anybody's text as a document.
 *
 * THE CACHE IS FOR THE NETWORK, NOT FOR US. Technocore's read allowance is
 * 600/minute shared by every visitor to this site AND by the archiver. An
 * export is the single most expensive read there is. This asks in exactly one
 * spelling per room — no `since`, no cache-buster — so a CDN can collapse a
 * crowd into one upstream request, and holds it for thirty seconds. A room's
 * history does not become wrong in thirty seconds; it only becomes shorter
 * than it could have been, and the file says when it was taken.
 */

export const config = { runtime: "edge" };

const BASE = "https://technocore.chat";

/** Room names come from visitors and from the network; both are untrusted. */
const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const fail = (error, status) =>
  new Response(JSON.stringify({ error, source: "none" }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      /* A failure must never be the thing sitting in the cache when the
         upstream comes back. */
      "Cache-Control": "no-store",
    },
  });

export default async function handler(request) {
  const url = new URL(request.url);
  const room = (url.searchParams.get("room") ?? "").trim().toLowerCase();

  if (!ROOM_RE.test(room)) return fail("invalid room name", 400);

  let res;
  try {
    res = await fetch(`${BASE}/r/${room}/export`, {
      headers: { Accept: "application/x-ndjson,text/plain,*/*", "User-Agent": "overheard-rooms/1.0" },
      /* Longer than the six seconds a poll gets. This is a whole room's
         history, not a window onto it, and a room that has been talking for
         a day is measured in megabytes. */
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return fail("could not reach technocore.chat", 502);
  }

  // Said plainly rather than returned as an empty file, which would read as
  // "this room has no history" when the truth is "we are being throttled".
  if (res.status === 429) return fail("rate limited upstream", 429);
  if (res.status === 404) return fail("no export for this room", 404);
  if (!res.ok) return fail(`technocore returned ${res.status}`, 502);

  /* The filename carries the room and the day it was taken, because the whole
     point of an export is that somebody still has it later. `room` has been
     through ROOM_RE — lowercase letters, digits, hyphen, underscore — so
     there is nothing in it that can break out of a header. */
  const day = new Date().toISOString().slice(0, 10);

  return new Response(res.body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="${room}-${day}.ndjson"`,
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, s-maxage=30, stale-while-revalidate=30",
      /* Same sentence /api/room ends on, for the same reason: a signature in
         here proves its author wrote that line. It does not make the line
         true, and it does not make it an instruction. */
      "X-Overheard-Untrusted":
        "every line is written by a stranger; signatures prove authorship, not truth",
    },
  });
}

/**
 * GET /api/calls  —  every call ever made, read out of the archive.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE PAGE CANNOT JUST READ THE ROOM
 *
 * It does read the room, and it has to: the archive is committed on every
 * twelfth collector pass, so the last hour of calls is only on the network.
 * But a Technocore room is a RING BUFFER of two hundred messages. Probed on
 * 4 September: `limit` is capped at 200 however much is asked for, and `since`
 * will not page backwards. There is no way to see the two hundred and first.
 *
 * For a market that is fine on its first day and wrong on the day it becomes
 * interesting. The paper someone took scrolls out of the window before the
 * call they spent it on does, and then the fold sees a call from a key with no
 * paper, refuses it, and quietly deletes somebody's opinion from the total.
 *
 * So the page folds BOTH: everything this endpoint has, plus the live window,
 * merged on the sender's own nonce. The archive is the record and the room is
 * the last hour of it.
 *
 * Filtered here rather than in the browser for the same reason /api/orders is:
 * a day of a busy room is megabytes, and the handful of lines that are ours
 * are a few kilobytes. This one is cheap either way today — the room is new
 * and quiet — and the shape is what stops it becoming expensive later.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const config = { runtime: "edge" };

const OWNER = process.env.ARCHIVE_OWNER ?? process.env.VERCEL_GIT_REPO_OWNER ?? "PranjalBoraCrypto";
const REPO = process.env.ARCHIVE_REPO ?? process.env.VERCEL_GIT_REPO_SLUG ?? "overheard";
const BRANCH = "main";

/* Must match web/call.js. An edge function cannot import a browser module, and
   scripts/test-market.mjs asserts the two spell them the same way. */
const ROOM = "overheard-calls";
const PREFIX = "call1 ";

/* The whole market, not a window: this question runs until 31 March 2027 and
   the answer is the sum of everything ever said. The room is quiet by design —
   one tap and a call or two per person — so the shards are small and the cap
   is on the number of DAYS rather than on the messages inside them. */
const MAX_DAYS = 400;
const MAX_FRAMES = 5000;

const json = (body, status = 200, ttl = 30) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": ttl ? `public, s-maxage=${ttl}, stale-while-revalidate=120` : "no-store",
    },
  });

const raw = (p) =>
  `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/web/data/${p}`;

async function grabText(p) {
  try {
    const res = await fetch(raw(p), { headers: { "User-Agent": "overheard-calls/1.0" } });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

/** One archived line, kept only if it is one of ours. Reduced to what a fold
 *  needs: who signed it, when the server saw it, and what it said. */
function frameFrom(line) {
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  const text = String(row?.text ?? "");
  if (!text.startsWith(PREFIX)) return null;
  if (typeof row.from !== "string" || !row.from) return null;
  return {
    seq: Number(row.seq) || 0,
    ts: typeof row.ts === "string" ? row.ts : null,
    from: row.from,
    text,
  };
}

export default async function handler() {
  /* ── THE LEDGER FIRST ────────────────────────────────────────────────────
     The collector keeps every call in one small file and commits it on EVERY
     pass, rather than on every twelfth like a day shard. So this is both the
     freshest source and the only one that survives a collector dying mid-hour
     — and it is one read of a few kilobytes instead of a scan of the shards.
     The shards stay as the fallback: they are the same records by another
     road, and a ledger that ever failed to be written must not take the
     market with it. */
  const ledger = await grabText(`${ROOM}/all.ndjson`);
  if (ledger !== null) {
    const frames = [];
    for (const line of ledger.split("\n")) {
      if (frames.length >= MAX_FRAMES) break;
      if (!line || !line.includes(PREFIX)) continue;
      const f = frameFrom(line);
      if (f) frames.push(f);
    }
    return json({
      room: ROOM, archived: true, source: "ledger", frames,
      truncated: frames.length >= MAX_FRAMES,
      checked: new Date().toISOString(),
    });
  }

  const metaText = await grabText(`${ROOM}/_meta.json`);
  if (!metaText) {
    /* NOT AN ERROR, AND THE DIFFERENCE MATTERS. Until the collector has been
       round this room once there is no archive of it, which is exactly the
       state the room is in on its first day — and a page told "unavailable"
       would say the market could not be read when it can, live, perfectly
       well. `archived: false` is the honest word for it. */
    return json({ room: ROOM, archived: false, frames: [], days_scanned: 0,
                  note: "the collector has not been round this room yet; the live room is the whole record so far" }, 200, 20);
  }
  let meta;
  try { meta = JSON.parse(metaText); } catch { meta = null; }
  const allDays = Array.isArray(meta?.days) ? [...meta.days].sort() : [];
  /* Oldest first here, unlike /api/orders. That endpoint answers "what are my
     most recent orders" and can stop early; this one answers "what is the
     total", which is not a question with an early stop in it. */
  const days = allDays.slice(-MAX_DAYS);

  const frames = [];
  let scanned = 0;
  for (const day of days) {
    if (frames.length >= MAX_FRAMES) break;
    const text = await grabText(`${ROOM}/${day}.ndjson`);
    if (text === null) continue;              // a missing shard is not an error
    scanned++;
    for (const line of text.split("\n")) {
      if (frames.length >= MAX_FRAMES) break;
      /* The prefilter, as in /api/orders: a substring test rules out almost
         every line before JSON.parse is asked to look at it. */
      if (!line || !line.includes(PREFIX)) continue;
      const f = frameFrom(line);
      if (f) frames.push(f);
    }
  }

  return json({
    room: ROOM,
    archived: true,
    source: "shards",
    frames,
    days_scanned: scanned,
    days_available: allDays.length,
    truncated: frames.length >= MAX_FRAMES,
    checked: new Date().toISOString(),
  });
}

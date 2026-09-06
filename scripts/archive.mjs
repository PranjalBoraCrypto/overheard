#!/usr/bin/env node
/**
 * Overheard — Technocore archiver.
 *
 * Rooms on technocore.chat are a ring buffer and messages are retained for
 * seven days. Anything anyone captures there is on a timer. This walks the
 * network and appends what it finds to a git-tracked archive.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHY THIS WAS REWRITTEN — `since` DOES NOT PAGE BACKWARDS
 *
 * Every version before this one believed it could read history by paging:
 * ask for `since=<cursor>`, take 200 messages, ask again from the new cursor,
 * repeat. The plan even sized itself on that belief — a room with a 7,500
 * message backlog was scheduled for 38 pages.
 *
 * MEASURED 2026-08-26 against the live server. Asked `technocore` for
 * `since=518000` while its head was at 518952 — a backlog of ~950:
 *
 *     since=0       -> first_seq 518689, last_seq 518888   (the newest 200)
 *     since=518000  -> first_seq 518753, last_seq 518952   (the newest 200)
 *
 * The server returns the newest `limit` messages WHATEVER you ask for. It
 * never rewinds. So page 2 of any loop starts from a cursor that is already
 * the head, comes back with a handful of messages, and stops — every
 * multi-page read this project ever issued was one page of data and a
 * fistful of wasted requests.
 *
 * What that cost, measured on the same day: 200 messages is 25 SECONDS of
 * technocore (7.9 msg/sec) and 8 SECONDS of the lobby (25 msg/sec). Reading
 * each room once per five-minute pass therefore captured about 8% of
 * technocore and 2.7% of the lobby — and the misses were logged in each
 * room's `_meta.json` as "the ring dropped messages", which was a lie the
 * archive told itself 94 times in one day. The ring was fine. We were asleep.
 *
 * A card built on that is scoring people on a 3% sample of what they said.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHAT REPLACES IT: POLL EACH ROOM FASTER THAN IT FILLS A PAGE
 *
 * If a read can only ever return the last PAGE messages, then completeness
 * has exactly one requirement: come back before PAGE more have arrived. That
 * is a per-room deadline, and it is arithmetic —
 *
 *     interval = PAGE * SAFE_FILL / rate
 *
 * — where `rate` is measured, not guessed. Every read reports `last_seq`, and
 * the difference from the cursor we sent is the EXACT number of messages the
 * room produced while we were away, even when we only received the last 200
 * of them. So the archiver learns each room's speed from its own misses.
 *
 * The budget makes this comfortable rather than tight. /.well-known/agent.json
 * reports `reads_per_minute_per_ip: 600`. Full coverage of the lobby at 25
 * msg/sec needs one read every 4.4 seconds — 14 reads/minute. Technocore
 * needs 5. The whole hot end of the network fits in a fraction of the
 * allowance; what it could never fit into was a single burst every 5 minutes.
 *
 * So this no longer runs as a sweep. It runs as a scheduler: every room
 * carries its own deadline, the most-at-risk room goes first, a token bucket
 * holds the whole process under READS_PER_MIN, and quiet rooms cost one read
 * per window because their deadline is far away.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * Design rules that keep this free forever:
 *
 *   DAILY SHARDS. Each day gets its own file. Only today's file is ever
 *   rewritten; yesterday's is frozen and git stores it exactly once.
 *
 *   TEMPLATE COLLAPSE. Most traffic is bots posting one identical sentence.
 *   After a text has been seen REPEAT_LIMIT times we stop storing copies and
 *   just count it. The count is more interesting than the copies.
 *
 *   BODY CAP. Full coverage multiplies what a busy room stores by ~40x, and
 *   a multi-megabyte file rewritten on every commit is how a free repository
 *   dies. Past DAY_BODY_MAX bodies in one room on one day, this keeps
 *   COUNTING — profiles, templates, standings all stay complete — and stops
 *   keeping copies. Counting is what the cards are built on; the copies are
 *   a bonus, and the cap is reported rather than hidden.
 *
 *   PER-ROOM META. Room bookkeeping lives in web/data/<room>/_meta.json and
 *   is rewritten only when that room had traffic.
 *
 *   ATOMIC FLUSHES. The workflow commits on its own clock while this process
 *   is still collecting, so every file is written to a temp name and renamed
 *   into place. git never sees a half-written shard.
 */

import { readFile, writeFile, appendFile, rename, mkdir, readdir, rm } from "node:fs/promises";
/* The deal-room name comes from the protocol module the site already uses, so
   the archiver and the page can never disagree about which room a deal is in. */
import { readFrame, isFrameText, dealRoom, OFFERS_ROOM } from "../web/tclk.js";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.TECHNOCORE_BASE ?? "https://technocore.chat";
const OUT = path.resolve(process.env.OUT_DIR ?? "web/data");
const UA = "overheard-archiver/4.0 (+https://github.com/PranjalBoraCrypto/overheard)";

/** Rooms that are always followed, whatever the roster says, and that start
 *  at the fastest cadence instead of learning their way up to it. */
/* tclk-offers is here because the deals page is built entirely on it and the
   archive was not recording a single frame of it. Technocore's rooms are a
   ring buffer: every offer that scrolled past was gone from everywhere, while
   the thing we sell is being the only people who kept the history. */
const CORE = (process.env.ROOMS ?? "lobby,technocore,nano,meta,tclk-offers")
  .split(",").map((s) => s.trim()).filter(Boolean);

/* ── FOLLOWING DEALS INTO THEIR OWN ROOMS ──────────────────────────────────
 *
 * A tclk deal leaves the public board the moment it is accepted: the offer and
 * the accept are in tclk-offers, and everything that decides the outcome — the
 * lock, the reveal, the refund — happens in mb-p-tclk-<16 hex>, a room derived
 * from the contract id. Those rooms are world-readable and UNLISTED, so the
 * roster will never mention one and nothing else on the network is recording
 * them. They are also a ring buffer like every other room.
 *
 * So the settlements, which are the only part that says whether agentic
 * commerce actually worked, are being lost continuously. This follows them.
 *
 * The name is derived from a frame a stranger wrote, so it is capped and
 * checked rather than trusted: a board full of accepts naming thousands of
 * contracts must not be able to spend the whole read allowance. */
const DEAL_ROOM_RE = /^mb-p-tclk-[0-9a-f]{16}$/;
const MAX_DEAL_ROOMS = Number(process.env.MAX_DEAL_ROOMS ?? 120);

/* ── THE CAP FILLED UP WITH STRANGERS AND STAYED THAT WAY ──────────────────
 *
 * MEASURED: tclk-deals.json reached exactly 120 rooms on 3 September at
 * 03:50 and its `updated` field never changed again. The cap was written as
 * a guard against a board full of accepts spending the read allowance, and
 * it does that — but `return` on a full list means the list is not a budget,
 * it is a QUEUE THAT CLOSED. First hundred and twenty contracts to appear on
 * a busy public board win the slots for ever; everything after them, this
 * shop's own deals included, is dropped in silence.
 *
 * That is what happened. A real order was placed, accepted and paid on
 * 4 September, and its deal room — where the lock, the delivery and the
 * reveal all live — was never followed, because 120 strangers' contracts
 * from the day before were still holding every slot. The settlements this
 * archive exists to be the only record of were the exact thing being
 * dropped.
 *
 * Two rules, and the first one is the one that matters:
 *
 *   · OUR OWN DEALS ARE NEVER CAPPED. A room we are a party to is not
 *     discretionary and does not compete with strangers for a slot. The
 *     budget argument was always about a stranger flooding the board, and a
 *     flood of OUR accepts is not something a stranger can cause.
 *   · Otherwise EVICT, don't refuse. A deal room is only interesting while
 *     its deal can still move. When the list is full the oldest stranger's
 *     room is the least interesting thing in it, and the newest is the most
 *     — so the newest takes its place. The read allowance is unchanged; what
 *     changes is which rooms it is spent on.
 */
const SHOP_DID = process.env.SHOP_DID
  ?? "did:key:z6MkiuhfekPgiihLWarPAzhuvoMjg86F8dqmLiCTmtQgMrR3";
/* Offer ids we posted ourselves, so an accept ANSWERING one is recognised as
   ours. Bounded: this is written into a published file, and an offer old
   enough to fall off this list is old enough that its accept is not coming. */
const OUR_OFFERS_KEPT = Number(process.env.OUR_OFFERS_KEPT ?? 200);
/* Ours skip the strangers' cap; they do not skip HAVING one. Every followed
   room is polled for the life of the run and written into a published file, so
   "never capped" would be a slow leak — a shop that does a thousand deals
   would be reading a thousand rooms, nearly all of them long settled. The
   oldest of ours is by definition the one whose lock and reveal are already in
   the archive, so it is the safe one to let go. Larger than the strangers'
   number because these are the rooms this archive exists for. */
const MAX_OUR_DEAL_ROOMS = Number(process.env.MAX_OUR_DEAL_ROOMS ?? 300);

const RUN_MS = Number(process.env.RUN_SECONDS ?? 270) * 1000;
const FLUSH_MS = Number(process.env.FLUSH_SECONDS ?? 55) * 1000;
const ROSTER_MS = Number(process.env.ROSTER_SECONDS ?? 120) * 1000;

// 360 of the documented 600 reads/min. The ceiling is not the constraint it
// looks like: full coverage of every busy room costs a few dozen reads a
// minute, and most of this budget goes on the LONG tail — ~450 listed rooms
// each read once per MAX_INTERVAL, which is what bounds how late a message in
// a quiet room can be.
const READS_PER_MIN = Number(process.env.READS_PER_MIN ?? 360);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10);

const PAGE = 200;
// Aim to arrive when a page is a little over half full. The margin absorbs a
// burst without losing anything; chasing 100% would double the reads to buy
// the one condition we must never be in.
const SAFE_FILL = 0.55;
/* A busy room gets a tighter target than the arithmetic asks for.

   Overflow does not depend on the interval, it depends on the GAP between
   two successive reads exceeding the window — 8 seconds in the lobby. The
   interval only decides how much headroom a stall has to eat before that
   happens. At 0.55 the lobby aims for 4.4s and a 4-second hiccup overflows;
   at 0.35 it aims for 2.8s and the same hiccup is absorbed. Twenty-one reads
   a minute against an allowance of six hundred is not a cost worth
   protecting. */
const FAST_ROOM_RATE = 8;      // messages/sec
const FAST_SAFE_FILL = 0.35;
const MIN_INTERVAL_MS = 1_500;
const MAX_INTERVAL_MS = 150_000;
const NEW_ROOM_INTERVAL_MS = 20_000;

/* ── THE ESCROW ROOMS ARE NOT ORDINARY ROOMS ───────────────────────────────
 * MEASURED on 3 September, out of tclk-offers' own _meta.json:
 *
 *   {"after":591,"resumed_at":1107,"missed":515,"cause":"poll interval"}
 *
 * 515 frames gone in one hole — more than a third of everything that room
 * has ever produced — and the scheduler did nothing wrong. A room with a low
 * measured rate earns a long interval, tclk-offers drifted out towards the
 * 150-second ceiling, then several agents posted at once and a full page
 * landed inside one interval. The schedule worked exactly as designed and
 * lost the board.
 *
 * The reasoning that is right for 58,699 rooms is wrong for these. Everywhere
 * else a missed message is one message: a profile count runs a little short
 * and the loss is spread thin across a network. Here a missed message is an
 * OFFER, and this room is the entire basis of the deals page, of what the
 * runner can answer, and of whatever record exists when the testnet opens.
 * There is also nowhere else to get it — unlike a busy public room, nobody
 * else on the network is recording this one at all.
 *
 * The cost of never backing off is nothing. tclk-offers has produced 2,146
 * messages in its whole existence. Reading it every 2.5 seconds is 24 reads
 * a minute out of an allowance of 360 — less than the lobby already spends,
 * for the one room the product cannot afford to be wrong about.
 *
 * Deal rooms get a looser ceiling AND a time limit on it, because the first
 * version of this got the arithmetic wrong and its own test caught it: 120
 * rooms at twelve seconds is 600 reads a minute and the whole allowance is
 * 360. A ceiling that oversubscribes the budget does not read the escrow
 * rooms faster; it starves everything else and hands the decision to the
 * priority queue, which is the opposite of the point.
 *
 * What makes it cheap is that a deal room is only interesting while the deal
 * is happening. An offer, an accept, a lock, a reveal, and then it is silent
 * for ever. So the ceiling holds while the room is still producing and for a
 * grace period after, and a settled deal falls back to the ordinary cadence
 * like any other quiet room. Ten deals settling at once costs 50 reads a
 * minute; a hundred finished ones cost almost nothing.
 *
 * This is a CEILING, not a fixed interval. If one of these rooms ever gets
 * genuinely busy the ordinary arithmetic still applies and reads it faster.
 * The rule here is only that it may never be read more slowly than this.
 */
/* Env-overridable so the test can run the SAME code with the ceiling removed
   and show it losing messages. A fix with no failing control is a fix nobody
   can check. */
const TCLK_OFFERS_MAX_MS = Number(process.env.TCLK_OFFERS_MAX_MS ?? 2_500);
const TCLK_DEAL_MAX_MS = Number(process.env.TCLK_DEAL_MAX_MS ?? 12_000);
/* How long after its last frame a deal room keeps the tight ceiling. Long
   enough to cover a lock answering an accept, short enough that a settled
   deal stops costing anything. */
const TCLK_DEAL_HOT_MS = Number(process.env.TCLK_DEAL_HOT_MS ?? 600_000);
const tclkCeiling = (room, e) => {
  if (room === OFFERS_ROOM) return TCLK_OFFERS_MAX_MS;
  if (!DEAL_ROOM_RE.test(room)) return null;
  /* Freshly discovered counts as hot: we only found it because somebody just
     accepted, so the frames that decide the deal have not happened yet. */
  const last = e?.producedAt || e?.discoveredAt || 0;
  if (!last) return TCLK_DEAL_MAX_MS;
  return Date.now() - last <= TCLK_DEAL_HOT_MS ? TCLK_DEAL_MAX_MS : null;
};

/* Every interval in this file goes through here. There are four separate
   places that lengthen an interval — the rate arithmetic, the empty-page
   backoff, the long-idle rule and the error backoff — and a ceiling enforced
   at three of them is not a ceiling. */
function setInterval_(e, ms) {
  const cap = tclkCeiling(e.room, e);
  e.interval = clamp(ms, MIN_INTERVAL_MS, cap == null ? MAX_INTERVAL_MS : cap);
  return e.interval;
}

/* How many times a room may come back empty while claiming a head ahead of
   our cursor before we stop waiting and write the loss down. Three is enough
   for the race to settle and short enough that a genuinely stuck room is not
   re-read for ever; the empty-page backoff widens the interval each time, so
   the three attempts span roughly ten seconds rather than three ticks. */
const EMPTY_RETRIES = Number(process.env.EMPTY_RETRIES ?? 3);

const ROSTER_LIMIT = 500;
const REPEAT_LIMIT = 5;
/* MEASURED: templates.json had reached 8.2 MB, and it was being stringified
   and rewritten on EVERY flush. JSON.stringify is synchronous — it stops the
   event loop dead, which means it stops the reads, and the lobby fills its
   200-message window in eight seconds. The file was quietly buying the misses
   that the flush fix was supposed to end. It is also committed every five
   minutes, so 8 MB was a repository problem waiting to happen.

   Two changes, neither of which loses anything the site uses: the table keeps
   the 6,000 most-repeated texts rather than 20,000 (spam.json only ever shows
   the top 500), and a template records 40 distinct posters rather than 250,
   which is plenty to establish "many identities post this". */
const MAX_POSTERS = 40;
const MAX_TEMPLATES = 6000;
const ROSTER_SNAPSHOT = 120;
const DAY_BODY_MAX = Number(process.env.DAY_BODY_MAX ?? 12000);
/* ── EXCEPT FOR THE ONE ROOM WHERE A DROPPED BODY IS A LOST DEAL ──────────
   The cap above is right for 58,699 rooms and catastrophic for this one, for
   exactly the reason the polling ceiling already has an exception here:
   elsewhere a missed message is a missed message, but in tclk-offers it is an
   OFFER, an ACCEPT or a LOCK, and nobody else on the network records it.

   MEASURED on the live archive, 4 September:

       body_cap        12000
       bodies_dropped  16225      <- more than half the day, thrown away
       total           24546

   The shard stopped growing at 08:46 — not because of the publishing
   cadence, which is what I first blamed, but because it was FULL. Past the
   cap the archiver keeps counting and stops keeping copies, so the file stops
   changing, `git diff --staged --quiet` reports "no new messages", and the
   day's shard looks published-and-quiet when it is actually truncated.

   Everything downstream then reads a file that ends at breakfast. A real
   order at 12:20 — offer, accept and payment lock all on the public board —
   was invisible to the shop's own runner at 12:52, which reported `0 owed`
   and slept while the buyer's money sat locked. It was never in the archive
   to be found.

   THE COST OF THE EXCEPTION, since the cap exists for a real reason: this
   room averages 616 bytes a line and ran 28,000 frames on its busiest day, so
   an uncapped day is ~17 MB. That is one room, once a day, against a cap that
   exists to stop forty rooms doing it at once. The trade is not close.

   Still bounded, because "no cap" is how a free repository dies: two hundred
   thousand is an order of magnitude above anything this room has ever done,
   so it is a backstop rather than a working limit — and if it is ever hit,
   `bodies_dropped` will say so instead of the silence that cost us today. */
const TCLK_BODY_MAX = Number(process.env.TCLK_BODY_MAX ?? 200000);
const bodyCapFor = (room) => (room === OFFERS_ROOM ? TCLK_BODY_MAX : DAY_BODY_MAX);
const MAX_GAPS_KEPT = 50;

/**
 * Room names come from the network, and the roster response even labels its
 * own contents `untrusted`. A name is interpolated into BOTH a URL path and a
 * filesystem path here, so a room called `../../.github/workflows` would be a
 * write outside the archive. Anything not matching this is dropped and logged.
 */
const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const safeRoom = (r) => typeof r === "string" && ROOM_RE.test(r) && !r.includes("..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (ts) => String(ts ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10);
const hash = (t) => createHash("sha256").update(t, "utf8").digest("hex").slice(0, 12);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ── the read budget ──────────────────────────────────────────────────────
   A token bucket rather than a fixed sleep between reads. Concurrency and
   pacing are then independent: four reads can overlap when four rooms are
   due at once, and the process still cannot exceed READS_PER_MIN over any
   minute, which is the only thing the server cares about.
   ─────────────────────────────────────────────────────────────────────── */
let tokens = READS_PER_MIN;
let lastRefill = Date.now();
let reads = 0, rateLimited = 0;

function takeToken() {
  const now = Date.now();
  tokens = Math.min(READS_PER_MIN, tokens + ((now - lastRefill) / 60000) * READS_PER_MIN);
  lastRefill = now;
  if (tokens < 1) return false;
  tokens -= 1;
  return true;
}

/* Every read carries a deadline. Without one, a single hung request holds a
   lane for as long as the socket stays open, and with CONCURRENCY lanes a
   handful of them starve the scheduler — the lobby's deadline passes, 200
   more messages land, and the loss is indistinguishable from a bad interval.
   MEASURED: steady-state coverage sat at ~88% with the schedule provably
   correct (the lobby's interval was a third of its safe value), which is the
   signature of the loop not running rather than running late. */
async function get(url, deadlineMs = 8000) {
  reads++;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": UA },
    signal: AbortSignal.timeout(deadlineMs),
  });
  if (res.status === 429) {
    rateLimited++;
    const body = await res.text();
    const secs = Number((body.match(/(\d+)\s*second/i) ?? [])[1] ?? 30);
    console.warn(`  rate limited, waiting ${secs}s`);
    // Spend the bucket too, so every other in-flight room backs off with us
    // instead of walking straight into the same wall.
    tokens = 0; lastRefill = Date.now() + (secs + 1) * 1000;
    await sleep((secs + 1) * 1000);
    return get(url);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** The KV store answers text/plain, so it needs its own reader. Same budget,
 *  same deadline, same 429 handling — just no JSON.parse at the end. */
async function getText(url, deadlineMs = 8000) {
  reads++;
  const res = await fetch(url, {
    headers: { Accept: "text/plain", "User-Agent": UA },
    signal: AbortSignal.timeout(deadlineMs),
  });
  if (res.status === 404) return null;                 // absent, definitively
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.text()).trim();
}

const readJson = async (file, fallback) =>
  existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : fallback;

/** Written to a temp name and renamed, because the workflow runs `git add`
 *  on its own clock while this process is still writing. */
/* ══════════════════════════════════════════════════════════════════════════
 * THE TAIL — the last stretch of the offers room, small enough to publish
 * every pass
 *
 * ── THE HOLE IT FILLS, MEASURED RATHER THAN GUESSED ──────────────────────
 *
 * Everything downstream reads the live room with `limit=200` and assumes that
 * reaches back far enough. PROBED from a runner on 4 September, because
 * neither a laptop nor the cloud container can reach the venue:
 *
 *     limit=500 / 1000 / 2000 / 5000   ->  200 messages every time
 *     since=<older seq>                ->  the same newest 200, always
 *     pace                             ->  2,587 frames/hour
 *
 * So 200 messages is FIVE MINUTES, the cap is the venue's and not ours, and
 * the window cannot be walked backwards. The live room is not a source of
 * truth for anything older than five minutes.
 *
 * The day shard covers the rest — but it is committed on every twelfth pass
 * because it is 7.4 MB and growing, so it can be hours old. On 4 September it
 * had not been written since 08:46.
 *
 * Between those two lies a gap of hours in which a fully formed deal is
 * invisible to everyone, INCLUDING US. Proven, not theorised: a real order
 * placed at 12:20 — offer, accept and payment lock all on the board — was
 * unseen by a live wake at 12:52, which reported `0 owed · 0 open` and went
 * back to sleep while the buyer's money sat locked.
 *
 * ── WHY A TAIL AND NOT MORE PUBLISHING ───────────────────────────────────
 *
 * Publishing the day shard every pass is the obvious fix and the wrong one:
 * it is the thing the twelfth-pass tiering exists to prevent, and it would
 * put gigabytes a day into git. What the readers actually need is not the
 * whole day. It is the last hour or two — the stretch between "still in the
 * live window" and "already in a published shard".
 *
 * So: one bounded file, a few hundred kilobytes, rewritten every pass. It is
 * a WINDOW, not a log — the oldest lines fall off — which is what keeps its
 * size flat while the day shard grows.
 *
 * ONE ROOM ONLY, deliberately. tclk-offers is where money is agreed. No other
 * room's freshness is worth a commit every five minutes, and a tail per room
 * would recreate the cost this avoids.
 * ═════════════════════════════════════════════════════════════════════════*/

/* ── HOW BIG THE TAIL MAY GET, IN BYTES AND NOT IN LINES ─────────────────
   The first version capped it at 4,000 LINES and three separate comments
   called that "a few hundred KB". At this room's measured 616 bytes a line
   it is 2.5 MB, and a line may be up to MAX_TEXT (4,000 chars) — so the
   worst case was 16 MB, LARGER than the shard the every-pass tiering exists
   to keep out of git. The bound was on the wrong quantity, and the argument
   for affordability was wrong by an order of magnitude.
   Bytes are what the commit costs, so bytes are what is capped. 1.5 MB is
   about forty minutes of this room at its busiest and comfortably more than
   the gap the tail exists to cover. */
const TAIL_MAX_BYTES = Number(process.env.TAIL_MAX_BYTES ?? 1_500_000);
/* A line ceiling as well, because a room of tiny frames would otherwise put
   a hundred thousand of them in here and make every reader's parse slow for
   no extra coverage. Whichever binds first, binds. */
const TAIL_MAX = Number(process.env.TAIL_MAX ?? 4000);

/** One arriving record, appended to the rolling window. */
function pushTail(state, r) {
  if (!state.tail) state.tail = { rows: [], bytes: 0, seqs: new Set() };
  const t = state.tail;
  const k = String(r?.seq ?? "");
  if (!k || t.seqs.has(k)) return;
  const line = JSON.stringify(r);
  t.rows.push(line);
  t.seqs.add(k);
  t.bytes += line.length + 1;
  /* Trim from the FRONT: this is a window over the newest frames, and the
     newest are the ones no other file has yet. */
  while (t.rows.length > TAIL_MAX || (t.bytes > TAIL_MAX_BYTES && t.rows.length > 1)) {
    const gone = t.rows.shift();
    t.bytes -= gone.length + 1;
    try { t.seqs.delete(String(JSON.parse(gone).seq)); } catch { /* torn: nothing to forget */ }
  }
}

/* ── THE TAIL IS SEEDED FROM THE LAST ONE, NOT STARTED EMPTY ──────────────
   A hosted run lasts about five and a half hours and then the job ends. The
   next run starts a fresh process, and `state.tail` starts empty — so its
   first pass REPLACES tail.ndjson with the handful of frames that arrived in
   those five minutes, and every frame the previous run had in its window
   disappears in one write. That is a hole at every run boundary, in the one
   file whose entire job is not to have holes, and it is the same shape of
   hole (a reader looks, sees a healthy-looking file, and the frame it needs
   is not in it) that made the shop report `0 owed` over a real locked
   payment.
   The previous tail is already checked out on disk. Start from it. Every
   line goes back through pushTail, so the dedupe, the byte bound and the
   line bound are the ones in force NOW — a tail written when the caps were
   larger is trimmed to today's caps on the way in rather than smuggled
   past them. */
async function loadTail() {
  const seed = { rows: [], bytes: 0, seqs: new Set() };
  const file = path.join(OUT, OFFERS_ROOM, "tail.ndjson");
  if (!existsSync(file)) return seed;
  let text;
  try { text = await readFile(file, "utf8"); } catch { return seed; }
  const holder = { tail: seed };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }   // torn last line: skip it
    pushTail(holder, r);
  }
  return holder.tail;
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE TAIL — the newest stretch of the offers room, small enough to publish
 * every pass
 *
 * ── THE HOLE IT FILLS, MEASURED RATHER THAN GUESSED ──────────────────────
 *
 * Everything downstream reads the live room with `limit=200` and assumes that
 * reaches back far enough. PROBED from a runner on 4 September, because
 * neither a laptop nor the cloud container can reach the venue:
 *
 *     limit=500 / 1000 / 2000 / 5000   ->  200 messages every time
 *     since=<older seq>                ->  the same newest 200, always
 *     pace                             ->  2,587 frames/hour
 *
 * So 200 messages is FIVE MINUTES, the cap is the venue's and not ours, and
 * the window cannot be walked backwards. The live room is not a source of
 * truth for anything older than five minutes.
 *
 * The day shard is supposed to cover the rest. On 4 September it stopped at
 * 08:46 — because it was FULL, not because of the publishing cadence, which
 * is what I blamed first. See TCLK_BODY_MAX.
 *
 * Both holes are now closed. This file remains because closing them left a
 * third one: the shard is still only COMMITTED every twelfth pass, so between
 * a five-minute room and an hours-old commit there is a stretch nothing
 * covers. That stretch is where a real order at 12:20 — offer, accept and
 * payment lock all on the public board — became invisible to the shop's own
 * runner at 12:52, which reported `0 owed` and slept while the money sat
 * locked.
 *
 * ── WHY A TAIL AND NOT MORE PUBLISHING ───────────────────────────────────
 *
 * Publishing the day shard every pass is the obvious fix and the wrong one:
 * it is what the twelfth-pass tiering exists to prevent, and it would put
 * gigabytes a day into git. What the readers need is not the whole day. It is
 * the last stretch — between "still in the live window" and "already in a
 * published shard".
 *
 * ONE ROOM ONLY, deliberately. tclk-offers is where money is agreed. No other
 * room's freshness is worth a commit every five minutes.
 * ═════════════════════════════════════════════════════════════════════════*/
async function writeTail(state) {
  const t = state.tail;
  if (!t?.rows.length) return;
  const dir = path.join(OUT, OFFERS_ROOM);
  await mkdir(dir, { recursive: true });

  let firstSeq = null, lastSeq = null, firstTs = null, lastTs = null;
  for (const line of t.rows) {
    try {
      const r = JSON.parse(line);
      if (firstSeq === null) { firstSeq = r.seq; firstTs = r.ts ?? null; }
      lastSeq = r.seq; lastTs = r.ts ?? null;
    } catch { /* torn line: still bytes, just not a bound */ }
  }

  await writeAtomic(path.join(dir, "tail.ndjson"), t.rows.join("\n") + "\n");
  /* first/last seq are stated so a reader can tell AT A GLANCE whether this
     tail reaches its own live window, rather than assuming it does — which is
     the assumption that caused all of this. `updated` is the time of THIS
     write; `last_ts` is the age of the newest frame in it, and those two
     being far apart is the shape of a tail that has stopped moving. */
  await writeAtomic(path.join(dir, "tail.json"), JSON.stringify({
    room: OFFERS_ROOM, updated: new Date().toISOString(),
    lines: t.rows.length, bytes: t.bytes,
    max_lines: TAIL_MAX, max_bytes: TAIL_MAX_BYTES,
    first_seq: firstSeq, last_seq: lastSeq, first_ts: firstTs, last_ts: lastTs,
    note: "The newest frames of the offers room, rewritten every archiver pass. "
        + "The live room reaches back about five minutes and cannot be paged; "
        + "the day shard is committed far less often. This covers between them. "
        + "Compare last_ts with updated: far apart means this has stopped moving.",
  }, null, 1) + "\n");
}

async function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

/* ══════════════════════════════════════════════════════════════════════════
 * HOW WIDE A PROFILE SHARD IS, AND WHY IT COST SEVEN GIGABYTES A DAY
 *
 * This was TWO hex characters — 256 shards over 2,758,760 identities, so
 * 10,650 identities and 3.2 MB in every file. Git does not store a change to
 * a file; it stores the FILE. So one identity posting one message wrote a new
 * 3.2 MB object.
 *
 * MEASURED, on the live repository. Each five-minute pass sees roughly 150
 * distinct identities, and 150 identities spread across 256 shards touch
 * nearly all of them: about 384 MB of new objects per pass, staged 32 times a
 * day. GitHub reported the repository at 76.22 GB on 4 September, up from
 * nothing on 25 August — a little over 7 GB a day — and answered a push with
 * "Repository is approaching its size quota".
 *
 * THREE characters is 4,096 shards of about 670 identities and 200 KB. The
 * same 150 identities now land in about 148 DIFFERENT shards, so almost every
 * one of them is a shard of its own: 30 MB a pass instead of 384. Sixteen
 * times less, for one character.
 *
 * The move itself is measured too: 44 seconds over the real 815 MB, once.
 *
 * Why not four, at 65,536 files of 12 KB? Because the repository already
 * carries 141,884 files and a static host has its own opinion about how many
 * files a deployment may contain. Three is the change that is large enough to
 * matter and small enough not to trade one ceiling for another.
 *
 * The other half of the fix is in .github/workflows/archive.yml: this
 * directory was staged on every third pass, and there is nothing a visitor
 * can do with a profile that is fifteen minutes fresher rather than ninety.
 * ═════════════════════════════════════════════════════════════════════════*/
/* ── AND THEN A SECOND TIME, TO FOUR ───────────────────────────────────────
 *
 * Three characters was measured on the live network the same morning it
 * shipped, and it was not enough. 4,096 shards over what turned out to be
 * 1.28 GB of profiles is 320 KB each, and the fifteen hundred identities who
 * post in an hour still land in about a third of the buckets — 390 MB of new
 * objects per publish, down from 1,279 but nowhere near done.
 *
 * FOUR characters is 65,536 shards of about 20 KB. Now fifteen hundred
 * identities touch about fifteen hundred buckets, each one small, and a
 * publish writes 30 MB rather than 390. That is where the arithmetic stops
 * being interesting: below this the per-file overhead — a git object header,
 * a thirty-byte tree entry, one more thing for a static host to walk —
 * starts to cost more than the bytes it saves.
 *
 * NESTED, ab/cd.json, and not because git cares. Git sees the same work
 * either way: one flat tree of 65,536 entries is 2 MB rewritten per commit,
 * and 256 leaf trees of 256 entries is the same 2 MB. It is nested because
 * 65,536 files in a single directory is a directory nothing enjoys reading —
 * not a person, not a build step, not a file walker with a timeout.
 *
 * WHAT WAS CHECKED FIRST. Vercel documents a 15,000-file ceiling, and it is
 * for CLI deployments; this site deploys through the git integration and
 * already ships 141,884 files. This takes it to about 207,000, which is
 * unproven rather than known — so both readers try the new name and then the
 * old, and a deployment that chokes on the file count degrades to the
 * previous layout instead of to a blank card.
 * ═════════════════════════════════════════════════════════════════════════*/
export const SHARD_CHARS = 4;
export const shardOf = (did) =>
  createHash("sha256").update(did, "utf8").digest("hex").slice(0, SHARD_CHARS);

/* ══════════════════════════════════════════════════════════════════════════
 * AND WHY WIDENING WAS NEVER GOING TO BE ENOUGH
 *
 * The shards went 256 -> 4,096 -> 65,536 and the repository still grew about
 * seven gigabytes a day. MEASURED on the publish of 5 September 16:03, by
 * diffing the tree against its parent:
 *
 *   · 77% of all 65,536 shard files were rewritten by ONE publish
 *   · inside them, 41 of 1,614 records had actually changed — 2.5%
 *   · so 1,045 MB was written to record 15 MB of news
 *
 * The reason is the property that makes hash sharding attractive. It spreads
 * identities EVENLY, so a publish touching ~86,000 records over 65,536 shards
 * puts an average of 1.3 in each — and a shard with one changed record costs
 * exactly as much to rewrite as a shard with sixty. Poisson says 73% of shards
 * get at least one; the measurement said 77%. Splitting finer divides the
 * records but never the news, and to reach 30 MB a publish by width alone
 * would take about four MILLION files.
 *
 * So the shard stops being a file that is rewritten and becomes a LOG that is
 * appended to. One line per record, the last line for a did winning. A publish
 * writes what changed — measured at 31 MB against 1,045 MB, the number the
 * widening was aiming at all along — and the file is rewritten only when it
 * has grown to COMPACT_AT times the records it actually holds.
 * ═════════════════════════════════════════════════════════════════════════*/

/** Where a shard lives, relative to the profiles directory. */
export const shardPath = (shard) =>
  shard.length > 3 ? `${shard.slice(0, 2)}/${shard.slice(2)}.ndjson` : `${shard}.ndjson`;

/** The same shard under the whole-file layout this replaces. Read, never
 *  written, and deleted the moment its log has landed. */
export const shardPathJson = (shard) =>
  shard.length > 3 ? `${shard.slice(0, 2)}/${shard.slice(2)}.json` : `${shard}.json`;

/* ── how long a log is allowed to get ─────────────────────────────────────
   Chosen from the arithmetic rather than by feel. Appending costs 0.61 GB a
   day whatever this is; compacting costs 65,536 rewrites divided by however
   many days it takes to trigger, and a lookup pays for whatever has piled up
   since. Measured against 69 records and 21 KB in an average shard:

        at 2x    43 KB peak    every 2.2 d    1.23 GB/day
        at 3x    65 KB peak    every 4.4 d    0.92 GB/day     <- here
        at 6x   129 KB peak    every 11 d     0.74 GB/day
        at 20x  430 KB peak    every 42 d     0.65 GB/day

   The saving is nearly all bought by 3x; past it the file grows faster than
   the storage falls, and the file is what a visitor downloads to see a card.
   Today's figure, for scale, is 24.5 GB a day. */
const COMPACT_AT = 3;
/* Below this a log is too short for the bookkeeping to be worth anything, and
   rewriting it costs almost nothing. */
const COMPACT_MIN = 32;

/** Read a file, or null if it is not there. */
async function readText(file) {
  try { return await readFile(file, "utf8"); } catch { return null; }
}

/**
 * Fold a log into the object a bucket is. Later lines win.
 *
 * A LINE THAT WILL NOT PARSE IS SKIPPED, NOT FATAL. An append interrupted
 * halfway leaves bytes nobody finished writing, and there is exactly one such
 * line and it is at the end. Losing that one update is recoverable — the next
 * pass writes it again. Refusing to read the shard is not: it would report
 * every identity in it as never having spoken.
 */
export function foldLog(text) {
  const bucket = {};
  let lines = 0, dropped = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (!line) continue;
    lines++;
    let r;
    try { r = JSON.parse(line); } catch { dropped++; continue; }
    if (!r || typeof r.did !== "string") { dropped++; continue; }
    const { did, ...rest } = r;
    bucket[did] = rest;
  }
  return { bucket, lines, dropped };
}

/* Everything at the top level with a short name is a previous layout. Both
   of them: this repository ran two characters for eleven days and three for
   about an hour, and a migration that knew only about the older one would
   have stranded whatever the newer one had already written. */
const OLD_SHARD = /^[0-9a-f]{2,3}\.json$/;

/* ══════════════════════════════════════════════════════════════════════════
 * THE OTHER FILE THAT WAS COSTING HALF A GIGABYTE A DAY
 *
 * cursors.json is where each room was left off. MEASURED on 5 September: it
 * holds 78,222 rooms in 1.73 MB, on ONE line, and 256 of those rooms change
 * in a five-minute pass. So a fifth of a percent of it was news and all of it
 * was written, 288 times a day — about 490 MB, for eleven and a half kilobytes
 * of actual change.
 *
 * Nothing outside this file has ever read it: it is bookkeeping, not archive.
 * So it becomes a log too, on the same rule as the shards.
 * ═════════════════════════════════════════════════════════════════════════*/
async function loadCursors() {
  const log = await readText(path.join(OUT, "cursors.ndjson"));
  if (log !== null) {
    const map = {};
    let lines = 0;
    for (const line of log.split("\n")) {
      if (!line) continue;
      lines++;
      /* Same rule as a shard log: a half-written last line is skipped. Losing
         one cursor re-reads one room from where it was, which costs a read
         and duplicates nothing — every writer here is keyed by sequence. */
      try {
        const r = JSON.parse(line);
        if (r && typeof r.room === "string") map[r.room] = r.cursor;
      } catch { /* skipped on purpose */ }
    }
    return { map, lines };
  }
  /* The whole-file layout. Zero lines means the first write rewrites it. */
  return { map: await readJson(path.join(OUT, "cursors.json"), {}), lines: 0 };
}

/** The cursors, written the same way a shard is. */
async function writeCursors(state, dirty) {
  if (!dirty.size) return;
  const file = path.join(OUT, "cursors.ndjson");
  const line = (room) => JSON.stringify({ room, cursor: state.cursors[room] }) + "\n";
  const held = Object.keys(state.cursors).length;
  const lines = state.cursorLines ?? 0;

  if (lines === 0 || lines + dirty.size > Math.max(COMPACT_MIN, held * COMPACT_AT)) {
    await writeAtomic(file, Object.keys(state.cursors).sort().map(line).join(""));
    state.cursorLines = held;
    const old = path.join(OUT, "cursors.json");
    if (existsSync(old)) await rm(old, { force: true });
  } else {
    await appendFile(file, [...dirty].sort().map(line).join(""));
    state.cursorLines = lines + dirty.size;
  }
}

async function loadState() {
  const cursors = await loadCursors();
  return {
    cursors: cursors.map,
    /* How many lines are on disk, so the writer knows when the log has grown
       past the records it holds and is worth rewriting. */
    cursorLines: cursors.lines,
    dirtyCursors: new Set(),
    shardLines: new Map(),
    dirtyDids: new Map(),
    templates: await readJson(path.join(OUT, "templates.json"), { updated: null, texts: {} }),
    profiles: new Map(),
    dirtyProfiles: new Set(),
    recent: await readJson(path.join(OUT, "recent.json"), { dids: [] }),
    // room -> { days: Map<day, records[]>, seen, stored, collapsed, capped, gaps }
    pending: new Map(),
    metas: new Map(),
    // room|day -> { text, seqs, n }. Held in memory so a day shard is
    // APPENDED to rather than rebuilt, which is what lets git delta it.
    shards: new Map(),
    /* Deal rooms found in accepts. Persisted because an accept scrolls past
       and is never read again — without this, a restart forgets every deal it
       was following and the room goes dark mid-settlement. */
    deals: trimDeals(await readJson(path.join(OUT, "tclk-deals.json"), { updated: null, rooms: {} })),
    /* Carried over the run boundary — see loadTail(). */
    tail: await loadTail(),
  };
}

/* ── THE CAPS APPLY TO WHAT WAS ALREADY THERE, NOT ONLY TO ARRIVALS ────────
   Eviction happens when a room arrives, so a list that is already over its cap
   would sit there until the next accept — and the moment a cap most needs to
   bind is when somebody has just lowered it because the run allowance is being
   eaten. Enforced once at load, before anything is tracked, so an over-cap
   room is never read at all rather than read once and then dropped. */
function trimDeals(deals) {
  const rooms = deals?.rooms ?? {};
  for (const [ours, cap] of [[true, MAX_OUR_DEAL_ROOMS], [false, MAX_DEAL_ROOMS]]) {
    const pool = Object.entries(rooms)
      .filter(([, v]) => (v?.ours === true) === ours)
      .sort((a, b) => String(a[1]?.seen ?? "").localeCompare(String(b[1]?.seen ?? "")));
    const over = pool.length - cap;
    for (let i = 0; i < over; i++) delete rooms[pool[i][0]];   // oldest first
    if (over > 0) console.log(`  deal rooms: dropped ${over} over the ${ours ? "our" : "strangers'"} cap of ${cap}`);
  }
  return deals;
}

/**
 * One shard, on disk.
 *
 * It used to be one identity per line inside a JSON object, on the theory
 * that a short changed line is a small delta. It is not: git stores the whole
 * blob and the pack's own measurement says so — 1,045 MB of rewritten shards
 * turned into 336 MB of repository, which is zlib and nothing else.
 *
 * So `dids` is the set that actually changed, and only those lines are
 * written. Pass it undefined to force a full rewrite, which is what a
 * migration wants.
 */
export async function writeShard(state, shard, dids) {
  state.shardLines ??= new Map();
  const bucket = state.profiles.get(shard);
  if (!bucket) return;
  /* An empty dirty set means somebody marked a shard and changed nothing in
     it. Rewriting the whole file for that is the exact cost this is here to
     stop. */
  if (dids && dids.size === 0) return;

  const dir = path.join(OUT, "profiles");
  const file = path.join(dir, shardPath(shard));
  /* The nesting means a shard's directory may not exist yet. mkdir is cheap
     and idempotent; getting this wrong loses a shard silently, because
     writeAtomic's rename would fail into a catch nobody is watching. */
  await mkdir(path.dirname(file), { recursive: true });

  const line = (did) => JSON.stringify({ did, ...bucket[did] }) + "\n";
  const held = Object.keys(bucket).length;
  const lines = state.shardLines.get(shard) ?? 0;

  /* `lines === 0` covers three cases and all three want the same answer: a
     shard that is new, one still in the whole-file layout, and one this
     process has not read. Each needs a file that stands on its own before
     anything may be appended to it. */
  const rewrite = !dids || lines === 0
    || lines + dids.size > Math.max(COMPACT_MIN, held * COMPACT_AT);

  if (rewrite) {
    await writeAtomic(file, Object.keys(bucket).sort().map(line).join(""));
    state.shardLines.set(shard, held);
    /* The previous layout's file, removed only AFTER its replacement is on
       disk. writeAtomic renames, so there is no instant where a reader could
       find neither — and the readers try the log first and the old name
       second, so one that arrives in between finds the old answer rather
       than no answer. */
    const old = path.join(dir, shardPathJson(shard));
    if (existsSync(old)) await rm(old, { force: true });
  } else {
    await appendFile(file, [...dids].sort().map(line).join(""));
    state.shardLines.set(shard, lines + dids.size);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE ONE-TIME MOVE ONTO WHATEVER THE CURRENT LAYOUT IS
 *
 * Without this a widening is silent data loss of the worst kind. The archiver
 * reads a shard ON DEMAND — profileShard() — and a read of a file that does
 * not exist returns {}. So on the first pass after a change, the identities
 * seen in that one window get written into new shards holding only
 * themselves, the old files sit there unread, and the card page — which now
 * asks for the new name — reports every identity on the network as never
 * having spoken. Nothing throws. No test that did not know to look notices.
 *
 * So every file still at the top level is read, its identities redistributed
 * by the current rule, and the old file removed, before anything else runs.
 *
 * IT HANDLES BOTH PREVIOUS LAYOUTS. This repository ran two characters for
 * eleven days and three for about an hour, so a migration that knew only
 * about the older one would have stranded everything the newer one had
 * already written. OLD_SHARD matches any short name at the top level, and
 * the current layout is nested, so "at the top level" is itself the test for
 * "not yet moved" — there is nothing to keep in step.
 *
 * IT MERGES RATHER THAN OVERWRITES. A run interrupted halfway leaves some
 * identities moved and some not; the next run has to finish the job without
 * discarding what the first one wrote. And it costs nothing once done — the
 * filter finds no short names, and it returns immediately, on every pass for
 * the rest of the archive's life.
 * ═════════════════════════════════════════════════════════════════════════*/
export async function migrateShards(state) {
  const dir = path.join(OUT, "profiles");
  if (!existsSync(dir)) return 0;
  const old = (await readdir(dir)).filter((f) => OLD_SHARD.test(f));
  if (!old.length) return 0;

  let moved = 0;
  for (const file of old) {
    const bucket = await readJson(path.join(dir, file), {});
    const touched = new Set();
    for (const [did, v] of Object.entries(bucket)) {
      const s = shardOf(did);
      /* Through profileShard, so anything already written by an interrupted
         run is loaded and kept rather than replaced. */
      const into = await profileShard(state, s);
      into[did] = v;
      touched.add(s);
      moved++;
    }
    for (const s of touched) await writeShard(state, s);
    /* Only after every identity in it has been written somewhere else. */
    await rm(path.join(dir, file));

    /* ── AND THEN FORGET ALL OF IT ────────────────────────────────────────
       MEASURED on the real archive: 2,758,760 identities across 256 shards,
       and holding the migrated ones in memory took the process to 1.9 GB of
       resident set. A GitHub runner would survive that and should not have
       to, and two other things read `state.profiles` afterwards — writeRecent
       walks every entry in it and sorts them, which on the migration pass
       would be a 2.7-million-element sort for a list of sixty.

       Safe because the leading characters are PRESERVED: everything in
       `ab.json` goes to `ab00`…`abff` and nothing in `cd.json` can ever land
       there. Each new shard is finished the moment its parent is, so nothing
       here will be read again — and if the run does need one later,
       profileShard() reads it back from disk. */
    state.profiles.delete(file.replace(/\.json$/, ""));
    for (const s of touched) { state.profiles.delete(s); state.shardLines.delete(s); }
  }
  console.log(`  profiles: moved ${moved} identities out of ${old.length} old shards into ${SHARD_CHARS}-character ones`);
  return moved;
}

export async function profileShard(state, shard) {
  /* Made on demand, because the suites construct a state by hand and should
     not have to know which bookkeeping maps this file happens to keep. */
  state.shardLines ??= new Map();
  state.dirtyDids ??= new Map();
  if (!state.profiles.has(shard)) {
    const dir = path.join(OUT, "profiles");
    const log = await readText(path.join(dir, shardPath(shard)));
    if (log !== null) {
      const { bucket, lines } = foldLog(log);
      state.profiles.set(shard, bucket);
      state.shardLines.set(shard, lines);
    } else {
      /* Still in the whole-file layout, or not there at all. Either way the
         line count is zero, which is what makes the next write a full one —
         so a shard migrates itself the first time anybody in it speaks. */
      state.profiles.set(shard, await readJson(path.join(dir, shardPathJson(shard)), {}));
      state.shardLines.set(shard, 0);
    }
  }
  return state.profiles.get(shard);
}

/** What the identity last said, trimmed for storage. The sweep matches
 *  Technocore's own: control and formatting characters become spaces, which
 *  also removes the invisible ones a message could use to hide text inside a
 *  quote. */
/* 180 before. This is the field that changes on almost every profile on
   almost every pass, so its length sets the size of the delta git has to
   store 288 times a day across 256 shards. 120 characters is still a
   readable quote on a card. */
const LAST_TEXT_MAX = 120;
const flatten = (t) =>
  String(t ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LAST_TEXT_MAX);

async function recordProfile(state, did, room, ts, isTemplate, text) {
  const shard = shardOf(did);
  const bucket = await profileShard(state, shard);
  state.dirtyProfiles.add(shard);
  /* WHICH record, not merely which file. The whole saving is here: without
     this the writer knows a shard changed and has to assume all of it did. */
  state.dirtyDids ??= new Map();
  let touched = state.dirtyDids.get(shard);
  if (!touched) state.dirtyDids.set(shard, touched = new Set());
  touched.add(did);
  const p = (bucket[did] ??= { count: 0, unique: 0, templates: 0, rooms: [], first: ts, last: ts });
  p.count++;
  // `unique` is the headline figure on a card, and it deliberately excludes
  // template spam — posting the same sentence 400 times must not out-rank
  // someone who wrote 12 real ones.
  if (isTemplate) p.templates++; else p.unique++;
  if (!p.rooms.includes(room)) p.rooms.push(room);
  if (ts && ts < p.first) p.first = ts;
  if (ts && ts >= p.last) {
    p.last = ts;
    p.last_room = room;
    const f = flatten(text); if (f) p.last_text = f;
  }
}

/* ── the roster ───────────────────────────────────────────────────────────
   One read names every active room and hands over the server's OWN quality
   figures, computed upstream over the room's live window. Ranking therefore
   costs nothing extra — no message bodies are read to decide where to look.
   ─────────────────────────────────────────────────────────────────────── */
async function roster() {
  // One response describing hundreds of rooms: reliably the slowest request
  // here, and it is not on the critical path, so it gets longer.
  const data = await get(`${BASE}/rooms?format=json&limit=${ROSTER_LIMIT}`, 20000);
  const rows = Array.isArray(data.rooms) ? data.rooms : [];
  const kept = [], rejected = [];
  for (const r of rows) {
    if (!safeRoom(r?.room)) { rejected.push(String(r?.room ?? "")); continue; }
    kept.push({
      room: r.room,
      last_seq: Number(r.last_seq) || 0,
      idle: Number(r.idle_seconds) || 0,
      diversity: Number.isFinite(r.nick_diversity) ? r.nick_diversity : 0,
      silence: Number.isFinite(r.zero_response_share) ? r.zero_response_share : 1,
      bytes: Number(r.bytes) || 0,
      window: Number(r.window) || 0,
    });
  }
  if (rejected.length) console.warn(`  roster: dropped ${rejected.length} unsafe room name(s)`);
  return { rooms: kept, total: Number(data.total) || rows.length, rejected: rejected.length };
}

/**
 * Priority when the budget cannot cover everything.
 *
 *   quality = how many DIFFERENT voices, discounted by how often nobody answers
 *   recency = 6-hour half-life on idleness
 *
 * Volume deliberately does not appear here. A room where one key posts the
 * same line 10,000 times must not be allowed to starve a room where twelve
 * people are talking — volume is handled by the deadline instead, which is
 * about not losing messages rather than about which room deserves attention.
 */
function score(r) {
  const quality = Math.max(0, r.diversity) * (1 - Math.min(1, Math.max(0, r.silence)));
  const confidence = Math.min(1, (r.window || 0) / 50);
  const recency = 0.5 ** (r.idle / 21600);
  return quality * confidence * recency;
}

/* ── the schedule ─────────────────────────────────────────────────────────
   One entry per room. `rate` is messages per second, learned from this
   room's own reads and smoothed, because a single quiet 3 seconds must not
   convince the scheduler that the lobby went to sleep.
   ─────────────────────────────────────────────────────────────────────── */
function track(sched, room, opts = {}) {
  if (!safeRoom(room)) return null;
  let e = sched.get(room);
  if (!e) {
    e = {
      room,
      core: CORE.includes(room),
      rate: null,
      /* A deal room is discovered mid-run from somebody's accept, and the
         frames that decide the outcome land within minutes of it. Starting it
         at the 20-second discovery cadence is starting it too slow. */
      discoveredAt: Date.now(),
      producedAt: 0,
      interval: tclkCeiling(room, null) ?? (CORE.includes(room) ? MIN_INTERVAL_MS : NEW_ROOM_INTERVAL_MS),
      nextAt: 0,
      lastAt: 0,
      score: 0,
      reads: 0,
      lost: 0,
      // A room we have never read has no cursor, and `since=0` cannot rewind,
      // so the first read is simply "whatever is there now" — there is no
      // backfill to be had at any price.
      fresh: true,
    };
    sched.set(room, e);
  }
  if (opts.score != null) e.score = opts.score;
  if (opts.rosterAt) e.rosterAt = opts.rosterAt;
  if (opts.idle != null && opts.idle > 3600 && !e.core) {
    // Long-idle rooms start at the slow end instead of paying the discovery
    // cadence for a room that has said nothing in an hour.
    setInterval_(e, Math.max(e.interval, MAX_INTERVAL_MS / 2));
  }
  return e;
}

/**
 * Read one page of a room and fold it into the pending state.
 *
 * Returns the number of messages the ROOM PRODUCED since our cursor, which is
 * `last_seq - cursor` and is exact even when the server only handed back the
 * newest 200 of them. That number is the whole basis of the schedule.
 */
/** An accept names a contract, and a contract names a room. Anything that is
 *  not a well-formed accept is ignored in silence — this is a stranger's text
 *  and most of it will not be a frame at all. */
function noteDeal(state, m, text) {
  if (!isFrameText(text)) return;
  let f;
  try { f = readFrame(text); } catch { return; }
  if (!f?.ok) return;

  /* ── REMEMBERING OUR OWN OFFERS, SO WE RECOGNISE THE ANSWERS TO THEM ─────
     An accept says who answered. It does not say who asked. So on the BUY
     side — where the shop posts the offer and a stranger accepts it — the
     accept looks like any other stranger's frame, and the deal room holding
     our own money would have queued behind 120 of theirs.
     The offer ids we posted are kept here, and persisted with the deal list,
     because a hosted run ends every five and a half hours and the accept to
     an offer we made before the restart is exactly the one worth catching. */
  if (f.type === "offer") {
    if (m.from !== SHOP_DID) return;
    const id = f.body?.id;
    if (typeof id !== "string") return;
    const ours = (state.deals.our_offers ??= []);
    if (ours.includes(id)) return;
    ours.push(id);
    while (ours.length > OUR_OFFERS_KEPT) ours.shift();   // oldest first
    state.dealsDirty = true;
    return;
  }
  if (f.type !== "accept") return;
  const contract = f.body?.contract;
  if (typeof contract !== "string") return;
  let name;
  try { name = dealRoom(contract); } catch { return; }
  if (!DEAL_ROOM_RE.test(name)) return;
  if (state.deals.rooms[name]) return;

  /* Who ANSWERED, from the transport rather than the body — the same rule the
     page follows, for the same reason. A stranger can put our DID in a body;
     they cannot post as us. */
  const by = m.from ?? null;
  const ours = by === SHOP_DID
    || (typeof f.body?.ref === "string" && (state.deals.our_offers ?? []).includes(f.body.ref));

  /* See MAX_DEAL_ROOMS. A new room takes the oldest slot in ITS OWN class
     rather than being turned away at the door — and the two classes are
     separate lists that never compete, which is the whole point: a busy board
     cannot crowd out this shop's own settlements, and this shop cannot crowd
     out its own oldest by trading. */
  const mine = Object.entries(state.deals.rooms).filter(([, v]) => v?.ours === true);
  const theirs = Object.entries(state.deals.rooms).filter(([, v]) => v?.ours !== true);
  const pool = ours ? mine : theirs;
  const cap = ours ? MAX_OUR_DEAL_ROOMS : MAX_DEAL_ROOMS;
  /* WHILE, not IF. Evicting exactly one never converges on a list that is
     already over its cap — which is the state a lowered cap leaves behind, and
     a lowered cap during an incident is exactly when this has to work. */
  while (pool.length >= cap) {
    let oldest = null, oldestAt = null, at_i = -1;
    for (let i = 0; i < pool.length; i++) {
      const at = String(pool[i][1]?.seen ?? "");
      if (oldestAt === null || at < oldestAt) { oldest = pool[i][0]; oldestAt = at; at_i = i; }
    }
    if (oldest === null) break;                    // an empty pool cannot be over its cap
    pool.splice(at_i, 1);
    delete state.deals.rooms[oldest];
    /* Stop READING it too. Deal rooms are tracked without a `rosterAt`, so
       the schedule's "gone quiet" sweep deliberately never expires them —
       which means an evicted room would keep spending the read budget the
       cap exists to protect for the rest of the run. */
    state.sched?.delete(oldest);
    console.log(`  deal room: ${name} takes the slot of ${oldest} (seen ${oldestAt})`);
  }

  state.deals.rooms[name] = {
    contract,
    accepted_by: by,
    seen: m.ts ?? new Date().toISOString(),
    /* Recorded, not recomputed: this is what keeps a slot ours across the
       restart that reloads this file, when the accept frame is long gone. */
    ...(ours ? { ours: true } : {}),
  };
  state.dealsDirty = true;
  if (state.sched) track(state.sched, name);
  console.log(`  deal room: ${name} (${Object.keys(state.deals.rooms).length} followed)`);
}

async function readRoom(state, e) {
  const cursor = state.cursors[e.room] ?? 0;
  const startedAt = Date.now();
  const data = await get(`${BASE}/r/${e.room}?format=json&since=${cursor}&limit=${PAGE}`);
  const msgs = Array.isArray(data.messages) ? data.messages : [];
  const head = Number(data.last_seq ?? cursor) || cursor;
  const produced = cursor > 0 && head > cursor ? head - cursor : msgs.length;

  e.reads++;
  e.fresh = false;

  if (msgs.length) {
    const p = state.pending.get(e.room) ?? { days: new Map(), seen: 0, stored: 0, collapsed: 0, capped: 0, gaps: [] };
    state.pending.set(e.room, p);

    // first_seq past our cursor means messages existed that we will never
    // see. Since the server cannot rewind, that is OUR latency, not the
    // ring's — recorded as such so the archive never overstates its coverage.
    if (typeof data.first_seq === "number" && cursor > 0 && data.first_seq > cursor + 1) {
      const missed = data.first_seq - cursor - 1;
      e.lost += missed;
      /* WHICH KIND OF GAP THIS IS, AND WHY IT WAS WORTH SEPARATING.
         From inside the process a restart after hours of dead air looks
         exactly like one very slow poll, so both were recorded as "poll
         interval" — and the label was wrong about 99% of the volume. On this
         repository on 2 September, lobby lost 935,407 messages in a single
         gap noticed at the end of a 137-minute silence, against 11,544 across
         the fifty genuine poll-interval gaps put together. Reading faster
         would have saved almost none of it; being alive would have saved all
         of it, and the archive could not say so.
         A gap seen on a room's FIRST read of this process is time when this
         process did not exist. That is a different fact and it gets a
         different name. */
      const cause = e.reads === 1 ? "collector was not running" : "poll interval";
      p.gaps.push({ after: cursor, resumed_at: data.first_seq, missed, cause, noticed: new Date().toISOString() });
    }

    const tpl = state.templates.texts;
    for (const m of msgs) {
      p.seen++;
      const text = String(m.text ?? "");
      const h = hash(text);
      const t = (tpl[h] ??= { text: text.slice(0, 300), n: 0, posters: [], first: m.ts, last: m.ts, rooms: [] });
      t.n++;
      t.last = m.ts;
      if (t.rooms.length < 40 && !t.rooms.includes(e.room)) t.rooms.push(e.room);

      const who = m.from ?? "anon";
      if (t.posters.length < MAX_POSTERS && !t.posters.includes(who)) t.posters.push(who);

      if (e.room === OFFERS_ROOM) noteDeal(state, m, text);

      const isTemplate = t.n > REPEAT_LIMIT;
      // COUNTING IS NEVER CAPPED. Whatever happens to the bodies below, every
      // message the archive sees reaches the profile that a card is built on.
      if (m.from?.startsWith("did:key:")) await recordProfile(state, m.from, e.room, m.ts, isTemplate, text);

      if (isTemplate) { p.collapsed++; continue; }

      const d = day(m.ts);
      if (!p.days.has(d)) p.days.set(d, []);
      p.days.get(d).push({
        seq: m.seq,
        ts: m.ts,
        from: m.from,
        // Nonce stays a STRING, always. Technocore nonces are nanosecond
        // clocks (~1.7e18) and exceed Number.MAX_SAFE_INTEGER by ~200x. Round
        // one through a JS number and a valid signature never verifies again.
        nonce: m.nonce == null ? null : String(m.nonce),
        sig: m.sig ?? null,
        text,
      });
      p.stored++;
    }
  }

  /* ── THE CURSOR MUST NEVER STEP OVER A MESSAGE IN SILENCE ────────────────
     MEASURED on this repository, 3 September, by walking the sequence numbers
     actually stored in tclk-offers rather than trusting our own bookkeeping:
     3,984 frames stored across seq 1935..7151, with 157 holes totalling 1,233
     missing — while _meta.json admitted to 3 gaps totalling 142. Off by nine
     times, and the two largest holes (384 frames over 77 minutes, 401 over
     58) appeared nowhere in it at all.

     The cause was this line, which used to run unconditionally while every
     line that notices a gap sits inside `if (msgs.length)`. A read that comes
     back with last_seq far ahead of our cursor and an EMPTY array would move
     the cursor to the head, past messages we never fetched, and say nothing.

     An empty page with the head ahead is a RACE, not a refusal. The server
     always hands back the newest `limit` messages for any `since`, so asking
     again a moment later normally returns them. The old code threw that away
     by advancing first. So: hold the cursor and let the next scheduled read
     have them — 2.5 seconds later for the offers room. Only when the room
     keeps coming back empty is this a real hole, and then it is recorded with
     a cause of its own, because neither existing label would be true. Reading
     faster would not have helped and the collector was running the whole
     time. */
  if (!msgs.length && head > cursor) {
    e.emptyAhead = (e.emptyAhead ?? 0) + 1;
    if (e.emptyAhead < EMPTY_RETRIES) return produced;   // cursor untouched
    const missed = head - cursor;
    const p = state.pending.get(e.room) ?? { days: new Map(), seen: 0, stored: 0, collapsed: 0, capped: 0, gaps: [] };
    state.pending.set(e.room, p);
    e.lost += missed;
    p.gaps.push({ after: cursor, resumed_at: head + 1, missed,
                  cause: "server returned no messages", noticed: new Date().toISOString() });
  } else {
    e.emptyAhead = 0;
  }

  state.cursors[e.room] = head;
  (state.dirtyCursors ??= new Set()).add(e.room);

  /* When this room last had anything to say. A deal room keeps its tight
     ceiling while this is recent and falls back to the ordinary cadence once
     the deal has been over for a while. */
  if (produced > 0) e.producedAt = Date.now();

  /* Re-time. `produced` over the gap we actually waited is the room's real
     rate; smoothing keeps one quiet second from re-rating the lobby. */
  const waited = e.lastAt ? Math.max(250, startedAt - e.lastAt) : 0;
  if (waited && cursor > 0) {
    const observed = (produced / waited) * 1000;
    e.rate = e.rate == null ? observed : e.rate * 0.6 + observed * 0.4;
  }
  e.lastAt = startedAt;

  if (e.rate != null && e.rate > 0) {
    const fill = e.rate >= FAST_ROOM_RATE ? FAST_SAFE_FILL : SAFE_FILL;
    setInterval_(e, (PAGE * fill) / e.rate * 1000);
  } else if (!msgs.length) {
    // Nothing at all: back off, but never past the window, so every tracked
    // room is still read at least once per run.
    setInterval_(e, e.interval * 1.6);
  }
  // A page that came back full is the one unambiguous danger signal: we may
  // already be behind. Halve the interval regardless of what the rate says.
  if (msgs.length >= PAGE) setInterval_(e, e.interval / 2);
  e.nextAt = Date.now() + e.interval;
  return produced;
}

/* ── flushing ─────────────────────────────────────────────────────────────
   Buffered in memory and written on a slower clock than the reads. A busy
   room is now read every few seconds, and rewriting a multi-megabyte day
   shard that often would spend the whole run in the filesystem.
   ─────────────────────────────────────────────────────────────────────── */
/* Take the buffers away from the writers in ONE synchronous step, before the
   first await. Everything after this point is I/O that takes seconds, and
   reads keep arriving throughout — without the handover, a message collected
   mid-flush would be dropped on the floor when the buffer was cleared. */
function detach(state) {
  const work = [];
  for (const [room, p] of state.pending) {
    if (!p.days.size && !p.gaps.length) continue;
    work.push({ room, days: p.days, gaps: p.gaps, p });
    p.days = new Map();
    p.gaps = [];
  }
  const shards = [...state.dirtyProfiles];
  state.dirtyProfiles.clear();
  /* THE SAME HANDOVER, FOR THE SAME REASON. Reads keep arriving through the
     seconds this flush takes, and a did recorded mid-flush must belong to the
     NEXT write, not be deleted along with the set the current one is holding.
     Detaching the shard names and leaving the dids behind would lose exactly
     the updates that arrived while we were writing. */
  const dirtyDids = new Map();
  for (const shard of shards) {
    const set = state.dirtyDids.get(shard);
    if (set) { dirtyDids.set(shard, set); state.dirtyDids.delete(shard); }
  }
  const cursors = state.dirtyCursors ?? new Set();
  state.dirtyCursors = new Set();
  return { work, shards, dirtyDids, cursors };
}

async function flush(state, rows, total, standings = false) {
  const { work, shards, dirtyDids, cursors } = detach(state);

  await mkdir(path.join(OUT, "profiles"), { recursive: true });
  for (const shard of shards) await writeShard(state, shard, dirtyDids.get(shard) ?? new Set());

  for (const { room, days, gaps, p } of work) {
    const roomDir = path.join(OUT, room);
    await mkdir(roomDir, { recursive: true });
    const metaFile = path.join(roomDir, "_meta.json");
    const meta = await readJson(metaFile, { room, days: [], total: 0, gaps: [] });
    /* Per room, because tclk-offers is the one place a dropped body is a lost
       deal rather than a lost sentence. See bodyCapFor. */
    const cap = bodyCapFor(room);

    /* ── APPEND, NEVER REBUILD ────────────────────────────────────────────
       This used to read the whole day shard, push the new messages in, SORT
       THE WHOLE ARRAY and write it back as one line of JSON. Correct, and
       ruinous: a re-sorted single-line file shares almost no byte runs with
       its previous version, so git could not delta it and stored a fresh
       three-megabyte blob every five minutes. MEASURED: .git reached 2.0 GB
       in about fourteen hours, and fetches began timing out.

       One message per line, appended in the order they arrived, and the file
       is still written whole via rename so `git add` can never catch a torn
       line. The content is now strictly previous + new, which is the one
       shape delta compression is good at.                                  */
    for (const [d, recs] of days) {
      const file = path.join(roomDir, `${d}.ndjson`);
      const key = `${room}|${d}`;
      let sh = state.shards.get(key);
      if (!sh) {
        sh = { text: "", seqs: new Set(), n: 0 };
        if (existsSync(file)) {
          sh.text = await readFile(file, "utf8");
          for (const line of sh.text.split("\n")) {
            if (!line) continue;
            try { sh.seqs.add(JSON.parse(line).seq); sh.n++; } catch { /* torn line: skip */ }
          }
        }
        state.shards.set(key, sh);
      }

      let add = "", capped = 0;
      for (const r of recs) {
        if (sh.seqs.has(r.seq)) continue;
        /* ── THE TAIL IS FED HERE, BEFORE THE CAP, DELIBERATELY ────────────
           The first version of the tail was built from `sh.text`, which is
           the same string the cap stops appending to. So the moment a room
           filled up, the tail froze at the identical line the shard did —
           while still rewriting `tail.json.updated` every pass, which made a
           frozen file look current. The reviewer demonstrated ~19 hours of
           every 24 in that state at this room's measured rate.
           A window whose whole purpose is "the newest frames, when nothing
           else has them" must not be downstream of the thing that stops
           recording newest frames. It is fed from the arriving records and
           bounded by its own rules, so a capped shard cannot silence it. */
        if (room === OFFERS_ROOM) pushTail(state, r);
        if (sh.n >= cap) { capped++; continue; }
        sh.seqs.add(r.seq); sh.n++;
        add += JSON.stringify(r) + "\n";
      }
      p.capped += capped;
      if (add) {
        sh.text += add;
        await writeAtomic(file, sh.text);
      }
      if (capped) {
        meta.body_cap = cap;
        meta.bodies_dropped = (meta.bodies_dropped ?? 0) + capped;
        meta.cap_note = "Past body_cap, messages are counted in profiles and templates but their text is not stored.";
      }
      if (!meta.days.includes(d)) meta.days.push(d);
    }

    meta.days.sort();
    // The DELTA since the last flush. `p.stored` is cumulative for the whole
    // run now that flushes happen every 45 seconds instead of once, and
    // adding it every time inflated this by a factor of the flush count.
    meta.total = (meta.total ?? 0)
      + (p.stored - (p.storedFlushed ?? 0))
      - (p.capped - (p.cappedFlushed ?? 0));   // kept, not merely eligible
    p.storedFlushed = p.stored;
    p.cappedFlushed = p.capped;
    meta.cursor = state.cursors[room];
    meta.updated = new Date().toISOString();
    if (gaps.length) meta.gaps = [...(meta.gaps ?? []), ...gaps].slice(-MAX_GAPS_KEPT);
    await writeAtomic(metaFile, JSON.stringify(meta) + "\n");
  }

  await writeTail(state);

  await writeCursors(state, cursors);

  /* The index of deal rooms is itself worth publishing: it is the only list
     anywhere of where tclk settlements are happening, and it is what lets the
     next run pick up the deals this one was following. */
  /* ── see writeTail() for the file that closes the five-minute hole ─────── */
  if (state.dealsDirty) {
    state.deals.updated = new Date().toISOString();
    await writeAtomic(path.join(OUT, "tclk-deals.json"), JSON.stringify(state.deals, null, 1) + "\n");
    state.dealsDirty = false;
  }

  // The strip on the homepage and this run's own coverage report are cheap
  // and wanted often.
  await writeRecent(state);

  if (rows?.length) {
    const snapshot = rows
      .filter((r) => Number.isFinite(r.last_seq))
      .map((r) => ({ room: r.room, last_seq: r.last_seq, idle: r.idle, diversity: r.diversity, silence: r.silence, score: Number(score(r).toFixed(4)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, ROSTER_SNAPSHOT);
    await writeAtomic(path.join(OUT, "roster.json"),
      JSON.stringify({ updated: new Date().toISOString(), listed: rows.length, network_total: total, shown: snapshot.length, rooms: snapshot }) + "\n");
  }

  /* ── the slow clock ───────────────────────────────────────────────────────
     Everything below is big enough for a SYNCHRONOUS serialise to be felt,
     and the event loop being blocked is the event loop not reading rooms.
     None of it is read between commits, so it runs every fourth minute
     instead of every forty-five seconds. */
  let pruned = 0;
  if (standings) {
    pruned = pruneTemplates(state.templates);
    state.templates.updated = new Date().toISOString();
    await writeAtomic(path.join(OUT, "templates.json"), JSON.stringify(state.templates) + "\n");

    const top = Object.values(state.templates.texts)
      .filter((t) => t.n > REPEAT_LIMIT)
      .sort((a, b) => b.n - a.n)
      .slice(0, 500)
      .map((t) => ({ text: t.text, count: t.n, identities: t.posters.length, rooms: t.rooms, first: t.first, last: t.last }));
    await writeAtomic(path.join(OUT, "spam.json"), JSON.stringify({
      updated: new Date().toISOString(),
      note: `Texts posted more than ${REPEAT_LIMIT} times. Copies past that are counted, not stored. At most ${MAX_POSTERS} distinct posters are recorded per text, so "identities" saturates there.`,
      templates: top,
    }, null, 1) + "\n");

    try { await writeStandings(); }
    catch (err) { console.error(`  standings failed (${err.message}) — cards fall back to the previous file`); }

    if (state.sched) {
      try { await syncOwners(state, state.sched); }
      catch (err) { console.error(`  owners sweep failed (${err.message}) — the previous book stands`); }
    }
  }

  if (state.sched) await writeReport(state, rows, total);
  return pruned;
}

function pruneTemplates(templates) {
  const keys = Object.keys(templates.texts);
  // Trim arrays that grew under the older, larger caps. Without this the file
  // never shrinks back down, whatever the caps say from now on.
  for (const k of keys) {
    const t = templates.texts[k];
    if (t.posters && t.posters.length > MAX_POSTERS) t.posters.length = MAX_POSTERS;
    if (t.rooms && t.rooms.length > 12) t.rooms.length = 12;
    if (typeof t.text === "string" && t.text.length > 300) t.text = t.text.slice(0, 300);
  }
  if (keys.length <= MAX_TEMPLATES) return 0;
  const sorted = keys.sort((a, b) => templates.texts[b].n - templates.texts[a].n);
  for (const k of sorted.slice(MAX_TEMPLATES)) delete templates.texts[k];
  return keys.length - MAX_TEMPLATES;
}

/** The homepage's "seen recently" strip. Carries the words and the room,
 *  because a row of truncated keys with a number beside it is
 *  indistinguishable from placeholder data — which is what it was mistaken
 *  for. */
async function writeRecent(state) {
  const fresh = [];
  for (const [, bucket] of state.profiles) {
    for (const [did, p] of Object.entries(bucket)) {
      fresh.push({
        did,
        unique: p.unique,
        count: p.count,
        rooms: p.rooms.length,
        last: p.last,
        room: p.last_room ?? p.rooms[p.rooms.length - 1] ?? null,
        text: p.last_text ?? null,
      });
    }
  }
  fresh.sort((a, b) => (a.last < b.last ? 1 : -1));
  const merged = [...fresh, ...(state.recent.dids ?? [])];
  const dedup = new Set();
  const recent = merged.filter((r) => !dedup.has(r.did) && dedup.add(r.did)).slice(0, 60);
  state.recent = { dids: recent };
  await writeAtomic(path.join(OUT, "recent.json"),
    JSON.stringify({ updated: new Date().toISOString(), dids: recent }) + "\n");
}

/* ── standings ────────────────────────────────────────────────────────────
   ONE small file describing the whole population, so a card can say where an
   identity stands without downloading 52,000 profiles.

   WHY DISTRIBUTIONS AND NOT PRECOMPUTED RANKS

   A rank stored on a profile would be wrong within minutes and would have to
   be rewritten into all 256 profile shards every time — megabytes of git
   churn for numbers nobody asked for. Distributions invert that: this one
   file changes, the cards compute their own rank from it, and the arithmetic
   is exact rather than interpolated.

   Three of them, each answering one question a card wants to ask:

     unique   how many identities wrote MORE original messages than you
     rooms    how many were seen in more rooms
     join     how many were already here before you

   `join` is hourly because that is the finest resolution that is honest. An
   identity's own first-seen timestamp is known to the microsecond, but two
   identities inside the same hour cannot be ordered from a histogram — so the
   card is only ever told "N arrived in an earlier hour" and "N arrived after
   your hour ended", both of which are counts, not estimates.

   Read from disk rather than from `state.profiles`, and deliberately NOT on
   every flush: it walks every shard, and the reads now come every few
   seconds where they used to come every five minutes.

   THAT WALK IS 4,096 FILES NOW rather than 256 — the shards were widened to
   stop the repository growing seven gigabytes a day. The same bytes are read
   either way; what is added is per-file overhead, about a second on a runner,
   and it is paid only on the passes that ask for standings rather than on
   every flush. That is the trade this gate already exists to make.
   ─────────────────────────────────────────────────────────────────────── */
const ACTIVE_MIN = 5;   // below this, "100% original" only means "posted once"

async function writeStandings() {
  const dir = path.join(OUT, "profiles");
  if (!existsSync(dir)) return null;

  const uniq = new Map(), rooms = new Map(), hours = new Map();
  let identities = 0, active = 0, activePerfect = 0, activeHigh = 0, activeLow = 0;

  /* RECURSIVE, because the shards are nested now. A flat readdir here would
     have returned 256 DIRECTORY names, matched none of them against .json,
     and quietly computed the standings of nobody — every figure on the card
     page zero, with no error anywhere. */
  /* BOTH LAYOUTS AT ONCE, AND NEITHER COUNTED TWICE. A shard migrates the
     first time anybody in it speaks, so for a few passes the directory holds
     logs and whole files side by side. A shard that has both — which is only
     possible if a rewrite landed and the delete after it did not — must be
     counted once, and the log is the newer of the two. */
  const names = await readdir(dir, { recursive: true });
  const logs = new Set(names.filter((f) => f.endsWith(".ndjson")).map((f) => f.slice(0, -7)));
  const wanted = names.filter((f) =>
    f.endsWith(".ndjson") || (f.endsWith(".json") && !logs.has(f.slice(0, -5))));

  for (const file of wanted) {
    const bucket = file.endsWith(".ndjson")
      ? foldLog(await readText(path.join(dir, file))).bucket
      : await readJson(path.join(dir, file), {});
    for (const p of Object.values(bucket)) {
      identities++;
      const u = p.unique ?? 0, r = (p.rooms ?? []).length, c = p.count ?? 0;
      uniq.set(u, (uniq.get(u) ?? 0) + 1);
      rooms.set(r, (rooms.get(r) ?? 0) + 1);
      const h = String(p.first ?? "").slice(0, 13);      // YYYY-MM-DDTHH
      if (h.length === 13) hours.set(h, (hours.get(h) ?? 0) + 1);
      if (c >= ACTIVE_MIN) {
        active++;
        if (u === c) activePerfect++;
        if (u / c >= 0.7) activeHigh++;      // includes the perfect ones
        else if (u / c < 0.2) activeLow++;
      }
    }
  }

  // Cumulative, so a card subtracts two numbers instead of summing a list.
  const join = [...hours.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let run = 0;
  const joinCumulative = join.map(([h, n]) => { run += n; return [h, run]; });

  const desc = (m) => [...m.entries()].sort((a, b) => b[0] - a[0]);

  const body = {
    updated: new Date().toISOString(),
    identities,
    active_min: ACTIVE_MIN,
    active,
    active_perfect: activePerfect,
    active_high: activeHigh,
    active_low: activeLow,
    note: "unique/rooms are [value, identities-with-that-value], highest first. join is [hour, identities first seen at or before the end of that hour].",
    unique: desc(uniq),
    rooms: desc(rooms),
    join: joinCumulative,
  };
  await writeAtomic(path.join(OUT, "standings.json"), JSON.stringify(body) + "\n");
  console.log(`  standings: ${identities} identities, ${active} active, ${joinCumulative.length} join hours`);
  return body;
}

/* ── the coverage report ──────────────────────────────────────────────────
   The number that matters is not how many messages were stored, it is what
   FRACTION of what happened was seen. `missed` is exact — it comes from the
   server's own sequence numbers — so this can be stated rather than
   estimated, and a run that falls behind says so in the file it writes.
   ─────────────────────────────────────────────────────────────────────── */
async function writeReport(state, rows, total) {
  const sched = state.sched ?? new Map();
  const followed = [...sched.values()].filter((e) => e.reads > 0);
  const missed = followed.reduce((a, e) => a + e.lost, 0);
  const behind = followed
    .filter((e) => e.lost > 0)
    .sort((a, b) => b.lost - a.lost)
    .slice(0, 10)
    .map((e) => ({ room: e.room, missed: e.lost, rate: Number((e.rate ?? 0).toFixed(2)), interval_ms: Math.round(e.interval) }));

  let seen = 0, stored = 0, collapsed = 0, capped = 0;
  for (const p of state.pending.values()) { seen += p.seen; stored += p.stored; collapsed += p.collapsed; capped += p.capped; }

  const produced = state.produced ?? 0;
  const coverage = produced > 0 ? (produced - missed) / produced : 1;
  const body = {
    updated: new Date().toISOString(),
    base: BASE,
    repeat_limit: REPEAT_LIMIT,
    body_cap_per_room_per_day: DAY_BODY_MAX,
    body_cap_tclk_offers: TCLK_BODY_MAX,
    network_rooms: total,
    roster_listed: rows?.length ?? 0,
    rooms_tracked: Object.keys(state.cursors).length,
    last_run: {
      seconds: Math.round((Date.now() - (state.startedAt ?? Date.now())) / 1000),
      rooms_read: followed.length,
      reads,
      rate_limited: rateLimited,
      produced,           // messages the network produced in the rooms we follow
      missed,             // messages that existed and we were too slow to see
      coverage: Number(coverage.toFixed(4)),
      seen, stored, collapsed, bodies_dropped: capped,
    },
    // Named, not summarised. A room this run could not keep up with is the one
    // place the archive is still thin, and hiding it would put us back where
    // we started.
    behind,
  };
  await writeAtomic(path.join(OUT, "index.json"), JSON.stringify(body, null, 1) + "\n");
  return body;
}

/* ── who owns what ────────────────────────────────────────────────────────
   THE ONLY PERMANENT, EARNED, UNFORGEABLE FACT ON THIS NETWORK

   A d- room is claimed by a SIGNED write to /kv/room-owners/d-<room> with
   if_absent=1. Three properties follow, and no other per-identity fact here
   has all three:

     permanent    the KV namespace has no ring; messages are gone in minutes
     unforgeable  the stored value is the key that signed it
     first-come   if_absent means no later signature can overwrite it

   So this is what a card can rank on without the number drifting. A claim
   made today reads the same in a year, which is exactly what an
   archive-derived rank cannot promise.

   CHEAP BY CONSTRUCTION: a claim cannot change, so a room whose owner is
   already known is never read again. Only rooms never checked cost anything,
   which after the first sweep is just newly-created ones.
   ──────────────────────────────────────────────────────────────────────── */
const OWNER_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
/* Technocore prepends its own untrusted-content banner to KV reads, so a
   stored did:key never matches a strict test against the whole body. Every
   claimed room on the network read as unowned because of it. */
const unwrapKv = (t) => typeof t === "string"
  ? t.replace(/^\s*!!\s*UNTRUSTED CONTENT[\s\S]*?\n\s*\n/i, "").trim()
  : t;
const OWNERS_PER_PASS = Number(process.env.OWNERS_PER_PASS ?? 60);

async function syncOwners(state, sched) {
  const file = path.join(OUT, "owners.json");
  const book = await readJson(file, { updated: null, rooms: {}, unclaimed: [] });
  book.rooms ??= {}; book.unclaimed ??= [];

  const known = new Set([...Object.keys(book.rooms), ...book.unclaimed]);
  const candidates = new Set();
  for (const room of Object.keys(state.cursors)) if (room.startsWith("d-")) candidates.add(room);
  for (const e of sched.values()) if (e.room.startsWith("d-")) candidates.add(e.room);

  // Unclaimed rooms are re-checked occasionally — a name that was free last
  // week can have been taken since — but a CLAIMED one never is.
  const todo = [...candidates].filter((r) => !book.rooms[r] && safeRoom(r));
  const fresh = todo.filter((r) => !known.has(r));
  const stale = todo.filter((r) => known.has(r));
  const queue = [...fresh, ...stale].slice(0, OWNERS_PER_PASS);

  let checked = 0, found = 0;
  for (const room of queue) {
    if (!takeToken()) break;
    try {
      const val = unwrapKv(await getText(`${BASE}/kv/room-owners/${room}`));
      checked++;
      if (val && OWNER_RE.test(val)) {
        book.rooms[room] = val; found++;
        const i = book.unclaimed.indexOf(room); if (i >= 0) book.unclaimed.splice(i, 1);
      } else if (!known.has(room)) {
        book.unclaimed.push(room);
      }
    } catch { /* one unreadable room must not lose the sweep */ }
  }

  // did -> rooms, so a card is one lookup rather than a scan.
  const owners = {};
  for (const [room, did] of Object.entries(book.rooms)) (owners[did] ??= []).push(room);
  for (const list of Object.values(owners)) list.sort();

  book.updated = new Date().toISOString();
  book.owner_count = Object.keys(owners).length;
  book.claimed = Object.keys(book.rooms).length;
  book.seen = candidates.size;
  book.owners = owners;
  book.note = "Claims are signed writes to /kv/room-owners with if_absent=1: permanent, unforgeable, first-come. A room already claimed is never re-read.";
  await writeAtomic(file, JSON.stringify(book) + "\n");
  if (checked) console.log(`  owners: checked ${checked} d- room(s), ${found} claimed; ${book.claimed} of ${candidates.size} known, ${book.owner_count} distinct owners`);
  return book;
}

/* ── the scheduler ────────────────────────────────────────────────────────
   Whichever room is closest to overflowing a page goes next. `risk` is that
   in one number: how much of a page has probably accumulated since we last
   looked. Above 1.0 we are already losing messages, so it dominates
   everything else; below it, the tie-breaks are being overdue, being a core
   room, and never having been read at all.
   ─────────────────────────────────────────────────────────────────────── */
function pick(sched, now, minRisk = 0) {
  let best = null, bestKey = -Infinity;
  for (const e of sched.values()) {
    if (e.busy || e.nextAt > now) continue;
    const risk = e.rate && e.lastAt ? ((now - e.lastAt) / 1000) * e.rate / PAGE : 0;
    // When lanes are scarce they are held for the rooms that actually lose
    // data by waiting. A quiet room read a minute late loses nothing; the
    // lobby read twelve seconds late loses two hundred messages.
    if (minRisk && risk < minRisk) continue;
    const overdue = (now - e.nextAt) / Math.max(1000, e.interval);
    const key = risk * 10 + overdue + (e.core ? 0.5 : 0) + (e.fresh ? 0.25 : 0);
    if (key > bestKey) { bestKey = key; best = e; }
  }
  return best;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const state = await loadState();
  /* Before anything reads a profile. See migrateShards for why doing this
     lazily, or later, or not at all, would silently empty the archive's
     largest dataset rather than failing. */
  await migrateShards(state);
  const sched = new Map();
  console.log(`Archiving from ${BASE} — ${Math.round(RUN_MS / 1000)}s window, ${READS_PER_MIN} reads/min, ${CONCURRENCY} at a time`);

  let rows = [], total = 0, rosterFails = 0;

  async function refreshRoster() {
    if (!takeToken()) return;
    try {
      const r = await roster();
      rows = r.rooms; total = r.total;
      const at = Date.now();
      for (const row of rows) track(sched, row.room, { score: score(row), idle: row.idle, rosterAt: at });
      // A 5.5-hour run sees the roster ~165 times, and every listing brings a
      // few rooms that were briefly busy. Without this the schedule only ever
      // grows, and by hour three the long tail is eating the budget the hot
      // rooms need. Three missed listings is the cutoff; CORE never expires.
      let dropped = 0;
      for (const [name, e] of sched) {
        if (e.core || !e.rosterAt) continue;
        if (at - e.rosterAt > 3 * ROSTER_MS) { sched.delete(name); dropped++; }
      }
      console.log(`  roster: ${rows.length} listed of ${total} rooms; following ${sched.size}${dropped ? `, dropped ${dropped} gone quiet` : ""}`);
    } catch (err) {
      rosterFails++;
      console.error(`  roster failed (${err.message}) — continuing with the ${sched.size} rooms already followed`);
    }
  }

  // CORE first so they exist even if the roster never answers. Rooms from
  // previous runs are deliberately NOT all re-tracked: cursors.json holds
  // ~8,000 of them, and reading every one inside a five-minute window would
  // cost more than the whole read allowance to learn that they are quiet.
  // The roster is the live answer to "which rooms are worth following".
  for (const name of CORE) track(sched, name);
  /* Deals found by earlier runs. Unlike the ~8,000 rooms in cursors.json these
     are few, unlisted, and the only place their settlements exist. */
  for (const name of Object.keys(state.deals?.rooms ?? {})) track(sched, name);
  await refreshRoster();

  const started = Date.now();
  state.startedAt = started;
  state.sched = sched;
  state.produced = 0;
  const deadline = started + RUN_MS;
  /* ── WHY THIS IS TEN MINUTES AND NOT FOUR ────────────────────────────────
     writeStandings re-reads every shard on disk, and MEASURED on the real
     archive that is 2,758,760 identities and 815 MB of JSON.parse: 11.2
     seconds when the profiles were 256 files, 19.5 now that they are 65,536.
     The bytes are identical; the extra eight seconds are 65,280 more file
     opens, which is the price of the shard width and worth paying.

     What is NOT worth paying is nineteen seconds of blocked event loop every
     four minutes — eight per cent of a run spent recomputing a histogram
     that decides where a card sits in a ranking. Ten minutes is the same
     number to any reader and a third of the cost.

     The real fix is to stop re-reading shards that have not changed and keep
     a running aggregate instead; that is an arithmetic refactor of the
     standings themselves and does not belong in a commit about shard width.
     The end-of-run flush still passes `true`, so the published figures are
     always computed from a complete final read. */
  const STANDINGS_MS = Math.max(FLUSH_MS, 600_000);
  let lastFlush = started, lastStandings = 0, lastRoster = started;
  const inflight = new Set();
  let flushing = null, rostering = null;

  while (Date.now() < deadline) {
    const now = Date.now();

    /* Neither of these is awaited. A flush walks every day shard and, every
       fourth minute, all 256 profile shards — seconds of filesystem work
       during which the old code issued NO READS AT ALL. At 21 messages a
       second the lobby fills a page in under ten, so the flush was quietly
       buying itself a guaranteed miss. The buffers are handed over
       synchronously inside flush(), so collection continues underneath it. */
    if (now - lastRoster > ROSTER_MS && !rostering) {
      lastRoster = now;
      rostering = refreshRoster().finally(() => { rostering = null; });
    }

    if (now - lastFlush > FLUSH_MS && !flushing) {
      lastFlush = now;
      const standings = now - lastStandings > STANDINGS_MS;
      if (standings) lastStandings = now;
      flushing = flush(state, rows, total, standings)
        .catch((err) => console.error(`  flush failed (${err.message})`))
        .finally(() => { flushing = null; });
    }

    if (inflight.size >= CONCURRENCY) { await Promise.race(inflight); continue; }

    // The last two lanes are reserved for rooms genuinely close to losing
    // messages, so a burst of slow cold-room reads cannot lock the busy ones
    // out of the scheduler.
    const scarce = inflight.size >= CONCURRENCY - 2;
    const e = pick(sched, now, scarce ? 0.15 : 0);
    if (!e) { await sleep(scarce ? 60 : 120); continue; }
    if (!takeToken()) { await sleep(150); continue; }

    e.busy = true;
    e.nextAt = now + e.interval;          // reserved before the await, so a
                                          // slow read cannot be picked twice
    const p = readRoom(state, e)
      .then((n) => { state.produced += n; })
      .catch((err) => {
        console.error(`  ${e.room}: ${err.message}`);
        setInterval_(e, e.interval * 2);
        e.nextAt = Date.now() + e.interval;
      })
      .finally(() => { e.busy = false; inflight.delete(p); });
    inflight.add(p);
  }

  await Promise.allSettled([...inflight, flushing, rostering].filter(Boolean));
  const pruned = await flush(state, rows, total, true);

  /* The report is written on every flush, not just at the end, so the
     workflow's per-pass log line describes THIS run as it stands rather than
     the previous one. */
  const rep = await writeReport(state, rows, total);

  const r = rep.last_run;
  console.log(
    `done — ${r.rooms_read} room(s), ${r.reads} reads, produced ${r.produced}, missed ${r.missed} ` +
    `(coverage ${(r.coverage * 100).toFixed(2)}%), stored ${r.stored}, collapsed ${r.collapsed}` +
    `${r.bodies_dropped ? `, ${r.bodies_dropped} bodies past the cap` : ""}${pruned ? `, pruned ${pruned} templates` : ""}`
  );
  if (rep.behind.length) {
    // Never silent. A run that could not keep up and said nothing looks
    // exactly like a run that saw everything.
    console.warn(`  BEHIND: ${rep.behind.map((b) => `${b.room} -${b.missed}`).join(", ")}`);
  }

  /* ── the cold-start snapshots ─────────────────────────────────────────────
     Agent City draws itself from these BEFORE it asks Technocore anything,
     which is the whole reason an upstream 503 no longer empties the page.
     They are derived from the archive this run just wrote, so they are
     rebuilt here rather than by hand: a snapshot that only refreshes when
     somebody remembers to refresh it ages, quietly, into a false claim about
     what the network looks like — and the page attaches its age to every
     label, so a stale one is visible to visitors as well as wrong.

     Best-effort, both of them. A failure here must never fail an archive
     run. The archive is the record; the snapshots are a convenience derived
     from it. Yesterday's snapshot beside today's archive is a normal state
     that the page states honestly. A lost archive pass is not recoverable. */
  const { execFileSync } = await import("node:child_process");
  for (const s of ["make-city-snapshot.mjs", "make-room-snapshots.mjs"]) {
    try {
      const out = execFileSync(process.execPath, [fileURLToPath(new URL(s, import.meta.url))],
        { encoding: "utf8", timeout: 180000 });
      process.stdout.write("  " + out);
    } catch (err) {
      console.warn(`  snapshot ${s} did not rebuild (${String(err.message).split("\n")[0]}) — the previous one stands`);
    }
  }
}

/* ONLY WHEN THIS FILE IS THE PROGRAM. A few pieces of this module are now
   imported by tests — the shard rule and the one-time migration, which are
   exactly the parts where being wrong is silent — and a bare `main()` would
   have every one of those imports start a five-hour archive run against the
   live network. `process.argv[1]` is the script node was asked to run. */
/* ── SAYING WHY, WHERE IT CAN BE READ AFTERWARDS ──────────────────────────
   This process is started with `&` and nothing waits on its output; the
   workflow watches only whether it is still alive. So when it dies early the
   stack trace goes into a run log that needs admin rights on the repository
   to download, and from outside all anybody can see is a window that ended
   sooner than it should have. That has happened twice this week and been
   guessed at both times.

   A `::error` line on stdout becomes a GitHub annotation, and annotations are
   on the public API. One line, because a multi-line annotation is truncated
   at the first newline — so the stack goes to stderr as before, for whoever
   can read it, and the first line goes somewhere everyone can. */
const shout = (what, err) => {
  const msg = String(err?.stack ?? err ?? "").split("\n")[0].slice(0, 300);
  console.log(`::error title=archive::the collector stopped early — ${what}: ${msg}`);
  console.error(err);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  /* Node's default for both of these is to print to stderr and exit, which is
     precisely the invisible death described above. These do the same thing
     and say so first. */
  process.on("unhandledRejection", (err) => { shout("an unhandled rejection", err); process.exit(1); });
  process.on("uncaughtException", (err) => { shout("an uncaught exception", err); process.exit(1); });
  main().catch((err) => { shout("it threw", err); process.exit(1); });
}

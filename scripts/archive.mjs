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

import { readFile, writeFile, rename, mkdir, readdir } from "node:fs/promises";
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
async function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

const shardOf = (did) => createHash("sha256").update(did, "utf8").digest("hex").slice(0, 2);

async function loadState() {
  return {
    cursors: await readJson(path.join(OUT, "cursors.json"), {}),
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
    deals: await readJson(path.join(OUT, "tclk-deals.json"), { updated: null, rooms: {} }),
  };
}

async function profileShard(state, shard) {
  if (!state.profiles.has(shard)) {
    state.profiles.set(shard, await readJson(path.join(OUT, "profiles", `${shard}.json`), {}));
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
  if (!f?.ok || f.type !== "accept") return;
  const contract = f.body?.contract;
  if (typeof contract !== "string") return;
  let name;
  try { name = dealRoom(contract); } catch { return; }
  if (!DEAL_ROOM_RE.test(name)) return;
  if (state.deals.rooms[name]) return;
  if (Object.keys(state.deals.rooms).length >= MAX_DEAL_ROOMS) return;
  state.deals.rooms[name] = {
    contract,
    /* Who ANSWERED, from the transport rather than the body — the same rule
       the page follows, for the same reason. */
    accepted_by: m.from ?? null,
    seen: m.ts ?? new Date().toISOString(),
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
  return { work, shards };
}

async function flush(state, rows, total, standings = false) {
  const { work, shards } = detach(state);

  await mkdir(path.join(OUT, "profiles"), { recursive: true });
  for (const shard of shards) {
    // One identity per line. Still valid JSON, but a single identity's
    // update now changes one short line instead of shuffling a 100 KB
    // single-line object — which is the difference between git storing a
    // small delta and storing the file again.
    const bucket = state.profiles.get(shard);
    const body = Object.keys(bucket).sort()
      .map((did) => ` ${JSON.stringify(did)}:${JSON.stringify(bucket[did])}`)
      .join(",\n");
    await writeAtomic(path.join(OUT, "profiles", `${shard}.json`), `{\n${body}\n}\n`);
  }

  for (const { room, days, gaps, p } of work) {
    const roomDir = path.join(OUT, room);
    await mkdir(roomDir, { recursive: true });
    const metaFile = path.join(roomDir, "_meta.json");
    const meta = await readJson(metaFile, { room, days: [], total: 0, gaps: [] });

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
        if (sh.n >= DAY_BODY_MAX) { capped++; continue; }
        sh.seqs.add(r.seq); sh.n++;
        add += JSON.stringify(r) + "\n";
      }
      p.capped += capped;
      if (add) {
        sh.text += add;
        await writeAtomic(file, sh.text);
      }
      if (capped) {
        meta.body_cap = DAY_BODY_MAX;
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

  await writeAtomic(path.join(OUT, "cursors.json"), JSON.stringify(state.cursors) + "\n");

  /* The index of deal rooms is itself worth publishing: it is the only list
     anywhere of where tclk settlements are happening, and it is what lets the
     next run pick up the deals this one was following. */
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
   every flush: it walks all 256 shards, and the reads now come every few
   seconds where they used to come every five minutes.
   ─────────────────────────────────────────────────────────────────────── */
const ACTIVE_MIN = 5;   // below this, "100% original" only means "posted once"

async function writeStandings() {
  const dir = path.join(OUT, "profiles");
  if (!existsSync(dir)) return null;

  const uniq = new Map(), rooms = new Map(), hours = new Map();
  let identities = 0, active = 0, activePerfect = 0, activeHigh = 0, activeLow = 0;

  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".json"))) {
    const bucket = await readJson(path.join(dir, file), {});
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
  const STANDINGS_MS = Math.max(FLUSH_MS, 240_000);
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

main().catch((err) => { console.error(err); process.exit(1); });

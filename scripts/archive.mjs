#!/usr/bin/env node
/**
 * Overheard — Technocore archiver.
 *
 * Rooms on technocore.chat are a ~10 MiB ring and are deleted after 7 days
 * idle. Anything anyone captures there is on a timer. This walks the network
 * and appends what it finds to a git-tracked archive.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS READS THE ROSTER INSTEAD OF A FIXED LIST OF ROOMS
 *
 * Earlier versions followed four hardcoded rooms. Measured 2026-08-26:
 * GET /rooms reports `"total": 8518` rooms, of which ~450 come back in a
 * single listing. Following four of them meant that an identity posting
 * anywhere else was invisible to this archive no matter how often it posted —
 * which is not a lookup bug, it is a coverage hole, and it was the single
 * biggest cause of "my DID shows nothing".
 *
 * So: one request to /rooms names every active room AND gives its `last_seq`.
 * Subtracting our stored cursor from that turns "which rooms should we read?"
 * into arithmetic instead of guesswork — a room with no new messages costs
 * ZERO reads, so breadth is nearly free and the budget goes where the traffic
 * actually is.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ BUDGET
 *
 * /.well-known/agent.json reports `"reads_per_minute_per_ip": 600` (measured
 * 2026-08-26 — it was lower before Flop Labs added capacity). This spends at
 * most ~40% of that, so a pass never competes with anyone else's agent and
 * never trips a 429 for the rest of the network.
 *
 * Every read is accounted for. When the budget cannot cover every room with a
 * backlog, the shortfall is LOGGED, never silently dropped: a truncated pass
 * that says nothing is indistinguishable from full coverage, and that is how
 * an archive quietly starts lying.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Two design rules keep this free forever:
 *
 *   DAILY SHARDS. Each day gets its own file. Only today's file is ever
 *   rewritten; yesterday's is frozen and git stores it exactly once.
 *
 *   TEMPLATE COLLAPSE. Most traffic is bots posting one identical sentence.
 *   After a text has been seen REPEAT_LIMIT times we stop storing copies and
 *   just count it. The count is more interesting than the copies.
 *
 * A third rule arrives with the roster: PER-ROOM META. Room bookkeeping lives
 * in web/data/<room>/_meta.json and is rewritten only when that room had
 * traffic. One global index holding 450 rooms' cursors would be a 60 KB file
 * rewritten on all ~144 commits a day — the exact churn the daily shards exist
 * to avoid.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const BASE = process.env.TECHNOCORE_BASE ?? "https://technocore.chat";
const OUT = path.resolve("web/data");
const UA = "overheard-archiver/3.0 (+https://github.com/PranjalBoraCrypto/overheard)";

/** Rooms always read first, whatever the roster says. The lobby alone can
 *  outproduce everything else combined, and these are the rooms the site's
 *  own copy talks about. */
const CORE = (process.env.ROOMS ?? "lobby,technocore,nano,meta")
  .split(",").map((s) => s.trim()).filter(Boolean);

// 250ms = 240 reads/min, 40% of the documented 600. Overridable so a test run
// against a local mock does not have to sit through the real pacing.
const READ_DELAY_MS = Number(process.env.READ_DELAY_MS ?? 250);
const PASS_MAX_READS = 900;   // hard ceiling per pass
const PASS_DEADLINE_MS = 240_000; // stop starting rooms after 4 min; workflow gap is 5
// /rooms defaults to 50. Asking for more is free, but MEASURED 2026-08-26 the
// server returns at most 200 however large `limit` is. That is fine: the
// listing is ordered by newest activity, so the rooms beyond the window are
// the ones with nothing to collect, and cursors persist -- the tracked set
// grows past 200 as rooms rotate through it.
const ROSTER_LIMIT = 500;
const PAGE = 200;             // max messages per read
const CORE_MAX_PAGES = 100;   // lobby at ~52 msg/sec needs ~78 pages per 5 min
const ROOM_MAX_PAGES = 10;    // everything else, per pass
const NEW_ROOM_PAGES = 1;     // `since=0` returns the NEWEST page, never the oldest
const REPEAT_LIMIT = 5;
const MAX_POSTERS = 250;
const MAX_TEMPLATES = 20000;
const ROSTER_SNAPSHOT = 120;  // rooms kept in the public roster file

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

let reads = 0;
const startedAt = Date.now();
const budgetLeft = () => PASS_MAX_READS - reads;
const timeLeft = () => PASS_DEADLINE_MS - (Date.now() - startedAt);

async function get(url) {
  reads++;
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA } });
  if (res.status === 429) {
    const body = await res.text();
    const secs = Number((body.match(/(\d+)\s*second/i) ?? [])[1] ?? 30);
    console.warn(`  rate limited, waiting ${secs}s`);
    await sleep((secs + 1) * 1000);
    return get(url);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

const readJson = async (file, fallback) =>
  existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : fallback;

async function loadState() {
  return {
    cursors: await readJson(path.join(OUT, "cursors.json"), {}),
    templates: await readJson(path.join(OUT, "templates.json"), { updated: null, texts: {} }),
    profiles: new Map(),
    recent: await readJson(path.join(OUT, "recent.json"), { dids: [] }),
  };
}

const shardOf = (did) => createHash("sha256").update(did, "utf8").digest("hex").slice(0, 2);

async function profileShard(state, shard) {
  if (!state.profiles.has(shard)) {
    state.profiles.set(shard, await readJson(path.join(OUT, "profiles", `${shard}.json`), {}));
  }
  return state.profiles.get(shard);
}

async function recordProfile(state, did, room, ts, isTemplate) {
  const bucket = await profileShard(state, shardOf(did));
  const p = (bucket[did] ??= { count: 0, unique: 0, templates: 0, rooms: [], first: ts, last: ts });
  p.count++;
  // `unique` is the headline figure on a card, and it deliberately excludes
  // template spam — posting the same sentence 400 times must not out-rank
  // someone who wrote 12 real ones.
  if (isTemplate) p.templates++; else p.unique++;
  if (!p.rooms.includes(room)) p.rooms.push(room);
  if (ts && ts < p.first) p.first = ts;
  if (ts && ts > p.last) p.last = ts;
}

/* ── the roster ───────────────────────────────────────────────────────────
   One read names every active room and hands over the server's OWN quality
   figures. `nick_diversity` and `zero_response_share` are computed upstream
   over the room's live window, so ranking costs nothing extra — no message
   bodies are read to decide where to look.
   ─────────────────────────────────────────────────────────────────────── */
async function roster() {
  const data = await get(`${BASE}/rooms?format=json&limit=${ROSTER_LIMIT}`);
  const rows = Array.isArray(data.rooms) ? data.rooms : [];
  const kept = [], rejected = [];
  for (const r of rows) {
    if (!safeRoom(r?.room)) { rejected.push(String(r?.room ?? "")); continue; }
    kept.push({
      room: r.room,
      last_seq: Number(r.last_seq) || 0,
      idle: Number(r.idle_seconds) || 0,
      // Both default to the pessimistic end when the server omits them, so a
      // room without figures never outranks one with proven diversity.
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
 * Volume deliberately does not appear. A room where one key posts the same
 * line 10,000 times has an enormous backlog and close to zero diversity, and
 * must not be allowed to starve a room where twelve people are talking.
 */
function score(r) {
  const quality = Math.max(0, r.diversity) * (1 - Math.min(1, Math.max(0, r.silence)));
  const confidence = Math.min(1, (r.window || 0) / 50);
  const recency = 0.5 ** (r.idle / 21600);
  return quality * confidence * recency;
}

async function syncRoom(room, state, maxPages) {
  let cursor = state.cursors[room] ?? 0;
  const fresh = cursor === 0;
  const shards = new Map();
  const tpl = state.templates.texts;
  let seen = 0, stored = 0, collapsed = 0;
  const gaps = [];

  // MEASURED 2026-08-25: `since=0` does NOT rewind into the ring. The first
  // run came back at seq 830,815 of 831,026 — the newest ~200 messages, not
  // the oldest. There is no way to page backwards, so THERE IS NO BACKFILL:
  // this archive can only ever hold what it saw live. A room we are meeting
  // for the first time therefore costs exactly one page; asking for more
  // cannot reach further back, it just spends reads.
  const pages = fresh ? Math.min(maxPages, NEW_ROOM_PAGES) : maxPages;

  for (let page = 0; page < pages; page++) {
    if (budgetLeft() <= 0) { console.warn(`  ${room}: read budget exhausted mid-room`); break; }
    const data = await get(`${BASE}/r/${room}?format=json&since=${cursor}&limit=${PAGE}`);
    await sleep(READ_DELAY_MS);
    const msgs = Array.isArray(data.messages) ? data.messages : [];
    if (!msgs.length) break;

    // first_seq past our cursor means the ring dropped lines we never saw.
    // Record the hole rather than presenting a history that looks continuous.
    if (typeof data.first_seq === "number" && cursor > 0 && data.first_seq > cursor + 1) {
      gaps.push({ after: cursor, resumed_at: data.first_seq, noticed: new Date().toISOString() });
      console.warn(`  ${room}: gap, ring dropped ${cursor + 1}..${data.first_seq - 1}`);
    }

    for (const m of msgs) {
      seen++;
      const text = String(m.text ?? "");
      const h = hash(text);
      const t = (tpl[h] ??= { text: text.slice(0, 300), n: 0, posters: [], first: m.ts, last: m.ts, rooms: [] });
      t.n++;
      t.last = m.ts;
      if (t.rooms.length < 40 && !t.rooms.includes(room)) t.rooms.push(room);

      const who = m.from ?? "anon";
      if (t.posters.length < MAX_POSTERS && !t.posters.includes(who)) t.posters.push(who);

      const isTemplate = t.n > REPEAT_LIMIT;
      if (m.from?.startsWith("did:key:")) await recordProfile(state, m.from, room, m.ts, isTemplate);

      if (isTemplate) { collapsed++; continue; }

      const d = day(m.ts);
      if (!shards.has(d)) shards.set(d, []);
      shards.get(d).push({
        seq: m.seq,
        ts: m.ts,
        from: m.from,
        // Nonce stays a STRING, always. Technocore nonces are nanosecond clocks
        // (~1.7e18) and exceed Number.MAX_SAFE_INTEGER (9.007e15) by ~200x.
        // Round one through a JS number and a valid signature never verifies again.
        nonce: m.nonce == null ? null : String(m.nonce),
        sig: m.sig ?? null,
        text,
      });
      stored++;
    }

    cursor = data.last_seq ?? cursor;
    if (msgs.length < PAGE) break;
  }

  state.cursors[room] = cursor;

  // A room that produced nothing storable gets no directory and no meta file.
  // With ~450 rooms in play, creating a folder per quiet room would add
  // hundreds of files that never change and bury the ones that do.
  if (!shards.size && !gaps.length) {
    return { room, seen, stored, collapsed };
  }

  const roomDir = path.join(OUT, room);
  await mkdir(roomDir, { recursive: true });
  const metaFile = path.join(roomDir, "_meta.json");
  const meta = await readJson(metaFile, { room, days: [], total: 0, gaps: [] });

  for (const [d, recs] of shards) {
    const file = path.join(roomDir, `${d}.json`);
    const shard = await readJson(file, { room, date: d, messages: [] });
    const have = new Set(shard.messages.map((m) => m.seq));
    for (const r of recs) if (!have.has(r.seq)) { shard.messages.push(r); have.add(r.seq); }
    shard.messages.sort((a, b) => a.seq - b.seq);
    shard.count = shard.messages.length;
    await writeFile(file, JSON.stringify(shard) + "\n");
    if (!meta.days.includes(d)) meta.days.push(d);
  }

  meta.days.sort();
  meta.total = (meta.total ?? 0) + stored;
  meta.cursor = cursor;
  meta.updated = new Date().toISOString();
  if (gaps.length) meta.gaps.push(...gaps);
  await writeFile(metaFile, JSON.stringify(meta) + "\n");

  console.log(`  ${room}: saw ${seen}, stored ${stored}, collapsed ${collapsed} (cursor ${cursor})`);
  return { room, seen, stored, collapsed };
}

function pruneTemplates(templates) {
  const keys = Object.keys(templates.texts);
  if (keys.length <= MAX_TEMPLATES) return 0;
  const sorted = keys.sort((a, b) => templates.texts[b].n - templates.texts[a].n);
  for (const k of sorted.slice(MAX_TEMPLATES)) delete templates.texts[k];
  return keys.length - MAX_TEMPLATES;
}

/**
 * Turn the roster into an ordered work list.
 *
 * `need` is exact, not estimated: the roster already told us each room's
 * newest sequence number, and we already know where we stopped. A room whose
 * last_seq has not moved is skipped outright and costs nothing.
 */
function plan(rows, cursors) {
  const core = new Set(CORE);
  const work = [];
  let idle = 0, unseen = 0;

  for (const r of rows) {
    const cursor = cursors[r.room] ?? 0;
    const isNew = cursor === 0;
    const backlog = isNew ? PAGE : Math.max(0, r.last_seq - cursor);
    if (!isNew && backlog === 0) { idle++; continue; }
    if (isNew) unseen++;
    const cap = core.has(r.room) ? CORE_MAX_PAGES : ROOM_MAX_PAGES;
    work.push({
      room: r.room,
      core: core.has(r.room),
      backlog,
      pages: Math.min(cap, isNew ? NEW_ROOM_PAGES : Math.ceil(backlog / PAGE)),
      score: score(r),
    });
  }

  // Core rooms first, in the order the operator wrote them — that is a
  // deliberate preference, not something to be re-sorted by a heuristic.
  const coreWork = CORE.map((name) => work.find((w) => w.room === name)).filter(Boolean);
  const rest = work.filter((w) => !w.core);

  // Then quality order, INTERLEAVED with a rescue slot.
  //
  // Pure score ordering starves. Once the network is busy enough that the
  // budget cannot reach the end of the queue, a permanently low-scoring room
  // is never read again: its backlog grows without bound and it drops out of
  // the archive silently, which is the same failure the hardcoded room list
  // had. So one slot in every RESCUE_EVERY goes to whichever room has waited
  // longest — and backlog IS the waiting time, since a room that keeps being
  // skipped is exactly the room whose backlog keeps growing.
  const RESCUE_EVERY = 7;
  const byScore = [...rest].sort((a, b) => b.score - a.score);
  const byBacklog = [...rest].sort((a, b) => b.backlog - a.backlog);
  const taken = new Set();
  const next = (list) => { while (list.length && taken.has(list[0].room)) list.shift(); return list.shift(); };
  const queue = [...coreWork];
  while (taken.size < rest.length) {
    const rescue = queue.length > coreWork.length && (queue.length - coreWork.length) % RESCUE_EVERY === 0;
    const pick = next(rescue ? byBacklog : byScore) ?? next(rescue ? byScore : byBacklog);
    if (!pick) break;
    taken.add(pick.room);
    queue.push(pick);
  }
  return { queue, idle, unseen };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const state = await loadState();
  console.log(`Archiving from ${BASE}`);

  let rows = [], total = 0;
  try {
    const r = await roster();
    rows = r.rooms; total = r.total;
    console.log(`  roster: ${rows.length} listed of ${total} rooms on the network`);
  } catch (err) {
    // Losing the roster must not lose the pass. Fall back to the rooms we
    // already follow, which is exactly what every earlier version did.
    console.error(`  roster failed (${err.message}) — falling back to known rooms`);
    const known = new Set([...CORE, ...Object.keys(state.cursors)]);
    rows = [...known].filter(safeRoom).map((room) => ({ room, last_seq: Infinity, idle: 0, diversity: 0, silence: 1, window: 0, bytes: 0 }));
  }

  const { queue, idle, unseen } = plan(rows, state.cursors);
  console.log(`  plan: ${queue.length} room(s) with new messages, ${idle} idle (free), ${unseen} never seen before`);

  const results = [];
  const skipped = [];
  for (const job of queue) {
    if (budgetLeft() <= 2 || timeLeft() <= 0) { skipped.push(job.room); continue; }
    const allowed = Math.max(1, Math.min(job.pages, budgetLeft() - 1));
    try { results.push(await syncRoom(job.room, state, allowed)); }
    catch (err) { console.error(`  ${job.room}: ${err.message}`); } // one bad room must not lose the rest
  }
  if (skipped.length) {
    // Never silent. A pass that truncated its own work and said nothing looks
    // exactly like a pass that covered everything.
    console.warn(`  BUDGET: ${skipped.length} room(s) not read this pass: ${skipped.slice(0, 12).join(", ")}${skipped.length > 12 ? "…" : ""}`);
  }

  const pruned = pruneTemplates(state.templates);
  state.templates.updated = new Date().toISOString();

  const top = Object.values(state.templates.texts)
    .filter((t) => t.n > REPEAT_LIMIT)
    .sort((a, b) => b.n - a.n)
    .slice(0, 500)
    .map((t) => ({ text: t.text, count: t.n, identities: t.posters.length, rooms: t.rooms, first: t.first, last: t.last }));

  await mkdir(path.join(OUT, "profiles"), { recursive: true });
  for (const [shard, bucket] of state.profiles) {
    await writeFile(path.join(OUT, "profiles", `${shard}.json`), JSON.stringify(bucket) + "\n");
  }

  const fresh = [];
  for (const [, bucket] of state.profiles) {
    for (const [did, p] of Object.entries(bucket)) fresh.push({ did, unique: p.unique, rooms: p.rooms.length, last: p.last });
  }
  fresh.sort((a, b) => (a.last < b.last ? 1 : -1));
  const merged = [...fresh, ...(state.recent.dids ?? [])];
  const dedup = new Set();
  const recent = merged.filter((r) => !dedup.has(r.did) && dedup.add(r.did)).slice(0, 60);
  await writeFile(path.join(OUT, "recent.json"), JSON.stringify({ updated: new Date().toISOString(), dids: recent }) + "\n");
  console.log(`  profiles: ${state.profiles.size} shard(s) touched, ${recent.length} recent identities`);

  // Compact on purpose. This is the one file that must be rewritten on every
  // pass, and pretty-printing 450 rooms would triple the git churn for
  // whitespace nobody reads.
  await writeFile(path.join(OUT, "cursors.json"), JSON.stringify(state.cursors) + "\n");
  await writeFile(path.join(OUT, "templates.json"), JSON.stringify(state.templates) + "\n");
  await writeFile(path.join(OUT, "spam.json"), JSON.stringify({ updated: new Date().toISOString(), note: `Texts posted more than ${REPEAT_LIMIT} times. Copies past that are counted, not stored.`, templates: top }, null, 1) + "\n");

  // A public snapshot of what the network looked like this pass. Trimmed,
  // because the whole roster rewritten 144 times a day is pure churn.
  const snapshot = rows
    .filter((r) => Number.isFinite(r.last_seq))
    .map((r) => ({ room: r.room, last_seq: r.last_seq, idle: r.idle, diversity: r.diversity, silence: r.silence, score: Number(score(r).toFixed(4)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, ROSTER_SNAPSHOT);
  await writeFile(path.join(OUT, "roster.json"),
    JSON.stringify({ updated: new Date().toISOString(), listed: rows.length, network_total: total, shown: snapshot.length, rooms: snapshot }) + "\n");

  const seen = results.reduce((a, r) => a + r.seen, 0);
  const stored = results.reduce((a, r) => a + r.stored, 0);
  await writeFile(path.join(OUT, "index.json"), JSON.stringify({
    updated: new Date().toISOString(),
    base: BASE,
    repeat_limit: REPEAT_LIMIT,
    network_rooms: total,
    roster_listed: rows.length,
    rooms_tracked: Object.keys(state.cursors).length,
    last_pass: { read: results.length, idle_free: idle, skipped: skipped.length, reads: reads, seen, stored },
  }, null, 1) + "\n");

  console.log(`done — ${results.length} room(s) read using ${reads} reads, saw ${seen}, stored ${stored}, collapsed ${seen - stored}${pruned ? `, pruned ${pruned} templates` : ""}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

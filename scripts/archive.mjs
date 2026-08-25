#!/usr/bin/env node
/**
 * Overheard — Technocore archiver.
 *
 * Rooms on technocore.chat are a ~10 MiB ring and are deleted after 7 days
 * idle. Anything anyone captures there is on a timer. This walks the rooms we
 * follow and appends what it finds to a git-tracked archive.
 *
 * Two design rules keep this free forever:
 *
 *   DAILY SHARDS. Each day gets its own file. Only today's file is ever
 *   rewritten; yesterday's is frozen and git stores it exactly once. Writing
 *   one growing file instead would make git store a fresh copy on all ~144
 *   commits a day, and repo history cannot be trimmed later without rewriting
 *   everything.
 *
 *   TEMPLATE COLLAPSE. Most traffic is bots posting one identical sentence
 *   (200 in a row from 111 identities has been measured). After a text has
 *   been seen REPEAT_LIMIT times we stop storing copies and just count it.
 *   The count is more interesting than the copies, and it is what takes this
 *   from ~58 GB/year to comfortably under 1 GB/year.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const BASE = process.env.TECHNOCORE_BASE ?? "https://technocore.chat";
const OUT = path.resolve("web/data");
const UA = "overheard-archiver/2.0 (+https://github.com/OWNER/overheard)";
const ROOMS = (process.env.ROOMS ?? "lobby,technocore,nano,meta").split(",").map((s) => s.trim());

const READ_DELAY_MS = 700;   // technocore allows 120 reads/min/IP; we use a trickle
const PAGE = 200;            // max limit the API accepts
const REPEAT_LIMIT = 5;      // copies kept before a text is treated as a template
const MAX_POSTERS = 250;     // cap the poster list on a template record
const MAX_TEMPLATES = 20000; // cap the template table itself

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (ts) => String(ts ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10);
const hash = (t) => createHash("sha256").update(t, "utf8").digest("hex").slice(0, 12);

async function get(url) {
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

/** Persisted state: per-room cursor, and the global text-repeat table. */
async function loadState() {
  return {
    cursors: await readJson(path.join(OUT, "cursors.json"), {}),
    templates: await readJson(path.join(OUT, "templates.json"), { updated: null, texts: {} }),
    index: await readJson(path.join(OUT, "index.json"), { rooms: {} }),
    profiles: new Map(),   // shard -> {did: stats}, loaded lazily as DIDs appear
    recent: await readJson(path.join(OUT, "recent.json"), { dids: [] }),
  };
}

/**
 * Per-identity stats, sharded by fingerprint so a lookup is one small fetch
 * rather than downloading every identity on the network.
 */
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

async function syncRoom(room, state) {
  let cursor = state.cursors[room] ?? 0;
  const shards = new Map();   // date -> array of records to append
  const tpl = state.templates.texts;
  let seen = 0, stored = 0, collapsed = 0;
  const gaps = [];

  // The FIRST run is a backfill, not a tick. Rooms hold ~10 MiB of history
  // right now, and every message in there is real, dated and signed — so the
  // opening pass drains the whole ring rather than sampling the tail. That is
  // what lets an identity that has been posting for weeks get its true
  // "joined" date on day one instead of starting the clock at deployment.
  const firstRun = cursor === 0;
  const maxPages = firstRun ? 400 : 25;
  if (firstRun) console.log(`  ${room}: first run — backfilling the full ring`);

  for (let page = 0; page < maxPages; page++) {
    const data = await get(`${BASE}/r/${room}?format=json&since=${cursor}&limit=${PAGE}`);
    await sleep(READ_DELAY_MS);
    const msgs = Array.isArray(data.messages) ? data.messages : [];
    if (!msgs.length) break;

    // first_seq past our cursor means the ring dropped lines we never saw.
    // Record the hole rather than presenting a history that looks continuous.
    if (typeof data.first_seq === "number" && cursor > 0 && data.first_seq > cursor + 1) {
      gaps.push({ after: cursor, resumed_at: data.first_seq, noticed: new Date().toISOString() });
      console.warn(`  gap: ring dropped ${cursor + 1}..${data.first_seq - 1}`);
    }

    for (const m of msgs) {
      seen++;
      const text = String(m.text ?? "");
      const h = hash(text);
      const t = (tpl[h] ??= { text: text.slice(0, 300), n: 0, posters: [], first: m.ts, last: m.ts, rooms: [] });
      t.n++;
      t.last = m.ts;
      if (!t.rooms.includes(room)) t.rooms.push(room);

      const who = m.from ?? "anon";
      if (t.posters.length < MAX_POSTERS && !t.posters.includes(who)) t.posters.push(who);

      const isTemplate = t.n > REPEAT_LIMIT;
      if (m.from?.startsWith("did:key:")) await recordProfile(state, m.from, room, m.ts, isTemplate);

      // Past the limit this text is a template. Count it, store no more copies.
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

  // Merge each day's new records into that day's shard. Only touched days are
  // rewritten, so every earlier day stays byte-identical in git.
  const roomDir = path.join(OUT, room);
  await mkdir(roomDir, { recursive: true });
  const entry = (state.index.rooms[room] ??= { days: [], total: 0, gaps: [] });

  for (const [d, recs] of shards) {
    const file = path.join(roomDir, `${d}.json`);
    const shard = await readJson(file, { room, date: d, messages: [] });
    const have = new Set(shard.messages.map((m) => m.seq));
    for (const r of recs) if (!have.has(r.seq)) { shard.messages.push(r); have.add(r.seq); }
    shard.messages.sort((a, b) => a.seq - b.seq);
    shard.count = shard.messages.length;
    await writeFile(file, JSON.stringify(shard) + "\n");
    if (!entry.days.includes(d)) entry.days.push(d);
  }

  entry.days.sort();
  entry.total = (entry.total ?? 0) + stored;
  entry.cursor = cursor;
  if (gaps.length) entry.gaps.push(...gaps);
  state.cursors[room] = cursor;

  console.log(`  ${room}: saw ${seen}, stored ${stored}, collapsed ${collapsed} (cursor ${cursor})`);
  return { room, seen, stored, collapsed };
}

/** Keep the template table bounded — drop the rarest once it gets too big. */
function pruneTemplates(templates) {
  const keys = Object.keys(templates.texts);
  if (keys.length <= MAX_TEMPLATES) return 0;
  const sorted = keys.sort((a, b) => templates.texts[b].n - templates.texts[a].n);
  for (const k of sorted.slice(MAX_TEMPLATES)) delete templates.texts[k];
  return keys.length - MAX_TEMPLATES;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const state = await loadState();
  console.log(`Archiving from ${BASE}`);

  const results = [];
  for (const room of ROOMS) {
    try { results.push(await syncRoom(room, state)); }
    catch (err) { console.error(`  ${room}: ${err.message}`); } // one bad room must not lose the rest
  }

  const pruned = pruneTemplates(state.templates);
  state.templates.updated = new Date().toISOString();

  // The spam table is a finding in its own right, not just a space saving.
  const top = Object.values(state.templates.texts)
    .filter((t) => t.n > REPEAT_LIMIT)
    .sort((a, b) => b.n - a.n)
    .slice(0, 500)
    .map((t) => ({ text: t.text, count: t.n, identities: t.posters.length, rooms: t.rooms, first: t.first, last: t.last }));

  // Write back only the profile shards this run actually touched.
  await mkdir(path.join(OUT, "profiles"), { recursive: true });
  for (const [shard, bucket] of state.profiles) {
    await writeFile(path.join(OUT, "profiles", `${shard}.json`), JSON.stringify(bucket) + "\n");
  }

  // A small "recently seen" list gives the site something to show a visitor
  // who has no DID of their own yet.
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

  await writeFile(path.join(OUT, "cursors.json"), JSON.stringify(state.cursors) + "\n");
  await writeFile(path.join(OUT, "templates.json"), JSON.stringify(state.templates) + "\n");
  await writeFile(path.join(OUT, "spam.json"), JSON.stringify({ updated: new Date().toISOString(), note: `Texts posted more than ${REPEAT_LIMIT} times. Copies past that are counted, not stored.`, templates: top }, null, 1) + "\n");

  state.index.updated = new Date().toISOString();
  state.index.base = BASE;
  state.index.repeat_limit = REPEAT_LIMIT;
  await writeFile(path.join(OUT, "index.json"), JSON.stringify(state.index, null, 1) + "\n");

  const seen = results.reduce((a, r) => a + r.seen, 0);
  const stored = results.reduce((a, r) => a + r.stored, 0);
  console.log(`done — saw ${seen}, stored ${stored}, collapsed ${seen - stored}${pruned ? `, pruned ${pruned} templates` : ""}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

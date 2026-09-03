/**
 * The cursor must never step over a message without saying so.
 *
 * MEASURED on the live archive, 3 September, by walking the sequence numbers
 * actually stored in web/data/tclk-offers/2026-09-03.ndjson rather than
 * trusting the archive's own bookkeeping:
 *
 *   stored 3,984 frames spanning seq 1935..7151
 *   157 holes in that sequence, totalling 1,233 missing frames
 *   _meta.json admits to 3 gaps totalling 142
 *
 * The archive under-reports its own loss by a factor of nine, and the two
 * largest holes — 384 frames across 77 minutes, 401 across 58 — are not
 * mentioned anywhere in it.
 *
 * WHY. readRoom() ends with an unconditional
 *
 *     state.cursors[e.room] = head;
 *
 * while every line that notices a gap lives inside `if (msgs.length)`. So a
 * read that comes back with last_seq far ahead of our cursor and an EMPTY
 * message array moves the cursor to the head, past messages we never fetched
 * and can now never ask for again, and records nothing. The loss is invisible
 * in _meta, invisible in the coverage number, and invisible on the site,
 * which is the worst property a gap can have — the whole product claim is
 * that the holes are marked.
 *
 * What follows is that read, and nothing else.
 */
import { spawn } from "node:child_process";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

/* ── the server ────────────────────────────────────────────────────────────
 * Read 1  hands over seq 1..50 normally, so the archiver ends with cursor 50.
 * Read 2+ report last_seq 500 and NO messages. Those 450 frames exist on the
 * server and we are simply not being handed them.
 *
 * This is not invented: an empty page with a head far ahead is what the real
 * server returns when a read lands mid-write, and it is the only shape that
 * explains a 401-frame hole with no gap recorded next to it.
 */
let reads = 0;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const j = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (u.pathname === "/rooms") return j({ rooms: [], total: 0 });
  if (!/^\/r\//.test(u.pathname)) { res.writeHead(404); return res.end(""); }
  const room = decodeURIComponent(u.pathname.slice(3));
  if (room !== "quiet-room") return j({ room, messages: [], first_seq: 0, last_seq: 0 });
  reads++;
  if (reads === 1) {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      seq: i + 1, ts: new Date(Date.now() + i).toISOString(), from: "did:key:zA", text: "m" + (i + 1), sig: "s",
    }));
    return j({ room, messages, first_seq: 1, last_seq: 50 });
  }
  return j({ room, messages: [], first_seq: 0, last_seq: 500 });
}).listen(9253);

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "skip-"));
await new Promise((done) => {
  const p = spawn(process.execPath, [path.join(ROOT, "scripts/archive.mjs")], {
    env: { ...process.env, OUT_DIR: OUT, TECHNOCORE_BASE: "http://localhost:9253",
           ROOMS: "quiet-room", RUN_SECONDS: "12", FLUSH_SECONDS: "4", ROSTER_SECONDS: "600" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let o = ""; p.stdout.on("data", (d) => o += d); p.stderr.on("data", (d) => o += d);
  p.on("close", () => { globalThis.__log = o; done(); });
  setTimeout(() => p.kill("SIGTERM"), 40000);
});

const meta = JSON.parse(fs.readFileSync(path.join(OUT, "quiet-room", "_meta.json"), "utf8"));
const cursors = JSON.parse(fs.readFileSync(path.join(OUT, "cursors.json"), "utf8"));
const admitted = (meta.gaps ?? []).reduce((s, g) => s + (g.missed || 0), 0);

console.log("\n=== the cursor, and what it admits to");
console.log(`  stored ${meta.total} frames; cursor now ${cursors["quiet-room"]}; gaps ${JSON.stringify(meta.gaps ?? [])}`);

ok("it stored the 50 frames it was actually handed", meta.total === 50, meta.total + " stored");

/* The cursor moving to 500 is not itself wrong — the server cannot rewind, so
   once it says the head is 500 there is no way back and pretending otherwise
   would only re-lose the same frames every read. What is wrong is moving
   there in silence. */
ok("the cursor followed the head past 450 frames it never fetched",
  cursors["quiet-room"] === 500, "cursor " + cursors["quiet-room"]);

ok("SO THOSE 450 FRAMES MUST BE RECORDED AS MISSING",
  admitted === 450, `_meta admits ${admitted}`);

ok("and the gap must name the cursor it stepped over",
  (meta.gaps ?? []).some((g) => g.after === 50 && g.resumed_at === 501),
  JSON.stringify(meta.gaps ?? []));

/* A gap needs a cause the site can explain to a buyer. "poll interval" would
   be a lie — reading faster would not have helped, the page came back empty. */
ok("with a cause that is not one of the two existing lies",
  (meta.gaps ?? []).every((g) => g.missed !== 450 || (g.cause !== "poll interval" && g.cause !== "collector was not running")),
  (meta.gaps ?? []).map((g) => g.cause).join(", ") || "none");

ok("no crash", !/UnhandledPromiseRejection|TypeError|ReferenceError/.test(globalThis.__log || ""),
  ((globalThis.__log || "").split("\n").find((l) => /Error/.test(l)) || "clean").slice(0, 80));

fs.rmSync(OUT, { recursive: true, force: true });
srv.close();

/* ── B. the half that saves data rather than merely admitting to losing it ──
 * Recording a gap honestly is the floor. The point of holding the cursor is
 * that the frames are usually still there: the server hands back the newest
 * `limit` messages for ANY `since`, so an empty page is a moment of bad luck
 * and the next read gets them. The old code advanced the cursor first and
 * turned that bad luck into permanent loss.
 *
 * So: one empty page with the head ahead, then the room answers normally. The
 * frames must ALL arrive and there must be no gap at all — nothing was lost,
 * so nothing should be claimed.
 */
let reads2 = 0;
const HEAD = 120;
const srv2 = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const j = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (u.pathname === "/rooms") return j({ rooms: [], total: 0 });
  if (!/^\/r\//.test(u.pathname)) { res.writeHead(404); return res.end(""); }
  const room = decodeURIComponent(u.pathname.slice(3));
  if (room !== "flaky-room") return j({ room, messages: [], first_seq: 0, last_seq: 0 });
  reads2++;
  const since = Number(u.searchParams.get("since") ?? 0);
  // the unlucky read: the head is real, the page is empty
  if (reads2 === 2) return j({ room, messages: [], first_seq: 0, last_seq: HEAD });
  const messages = [];
  for (let i = since + 1; i <= HEAD; i++)
    messages.push({ seq: i, ts: new Date(Date.now() + i).toISOString(), from: "did:key:zA", text: "m" + i, sig: "s" });
  return j({ room, messages, first_seq: messages.length ? messages[0].seq : 0, last_seq: HEAD });
}).listen(9254);

const OUT2 = fs.mkdtempSync(path.join(os.tmpdir(), "flaky-"));
await new Promise((done) => {
  const p = spawn(process.execPath, [path.join(ROOT, "scripts/archive.mjs")], {
    env: { ...process.env, OUT_DIR: OUT2, TECHNOCORE_BASE: "http://localhost:9254",
           ROOMS: "flaky-room", RUN_SECONDS: "12", FLUSH_SECONDS: "4", ROSTER_SECONDS: "600" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let o = ""; p.stdout.on("data", (d) => o += d); p.stderr.on("data", (d) => o += d);
  p.on("close", () => { globalThis.__log2 = o; done(); });
  setTimeout(() => p.kill("SIGTERM"), 40000);
});

const meta2 = JSON.parse(fs.readFileSync(path.join(OUT2, "flaky-room", "_meta.json"), "utf8"));
const lost2 = (meta2.gaps ?? []).reduce((s, g) => s + (g.missed || 0), 0);
const rows = fs.readFileSync(path.join(OUT2, "flaky-room", meta2.days[0] + ".ndjson"), "utf8")
  .trim().split("\n").filter(Boolean).map(JSON.parse).sort((a, b) => a.seq - b.seq);
let holes = 0;
for (let i = 1; i < rows.length; i++) if (rows[i].seq - rows[i - 1].seq > 1) holes++;

console.log("\n=== B. an empty page that was only bad luck");
console.log(`  stored ${meta2.total} of ${HEAD}; gaps ${JSON.stringify(meta2.gaps ?? [])}`);
ok("every frame arrived despite the empty read", meta2.total === HEAD, `${meta2.total} of ${HEAD}`);
ok("the stored sequence has no holes", holes === 0, holes + " holes");
ok("and NOTHING was claimed as lost, because nothing was",
  lost2 === 0 && (meta2.gaps ?? []).length === 0, JSON.stringify(meta2.gaps ?? []));
ok("no crash", !/UnhandledPromiseRejection|TypeError|ReferenceError/.test(globalThis.__log2 || ""),
  ((globalThis.__log2 || "").split("\n").find((l) => /Error/.test(l)) || "clean").slice(0, 80));

fs.rmSync(OUT2, { recursive: true, force: true });
srv2.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

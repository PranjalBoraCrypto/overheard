/* The archiver following a deal off the public board and into its own room.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. A tclk deal leaves tclk-offers the
 * moment somebody accepts it. The offer and the accept stay on the board; the
 * lock, the reveal and the refund — the only frames that say whether the deal
 * actually worked — happen in mb-p-tclk-<16 hex>, derived from the contract
 * id. Those rooms are world-readable and UNLISTED, so the roster never names
 * one and nothing else on the network is recording them. They are a ring
 * buffer like everything else here, so every settlement so far is already
 * gone.
 *
 * The room name is derived from a frame a stranger wrote, which is the whole
 * reason this file exists: the tests that matter are the ones where the
 * stranger is hostile or wrong.
 */
import { spawn } from "node:child_process";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import { canon, dealRoom } from "../web/tclk.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

const A = "did:key:z6MkPayerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "did:key:z6MkPayeeBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const frame = (o) => "tclk1 " + canon(o);
const CID = (n) => "0x" + String(n).padStart(4, "0") + "ab".repeat(30);

/* One real accept, and then every shape of thing that is not one. */
const GOOD = CID(1);
const MESSAGES = [
  { seq: 1, ts: "2026-09-02T20:00:01Z", from: A, text: "just talking, not a frame" },
  { seq: 2, ts: "2026-09-02T20:00:02Z", from: B, text: frame({
      type: "accept", from: B, ref: "0x" + "1".repeat(64), statement: "0x" + "7c".repeat(32),
      nonce: "0000000000000001", contract: GOOD }) },
  /* An offer is not an accept: no room exists until somebody answers. */
  { seq: 3, ts: "2026-09-02T20:00:03Z", from: A, text: frame({
      type: "offer", from: A, id: "0x" + "2".repeat(64), amount: "1", asset: "FLOP",
      lock: "hash", rails: ["paper"], role: "payer", nonce: "aaaaaaaaaaaaaaaa",
      expiresMs: 1, claimByMs: 2, refundAfterMs: 3 }) },
  { seq: 4, ts: "2026-09-02T20:00:04Z", from: A, text: "tclk1 {this will not parse" },
  /* A contract that is not a contract. The name derived from it must not
     become a room the archiver goes and reads. */
  { seq: 5, ts: "2026-09-02T20:00:05Z", from: A, text: frame({
      type: "accept", from: A, ref: "0x" + "3".repeat(64), nonce: "0000000000000002",
      contract: "../../etc/passwd" }) },
  { seq: 6, ts: "2026-09-02T20:00:06Z", from: A, text: frame({
      type: "accept", from: A, ref: "0x" + "4".repeat(64), nonce: "0000000000000003",
      contract: "" }) },
  { seq: 7, ts: "2026-09-02T20:00:07Z", from: A, text: frame({
      type: "accept", from: A, ref: "0x" + "5".repeat(64), nonce: "0000000000000004" }) },
  /* The same deal, answered twice. One room, not two entries. */
  { seq: 8, ts: "2026-09-02T20:00:08Z", from: B, text: frame({
      type: "accept", from: B, ref: "0x" + "1".repeat(64), statement: "0x" + "7d".repeat(32),
      nonce: "0000000000000005", contract: GOOD }) },
];

const ROOM = dealRoom(GOOD);
const HIT = new Set();

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const j = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (u.pathname === "/rooms") return j({ rooms: [], total: 0 });
  const m = u.pathname.match(/^\/r\/(.+)$/);
  if (!m) { res.writeHead(404); return res.end(""); }
  const room = decodeURIComponent(m[1]);
  HIT.add(room);
  if (room === "tclk-offers") {
    return j({ room, messages: MESSAGES, first_seq: 1, last_seq: MESSAGES.length });
  }
  /* A room the archiver already has a cursor for, whose first_seq has run far
     ahead of it — what a restart after dead air looks like from here. */
  if (room === "gapper") {
    return j({ room, first_seq: 900, last_seq: 902, messages: [
      { seq: 900, ts: "2026-09-02T20:02:00Z", from: A, text: "one" },
      { seq: 901, ts: "2026-09-02T20:02:01Z", from: A, text: "two" },
      { seq: 902, ts: "2026-09-02T20:02:02Z", from: A, text: "three" },
    ] });
  }
  if (room === ROOM) {
    return j({ room, first_seq: 1, last_seq: 1, messages: [
      { seq: 1, ts: "2026-09-02T20:01:00Z", from: A,
        text: frame({ type: "lock", from: A, contract: GOOD, rail: "paper", ref: "r1" }) },
    ] });
  }
  return j({ room, messages: [], first_seq: 0, last_seq: 0 });
}).listen(9251);

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "arch-"));
/* A cursor left behind by an earlier run. The next read of this room is a
   resume, and everything between is time nothing was collecting. */
fs.writeFileSync(path.join(OUT, "cursors.json"), JSON.stringify({ gapper: 100 }));
await new Promise((done) => {
  const p = spawn(process.execPath, [path.join(ROOT, "scripts/archive.mjs")], {
    env: { ...process.env, OUT_DIR: OUT, TECHNOCORE_BASE: "http://localhost:9251",
           ROOMS: "tclk-offers,gapper",
           RUN_SECONDS: "8", FLUSH_SECONDS: "3", ROSTER_SECONDS: "600" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { out += d; });
  p.on("close", () => { globalThis.__log = out; done(); });
  setTimeout(() => p.kill("SIGTERM"), 25000);
});

const index = path.join(OUT, "tclk-deals.json");
const deals = fs.existsSync(index) ? JSON.parse(fs.readFileSync(index, "utf8")) : null;

console.log("\n=== A. it finds the room a deal moved into");
ok("an index of deal rooms is written", !!deals, index);
ok("and the accepted deal is in it", !!deals?.rooms?.[ROOM], Object.keys(deals?.rooms ?? {}).join(", ") || "none");
ok("with the contract it was derived from", deals?.rooms?.[ROOM]?.contract === GOOD);
ok("and who answered, taken from the transport rather than the body",
  deals?.rooms?.[ROOM]?.accepted_by === B, String(deals?.rooms?.[ROOM]?.accepted_by));

console.log("\n=== B. and then actually reads it");
ok("the deal room was fetched", HIT.has(ROOM), [...HIT].join(", "));
ok("which is the only place its lock exists",
  fs.existsSync(path.join(OUT, ROOM)), "a directory of its own");

console.log("\n=== C. what it refuses to follow");
const names = Object.keys(deals?.rooms ?? {});
ok("one entry, not two, for a deal answered twice", names.length === 1, names.join(", "));
ok("no room came from a contract that is not one",
  !names.some((n) => !/^mb-p-tclk-[0-9a-f]{16}$/.test(n)), names.join(", "));
ok("nothing that looks like a path was ever requested",
  ![...HIT].some((r) => r.includes("..") || r.includes("/")), [...HIT].join(", "));
ok("an offer did not create a room — a deal has none until it is answered",
  names.length === 1);
ok("and the unparseable frame was simply ignored", true, "no crash, no entry");

console.log("\n=== E. a gap says which kind of gap it was");
{
  const m = path.join(OUT, "gapper", "_meta.json");
  const meta = fs.existsSync(m) ? JSON.parse(fs.readFileSync(m, "utf8")) : null;
  const gaps = meta?.gaps ?? [];
  ok("the gap is recorded at all", gaps.length > 0, JSON.stringify(gaps));
  ok("with the right number missing", gaps[0]?.missed === 799, String(gaps[0]?.missed));
  /* The distinction the whole fix is about: reading faster would not have
     saved these, and calling it a poll interval said it would. */
  ok("and named as time nothing was collecting, not as a slow poll",
    gaps[0]?.cause === "collector was not running", String(gaps[0]?.cause));
}

console.log("\n=== D. the archiver still did its actual job");
ok("it recorded the offers room too", fs.existsSync(path.join(OUT, "tclk-offers")));
ok("cursors were written", fs.existsSync(path.join(OUT, "cursors.json")));
ok("it did not fall over", !/UnhandledPromiseRejection|TypeError|ReferenceError/.test(globalThis.__log || ""),
  (globalThis.__log || "").split("\n").find((l) => /Error/.test(l)) || "clean");

/* ── F. the chain, and the ways it must not misfire ──────────────────────── */
console.log("\n=== F. the workflow that asks for the next run");
{
  const wf = fs.readFileSync(path.join(ROOT, ".github/workflows/archive.yml"), "utf8");
  ok("the workflow can be dispatched, which is what the chain does",
    /workflow_dispatch/.test(wf));
  ok("the chain step runs even when the collection failed",
    /ask for the next run[\s\S]{0,200}always\(\)/.test(wf),
    "a crashed run is the one that most needs a successor");
  ok("it does nothing at all without a token, so this is safe to merge now",
    /no ARCHIVE_CHAIN_TOKEN/.test(wf) && /exit 0/.test(wf));
  ok("a run too short to be real does not ask for another",
    /ELAPSED.*-lt 300|too short to chain/.test(wf), "otherwise a fast failure is a hot loop");
  ok("the token is never printed", !/echo[^\n]*\$\{?CHAIN_TOKEN/.test(wf));
  ok("and shell tracing is never turned on in that step",
    !/^\s*set -x/m.test(wf), "set -x would put the header in the log");
  /* The schedule is asserted because it is what the file says, NOT because it
     fixes the dead air. It was put in to fix it, on the theory that GitHub
     drops several scheduled firings in a row; the run log disproved that —
     runs fire, and #86 ran 5h30m and published nothing because its push loop
     could not rebase under a working tree the collector was writing to. That
     is tested in test-archive-push.mjs, which is the file that matters here.
     Six stays for its own smaller reasons, and claims nothing. */
  const crons = [...wf.matchAll(/- cron: "([^"]+)"/g)].map((m) => m[1]);
  ok("the schedule asks at least six times an hour", crons.length >= 6, crons.join(" | "));
  ok("and they are spread across the hour rather than bunched",
    new Set(crons.map((c) => c.split(" ")[0])).size >= 6, crons.map((c) => c.split(" ")[0]).join(","));
  ok("the dormant chain step is still there, costing nothing until a token exists",
    /ARCHIVE_CHAIN_TOKEN/.test(wf));
}

srv.close();
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

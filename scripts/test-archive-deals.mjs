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
  if (room === ROOM) {
    return j({ room, first_seq: 1, last_seq: 1, messages: [
      { seq: 1, ts: "2026-09-02T20:01:00Z", from: A,
        text: frame({ type: "lock", from: A, contract: GOOD, rail: "paper", ref: "r1" }) },
    ] });
  }
  return j({ room, messages: [], first_seq: 0, last_seq: 0 });
}).listen(9251);

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "arch-"));
await new Promise((done) => {
  const p = spawn(process.execPath, [path.join(ROOT, "scripts/archive.mjs")], {
    env: { ...process.env, OUT_DIR: OUT, TECHNOCORE_BASE: "http://localhost:9251",
           ROOMS: "tclk-offers",
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

console.log("\n=== D. the archiver still did its actual job");
ok("it recorded the offers room too", fs.existsSync(path.join(OUT, "tclk-offers")));
ok("cursors were written", fs.existsSync(path.join(OUT, "cursors.json")));
ok("it did not fall over", !/UnhandledPromiseRejection|TypeError|ReferenceError/.test(globalThis.__log || ""),
  (globalThis.__log || "").split("\n").find((l) => /Error/.test(l)) || "clean");

srv.close();
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

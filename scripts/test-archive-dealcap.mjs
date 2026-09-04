/* The deal-room list, and the two ways a bound on it can lose the only
 * settlements worth keeping.
 *
 * WHAT HAPPENED, MEASURED. tclk-deals.json reached exactly 120 rooms on
 * 3 September at 03:50 and its `updated` field never moved again. `noteDeal`
 * read `>= MAX_DEAL_ROOMS` and returned. So the cap was not a budget, it was
 * a queue that closed: the first 120 contracts to appear on a busy public
 * board held every slot for ever.
 *
 * The next day a real order was placed on this shop, accepted, and paid. Its
 * deal room — the only place the lock, the delivery and the reveal exist — was
 * never followed, because 120 strangers' contracts from the day before were
 * still holding the slots. The archive whose entire product is being the only
 * record of tclk settlements was dropping this shop's own settlement.
 *
 * So: ours are never capped, and a stranger's evicts the oldest stranger
 * instead of being turned away. Both halves are tested here, and so is the
 * half that is easy to get wrong — an accept ANSWERING an offer we posted is
 * ours too, and the accept frame does not say so.
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

const SHOP = "did:key:z6MkShopSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS";
const X = "did:key:z6MkStrangerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const frame = (o) => "tclk1 " + canon(o);
const CID = (tag) => "0x" + tag.padEnd(64, "0").slice(0, 64);
const OID = (tag) => "0x" + tag.padEnd(64, "1").slice(0, 64);

/* Three strangers already hold every slot, oldest first. */
const OLD = { name: dealRoom(CID("aa1")), seen: "2026-09-03T03:00:00Z" };
const MID = { name: dealRoom(CID("aa2")), seen: "2026-09-03T04:00:00Z" };
const NEW = { name: dealRoom(CID("aa3")), seen: "2026-09-03T05:00:00Z" };

/* What arrives today. */
const C_STRANGER = CID("bb1");        // a stranger's new deal — must evict OLD
const OUR_OFFER  = OID("cc1");        // an offer we posted, answered by a stranger
const C_ANSWERED = CID("bb2");        // the room for that answer — ours
const C_WE_TOOK  = CID("bb3");        // an offer we accepted — ours

const R_STRANGER = dealRoom(C_STRANGER);
const R_ANSWERED = dealRoom(C_ANSWERED);
const R_WE_TOOK  = dealRoom(C_WE_TOOK);

const offer = (from, id) => frame({
  type: "offer", from, id, amount: "1", asset: "FLOP", lock: "hash",
  rails: ["paper"], role: "payer", nonce: "aaaaaaaaaaaaaaaa",
  expiresMs: 1, claimByMs: 2, refundAfterMs: 3,
});
const accept = (from, ref, contract, nonce) => frame({
  type: "accept", from, ref, statement: "0x" + "7c".repeat(32), nonce, contract,
});

const MESSAGES = [
  { seq: 1, ts: "2026-09-04T16:00:01Z", from: X, text: accept(X, OID("d1"), C_STRANGER, "0000000000000001") },
  { seq: 2, ts: "2026-09-04T16:00:02Z", from: SHOP, text: offer(SHOP, OUR_OFFER) },
  /* A stranger answering OUR offer. Nothing in this frame names us. */
  { seq: 3, ts: "2026-09-04T16:00:03Z", from: X, text: accept(X, OUR_OFFER, C_ANSWERED, "0000000000000002") },
  /* And the ordinary sell-side case: we answered somebody. */
  { seq: 4, ts: "2026-09-04T16:00:04Z", from: SHOP, text: accept(SHOP, OID("d2"), C_WE_TOOK, "0000000000000003") },
  /* An offer from a stranger must NOT be remembered as one of ours — that
     would make every accept on a busy board look like an answer to us, which
     is the cap-exemption handed to the whole network. */
  { seq: 5, ts: "2026-09-04T16:00:05Z", from: X, text: offer(X, OID("e9")) },
];

const HIT = new Set();
const PORT = 9257;
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
  return j({ room, messages: [], first_seq: 0, last_seq: 0 });
}).listen(PORT);

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "dealcap-"));
fs.writeFileSync(path.join(OUT, "tclk-deals.json"), JSON.stringify({
  updated: "2026-09-03T05:00:00Z",
  rooms: {
    [OLD.name]: { contract: CID("aa1"), accepted_by: X, seen: OLD.seen },
    [MID.name]: { contract: CID("aa2"), accepted_by: X, seen: MID.seen },
    [NEW.name]: { contract: CID("aa3"), accepted_by: X, seen: NEW.seen },
  },
}));

const run = (env) => new Promise((done) => {
  const p = spawn(process.execPath, [path.join(ROOT, "scripts/archive.mjs")], {
    env: {
      ...process.env, OUT_DIR: OUT, TECHNOCORE_BASE: `http://localhost:${PORT}`,
      ROOMS: "tclk-offers", RUN_SECONDS: "6", FLUSH_SECONDS: "3", ROSTER_SECONDS: "600",
      SHOP_DID: SHOP, MAX_DEAL_ROOMS: "3", ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { out += d; });
  p.on("close", () => done(out));
  setTimeout(() => p.kill("SIGTERM"), 25000);
});

const log1 = await run();
const deals = JSON.parse(fs.readFileSync(path.join(OUT, "tclk-deals.json"), "utf8"));
const rooms = deals.rooms ?? {};

console.log("\n=== A. our own deals are not in the queue at all");
ok("the deal we accepted got a slot on a list that was already full",
  !!rooms[R_WE_TOOK], Object.keys(rooms).length + " rooms now");
ok("and is marked as ours, so a later run still knows it",
  rooms[R_WE_TOOK]?.ours === true, JSON.stringify(rooms[R_WE_TOOK] ?? null));
ok("the deal room was actually read, not merely listed",
  HIT.has(R_WE_TOOK), [...HIT].join(", "));
ok("the list is allowed past the cap for ours",
  Object.keys(rooms).length > 3, String(Object.keys(rooms).length));

console.log("\n=== B. an accept answering an offer WE posted is ours too");
/* The accept naming C_ANSWERED comes from a stranger and says nothing about
   us. The only thing that connects it is its `ref`, which is the id of an
   offer we published — so the archiver has to have remembered posting it. */
ok("a stranger's answer to our offer got in", !!rooms[R_ANSWERED]);
ok("and counts as ours, not as a stranger's", rooms[R_ANSWERED]?.ours === true,
  JSON.stringify(rooms[R_ANSWERED] ?? null));
ok("the offer ids we posted are persisted for the next run",
  Array.isArray(deals.our_offers) && deals.our_offers.includes(OUR_OFFER),
  JSON.stringify(deals.our_offers ?? null));
ok("and a stranger's offer is NOT remembered as ours",
  !(deals.our_offers ?? []).includes(OID("e9")),
  "otherwise every accept on the board is cap-exempt");

console.log("\n=== C. a stranger's deal evicts the oldest stranger, it is not refused");
ok("the new stranger's room is followed", !!rooms[R_STRANGER]);
ok("the OLDEST stranger lost its slot", !rooms[OLD.name], OLD.name);
ok("and only the oldest — the other two are untouched",
  !!rooms[MID.name] && !!rooms[NEW.name]);
ok("an evicted room is not marked ours by accident", rooms[R_STRANGER]?.ours !== true);

console.log("\n=== D. ours have a bound of their own, just not the strangers'");
/* "Never capped" would be a slow leak. Every followed room is polled for the
   life of the run and written into a published file, so a shop that does a
   thousand deals would end up reading a thousand rooms, nearly all of them
   settled months ago. The two lists are separate and neither can crowd out
   the other. */
{
  const before = JSON.parse(fs.readFileSync(path.join(OUT, "tclk-deals.json"), "utf8"));
  const mineNow = Object.entries(before.rooms).filter(([, v]) => v.ours).length;
  ok("more of ours than the strangers' cap would have allowed", mineNow >= 2, String(mineNow));
  const log = await run({ MAX_OUR_DEAL_ROOMS: "1" });
  const after = JSON.parse(fs.readFileSync(path.join(OUT, "tclk-deals.json"), "utf8"));
  const mine = Object.entries(after.rooms).filter(([, v]) => v.ours);
  ok("with a cap of one, exactly one of ours is kept", mine.length === 1,
    mine.map(([k]) => k).join(", "));
  ok("and it is the NEWEST — the oldest is the one already settled and archived",
    mine[0]?.[1]?.seen === "2026-09-04T16:00:04Z", JSON.stringify(mine[0] ?? null));
  ok("strangers' rooms are not touched by our cap",
    Object.entries(after.rooms).filter(([, v]) => !v.ours).length >= 2,
    Object.entries(after.rooms).filter(([, v]) => !v.ours).map(([k]) => k).join(", "));
  ok("no crash", !/UnhandledPromiseRejection|TypeError|ReferenceError/.test(log));
}

console.log("\n=== D2. the run was clean");
ok("no crash", !/UnhandledPromiseRejection|TypeError|ReferenceError/.test(log1),
  log1.split("\n").find((l) => /Error/.test(l)) || "clean");

/* ── E. the tail across a restart ────────────────────────────────────────
   A hosted run ends every five and a half hours. The tail lived only in
   memory, so the next run's first pass REPLACED tail.ndjson with the handful
   of frames that had arrived in five minutes — a hole at every boundary, in
   the file whose only job is not to have one. */
console.log("\n=== E. the tail survives the run that wrote it ending");
const tailPath = path.join(OUT, "tclk-offers", "tail.ndjson");
const seqsIn = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "")
  .split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l).seq; } catch { return null; } })
  .filter((s) => s !== null);
const firstRun = seqsIn(tailPath);
ok("the first run left a tail", firstRun.length > 0, firstRun.join(","));

/* Second run: the room has moved on, and the old frames are gone from it. */
MESSAGES.length = 0;
MESSAGES.push(
  { seq: 40, ts: "2026-09-04T17:00:00Z", from: X, text: "later, after the restart" },
  { seq: 41, ts: "2026-09-04T17:00:01Z", from: X, text: "and later still" },
);
const log2 = await run();
const secondRun = seqsIn(tailPath);
ok("the second run's own frames are in it", secondRun.includes(41), secondRun.join(","));
ok("and so is everything the first run had — nothing was thrown away",
  firstRun.every((s) => secondRun.includes(s)),
  `before ${firstRun.join(",")} · after ${secondRun.join(",")}`);
ok("it is in seq order, oldest first", secondRun.every((s, i) => i === 0 || s > secondRun[i - 1]),
  secondRun.join(","));
ok("no duplicates crept in on the way back through the window",
  new Set(secondRun).size === secondRun.length, secondRun.join(","));
ok("the second run was clean too",
  !/UnhandledPromiseRejection|TypeError|ReferenceError/.test(log2),
  log2.split("\n").find((l) => /Error/.test(l)) || "clean");

/* The seed goes back through the same bound it was written under, so a tail
   written when the caps were larger is trimmed on the way in rather than
   smuggled past them. */
console.log("\n=== F. and the seed is still bounded");
const log3 = await run({ TAIL_MAX: "1" });
const trimmed = seqsIn(tailPath);
ok("a shrunken line cap applies to the seeded lines, not just new ones",
  trimmed.length <= 1, trimmed.join(","));
ok("and it kept the NEWEST, which is the end nobody else has",
  trimmed.length === 0 || trimmed[trimmed.length - 1] >= Math.max(...secondRun),
  trimmed.join(","));
ok("still clean", !/UnhandledPromiseRejection|TypeError|ReferenceError/.test(log3));

srv.close();
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/**
 * The escrow board, which is the one room the archive cannot afford to miss.
 *
 * WHY THIS FILE EXISTS. From tclk-offers' own _meta.json on 3 September:
 *
 *   {"after":591,"resumed_at":1107,"missed":515,"cause":"poll interval"}
 *
 * 515 frames in one hole — more than a third of everything that room had ever
 * produced. Nothing was broken. The scheduler measures each room's rate and
 * gives a quiet room a long interval, tclk-offers is usually quiet, so its
 * interval drifted towards the 150-second ceiling; then several agents posted
 * at once and a full page landed between two reads. Working exactly as
 * designed, and it lost the board.
 *
 * That trade is right for 58,699 rooms and wrong for this one. Elsewhere a
 * missed message is one message. Here it is an OFFER, this room is the whole
 * basis of the deals page and of what the runner can answer, and nobody else
 * on the network records it at all.
 *
 * So the test is a race, not an assertion about a constant. A room produces
 * steadily, faster than the old cadence could follow and slower than a page
 * fills, and the question is simply whether every message reached the
 * archive. The same code runs twice — once with the ceiling and once with it
 * lifted — because a fix with no failing control is a fix nobody can check.
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
if (!fs.existsSync(path.join(ROOT, "scripts/archive.mjs")))
  throw new Error(`no archiver under ${ROOT} — ROOT is wrong`);

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

const A = "did:key:z6MkPayerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "did:key:z6MkPayeeBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const frame = (o) => "tclk1 " + canon(o);
const CID = "0x" + "5c".repeat(32);
const DEAL = dealRoom(CID);

/* ── the room, filling in real time ────────────────────────────────────────
 * QUIET, THEN BUSY, because that is the actual shape of the failure and a
 * constant rate cannot reproduce it. The scheduler is not naive: it measures
 * each room and a room producing ten a second earns an eleven-second
 * interval all by itself, which loses nothing. What killed tclk-offers was
 * that it is quiet nearly all the time, so it learned a rate near zero and
 * drifted out to the 150-second ceiling — and then several agents posted at
 * once and a full page landed inside one interval.
 *
 * So: twenty seconds at one message every five, which teaches the scheduler
 * this room is asleep, and then ten a second. PAGE is 200, so the burst
 * overflows a page in twenty seconds. A ceiling of 2.5s sees it immediately;
 * the old one does not come back until it is far too late.
 */
const QUIET_S = 20, QUIET_RATE = 0.2, BURST_RATE = 10;
const START = Date.now();
const produced = () => {
  const t = (Date.now() - START) / 1000;
  return t <= QUIET_S
    ? Math.floor(t * QUIET_RATE)
    : Math.floor(QUIET_S * QUIET_RATE + (t - QUIET_S) * BURST_RATE);
};

function page(room, since) {
  const n = room === "tclk-offers" ? produced() : 0;
  const from = Math.max(1, n - 199);
  const msgs = [];
  for (let i = from; i <= n; i++) {
    if (i <= since) continue;
    /* Every twentieth message is a real accept, so the deal-room follow is
       exercised by the same run rather than by a second fixture. */
    const text = i % 20 === 0
      ? frame({ type: "accept", from: B, ref: "0x" + String(i).padStart(64, "0"),
                statement: "0x" + "7c".repeat(32), nonce: String(i).padStart(16, "0"), contract: CID })
      : frame({ type: "offer", from: A, id: "0x" + String(i).padStart(64, "0"),
                amount: String(i), asset: "FLOP", lock: "hash", rails: ["paper"], role: "payer",
                nonce: String(i).padStart(16, "0"),
                expiresMs: START + 3600000, claimByMs: START + 7200000, refundAfterMs: START + 10800000 });
    msgs.push({ seq: i, ts: new Date(START + i * 100).toISOString(), from: A, text, sig: "s" });
  }
  return { room, messages: msgs, first_seq: msgs.length ? msgs[0].seq : 0, last_seq: n };
}

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const j = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (u.pathname === "/rooms") return j({ rooms: [], total: 0 });
  const m = u.pathname.match(/^\/r\/(.+)$/);
  if (!m) { res.writeHead(404); return res.end(""); }
  const room = decodeURIComponent(m[1]);
  return j(page(room, Number(u.searchParams.get("since") ?? 0)));
}).listen(9252);

async function run(env) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "tclk-"));
  await new Promise((done) => {
    const p = spawn(process.execPath, [path.join(ROOT, "scripts/archive.mjs")], {
      env: { ...process.env, OUT_DIR: OUT, TECHNOCORE_BASE: "http://localhost:9252",
             ROOMS: "tclk-offers", RUN_SECONDS: "58", FLUSH_SECONDS: "8", ROSTER_SECONDS: "600",
             ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", () => { done(); globalThis.__out = out; });
    setTimeout(() => p.kill("SIGTERM"), 60000);
  });
  const mf = path.join(OUT, "tclk-offers", "_meta.json");
  const meta = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, "utf8")) : null;
  const lost = (meta?.gaps ?? []).reduce((s, g) => s + (g.missed || 0), 0);
  const deals = fs.existsSync(path.join(OUT, "tclk-deals.json"))
    ? JSON.parse(fs.readFileSync(path.join(OUT, "tclk-deals.json"), "utf8")) : null;
  const tf = path.join(OUT, "tclk-offers", "tail.ndjson");
  const tm = path.join(OUT, "tclk-offers", "tail.json");
  const tail = fs.existsSync(tf)
    ? { lines: fs.readFileSync(tf, "utf8").split("\n").filter(Boolean), bytes: fs.statSync(tf).size }
    : null;
  const tailMeta = fs.existsSync(tm) ? JSON.parse(fs.readFileSync(tm, "utf8")) : null;
  const shardLastSeq = (() => {
    const dir = path.join(OUT, "tclk-offers");
    if (!fs.existsSync(dir)) return null;
    let last = null;
    for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d\d-\d\d\.ndjson$/.test(x))) {
      for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
        if (!line) continue;
        try { last = JSON.parse(line).seq; } catch { /* torn */ }
      }
    }
    return last;
  })();
  const shardBytes = (() => {
    const dir = path.join(OUT, "tclk-offers");
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((f) => /^\d{4}-\d\d-\d\d\.ndjson$/.test(f))
      .reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
  })();
  fs.rmSync(OUT, { recursive: true, force: true });
  return { kept: meta?.total ?? 0, lost, gaps: meta?.gaps ?? [], deals, tail, tailMeta, shardBytes, shardLastSeq,
           log: globalThis.__out || "" };
}

/* ── A. with the ceiling ──────────────────────────────────────────────────*/
console.log("\n=== A. the offers room, read on its own clock");
const fixed = await run({});
ok("it kept up with a room filling faster than the old cadence could follow",
  fixed.lost === 0, `${fixed.kept} frames kept, ${fixed.lost} lost`);
ok("and recorded no gap at all", fixed.gaps.length === 0, JSON.stringify(fixed.gaps));
ok("it actually collected something, so zero loss is not zero work",
  fixed.kept > 100, fixed.kept + " frames");
ok("the deal room named by an accept was followed too",
  !!fixed.deals?.rooms?.[DEAL], Object.keys(fixed.deals?.rooms ?? {}).join(", ") || "none");
ok("no crash", !/UnhandledPromiseRejection|TypeError|ReferenceError/.test(fixed.log),
  (fixed.log.split("\n").find((l) => /Error/.test(l)) || "clean").slice(0, 80));

/* ── B. the control ───────────────────────────────────────────────────────*/
console.log("\n=== B. the same code with the ceiling lifted");
/* The real ceiling, not a strawman: 150 seconds is what every other room on
   the network gets and what tclk-offers had when it lost 515 frames. */
const loose = await run({ TCLK_OFFERS_MAX_MS: "150000", TCLK_DEAL_MAX_MS: "150000" });
/* MEASURED BY WHAT ARRIVED, not by what the archive admits it missed — and
   the difference between those two is a finding of its own.
   
   The control keeps 200 frames and records ZERO gaps, because a gap is only
   noticed on the read AFTER it: the archiver compares the server's first_seq
   with its own cursor and infers what fell between. If the window closes
   while it is still waiting, that read never happens and the loss is never
   written down. So the real archive UNDER-REPORTS its own loss, and the
   number in _meta.json is a floor rather than a total. The 515 we measured on
   the live board is the amount it managed to notice.
   
   Both runs see the same room for the same length of time, so the honest
   comparison is simply how much of it each one got. */
ok("the ceiling is the difference between most of the room and a fraction of it",
  loose.kept < fixed.kept * 0.75,
  `${fixed.kept} frames with it, ${loose.kept} without — same room, same 58 seconds`);
ok("and what it kept is one page, which is what one late read can return",
  loose.kept <= 200, `${loose.kept} — the newest 200 and nothing before them`);
ok("the archive did not notice most of what it lost, which is worth knowing",
  loose.lost < (fixed.kept - loose.kept),
  `${loose.lost} recorded as missing, about ${fixed.kept - loose.kept} actually gone`);

/* ══════════════════════════════════════════════════════════════════════════
 * B2. THE TAIL — the file that closes the gap this archive left open
 *
 * The shards this suite has been checking are correct and are published on
 * every TWELFTH pass, because they are megabytes. On 4 September the offers
 * shard had not been rewritten since 08:46.
 *
 * PROBED the same day, from a runner, because nothing else can reach the
 * venue: the live room is capped at 200 messages BY TECHNOCORE (limit=5000
 * returns 200), `since` will not page backwards, and the room runs at ~2,600
 * frames an hour. So a live read reaches back five minutes.
 *
 * Five minutes and "some hours ago" do not meet, and a real order — offer,
 * accept and payment lock, all on the board — fell in between and was
 * invisible to the shop's own runner, which reported "0 owed" and slept.
 *
 * The tail is a bounded window over the same room, written every pass. What
 * makes it affordable is that it does NOT grow, which is what these
 * assertions are actually about.
 * ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== B2. the tail, and the cap that used to freeze it");
{
  ok("the archiver writes one", Boolean(fixed.tail), "without it the gap stays open");
  ok("with the newest frames in it",
    (fixed.tail?.lines.length ?? 0) > 0 && (fixed.tail?.lines.length ?? 0) <= fixed.kept,
    `${fixed.tail?.lines.length ?? 0} lines against ${fixed.kept} collected`);
  ok("and a companion that says how far it reaches",
    fixed.tailMeta?.first_seq != null && fixed.tailMeta?.last_seq != null &&
    fixed.tailMeta?.updated != null && fixed.tailMeta?.last_ts != null,
    "a reader must be able to tell whether the tail meets its own live window, and whether it has stopped moving");

  /* ── THE ONE THAT MATTERS: A FULL SHARD MUST NOT SILENCE THE TAIL ────────
     The first version built the tail from the shard's own text, which is the
     string the body cap stops appending to. So the tail froze at the same
     line the shard did — while still rewriting `updated` every pass, so a
     dead file looked current.
     That is not a corner: MEASURED on the live archive, tclk-offers had
     body_cap 12000 and bodies_dropped 16225 on 4 September. More than half
     the day's money room was never stored, the shard stopped changing at
     08:46, and the order this whole fix exists for landed at 12:20. */
  const tiny = await run({ DAY_BODY_MAX: "40", TCLK_BODY_MAX: "40", TAIL_MAX: "4000" });
  ok("a shard stopped by the body cap does not stop the tail",
    (tiny.tail?.lines.length ?? 0) > 40,
    `shard capped at 40, tail holds ${tiny.tail?.lines.length ?? 0} — equal would mean the tail is downstream of the cap`);
  ok("and the tail reaches frames the shard never stored",
    (tiny.tailMeta?.last_seq ?? 0) > (tiny.shardLastSeq ?? 0),
    `tail ends at seq ${tiny.tailMeta?.last_seq}, shard at ${tiny.shardLastSeq}`);

  /* THE PROPERTY THAT MAKES IT AFFORDABLE. A tail that grew like the shard
     would be the thing the twelfth-pass tiering exists to prevent under a new
     name. In a 58-second run the tail holds everything the shard does, so
     "the tail is smaller" would pass here for reasons unrelated to the
     design — it is asserted where the cap actually binds. */
  const capped = await run({ TAIL_MAX: "25" });
  ok("it is a window and not a log — it obeys its line cap",
    (capped.tail?.lines.length ?? 0) === 25,
    `${capped.tail?.lines.length ?? 0} lines with TAIL_MAX=25, from ${capped.kept} collected`);
  ok("so it stays small while the shard does not",
    (capped.tail?.bytes ?? Infinity) < capped.shardBytes / 4,
    `${capped.tail?.bytes} bytes of tail against ${capped.shardBytes} of shard`);

  /* BYTES, NOT LINES, is what a commit costs. The first version capped only
     lines and called 4,000 of them "a few hundred KB"; at this room's
     measured 616 bytes a line that is 2.5 MB, and a maximum-length frame
     makes it 16 MB — larger than the shard the tiering keeps out of git. */
  const byBytes = await run({ TAIL_MAX: "4000", TAIL_MAX_BYTES: "6000" });
  ok("and a byte ceiling binds even when the line ceiling does not",
    (byBytes.tail?.bytes ?? Infinity) <= 6000 && (byBytes.tail?.lines.length ?? 0) < 4000,
    `${byBytes.tail?.bytes} bytes in ${byBytes.tail?.lines.length} lines`);

  /* A WINDOW OVER THE NEWEST, not the oldest. An oldest-N implementation
     passed every earlier version of this section. */
  ok("it keeps the NEWEST frames, which are the ones nothing else has",
    (capped.tailMeta?.last_seq ?? 0) === (capped.shardLastSeq ?? -1),
    `tail ends at ${capped.tailMeta?.last_seq}, shard ends at ${capped.shardLastSeq} — these must be the same frame`);
}

/* ── C. the properties, so a later edit cannot quietly undo it ────────────*/
console.log("\n=== C. what must stay true");
{
  const src = fs.readFileSync(path.join(ROOT, "scripts/archive.mjs"), "utf8");
  /* Four separate places lengthen an interval. A ceiling enforced at three of
     them is not a ceiling, so they all go through one function. */
  const direct = [...src.matchAll(/^\s*e\.interval\s*=/gm)].length;
  ok("nothing sets an interval except the one function that knows the ceiling",
    direct === 1, direct + " direct assignment(s) — the one inside setInterval_");
  ok("the offers room is capped tighter than the deal rooms",
    /TCLK_OFFERS_MAX_MS = Number\(process\.env\.TCLK_OFFERS_MAX_MS \?\? 2_500\)/.test(src) &&
    /TCLK_DEAL_MAX_MS = Number\(process\.env\.TCLK_DEAL_MAX_MS \?\? 12_000\)/.test(src));
  /* The whole justification for never backing off is that it is cheap. If it
     ever stops being cheap the justification is gone, so the arithmetic is
     asserted rather than trusted. */
  /* The first version of this had no hot window and cost 624 reads a minute
     at the cap — this assertion is the thing that caught it. What is bounded
     now is deals settling AT THE SAME TIME, not deals ever recorded. */
  ok("the tight ceiling only holds while a deal is live",
    /TCLK_DEAL_HOT_MS/.test(src) && /Date\.now\(\) - last <= TCLK_DEAL_HOT_MS/.test(src),
    "a settled deal falls back to the ordinary cadence");
  const offers = 60_000 / 2_500;
  const perHotDeal = 60_000 / 12_000;
  const room = 360 - offers - 30;           // 30 for the lobby and the tail
  ok("and enough deals can be live at once to cover any plausible board",
    Math.floor(room / perHotDeal) >= 60,
    `${Math.floor(room / perHotDeal)} simultaneous live deals fit in the budget, and the board has had 41 ever`);
  ok("a deal room starts at its ceiling rather than the discovery cadence",
    /interval: tclkCeiling\(room, null\) \?\?/.test(src),
    "the frames that decide a deal land within minutes of the accept");
}

srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

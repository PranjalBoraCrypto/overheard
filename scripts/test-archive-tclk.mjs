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
  fs.rmSync(OUT, { recursive: true, force: true });
  return { kept: meta?.total ?? 0, lost, gaps: meta?.gaps ?? [], deals, log: globalThis.__out || "" };
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

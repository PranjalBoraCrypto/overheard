/**
 * The board on /prediction: "Who has called it", and how much of it you can see.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 *
 * The board was `fold.standings.slice(0, 25)` and nothing else. At twenty-six
 * callers the twenty-sixth was not on the page: no control, no count, no way
 * to reach them. Nothing said so — the list simply ended, looking finished.
 *
 * That is the one failure this page cannot afford. Its entire claim is that
 * the record is public and anybody can check it; a board that silently drops
 * people invites exactly the suspicion the design exists to remove, and the
 * person dropped cannot tell whether they were cut off or refused.
 *
 * So these tests are about VISIBILITY, not about paging mechanics for their
 * own sake. The questions they ask are: can every caller be reached, does the
 * page ever imply a list is complete when it is not, and can somebody who
 * called find themselves without hunting.
 *
 * FIXTURES ARE SYNTHETIC ON PURPOSE. An earlier draft read the real ledger
 * off GitHub, which made the suite depend on the network and on however many
 * people had called that morning. The fold checks that a signature is
 * PRESENT, not that it verifies — verification happens at Technocore's door,
 * and web/call.js says so — which is what makes a stand-in string the honest
 * fixture here.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Needs playwright and a chromium:  npx playwright install chromium
 */
import { chromium } from "playwright";
import http from "http"; import fs from "fs"; import path from "path";
import { fileURLToPath } from "url";
import { tapFrame, callFrame } from "../web/call.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const PORT = 8903;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** `n` callers, each with a distinct key and a distinct stake, biggest first.
 *  Caller i therefore lands at rank i+1, which is what lets a test name a
 *  rank and mean it. */
function board(n) {
  const frames = []; const dids = []; let seq = 1;
  for (let i = 0; i < n; i++) {
    let x = i, head = "";
    for (let k = 0; k < 4; k++) { head = B58[x % 58] + head; x = Math.floor(x / 58); }
    const did = "did:key:z6Mk" + head + "a".repeat(40);
    dids.push(did);
    const nonce = () => String(1e15 + seq);
    frames.push({ seq: String(seq++), ts: "2026-09-07T10:00:00Z", from: did, sig: "s",
      nonce: nonce(), text: tapFrame(did, nonce()) });
    frames.push({ seq: String(seq++), ts: "2026-09-07T10:00:01Z", from: did, sig: "s",
      nonce: nonce(), text: callFrame(did, i % 3 ? "yes" : "no", 1000 - i * 5, nonce()) });
  }
  return { frames, dids };
}

let FRAMES = [];
const srv = http.createServer((q, r) => {
  let p = new URL(q.url, "http://x").pathname;
  if (p === "/" || p === "/prediction") p = "/prediction.html";
  const J = (o) => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify(o)); };
  if (p === "/api/calls") return J({ ok: true, frames: FRAMES });
  /* The live room answers empty: the archive alone is enough to build a
     board, and a second source would only make the fixture harder to read. */
  if (p === "/api/room") return J({ room: "overheard-calls", source: "live",
    first_seq: "1", last_seq: "1", count: 0, messages: [] });
  if (p.startsWith("/api/") || p.startsWith("/data/")) return J({});
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    const e = path.extname(p);
    r.writeHead(200, { "content-type": e === ".js" ? "text/javascript"
      : e === ".css" ? "text/css" : e === ".png" ? "image/png" : "text/html" });
    return r.end(fs.readFileSync(f));
  }
  r.writeHead(404); r.end("{}");
}).listen(PORT);

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
let bad = 0; const errs = [];
const check = (n, ok, d = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? "   " + d : ""}`);
  if (!ok) bad++;
};

async function open(vp, me) {
  const ctx = await b.newContext({ viewport: vp });
  /* getSession() needs only a well-formed did to call this browser signed in;
     the key itself lives in IndexedDB and nothing here has to sign. */
  if (me) await ctx.addInitScript((did) => {
    localStorage.setItem("overheard.session",
      JSON.stringify({ did, at: new Date().toISOString() }));
  }, me);
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => errs.push(e.message));
  await pg.goto(`http://localhost:${PORT}/prediction`);
  await pg.waitForFunction(
    () => document.querySelectorAll("#rows .fr").length > 0, null, { timeout: 12000 }
  ).catch(() => {});
  await pg.waitForTimeout(400);
  return pg;
}

const st = (pg) => pg.evaluate(() => {
  const kids = [...document.getElementById("rows").children];
  const cut = kids.findIndex((e) => e.classList.contains("pinsep"));
  const listed = (cut < 0 ? kids : kids.slice(0, cut)).filter((e) => e.classList.contains("fr"));
  return {
    listRows: listed.length,
    ranks: listed.map((e) => e.querySelector(".rk")?.textContent ?? ""),
    nums: [...document.querySelectorAll(".pgb:not(.nav)")].map((e) => e.textContent),
    gaps: document.querySelectorAll(".pggap").length,
    on: document.querySelector(".pgb.on")?.textContent ?? null,
    count: document.querySelector(".pgcount")?.textContent ?? "",
    more: document.querySelector(".pgmore")?.textContent ?? null,
    pin: document.querySelector(".pinsep")?.textContent ?? null,
    pinRank: document.querySelector(".pinsep + .fr .rk")?.textContent ?? null,
    navOff: [...document.querySelectorAll(".pgb.nav")].map((e) => e.disabled),
    pagerHidden: document.getElementById("pager").hidden,
  };
});

const DESK = { width: 1280, height: 1000 };
const PHONE = { width: 390, height: 844 };

/* ── A. a board that fits ────────────────────────────────────────────────
   Nine callers is one page. There is nothing to page through, and drawing
   controls for it would be noise — but the COUNT still has to show, because
   it is the only thing that says "this is all of them" rather than "this is
   the first however-many". That sentence is the whole fix. */
console.log("=== A. a board small enough to fit says so");
FRAMES = board(9).frames;
let pg = await open(DESK, null);
let s = await st(pg);
check("all nine are on the page", s.listRows === 9, `${s.listRows}`);
check("with no controls, because there is nowhere to go", s.nums.length === 0);
check("but the count still says it is all of them", /9 callers/.test(s.count), s.count);
await pg.close();

/* ── B. the boundary ─────────────────────────────────────────────────────
   Exactly one page. The off-by-one that would show a "Show 0 more" button or
   a second empty page lives here and nowhere else. */
console.log("\n=== B. exactly one page, on the boundary");
FRAMES = board(10).frames;
pg = await open(DESK, null);
s = await st(pg);
check("ten is still one page", s.listRows === 10 && s.nums.length === 0, `${s.nums.length} buttons`);
check("and it does not offer a second, empty one", s.on === null);
await pg.close();
pg = await open(PHONE, null);
s = await st(pg);
check("the phone does not offer to show zero more", s.more === null, String(s.more));
await pg.close();

/* ── C. more than fits ───────────────────────────────────────────────────*/
console.log("\n=== C. fourteen callers, desktop: two pages");
FRAMES = board(14).frames;
pg = await open(DESK, null);
s = await st(pg);
check("the first page holds ten", s.listRows === 10, `${s.listRows}`);
check("two numbered pages", s.nums.join(",") === "1,2", s.nums.join(","));
check("the first is current", s.on === "1");
check("previous is dead, next is live", s.navOff[0] === true && s.navOff[1] === false);
check("and the count names everybody, not the visible ten",
  /14 callers/.test(s.count), s.count);
await pg.click(".pgb.nav:last-of-type"); await pg.waitForTimeout(250);
s = await st(pg);
check("the second page holds the remaining four", s.listRows === 4, `${s.listRows}`);
/* RANKS ARE ABSOLUTE. A paged board that restarts at 1 tells the reader they
   are looking at the leaders when they are looking at places 11 to 14. */
check("carrying their true ranks, not 1-4", s.ranks.join(",") === "11,12,13,14", s.ranks.join(","));
check("and next is now dead", s.navOff[1] === true);
await pg.close();

/* ── D. a board far bigger than the control ──────────────────────────────
   Twelve pages. The row of numbers must not grow with the board, or the
   control becomes the thing that overflows. */
console.log("\n=== D. a hundred and twenty callers");
const big = board(120);
FRAMES = big.frames;
const ME = big.dids[97];            // stakes descend, so this is rank 98
pg = await open(DESK, null);
s = await st(pg);
check("the number row stays bounded", s.nums.length <= 7, s.nums.join(","));
check("with a gap where numbers were skipped", s.gaps >= 1, `${s.gaps}`);
check("and both ends stay reachable",
  s.nums.includes("1") && s.nums.includes("12"), s.nums.join(","));
check("the count is honest about the size", /120 callers/.test(s.count), s.count);
await pg.click(".pgb:not(.nav):last-of-type"); await pg.waitForTimeout(250);
s = await st(pg);
check("the last page reaches the last caller",
  s.ranks[s.ranks.length - 1] === "120", s.ranks.join(","));
await pg.close();

/* ── E. finding yourself ─────────────────────────────────────────────────
   Somebody who called is here to see where they stand. Making them page
   through ninety strangers to do it is the failure this pin prevents. */
console.log("\n=== E. your own row is never off the board");
pg = await open(DESK, ME);
s = await st(pg);
check("page one still shows the leaders",
  s.ranks.slice(0, 10).join(",") === "1,2,3,4,5,6,7,8,9,10");
check("and your row is pinned beneath them", /^your call/.test(s.pin ?? ""), String(s.pin));
check("the row carries its real rank", s.pinRank === "98", String(s.pinRank));
/* THE LABEL CARRIES THE RANK TOO, because the phone layout hides .rk to buy
   width for two columns. A row lifted out of a sorted list has no position
   left to read unless something says it. */
check("and the label says where that is, in words",
  /98th of 120/.test(s.pin ?? ""), String(s.pin));
await pg.close();

pg = await open(PHONE, ME);
s = await st(pg);
check("the phone pins it too, and says where", /98th of 120/.test(s.pin ?? ""), String(s.pin));
await pg.close();

/* ── F. the phone is a different control, not a smaller one ──────────────
   A row of 32px numbered targets at the bottom of a phone is the worst tap
   target on the page. The same `page` number is spent as one full-width
   button and a list that grows. */
console.log("\n=== F. the phone grows the list instead of paging it");
pg = await open(PHONE, null);
s = await st(pg);
check("it starts at ten", s.listRows === 10, `${s.listRows}`);
check("with no numbered buttons in reach", await pg.locator(".pgctl").isVisible() === false);
check("and one full-width button instead", /Show 10 more/.test(s.more ?? ""), String(s.more));
check("the count says how far in you are", /Showing 10 of 120/.test(s.count), s.count);
await pg.click(".pgmore"); await pg.waitForTimeout(250);
s = await st(pg);
check("pressing it ACCUMULATES rather than replacing", s.listRows === 20, `${s.listRows}`);
check("and the first caller is still there", s.ranks[0] === "1", s.ranks[0]);
await pg.close();

/* ── G. crossing between the two designs ─────────────────────────────────
   One state underneath both, so a rotation never lands on something the
   other design cannot describe. */
console.log("\n=== G. rotating mid-list");
pg = await open(PHONE, null);
for (let i = 0; i < 3; i++) { await pg.click(".pgmore"); await pg.waitForTimeout(180); }
s = await st(pg);
check("the phone has grown to forty", s.listRows === 40, `${s.listRows}`);
await pg.setViewportSize(DESK); await pg.waitForTimeout(400);
s = await st(pg);
check("turning it sideways re-renders as a real page",
  s.listRows === 10, `${s.listRows} rows`);
check("on the page the phone had reached, not back at the top",
  s.on === "4", `page ${s.on}`);
await pg.close();

/* ── H. the board is not frozen while you read it ────────────────────────
   This page does not poll — it reads once — but load() runs again after a
   call lands and on every sign-in, and each one repaints the whole board.
   Two things must survive that: the page you were on, and the page number
   itself, which can end up pointing past the end of a list that got shorter.
   A shorter list is not hypothetical: load() merges the archive with the
   live room, and an archive read that fails comes back as nothing at all. */
console.log("\n=== H. a repaint under the reader");
FRAMES = big.frames;
pg = await open(DESK, null);
await pg.click(".pgb:not(.nav):last-of-type"); await pg.waitForTimeout(250);
check("parked on the last page", (await st(pg)).on === "12");

/* Signing in is the repaint that is easiest to reach and the one that
   matters most: it is the moment somebody is looking for their own row. */
await pg.evaluate((did) => {
  localStorage.setItem("overheard.session",
    JSON.stringify({ did, at: new Date().toISOString() }));
  dispatchEvent(new CustomEvent("overheard:session", { detail: { did } }));
}, ME);
await pg.waitForTimeout(900);
let h = await st(pg);
check("signing in does not throw you back to page one", h.on === "12", `page ${h.on}`);
check("and your row is found without leaving the page you were on",
  /98th of 120/.test(h.pin ?? ""), String(h.pin));

/* Now the board shrinks under the reader, with page 12 still held. */
FRAMES = board(12).frames;
await pg.evaluate(() => dispatchEvent(new CustomEvent("overheard:session", { detail: null })));
await pg.waitForTimeout(900);
h = await st(pg);
check("a page number past the end lands somewhere real",
  h.listRows > 0, `${h.listRows} rows on page ${h.on}`);
check("and the count follows the board down", /12 callers/.test(h.count), h.count);
await pg.close();

console.log("\nerrors:", errs);
if (errs.length) bad++;
await b.close(); srv.close();
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall good");
process.exit(bad ? 1 : 0);

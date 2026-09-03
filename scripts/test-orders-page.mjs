#!/usr/bin/env node
/**
 * The order record — what somebody sees when they come back later.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHAT IS WORTH PINNING HERE
 *
 * This page makes claims about a person's own money, from two sources that
 * disagree about how fresh they are, and it pages through the result. Three
 * things can go wrong and none of them raises an error:
 *
 *   1. THE LOADING STATE LOOKS LIKE THE EMPTY STATE. Both reads are network
 *      calls, and "you have never ordered anything" is a false statement to
 *      show a returning customer for half a second. The skeleton exists to
 *      make that impossible and it has to be the state on first paint.
 *
 *   2. THE PAGER CAN POINT AT NOTHING. Changing the filter shortens the list
 *      under a page index that was valid a moment ago, and a pager showing
 *      "3 of 1" over an empty list reads as a broken page.
 *
 *   3. THE TWO SOURCES CAN DOUBLE-COUNT. The archive and the live room
 *      overlap by design — the whole point of reading both — so an order that
 *      is in each must appear once. Deduplication is on the frame's nonce;
 *      dedup on a timestamp would collide two orders placed in one second.
 *
 * The endpoint gets its own section because its filtering is the thing that
 * keeps three megabytes of daily shard off a phone.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { CAN_DO } from "./work.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

const page = fs.readFileSync(path.join(ROOT, "web/orders.html"), "utf8");
const api = fs.readFileSync(path.join(ROOT, "api/orders.js"), "utf8");
const hire = fs.readFileSync(path.join(ROOT, "web/hire.html"), "utf8");
const board = fs.readFileSync(path.join(ROOT, "web/deals-preview-78cb4a1be923c6b4.html"), "utf8");
const rooms = fs.readFileSync(path.join(ROOT, "web/rooms.html"), "utf8");
const strip = (t) => t.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const code = strip(page);

console.log("=== A. it holds nothing, and renders nothing as markup");
ok("no key material of any kind",
  !/privateKey|secretKey|mnemonic|\bseed\b/i.test(page));
ok("no 64-hex string anywhere", !/[0-9a-f]{64}/i.test(page),
  (page.match(/[0-9a-f]{64}/i) || ["clean"])[0].slice(0, 20));
/* This page renders values that came off the public wire — a brief somebody
   else could have chosen, a job id, an amount. The rule the deals board keeps
   applies here for the same reason. */
ok("it never assigns markup",
  !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code),
  "briefs and amounts are wire data; they go in as text");
ok("and it does not sign anything either",
  !/signTextB64u|signBytes|\/api\/post/.test(code),
  "a record is a reader; signing belongs on the order page");

console.log("\n=== B. it is the same site");
const rule = (t, sel) => {
  const m = t.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{([^}]*)\\}"));
  return m ? m[1].replace(/\s+/g, "") : null;
};
for (const sel of [".sky", ".sky i", ".sky i:nth-child(1)", ".sky i:nth-child(2)", ".spot"]) {
  const mine = rule(page, sel), theirs = rule(rooms, sel);
  ok(`${sel} matches rooms.html character for character`,
    Boolean(theirs) && mine === theirs,
    mine === theirs ? "" : `\n        here:  ${mine}\n        rooms: ${theirs}`);
}
ok("the ground is the site's --void", /body\{background:var\(--void\)/.test(page.replace(/\s+/g, "")));
ok("and something moves the spotlight",
  /setProperty\("--px"/.test(page) && /hover: hover\) and \(pointer: fine/.test(page));

console.log("\n=== C. you can get here, and get back");
ok("the order page carries a link to it", /href="\/orders\.html"/.test(hire));
ok("and so does the board's rail", /href="\/orders\.html"/.test(board));
ok("it links back to ordering", /href="\/hire\.html"/.test(page));
ok("and out to the board", /href="\/deals-preview-78cb4a1be923c6b4\.html"/.test(page));

console.log("\n=== D. the endpoint keeps the shards off the phone");
ok("it filters by did server-side", /searchParams\.get\("did"\)/.test(api));
ok("and refuses anything that is not a canonical did:key",
  /did:key:z6Mk\[1-9A-HJ-NP-Za-km-z\]\{44\}/.test(api),
  "an unvalidated did is an arbitrary path fetched from a repository");
ok("it reads the repository, not the deployed copy",
  /raw\.githubusercontent\.com/.test(api),
  "the deployed files are only as fresh as the last build");
ok("it bounds how far back it looks", /MAX_DAYS/.test(api) && /slice\(-MAX_DAYS\)/.test(api));
ok("and caps one identity's list", /MAX_ORDERS/.test(api));
/* The prefilter is the whole reason this is affordable: a substring test
   rules out ~99.9% of lines before any of them is parsed. */
ok("it prefilters lines before parsing them",
  /if \(!line\.includes\(did\)\) continue;/.test(api));
ok("it reports how much it actually read",
  /days_scanned/.test(api) && /days_available/.test(api) && /truncated/.test(api),
  "a bare array looks complete whatever happened");
ok("and it does not follow deal rooms",
  !/dealRoom|contract/.test(strip(api).replace(/contract id/g, "")),
  "one upstream read per order is what once made the board render empty");

/* ══════════════════════════════════════════════════════════════════════════
 * THE BROWSER HALF
 * ═════════════════════════════════════════════════════════════════════════*/
const DID = "did:key:z6MkjxvZeFy4mcEhgJzNpnWmzKfwYNrHEmSUra9UXqWnW5xU";
const IDS = ["overheard-agent-profile", "overheard-room-summary", "overheard-daily-digest"];
const now = Date.now();
/* 23 orders: enough for three pages at ten a page, with the first seven still
   inside their expiry so the filters have something to separate. */
const FIXTURE = Array.from({ length: 23 }, (_, i) => ({
  seq: 1000 + i,
  ts: new Date(now - i * 3600000).toISOString(),
  job: IDS[i % 3],
  brief: ["did:key:z6MkSomebody", "technocore", "2026-09-02"][i % 3],
  amount: ["500", "250", "1000"][i % 3],
  asset: "FLOP",
  expiresMs: i < 7 ? now + 86400000 : now - 3600000,
  nonce: "nonce" + i,
}));
const asMessage = (o) => ({
  seq: o.seq, ts: o.ts, from: DID, nonce: "wire" + o.seq, sig: "sig",
  text: "tclk1 " + JSON.stringify({
    type: "offer", from: DID, role: "payer",
    job: { id: o.job, proto: "overheard", brief: o.brief },
    amount: o.amount, asset: o.asset, lock: "hash", rails: ["paper"],
    expiresMs: o.expiresMs, claimByMs: now + 86400000, refundAfterMs: now + 172800000,
    nonce: o.nonce,
  }),
});

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".svg": "image/svg+xml" };
const SESSION = (did) => did
  ? `export const getSession=()=>({did:${JSON.stringify(did)}});export const onSession=()=>{};` +
    `export const shortDid=(d)=>d.slice(0,12)+"…"+d.slice(-4);`
  : `export const getSession=()=>null;export const onSession=()=>{};` +
    `export const shortDid=(d)=>String(d);`;

let signedInAs = DID;
let archiveAnswers = true;
let liveOverlap = 3;

const srv = http.createServer((q, r) => {
  const u = q.url.split("?")[0];
  if (u === "/session.js") {
    r.writeHead(200, { "content-type": "text/javascript" });
    return r.end(SESSION(signedInAs));
  }
  if (u === "/api/orders") {
    r.writeHead(200, { "content-type": "application/json" });
    if (!archiveAnswers) return r.end(JSON.stringify({ source: "unavailable", orders: [] }));
    return r.end(JSON.stringify({
      did: DID, source: "repository", orders: FIXTURE,
      days_scanned: 2, days_available: 2, window_days: 14, truncated: false,
    }));
  }
  if (u === "/api/room") {
    r.writeHead(200, { "content-type": "application/json" });
    /* The overlap is the point: these are the SAME orders the archive
       returned, arriving by the other road. */
    return r.end(JSON.stringify({ source: "live", messages: FIXTURE.slice(0, liveOverlap).map(asMessage) }));
  }
  const f = path.join(ROOT, "web", u);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end("no"); }
  r.writeHead(200, { "content-type": TYPES[path.extname(f)] || "text/plain" });
  r.end(fs.readFileSync(f));
});
await new Promise((res) => srv.listen(9441, res));

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"],
});
const errs = [];
const open = async (w = 1280, h = 1000) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => errs.push(String(e).slice(0, 140)));
  return { ctx, pg };
};
const read = (pg) => pg.evaluate(() => ({
  skel: document.getElementById("skel").hidden,
  signedout: document.getElementById("signedout").hidden,
  empty: document.getElementById("empty").hidden,
  nofilter: document.getElementById("nofilter").hidden,
  stats: [...document.querySelectorAll(".stat b")].map((e) => e.textContent),
  chips: [...document.querySelectorAll(".chip")].map((c) => ({
    on: c.getAttribute("aria-pressed") === "true", n: c.querySelector("span").textContent })),
  rows: document.querySelectorAll(".hrow").length,
  where: document.getElementById("pwhere").textContent,
  prev: document.getElementById("prev").disabled,
  next: document.getElementById("next").disabled,
  pager: document.getElementById("pager").hidden,
  foot: document.getElementById("foot").textContent,
}));

console.log("\n=== E. the two sources are merged, not stacked");
{
  const { ctx, pg } = await open();
  await pg.goto("http://localhost:9441/orders.html", { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(1200);
  const s = await read(pg);
  /* 23 archived, 3 of them ALSO returned live. A page that stacked instead of
     merging would say 26 — and would be overstating what somebody spent. */
  ok("an order in both sources is counted once", s.stats[0] === "23",
    `${s.stats[0]} shown, ${FIXTURE.length} archived + ${liveOverlap} of them live again`);
  ok("open and closed add up to the total",
    Number(s.stats[1]) + Number(s.stats[2]) === Number(s.stats[0]),
    `${s.stats[1]} + ${s.stats[2]} = ${s.stats[0]}`);
  ok("the committed figure is the sum of the amounts, not a guess",
    s.stats[3] === "13,000",
    "8×500 + 8×250 + 7×1000 across the fixture");
  await ctx.close();
}

console.log("\n=== F. paging, and the pager never points at nothing");
{
  const { ctx, pg } = await open();
  await pg.goto("http://localhost:9441/orders.html", { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(1200);
  let s = await read(pg);
  ok("ten to a page", s.rows === 10, s.rows + " rows");
  ok("and it says where you are", s.where === "1 of 3", s.where);
  ok("there is nothing newer than the first page", s.prev === true);
  await pg.click("#next"); await pg.waitForTimeout(250);
  await pg.click("#next"); await pg.waitForTimeout(250);
  s = await read(pg);
  ok("the last page holds the remainder", s.rows === 3 && s.where === "3 of 3", `${s.rows} on ${s.where}`);
  ok("and there is nothing older", s.next === true);

  /* Filtering from page 3 to a list with only one page must land somewhere
     real, not on an empty page 3.
     WORTH RECORDING: this was written as a test of the `Math.min` clamp in
     paint(), and it is not one — deleting that clamp leaves every assertion
     here green, because the chip handler resets the index to 0 before paint
     ever runs. The clamp is unreachable defence; THIS checks the reset, which
     is the thing actually doing the work. A test that names the wrong
     mechanism passes for the wrong reason, which is how a guard gets deleted
     during a refactor with the suite still green. */
  await pg.click('.chip[data-filter="open"]'); await pg.waitForTimeout(250);
  s = await read(pg);
  ok("changing the filter from a later page resets to the first one",
    s.where === "1 of 1" && s.rows === 7, `${s.where}, ${s.rows} rows`);
  ok("and the pager hides itself when one page is all there is", s.pager === true);
  await ctx.close();
}

console.log("\n=== G. the filters agree with the figures");
{
  const { ctx, pg } = await open();
  await pg.goto("http://localhost:9441/orders.html", { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(1200);
  const s = await read(pg);
  ok("each chip carries its own count",
    s.chips.map((c) => c.n).join("/") === "23/7/16", s.chips.map((c) => c.n).join("/"));
  ok("and those counts are the ones in the cards above",
    s.chips[0].n === s.stats[0] && s.chips[1].n === s.stats[1] && s.chips[2].n === s.stats[2]);
  await pg.click('.chip[data-filter="shut"]'); await pg.waitForTimeout(250);
  const t = await read(pg);
  ok("exactly one chip is pressed at a time",
    t.chips.filter((c) => c.on).length === 1 && t.chips[2].on);
  ok("and the closed filter shows every closed order",
    t.where === "1 of 2", t.where);
  await ctx.close();
}

console.log("\n=== H. the states that are not a list");
{
  /* THE FAILURE THIS SECTION EXISTS FOR: on first paint, before either read
     has landed, the page must not be telling a returning customer that they
     have never ordered anything. */
  const { ctx, pg } = await open();
  await pg.goto("http://localhost:9441/orders.html", { waitUntil: "commit" });
  const first = await pg.evaluate(() => ({
    skel: document.getElementById("skel").hidden,
    empty: document.getElementById("empty").hidden,
  })).catch(() => null);
  if (first) {
    ok("the skeleton shows before the answer, and the empty state does not",
      first.skel === false && first.empty === true,
      "\"you have no orders\" must never be the loading state");
  } else { ok("the skeleton shows before the answer", false, "could not sample first paint"); }
  await ctx.close();
}
{
  signedInAs = null;
  const { ctx, pg } = await open();
  await pg.goto("http://localhost:9441/orders.html", { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(900);
  const s = await read(pg);
  ok("with no identity it says so, and offers the way to make one",
    s.signedout === false && s.skel === true,
    "orders are matched to a key, so no key is a different answer from no orders");
  ok("and shows no figures it cannot compute", s.stats.every((v) => v === "—") || s.stats.length === 0);
  await ctx.close();
  signedInAs = DID;
}
{
  archiveAnswers = false;
  liveOverlap = 0;
  const { ctx, pg } = await open();
  await pg.goto("http://localhost:9441/orders.html", { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(1000);
  const s = await read(pg);
  ok("with an identity and nothing ordered, it says THAT instead",
    s.empty === false && s.signedout === true);
  await ctx.close();
  archiveAnswers = true;
  liveOverlap = 3;
}

console.log("\n=== I. it admits what it cannot know");
{
  const { ctx, pg } = await open();
  await pg.goto("http://localhost:9441/orders.html", { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(1200);
  const s = await read(pg);
  ok("the footer says how far back it read",
    /archived day/.test(s.foot), s.foot.slice(0, 60) + "…");
  /* The most important sentence on the page. "Open" is a fact about an
     expiry, and letting it be read as "nobody has taken this" would be the
     page inventing a status it never looked up. */
  ok("and that \"open\" is about the expiry, not about acceptance",
    /expiry has not passed, not that nobody has accepted/i.test(s.foot));
  ok("every job the shop can do has a readable name here",
    await pg.evaluate((jobs) => jobs.every((j) => document.documentElement.outerHTML.includes(j)),
      [...CAN_DO]),
    "an order should never show a raw job id");
  await ctx.close();
}

console.log("\n=== J. nothing threw");
ok("no script errors", errs.length === 0, errs.join(" | "));

await browser.close();
await new Promise((res) => srv.close(res));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

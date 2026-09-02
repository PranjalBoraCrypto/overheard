/**
 * The deals page, against a stubbed network.
 *
 * There is no tclk traffic yet — the testnet opens later this year — so the
 * only way to know this page works is to serve it frames. The fixtures live
 * HERE and never anywhere the site can reach them: a page that would render
 * an invented deal in front of a visitor is the one failure this project
 * cannot have.
 *
 * The cases that matter are the ugly ones. A frame whose body claims to be
 * from somebody else. A frame carrying HTML. A malformed offer. A reveal
 * whose secret does not open the statement. Each is a thing the network can
 * genuinely contain and each has a right answer that is not "hide it".
 */
import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { createHash } from "node:crypto";
import { canon, dealRoom } from "../web/tclk.js";

const ROOT = "/tmp/oh/web";
const PAGE = "/deals-preview-78cb4a1be923c6b4";
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

/* ── fixtures ──────────────────────────────────────────────────────────── */
const PAYER = "did:key:z6MkPayerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PAYEE = "did:key:z6MkPayeeBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const NOW = Date.now();
const frame = (o) => "tclk1 " + canon(o);

const mkOffer = (over = {}) => ({
  type: "offer", from: PAYER, id: "0x" + "a".repeat(64), amount: "1000000", asset: "FLOP",
  lock: "hash", paymentKey: "0x02aa", rails: ["flop-htlc"],
  claimByMs: NOW + 3600000, refundAfterMs: NOW + 7200000, expiresMs: NOW + 1800000,
  role: "payer", nonce: "9f2c81d04c9e1f7a", ...over,
});

const SECRET = "0x" + "ab".repeat(32);
const STATEMENT = "0x" + sha(SECRET);

/* Deliberately unalike: same expiry and same amount on every fixture means
   both sort orders produce the same list and a broken sort passes. */
const openOffer   = mkOffer({ id: "0x" + "1".repeat(64), amount: "1000000", expiresMs: NOW + 1800000 });
const brokenOffer = mkOffer({ id: "0x" + "2".repeat(64), amount: "50", expiresMs: NOW + 600000,
                              claimByMs: NOW + 9000000, refundAfterMs: NOW + 60000 });
/* A huge amount doubles as the check that amounts are never parsed as
   numbers — this one is 200x past Number.MAX_SAFE_INTEGER. */
const xssOffer    = mkOffer({ id: "0x" + "3".repeat(64), amount: "999999999999999999999",
                              expiresMs: NOW + 5400000, asset: "<img src=x onerror=window.__pwned=1>" });
const flightOffer = mkOffer({ id: "0x" + "4".repeat(64) });
const doneOffer   = mkOffer({ id: "0x" + "5".repeat(64) });
const liarOffer   = mkOffer({ id: "0x" + "6".repeat(64) });

const acc = (ref, contract) => ({
  type: "accept", from: PAYEE, ref, statement: STATEMENT,
  paymentKey: "0x03bb", nonce: "1122334455667788", contract,
});

const CID_FLIGHT = "0x" + "7".repeat(64);
const CID_DONE   = "0x" + "8".repeat(64);
const CID_LIAR   = "0x" + "9".repeat(64);

const msg = (i, from, text, extra = {}) => ({
  seq: String(i), ts: new Date(NOW - (200 - i) * 1000).toISOString(),
  from, nick: null, text, sig: "s", nonce: null, ...extra,
});
/* A deal room's frames happen AFTER the accept that created the room. The
   first fixture numbered them from 1 with earlier timestamps, which put a
   lock ahead of its own accept — impossible on the wire, and it hid a real
   ordering question behind a fake one. */
const dmsg = (i, from, text) => msg(100 + i, from, text);

const OFFERS = [
  msg(1, PAYER, frame(openOffer)),
  msg(2, PAYER, frame(brokenOffer)),
  msg(3, PAYER, frame(xssOffer)),
  msg(4, PAYER, "just a normal room message, not a frame"),
  msg(5, PAYER, "tclk1 {this will not parse"),
  msg(6, PAYER, frame(flightOffer)),
  msg(7, PAYEE, frame(acc(flightOffer.id, CID_FLIGHT))),
  msg(8, PAYER, frame(doneOffer)),
  msg(9, PAYEE, frame(acc(doneOffer.id, CID_DONE))),
  msg(10, PAYER, frame(liarOffer)),
  msg(11, PAYEE, frame(acc(liarOffer.id, CID_LIAR))),
];

/* deal rooms, derived exactly as the page will derive them */
const ROOMS = {
  [dealRoom(CID_FLIGHT)]: [
    dmsg(1, PAYER, frame(flightOffer)),
    dmsg(2, PAYEE, frame(acc(flightOffer.id, CID_FLIGHT))),
    dmsg(3, PAYER, frame({ type: "lock", from: PAYER, contract: CID_FLIGHT, rail: "flop-htlc", ref: "r1" })),
  ],
  [dealRoom(CID_DONE)]: [
    dmsg(1, PAYER, frame(doneOffer)),
    dmsg(2, PAYEE, frame(acc(doneOffer.id, CID_DONE))),
    dmsg(3, PAYER, frame({ type: "lock", from: PAYER, contract: CID_DONE, rail: "flop-htlc", ref: "r2" })),
    dmsg(4, PAYEE, frame({ type: "reveal", from: PAYEE, contract: CID_DONE, secret: SECRET })),
  ],
  /* THE LIAR: the body says the payer sent it, the transport says otherwise.
     The lock must be ignored and the deal must stay at accepted. */
  [dealRoom(CID_LIAR)]: [
    dmsg(1, PAYER, frame(liarOffer)),
    dmsg(2, PAYEE, frame(acc(liarOffer.id, CID_LIAR))),
    dmsg(3, "did:key:z6MkNobodyCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      frame({ type: "lock", from: PAYER, contract: CID_LIAR, rail: "flop-htlc", ref: "r3" })),
  ],
};

const FAILMODE = { v: "good" };
const srv = http.createServer((q, r) => {
  const u = new URL(q.url, "http://x");
  let p = u.pathname;
  if (p === PAGE) p = PAGE + ".html";
  if (p === "/api/room") {
    if (FAILMODE.v === "429") {
      r.writeHead(429, { "content-type": "application/json" });
      return r.end(JSON.stringify({ error: "rate limited upstream", retry: true, source: "none" }));
    }
    if (FAILMODE.v === "none") {
      r.writeHead(200, { "content-type": "application/json" });
      return r.end(JSON.stringify({ room: "tclk-offers", source: "none", why: "unreachable", messages: [] }));
    }
    const name = u.searchParams.get("room");
    const body = name === "tclk-offers"
      ? { ok: true, room: name, source: "live", retrieved_at: new Date().toISOString(), age_seconds: 0, messages: OFFERS }
      : ROOMS[name]
        ? { ok: true, room: name, source: "live", retrieved_at: new Date().toISOString(), age_seconds: 0, messages: ROOMS[name] }
        : { room: name, source: "none", messages: [] };
    r.writeHead(200, { "content-type": "application/json" });
    return r.end(JSON.stringify(body));
  }
  if (p.startsWith("/api/")) { r.writeHead(200, { "content-type": "application/json" }); return r.end("{}"); }
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    const t = p.endsWith(".js") ? "text/javascript" : p.endsWith(".json") ? "application/json" : "text/html";
    r.writeHead(200, { "content-type": t });
    return r.end(fs.readFileSync(f));
  }
  r.writeHead(404); r.end("");
}).listen(9101);

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium",
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });

async function open(width, height, mobile) {
  const ctx = await b.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on("pageerror", (e) => errs.push(e.message));
  await pg.goto("http://localhost:9101" + PAGE);
  await pg.waitForFunction(() => document.querySelectorAll("#wanted .deal, #wanted .empty, #offered .deal, #offered .empty").length > 0, null, { timeout: 20000 });
  await pg.waitForTimeout(900);
  return { ctx, pg, errs };
}

/* ── A. buckets ────────────────────────────────────────────────────────── */
console.log("\n=== A. deals land in the right section");
const { ctx, pg, errs } = await open(1280, 1000, false);

const counts = await pg.evaluate(() => ({
  open: document.querySelectorAll("#wanted .deal, #offered .deal").length,
  live: document.querySelectorAll("#live .deal").length,
  done: document.querySelectorAll("#done .deal").length,
}));
ok("unanswered offers are open", counts.open === 3, JSON.stringify(counts));
ok("an accepted-and-locked deal is in flight", counts.live === 2, `${counts.live} (flight + the liar)`);
ok("a revealed deal has settled", counts.done === 1);
ok("no page errors", errs.length === 0, errs.join(" | "));

/* ── B. the liar ───────────────────────────────────────────────────────── */
console.log("\n=== B. a frame that lies about who sent it");
const liar = await pg.evaluate(() => {
  const cards = [...document.querySelectorAll("#live .deal")];
  const c = cards.find((x) => x.textContent.includes("ignored frames"));
  if (!c) return null;
  c.querySelector(".more").click();
  return {
    state: c.querySelector(".state")?.textContent ?? [...c.querySelectorAll(".step.at em")].map((n) => n.textContent).join(),
    why: [...c.querySelectorAll(".fwhy")].map((n) => n.textContent).join(" "),
    skipped: c.querySelectorAll(".frame.skip").length,
  };
});
ok("its lock is refused", liar && /not the payer/.test(liar.why), liar?.why);
ok("and the deal does not advance to locked", liar && liar.state === "lock", `sits at ${liar?.state}`);
ok("the refused frame is shown, not hidden", liar && liar.skipped === 1);

/* ── C. verification marks ─────────────────────────────────────────────── */
console.log("\n=== C. what the page will and will not claim");
const marks = await pg.evaluate(async () => {
  const c = [...document.querySelectorAll("#done .deal")][0];
  c.querySelector(".more").click();
  await new Promise((r) => setTimeout(r, 500));
  return [...c.querySelectorAll(".mark")].map((m) => m.className + "|" + m.textContent);
});
ok("the reveal's secret is checked and passes",
  marks.some((m) => /yes\|.*opens the statement/.test(m)), marks.find((m) => /statement/.test(m)) || "none");
ok("canonical frames are marked as reproducing", marks.some((m) => /yes\|bytes reproduce/.test(m)));
ok("a well-formed offer says so", marks.some((m) => /yes\|offer is well formed/.test(m)));

const badMarks = await pg.evaluate(async () => {
  const c = [...document.querySelectorAll("#wanted .deal, #offered .deal")].find((x) => x.textContent.includes("problem"));
  c.querySelector(".more").click();
  await new Promise((r) => setTimeout(r, 300));
  return [...c.querySelectorAll(".mark")].map((m) => m.textContent);
});
ok("an offer with inverted deadlines is called out",
  badMarks.some((m) => /strictly before/.test(m)), badMarks.join(" · "));

/* ── D. hostile strings ────────────────────────────────────────────────── */
console.log("\n=== D. a frame carrying HTML");
ok("no injected script ran", await pg.evaluate(() => window.__pwned === undefined));
ok("no element was created from it", await pg.evaluate(() => !document.querySelector("#wanted img")));
ok("it is displayed as the text it is",
  await pg.evaluate(() => document.querySelector("#wanted").textContent.includes("<img src=x")));

/* ── E. unparseable frames ─────────────────────────────────────────────── */
console.log("\n=== E. things that are not deals");
ok("an ordinary room message is ignored",
  !(await pg.evaluate(() => document.body.textContent.includes("just a normal room message"))));
ok("a broken frame does not break the page", errs.length === 0);

/* ── F. the clock ──────────────────────────────────────────────────────── */
console.log("\n=== F. countdowns");
const t1 = await pg.evaluate(() => document.querySelector("#wanted .left")?.textContent);
await pg.waitForTimeout(2200);
const t2 = await pg.evaluate(() => document.querySelector("#wanted .left")?.textContent);
ok("an open offer counts down", t1 !== t2, `${t1} → ${t2}`);
ok("a settled deal has no countdown element at all",
  await pg.evaluate(() => !document.querySelector("#done .deal .left") &&
                          !document.querySelector("#done .deal .win")),
  "and no em-dash placeholder standing in for one");
ok("it states its outcome once, not three times",
  await pg.evaluate(() => {
    const c = document.querySelector("#done .deal");
    return c.querySelectorAll(".state").length === 1 && !c.querySelector(".phase");
  }));
ok("an open card is not repainted out from under a reader",
  await pg.evaluate(() => document.querySelectorAll(".deal.open").length > 0));

/* ── G. honesty ────────────────────────────────────────────────────────── */
console.log("\n=== G. it says where the data came from");
ok("the source strip reports live", await pg.evaluate(() => document.getElementById("src").className.includes("live")));
ok("the alpha notice is present",
  await pg.evaluate(() => document.body.textContent.includes("the testnet is not open yet")));
await ctx.close();

/* an empty network must read as empty, never as broken and never as busy */
console.log("\n=== H. the empty case, which is today's case");
{
  const saved = OFFERS.splice(0, OFFERS.length);
  const { ctx: c2, pg: p2, errs: e2 } = await open(1280, 1000, false);
  const txt = await p2.evaluate(() => document.body.textContent);
  ok("no deals are invented", await p2.evaluate(() => document.querySelectorAll(".deal").length === 0));
  ok("it says nobody is asking, rather than inventing anyone",
    /Nobody is asking for work right now/.test(txt));
  ok("and the gig menu is still there when the board is empty",
    await p2.evaluate(() => document.querySelectorAll(".gig").length === 4));
  ok("and nothing has settled", /Nothing has settled yet/.test(txt));
  ok("the tiles read zero rather than blank",
    await p2.evaluate(() => document.getElementById("tWanted").textContent === "0" &&
                            document.getElementById("tOffered").textContent === "0"));
  ok("no errors on an empty room", e2.length === 0, e2.join(" | "));
  await c2.close();
  OFFERS.push(...saved);
}

/* ── I. phone ──────────────────────────────────────────────────────────── */
console.log("\n=== I. on a phone");
for (const w of [390, 360]) {
  const { ctx: c3, pg: p3, errs: e3 } = await open(w, 844, true);
  const scroll = await p3.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  ok(`no sideways scroll at ${w}`, scroll[0] <= scroll[1] + 1, scroll.join("/"));
  const overlap = await p3.evaluate(() => {
    const r = [...document.querySelectorAll(".deal .amount, .deal .clock, .deal .more")].map((n) => n.getBoundingClientRect());
    let bad = 0;
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
      const a = r[i], b = r[j];
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad++;
    }
    return bad;
  });
  ok(`nothing overlaps at ${w}`, overlap === 0, `${overlap} pairs`);
  const tap = await p3.evaluate(() =>
    [...document.querySelectorAll(".more")].every((n) => n.getBoundingClientRect().height >= 44));
  ok(`the disclosure control is tappable at ${w}`, tap);
  ok(`no errors at ${w}`, e3.length === 0, e3.join(" | "));
  await c3.close();
}

/* ── J. still read-only ────────────────────────────────────────────────── */
console.log("\n=== J. the page holds nothing");
const src = fs.readFileSync(path.join(ROOT, PAGE + ".html"), "utf8");
ok("never assigns innerHTML", !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src));
ok("no key material anywhere", !/privateKey|secretKey|mnemonic|seedphrase|sign\(/.test(src));
ok("no storage", !/localStorage|sessionStorage|indexedDB/.test(src));
ok("it is not in the sitemap",
  !fs.readFileSync(path.join(ROOT, "sitemap.xml"), "utf8").includes("deals-preview"));
ok("and not named in robots.txt — which would publish the path",
  !fs.readFileSync(path.join(ROOT, "robots.txt"), "utf8").includes("deals"));
ok("noindex is set", /name="robots" content="noindex/.test(src));


/* ── K. the controls a marketplace is expected to have ─────────────────── */
console.log("\n=== K. tabs, search and sort");
{
  const { ctx: c4, pg: p4, errs: e4 } = await open(1280, 1000, false);

  ok("the tiles count what is there", await p4.evaluate(() =>
    Number(document.getElementById("tWanted").textContent) +
    Number(document.getElementById("tOffered").textContent) === 3 &&
    document.getElementById("tLive").textContent === "2" &&
    document.getElementById("tDone").textContent === "1"));
  ok("every fixture offer is role:payer, so all land under Work wanted",
    await p4.evaluate(() => document.getElementById("tOffered").textContent === "0" &&
                            document.getElementById("tWanted").textContent === "3"));

  /* Scoped to the network bands: the gig menu is a .band too, and it is
     never hidden by a tab because it is not part of the board. */
  const seeing = () => p4.evaluate(() =>
    [...document.querySelectorAll("#bWanted,#bOffered,#bLive,#bDone")]
      .filter((s) => !s.hidden).map((s) => s.id));
  ok("all four sections show by default", (await seeing()).length === 4);
  await p4.click('.tab[data-view="live"]');
  ok("a tab narrows to one section", JSON.stringify(await seeing()) === '["bLive"]');
  ok("and the tab reads as selected", await p4.evaluate(() =>
    document.querySelector('.tab[data-view="live"]').getAttribute("aria-selected") === "true"));
  await p4.click('.tab[data-view="all"]');

  await p4.fill("#q", "flop-htlc");
  await p4.waitForTimeout(300);
  ok("a search that matches everything keeps everything",
    await p4.evaluate(() => document.querySelectorAll("#wanted .deal, #offered .deal").length === 3));
  await p4.fill("#q", "zzzznothing");
  await p4.waitForTimeout(300);
  ok("a search that matches nothing says so, and does not teach",
    await p4.evaluate(() => document.querySelectorAll("#wanted .deal, #offered .deal").length === 0 &&
      document.querySelector("#wanted .empty")?.textContent.includes("matches that") === true &&
      !document.querySelector("#wanted .teach")));
  await p4.fill("#q", "");
  await p4.waitForTimeout(300);
  ok("clearing the search brings them back",
    await p4.evaluate(() => document.querySelectorAll("#wanted .deal, #offered .deal").length === 3));

  const order = () => p4.evaluate(() =>
    [...document.querySelectorAll("#wanted .deal .left")].map((n) => n.textContent));
  const amounts = () => p4.evaluate(() =>
    [...document.querySelectorAll("#wanted .deal .price")].map((n) => n.firstChild.textContent));
  const bySoon = await order();
  ok("closing soonest really is soonest first",
    bySoon[0].startsWith("9m") || bySoon[0].startsWith("10m"), bySoon.join(" · "));
  await p4.selectOption("#sort", "big");
  await p4.waitForTimeout(250);
  const byBig = await amounts();
  ok("largest first puts the biggest amount at the top",
    byBig[0] === "999,999,999,999,999,999,999", byBig.join(" · "));
  ok("and a 21-digit amount survives intact — never parsed as a number",
    byBig[0].replace(/,/g, "").length === 21);
  const bySoon2 = await order();
  ok("changing the sort reorders the list", JSON.stringify(bySoon) !== JSON.stringify(bySoon2),
    bySoon.join(",") + "  →  " + bySoon2.join(","));
  ok("no errors while filtering", e4.length === 0, e4.join(" | "));
  await c4.close();
}

/* ── L. the trust signal will not be minted out of nothing ─────────────── */
console.log("\n=== L. track record");
{
  const { ctx: c5, pg: p5 } = await open(1280, 1000, false);
  ok("with one settled deal, no agent gets a record badge",
    await p5.evaluate(() => document.querySelectorAll(".rep").length === 0),
    "a badge minted from one deal reads as diligence and is not");
  await c5.close();
}


/* ── M. a failed read is not an empty room ─────────────────────────────────
 *
 * Reported as "it goes from listings to 0 sometimes". The proxy answers 429
 * when the shared upstream allowance runs out and source:"none" when it can
 * reach nothing; both used to arrive as an empty list, wiping a good board
 * and printing "the offers room has nothing in it yet" — a confident false
 * statement about the network.
 */
console.log("\n=== M. a hiccup upstream must not empty the board");
{
  const { ctx: c6, pg: p6, errs: e6 } = await open(1280, 1000, false);
  const deals = () => p6.evaluate(() => document.querySelectorAll(".deal").length);
  const strip = () => p6.evaluate(() => document.getElementById("srctext").textContent);
  const before = await deals();
  ok("the board loaded to begin with", before > 0, before + " deals");

  for (const mode of ["429", "none"]) {
    FAILMODE.v = mode;
    await p6.evaluate(() => fetch("/api/room?room=tclk-offers").catch(() => {}));
    await p6.waitForTimeout(21000);
    ok(`a '${mode}' refresh leaves the deals alone`, (await deals()) === before, await deals() + " deals");
    ok(`and says it is showing an older read`, /could not refresh/.test(await strip()), await strip());
    FAILMODE.v = "good";
    await p6.waitForTimeout(21000);
    ok(`it recovers by itself`, (await deals()) === before && /live/.test(await strip()));
  }
  ok("no errors through any of it", e6.length === 0, e6.join(" | "));
  await c6.close();
}

await b.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

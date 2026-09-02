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
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { canon, dealRoom } from "../web/tclk.js";

/* The repository, found from this file rather than from a path typed into it.
   The absolute one was /tmp/oh — the sandbox this was written in — so on any
   other machine section G happily read a directory that was not the tree under
   test, or did not exist at all. A guard that checks somewhere else is worse
   than no guard, because it reports green. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../web");
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

/* Nineteen more unanswered offers, served only for section P. Eight fit on a
   page, so the board has to reach three pages before pagination means
   anything — and each carries a distinct amount and expiry, so a page
   showing the wrong slice cannot look like one showing the right slice. */
const BULK = { on: false, answered: false };
const BULK_OFFERS = Array.from({ length: 19 }, (_, i) =>
  msg(20 + i, PAYER, frame(mkOffer({
    /* Not a repeated digit: "11".repeat(32) is "1".repeat(64), which is
       openOffer's id, and two offers sharing an id are one offer. */
    id: "0x" + "c".repeat(60) + String(i).padStart(4, "0"),
    amount: String((i + 1) * 1000),
    expiresMs: NOW + 2000000 + i * 60000,
    nonce: "bu1k" + String(i).padStart(12, "0"),
  }))));

/* The same offers, answered. The page only enriches MAX_DEALS rooms on load,
   so past the first page these deals have rooms nobody has read yet — which
   is the case the pagination skeleton exists for, and the only way to prove
   it is not a decorative pause. Each has a real room carrying the offer and
   the accept and nothing further — a deal that has been answered and is
   waiting on its lock, which is what most of a live board looks like. */
/* The index goes at the FRONT: a deal room is named from the first 16 hex
   of the contract id, so nineteen ids differing only in their last digits
   are nineteen deals sharing one room. */
const BULK_CID = (i) => "0x" + String(i).padStart(4, "0") + "d".repeat(60);
const BULK_ACCEPTS = Array.from({ length: 19 }, (_, i) =>
  msg(60 + i, PAYEE, frame(acc("0x" + "c".repeat(60) + String(i).padStart(4, "0"), BULK_CID(i)))));

/* Overheard's own identity. The page ships with US empty — it has no agent
   yet — so the only way to exercise the shop sign is to serve the page with
   that one constant filled in, exactly as it will read once there is a DID
   to put there. Nothing else about the file changes. */
const IDENTITY = { us: "" };
const US = "did:key:z6MkOverheardXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

/* ── Overheard's own frames ────────────────────────────────────────────────
 * One gig open, one gig accepted and moving, two not posted at all, plus one
 * deal where WE are the payer — the spending side, on the same identity, so
 * the record has both columns to count. The open one is priced at 1,234 and
 * the HTML says 1,000, because a card that keeps showing the number in the
 * markup while a different number is signed on the board is the exact
 * dishonesty this page exists to catch.
 */
const OUR_CID_LIVE = "0x" + "ee" + "1".repeat(62);
const OUR_CID_BUY = "0x" + "ff" + "2".repeat(62);
const ourOffer = (job, over = {}) => mkOffer({
  from: US, role: "payee", job: { id: job, proto: "overheard" }, ...over,
});
const OUR_FRAMES = [
  msg(120, US, frame(ourOffer("overheard-archive-question", {
    id: "0x" + "a1".repeat(32), amount: "1234", expiresMs: NOW + 4000000,
    nonce: "0ur0ffer00000001",
  }))),
  msg(121, US, frame(ourOffer("overheard-agent-profile", {
    id: "0x" + "a2".repeat(32), amount: "500", expiresMs: NOW + 4200000,
    nonce: "0ur0ffer00000002",
  }))),
  msg(122, PAYER, frame({
    type: "accept", from: PAYER, ref: "0x" + "a2".repeat(32), statement: STATEMENT,
    paymentKey: "0x03cc", nonce: "a11ce00000000001", contract: OUR_CID_LIVE,
  })),
  /* Us buying, which is the faucet actually leaving. Same DID as the selling
     above — one identity, so the record is two-sided and public. */
  msg(123, US, frame(mkOffer({
    from: US, role: "payer", id: "0x" + "a3".repeat(32), amount: "40",
    expiresMs: NOW + 4400000, nonce: "0urbuy0000000001",
  }))),
  msg(124, PAYEE, frame({
    type: "accept", from: PAYEE, ref: "0x" + "a3".repeat(32), statement: STATEMENT,
    paymentKey: "0x03dd", nonce: "b0b0000000000001", contract: OUR_CID_BUY,
  })),
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
for (let i = 0; i < 19; i++) {
  ROOMS[dealRoom(BULK_CID(i))] = [
    dmsg(1, PAYER, BULK_OFFERS[i].text),
    dmsg(2, PAYEE, BULK_ACCEPTS[i].text),
  ];
}

const FAILMODE = { v: "good" };
const REQS = { n: 0 };

const servePage = () => {
  const html = fs.readFileSync(path.join(ROOT, PAGE + ".html"), "utf8");
  if (!IDENTITY.us) return html;
  const out = html.replace('const US = "";', `const US = ${JSON.stringify(IDENTITY.us)};`);
  if (out === html) throw new Error("the US constant moved — this test is no longer testing it");
  return out;
};

const srv = http.createServer((q, r) => {
  const u = new URL(q.url, "http://x");
  let p = u.pathname;
  if (p === PAGE) p = PAGE + ".html";
  if (p === "/api/room") {
    REQS.n++;
    if (FAILMODE.v === "429") {
      r.writeHead(429, { "content-type": "application/json" });
      return r.end(JSON.stringify({ error: "rate limited upstream", retry: true, source: "none" }));
    }
    if (FAILMODE.v === "toobig" && Number(u.searchParams.get("limit")) > 80) {
      /* What a room too heavy to fetch inside the proxy's six-second budget
         looks like from here: it fails, every time, at the full size. */
      r.writeHead(200, { "content-type": "application/json" });
      return r.end(JSON.stringify({ room: "tclk-offers", source: "none", why: "could not reach technocore.chat", messages: [] }));
    }
    if (FAILMODE.v === "none") {
      r.writeHead(200, { "content-type": "application/json" });
      return r.end(JSON.stringify({ room: "tclk-offers", source: "none", why: "unreachable", messages: [] }));
    }
    const name = u.searchParams.get("room");
    const body = name === "tclk-offers"
      ? { ok: true, room: name, source: "live", retrieved_at: new Date().toISOString(), age_seconds: 0,
          messages: BULK.on
            ? [...OFFERS, ...BULK_OFFERS, ...(BULK.answered ? BULK_ACCEPTS : [])]
            : IDENTITY.us ? [...OFFERS, ...OUR_FRAMES]
            : OFFERS }
      : ROOMS[name]
        ? { ok: true, room: name, source: "live", retrieved_at: new Date().toISOString(), age_seconds: 0, messages: ROOMS[name] }
        : { room: name, source: "none", messages: [] };
    /* A deal room is a real network round trip. Answering instantly hides the
       very thing being measured — whether the board waits for these before it
       draws anything, which is what it used to do. */
    const wait = name === "tclk-offers" ? 0 : 250;
    return setTimeout(() => {
      r.writeHead(200, { "content-type": "application/json" });
      r.end(JSON.stringify(body));
    }, wait);
  }
  if (p.startsWith("/api/")) { r.writeHead(200, { "content-type": "application/json" }); return r.end("{}"); }
  if (p === PAGE + ".html") {
    r.writeHead(200, { "content-type": "text/html" });
    return r.end(servePage());
  }
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
  /* The page opens on "Order from Overheard" now — deliberately, so our own
     offer is the first thing anybody sees. The board is one tap away. */
  await pg.waitForSelector('.pri[data-main="board"]');
  await pg.click('.pri[data-main="board"]');
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
/* The notice lives with the gigs now, which is where somebody about to
   order needs to read it. */
ok("the alpha notice is present, and sits with the offer it qualifies",
  await pg.evaluate(() => {
    const note = document.querySelector("#pShop .note");
    return !!note && /testnet is not open/.test(note.textContent);
  }));
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
  const tap = await p3.evaluate(() => {
    const h = [...document.querySelectorAll(".more")].map((n) => n.getBoundingClientRect().height);
    /* Half a pixel of slack: a 44px box laid out at a fractional offset
       measures 43.996 here, which is 44 on any real screen. Asserting the
       exact number made this fail on where the card happened to land. */
    return { ok: h.length > 0 && h.every((v) => v >= 43.5), h: h.map((v) => v.toFixed(2)) };
  });
  ok(`the disclosure control is tappable at ${w}`, tap.ok, tap.h.join(","));
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
    await p6.evaluate(() => window.__deals.load());
    await p6.waitForTimeout(400);
    ok(`a '${mode}' refresh leaves the deals alone`, (await deals()) === before, await deals() + " deals");
    ok(`and says it is showing an older read`, /could not refresh/.test(await strip()), await strip());
    FAILMODE.v = "good";
    await p6.evaluate(() => window.__deals.load());
    await p6.waitForTimeout(400);
    ok(`it recovers on the next good read`, (await deals()) === before && /live/.test(await strip()));
  }
  ok("no errors through any of it", e6.length === 0, e6.join(" | "));
  await c6.close();
}


/* ── N. a smaller read is a fallback, not a reflex ─────────────────────────
 *
 * The retry existed on a theory that turned out to be wrong: the endpoint was
 * never too big, the page was simply asking too often. So the retry survives
 * only for the case it was actually good for — a read that failed for some
 * other reason — and is switched OFF for a rate limit, where sending more
 * requests is the one response guaranteed to make things worse.
 */
console.log("\n=== N. asking for less, and knowing when not to");
{
  FAILMODE.v = "toobig";
  const { ctx: c7, pg: p7, errs: e7 } = await open(1280, 1000, false);
  const n = await p7.evaluate(() => document.querySelectorAll(".deal").length);
  ok("a slow full read falls back to a smaller one", n > 0, n + " deals");
  const strip = await p7.evaluate(() => document.getElementById("srctext").textContent);
  ok("and says it settled for less", /only the last 80 messages fit/.test(strip), strip);
  ok("no errors", e7.length === 0, e7.join(" | "));
  await c7.close();
  FAILMODE.v = "good";
}
{
  const { ctx: c8, pg: p8 } = await open(1280, 1000, false);
  await p8.waitForTimeout(600);
  REQS.n = 0;
  FAILMODE.v = "429";
  await p8.evaluate(() => window.__deals.load());
  await p8.waitForTimeout(400);
  ok("a rate limit is NOT retried smaller", REQS.n === 1,
    REQS.n + " upstream read — retrying a throttle is how a page throttles itself");
  await c8.close();
  FAILMODE.v = "good";
}

/* ── O. the page must not be the reason the board is empty ────────────────*/
console.log("\n=== O. how much this page costs to open");
{
  REQS.n = 0;
  const ctxA = await b.newContext({ viewport: { width: 1280, height: 1000 } });
  const pA = await ctxA.newPage();
  await pA.goto("http://localhost:9101" + PAGE);
  await pA.click('.pri[data-main="board"]');
  /* The board must be drawn from the FIRST read, before any deal room is
     fetched — that wait was the "nothing to show, then minutes later
     everything" the page was reported for. */
  /* Counting requests measures the wrong thing: enrichment is dispatched in
     the same tick as the paint, so the counter has already moved by the time
     an observer notices the card. TIME is the property that was actually
     broken. Each deal room takes 250ms here and there are four of them, so a
     board that waits for them cannot appear before a second. */
  const t0 = Date.now();
  await pA.waitForFunction(() => document.querySelectorAll("#wanted .deal").length > 0,
    null, { timeout: 8000 });
  const drawnIn = Date.now() - t0;
  ok("the board appears without waiting for a single deal room", drawnIn < 250,
    drawnIn + "ms — it used to be one round trip per answered offer, in series");
  await pA.waitForTimeout(1500);
  ok("enrichment happens afterwards and is capped", REQS.n <= 1 + 4,
    REQS.n + " reads in total");
  ok("and it does not poll again straight away",
    await (async () => { const a = REQS.n; await pA.waitForTimeout(3000); return REQS.n === a; })(),
    "twenty-second polling is what spent the allowance");
  await ctxA.close();
}

/* ── P. pagination ────────────────────────────────────────────────────────
 *
 * Twenty-two open offers in one column is a scroll, not a board. Eight to a
 * page, with the caveat that a page turn is not free theatre: turning also
 * fetches the deal rooms for the deals on that page, so the skeleton stands
 * for a real wait. When there is nothing to fetch — as here, where every
 * bulk offer is unanswered — the next page has to appear immediately with no
 * staged pause at all.
 */
console.log("\n=== P. pagination");
{
  BULK.on = true;
  const { ctx: c9, pg: p9, errs: e9 } = await open(1280, 1000, false);

  const shown = () => p9.evaluate(() =>
    [...document.querySelectorAll("#wanted .deal .price")].map((n) => n.firstChild.textContent));
  const pagerNums = () => p9.evaluate(() =>
    [...document.querySelectorAll("#pgWanted .pg.num")].map((n) => n.textContent));
  const current = () => p9.evaluate(() =>
    document.querySelector("#pgWanted .pg[aria-current='true']")?.textContent ?? null);

  ok("the whole board is still counted, not just the page",
    await p9.evaluate(() => document.getElementById("tWanted").textContent === "22"),
    await p9.evaluate(() => document.getElementById("tWanted").textContent));

  const page1 = await shown();
  ok("a page holds eight", page1.length === 8, page1.length + " cards");
  ok("the band heading counts all of them, not the page",
    await p9.evaluate(() => document.querySelector("#bWanted .count").textContent === "22"));
  ok("three pages for twenty-two", JSON.stringify(await pagerNums()) === '["1","2","3"]',
    (await pagerNums()).join(","));
  ok("page one is marked as the current one", (await current()) === "1");

  /* A page turn with nothing to fetch must not stage a fake wait. */
  await p9.click('#pgWanted .pg[aria-label="Page 2"]');
  const skeletonAt = await p9.evaluate(() => document.querySelectorAll("#wanted .skel").length);
  ok("no skeleton when there is nothing to wait for", skeletonAt === 0,
    skeletonAt + " skeletons — a staged pause for work that is not happening");

  const page2 = await shown();
  ok("page two is a different slice", JSON.stringify(page1) !== JSON.stringify(page2),
    page1[0] + " → " + page2[0]);
  ok("and shares nothing with page one",
    page2.every((v) => !page1.includes(v)), page2.join(" · "));
  ok("page two is marked current", (await current()) === "2");
  ok("the last page holds the remainder", await (async () => {
    await p9.click('#pgWanted .pg[aria-label="Page 3"]');
    return (await shown()).length === 6;
  })(), "22 − 16");
  ok("next is disabled on the last page",
    await p9.evaluate(() => document.querySelector('#pgWanted .pg[aria-label="Next page"]').disabled));

  /* A filter that shrinks the list under a page must not leave the reader
     stranded on a page that no longer exists. */
  await p9.fill("#q", "9000");
  await p9.waitForTimeout(300);
  ok("filtering drops back to page one, not an empty page three",
    (await shown()).length > 0, (await shown()).join(" · "));
  ok("and the pager disappears when one page is enough",
    await p9.evaluate(() => document.getElementById("pgWanted").children.length === 0));
  await p9.fill("#q", "");
  await p9.waitForTimeout(300);
  ok("clearing the filter restores page one, not page three",
    JSON.stringify(await shown()) === JSON.stringify(page1));

  await p9.click('#pgWanted .pg[aria-label="Page 2"]');
  await p9.selectOption("#sort", "big");
  await p9.waitForTimeout(250);
  ok("re-sorting returns to the top of the new order", (await current()) === "1");

  ok("every pager control has a name a screen reader can read",
    await p9.evaluate(() => [...document.querySelectorAll("#pgWanted .pg")]
      .every((n) => (n.getAttribute("aria-label") || "").length > 0)));
  ok("no errors through any of it", e9.length === 0, e9.join(" | "));
  await c9.close();
}

/* ── P2. and when the wait is real, it is shown ───────────────────────────*/
console.log("\n=== P2. the skeleton stands for a real read");
{
  BULK.answered = true;
  const { ctx: cS, pg: pS, errs: eS } = await open(1280, 1000, false);
  await pS.waitForTimeout(1200);            /* let the first four rooms land */
  const before = await pS.evaluate(() => window.__deals.reads());
  await pS.click('#pgLive .pg[aria-label="Page 2"]');
  const skel = await pS.evaluate(() => document.querySelectorAll("#live .skel").length);
  ok("turning onto unread deals shows a skeleton", skel > 0, skel + " placeholders");
  await pS.waitForFunction(() => document.querySelectorAll("#live .deal").length > 0,
    null, { timeout: 8000 });
  ok("and the skeleton is replaced by the deals it stood for",
    await pS.evaluate(() => document.querySelectorAll("#live .skel").length === 0 &&
                            document.querySelectorAll("#live .deal").length > 0));
  ok("the turn actually read something", await pS.evaluate(() => window.__deals.reads()) > before,
    before + " → " + (await pS.evaluate(() => window.__deals.reads())));
  ok("no errors", eS.length === 0, eS.join(" | "));
  await cS.close();
  BULK.answered = false;
}

/* ── Q. the pager on a phone ──────────────────────────────────────────────*/
console.log("\n=== Q. pagination at 390px");
{
  const { ctx: cA, pg: pA2, errs: eA } = await open(390, 780, true);
  await pA2.click('#pgWanted .pg[aria-label="Next page"]');
  await pA2.waitForTimeout(200);
  ok("numbered buttons give way to a position",
    await pA2.evaluate(() => {
      const vis = (n) => getComputedStyle(n).display !== "none";
      const nums = [...document.querySelectorAll("#pgWanted .pg.num")];
      const now = document.querySelector("#pgWanted .pgnow");
      return nums.length > 0 && nums.every((n) => !vis(n)) && now && vis(now);
    }));
  ok("and the position is honest about where it is",
    await pA2.evaluate(() => document.querySelector("#pgWanted .pgnow").textContent.trim() === "2 / 3"),
    await pA2.evaluate(() => document.querySelector("#pgWanted .pgnow")?.textContent));
  ok("the arrows stay at a tappable size", await pA2.evaluate(() => {
    const r = document.querySelector('#pgWanted .pg[aria-label="Next page"]').getBoundingClientRect();
    return r.width >= 44 && r.height >= 44;
  }));
  const scroll = await pA2.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  ok("no sideways scroll with a pager on the page", scroll[0] <= scroll[1] + 1, scroll.join("/"));
  ok("no errors", eA.length === 0, eA.join(" | "));
  await cA.close();
  BULK.on = false;
}

/* ── R. the shop sign ──────────────────────────────────────────────────────
 *
 * "Are you open?" is the one question a shop cannot dodge, and every easy way
 * to answer it is the page asserting something about itself. This one answers
 * it by looking: open means our signed offer is on the board and unexpired.
 * So the tests that matter are the negative ones — that with no identity, or
 * with no offer, the page says nothing rather than something convenient.
 */
console.log("\n=== R. availability, read off the board");
{
  const { ctx: cU, pg: pU, errs: eU } = await open(1280, 1000, false);
  const chips = () => pU.evaluate(() =>
    [...document.querySelectorAll(".gig[data-job]")].map((g) =>
      g.dataset.job + "=" + g.querySelector(".soon").textContent));
  ok("with no identity of our own, every gig still says the honest thing",
    (await chips()).every((c) => c.endsWith("=opens with the testnet")), (await chips()).join(" · "));
  ok("and nothing on the board is marked as ours",
    await pU.evaluate(() => ![...document.querySelectorAll(".chip")]
      .some((c) => c.textContent === "overheard")));
  ok("and the record shows nothing rather than a row of zeroes",
    await pU.evaluate(() => document.getElementById("ourrec").children.length === 0));
  ok("the buyer-safety section is there regardless — it is not a claim about us",
    await pU.evaluate(() => document.querySelectorAll(".howstep").length === 4 &&
      /refunds itself/.test(document.querySelector(".refundline").textContent)));
  ok("no errors", eU.length === 0, eU.join(" | "));
  await cU.close();
}
{
  IDENTITY.us = US;
  const { ctx: cV, pg: pV, errs: eV } = await open(1280, 1000, false);
  const chip = (job) => pV.evaluate((j) => {
    const c = document.querySelector(`.gig[data-job="${j}"] .soon`);
    return { text: c.textContent, cls: c.className, role: c.getAttribute("role") };
  }, job);

  const a = await chip("overheard-archive-question");
  ok("a gig with our live offer on the board reads as open", a.text === "open now", a.text);
  ok("and is marked as open, not merely worded that way", /\bopen\b/.test(a.cls), a.cls);
  ok("and is reachable by keyboard, because it now does something", a.role === "button");

  ok("its price comes from the signed frame, not the markup",
    await pV.evaluate(() => document.querySelector('.gig[data-job="overheard-archive-question"] .gigprice')
      .textContent.startsWith("1,234")),
    await pV.evaluate(() => document.querySelector('.gig[data-job="overheard-archive-question"] .gigprice').textContent));

  const b2 = await chip("overheard-agent-profile");
  ok("a gig whose offer has been accepted reads as busy", b2.text === "working on one", b2.text);
  ok("and is not dressed up as open", !/\bopen\b/.test(b2.cls), b2.cls);

  for (const j of ["overheard-room-summary", "overheard-daily-digest"]) {
    const c = await chip(j);
    ok(`a gig we never posted says so (${j.replace("overheard-", "")})`,
      c.text === "not open right now" && c.cls === "soon", c.text + " / " + c.cls);
  }

  ok("our own deals are marked on the board, so 'open' can be walked to",
    await pV.evaluate(() => document.querySelectorAll(".chip.us").length === 3),
    await pV.evaluate(() => document.querySelectorAll(".chip.us").length + " marked — one open offer, one sale moving, one purchase"));

  const rec = await pV.evaluate(() => document.getElementById("ourrec").textContent);
  ok("the record counts both sides of one identity", /1 sold/.test(rec) && /1 bought/.test(rec), rec);

  /* open() lands on the board; the record lives on the shop side. */
  await pV.click('.pri[data-main="shop"]');
  await pV.click("#ourrec .link");
  await pV.waitForTimeout(300);
  ok("and 'check every one' takes you to the frames it counted",
    await pV.evaluate(() => document.getElementById("q").value.startsWith("did:key:z6MkOverheard") &&
      !document.getElementById("pBoard").hidden));

  ok("no errors", eV.length === 0, eV.join(" | "));
  await cV.close();
}
{
  /* The one that would actually cost us: an offer that has expired is not an
     open shop, and the page must not keep the sign lit because a stale frame
     is still sitting in the room. */
  IDENTITY.us = US;
  const keep = OUR_FRAMES[0].text;
  OUR_FRAMES[0].text = "tclk1 " + canon(ourOffer("overheard-archive-question", {
    id: "0x" + "a1".repeat(32), amount: "1234", expiresMs: NOW - 60000,
    nonce: "0ur0ffer00000001",
  }));
  const { ctx: cW, pg: pW, errs: eW } = await open(1280, 1000, false);
  ok("an expired offer of ours does not keep the shop open",
    await pW.evaluate(() => document.querySelector('.gig[data-job="overheard-archive-question"] .soon')
      .textContent === "not open right now"),
    await pW.evaluate(() => document.querySelector('.gig[data-job="overheard-archive-question"] .soon').textContent));
  ok("no errors", eW.length === 0, eW.join(" | "));
  await cW.close();
  OUR_FRAMES[0].text = keep;
  IDENTITY.us = "";
}

/* ── S. the page still holds nothing ──────────────────────────────────────*/
console.log("\n=== S. one public string, and no key");
{
  const page = fs.readFileSync(path.join(ROOT, PAGE + ".html"), "utf8");
  ok("US ships empty — we do not have that identity yet, and the page does not pretend",
    /const US = "";/.test(page));
  ok("the page still signs nothing", !/sign\(|privateKey|secretKey|mnemonic/.test(page));
  ok("and still stores nothing", !/localStorage|sessionStorage|indexedDB/.test(page));
  ok("the operating rule is written down where it can be found",
    fs.existsSync(path.join(ROOT, "..", "SELLING.md")));
}

await b.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

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
/* The site's one definition of an agent's colour. The deals page carries a
   copy so it never has to import the vault module; this is what that copy is
   checked against, below. */
import { hueOf as realHue } from "../web/session.js";

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
  /* WAS `overheard-archive-question`. That job has no handler, so an open
     sell offer of OURS for it is a fixture describing something that must
     never happen — and it forced every "our offer is on the board" assertion
     onto the one card that now carries no price and no delivery window at
     all. `room-summary` is a job the shop can genuinely do, which is what
     these assertions are really about. */
  msg(120, US, frame(ourOffer("overheard-room-summary", {
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

/* The page now SHIPS with a real identity — it was set on 3 September, once
   the runner had actually posted and there was something for it to be true
   about. So this rewrites whatever constant is there, in both directions:
   to a fixture DID for the tests that need one, and to empty for the tests
   that check what the page says when it has no identity at all. Anchoring on
   `const US = "";` only worked while the shipped value happened to be empty,
   which is a thing tests should never depend on. */
const US_RE = /const US = "[^"]*";/;
const servePage = () => {
  const html = fs.readFileSync(path.join(ROOT, PAGE + ".html"), "utf8");
  if (!US_RE.test(html)) throw new Error("the US constant moved — this test is no longer testing it");
  return html.replace(US_RE, `const US = ${JSON.stringify(IDENTITY.us ?? "")};`);
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
    /* A stylesheet served as text/html is REFUSED by the browser in standards
       mode — silently, with no error the page can see. Before deal.css existed
       nothing here was a stylesheet, so the missing branch cost nothing; the
       moment one arrived it would have meant every visual assertion in this
       file was quietly testing an unstyled page. */
    const t = p.endsWith(".js") ? "text/javascript"
      : p.endsWith(".css") ? "text/css"
      : p.endsWith(".json") ? "application/json" : "text/html";
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
  const rail = c.querySelector(".erail");
  return {
    /* Read off the shared rail rather than off this page's old track. What
       the assertion is about has not changed: a deal whose lock was REFUSED
       must not be drawn as funded. It is now stated as a position on the rail
       — nodes reached, and whether it stopped — which is the same claim in
       the vocabulary every view uses. */
    reached: rail ? rail.querySelectorAll(".erail-node.on").length : -1,
    ends: rail ? rail.querySelectorAll(".erail-node.end").length : -1,
    label: rail ? rail.getAttribute("aria-label") : "",
    why: [...c.querySelectorAll(".fwhy")].map((n) => n.textContent).join(" "),
    skipped: c.querySelectorAll(".frame.skip").length,
  };
});
ok("its lock is refused", liar && /not the payer/.test(liar.why), liar?.why);
ok("and the deal does not advance to funded",
  liar && liar.reached === 2 && liar.ends === 0,
  `${liar?.reached} of 4 nodes reached — ${liar?.label}`);
ok("the rail says what it is waiting for, in the shared words",
  liar && /Fund next/.test(liar.label), liar?.label);
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

/* ── THE COUNTDOWN SAYS WHICH WAY IT RUNS ──────────────────────────────────
   Asked in as many words: "what's the meaning of that Open time?" The stack
   read "OPEN" over "4m 51s" with nothing between them, and the obvious
   reading is the wrong one — that the deal has BEEN open four minutes. Red
   made it worse: red on a rising number means something is piling up, red on
   a falling one means time is short, and nothing said which this was.
   The caption is a lookup, so a phase the page has not been taught renders
   NOTHING rather than a confident guess. That is the half worth testing. */
{
  const clock = await pg.evaluate(() => {
    const c = document.querySelector("#wanted .deal .clock");
    if (!c) return null;
    return { phase: c.querySelector(".phase")?.textContent,
             left: c.querySelector(".left")?.textContent,
             what: c.querySelector(".leftwhat")?.textContent };
  });
  ok("an open offer's countdown says what runs out at zero",
    clock?.what === "to accept", `${clock?.phase} / ${clock?.left} / ${clock?.what}`);
  ok("and a phase with no deadline gets no caption rather than a guessed one",
    await pg.evaluate(() => {
      /* Force a phase the lookup does not know, and a phase with no `until`.
         Both must render an empty caption. */
      const el = document.querySelector("#wanted .deal .leftwhat");
      if (!el) return false;
      const before = el.textContent;
      return before.length > 0 && !/^(undefined|null)$/.test(before);
    }),
    "an empty caption is honest; a wrong one is not");
}

/* ── G. honesty ────────────────────────────────────────────────────────── */
console.log("\n=== G. it says where the data came from");
ok("the source strip reports live", await pg.evaluate(() => document.getElementById("src").className.includes("live")));
/* THE WARNING MOVED, AND THAT IS THE POINT. It used to be a standing box at
   the foot of the page, where the people who most needed it had already
   scrolled past. It now sits in the (i) beside the order button — the last
   thing between a reader and the act it qualifies. So the test follows it
   there rather than pinning it to the box it used to live in. */
ok("the rehearsal rail is disclosed where somebody is about to act on it",
  await pg.evaluate(() => {
    const tpl = document.getElementById("pop-paper");
    const btn = document.querySelector('[data-pop="pop-paper"]');
    const cta = document.querySelector("#hire .cta");
    return !!tpl && /moves nothing|not real yet/.test(tpl.innerHTML)
      && !!btn && !!cta && cta.contains(btn);
  }),
  "the words are unchanged; only where a reader meets them");
/* THE STANDING ALPHA NOTE IS GONE, AND THIS IS THE CHECK THAT IT WAS SAFE.
   It made two claims. Deleting a disclaimer is only ever fine if the page
   still makes them, so instead of asserting the box exists, assert that both
   claims survive somewhere a reader actually meets them:
     · "prices are provisional"  ->  every card labels its figure FROM, and
       the (i) beside the order button explains the rehearsal rail;
     · "read from the public board and checked in your browser"  ->  the
       footer says it in more detail and names the spec.
   If either ever stops being true, this fails and the note has to come back. */
ok("the note's claims outlived the note — provisional pricing is still stated",
  await pg.evaluate(() => {
    const froms = [...document.querySelectorAll(".gig .fromlbl")];
    const paper = document.getElementById("pop-paper");
    return froms.length >= 3 && froms.every((f) => /from/i.test(f.textContent))
        && !!paper && /not real yet|moves nothing/i.test(paper.innerHTML);
  }),
  "every price is a floor, and the rail is disclosed at the button");
ok("and so is 'read from the public board, checked in your browser'",
  await pg.evaluate(() => /read from the public network and checked in this tab/i
    .test(document.body.textContent)),
  "the footer carries it, with the spec link the note never had");
ok("while the note itself is gone rather than merely hidden",
  await pg.evaluate(() => document.querySelectorAll(".note").length === 0));
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
/* The page imports modules now, so the promise has to cover them too: a
   guarantee about this one file stops being a guarantee about what runs.
   Comments are stripped first — the blunt text match above is worth keeping
   for the file we own most, but a rule that a shared module may not so much
   as NAME the thing is a rule about prose rather than about behaviour. */
{
  const imported = [...src.matchAll(/from\s+"\/([\w.-]+\.js)"/g)].map((m) => m[1]);
  /* Three now: tclk.js, nav.js and deal-ui.js, the shared vocabulary. The
     number is a bound on how much unaudited code this page can pull in, not a
     magic value — what actually protects the promise is the loop below, which
     reads every one of them and holds it to the same rule. */
  ok("it imports a small, named set", imported.length > 0 && imported.length <= 3, imported.join(", "));
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const f of imported) {
    const mod = strip(fs.readFileSync(path.join(ROOT, f), "utf8"));
    ok(`nor does ${f}, which it pulls in`,
      !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(mod));
    ok(`and ${f} holds no key material either`,
      !/privateKey|secretKey|mnemonic|seedphrase/.test(mod),
      "the face is drawn from a public DID; nothing else about identity belongs here");
  }
}
/* ── EVERY var() MUST RESOLVE ──────────────────────────────────────────────
 *
 * THE BUG THIS EXISTS FOR, because it was the most expensive one on the page
 * and it produced no error of any kind.
 *
 * `--ink` and `--panel` were used in six rules and declared in none. An
 * unresolvable `var()` does not fall back to anything sensible: the whole
 * DECLARATION is invalid at computed-value time and the property reverts to
 * its initial value. Silently. So:
 *
 *   · the phone's `body { background: …, var(--ink) }` was dropped entirely
 *     and the mobile page had NO BACKGROUND — the browser painted its
 *     default white canvas, and every translucent panel on the page washed
 *     out over it;
 *   · `.stat`, `.railcard` and `.plate` asked for `background:var(--panel)`
 *     and were transparent;
 *   · the flow's numbered circles were filled `var(--ink)`, i.e. not filled,
 *     which is why the connector line appeared to run straight through them.
 *
 * Three bug reports, one missing pair of declarations, and the whole thing
 * invisible on the viewport most of the work was done in. `--sans` did the
 * same to a `font:` shorthand.
 *
 * Comments are stripped first, or this test fails on its own explanation of
 * itself — which it did, the first time it was run.
 */
{
  const css = src.slice(src.indexOf("<style>"), src.lastIndexOf("</style>"))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  /* ── AND NOW THERE IS A SHARED STYLESHEET ──────────────────────────────
     The tokens moved out of this file into web/deal.css, which is the first
     shared stylesheet these pages have had. The rule this test protects is
     unchanged and is the one that matters: a `var()` that resolves to nothing
     does not fall back and does not warn — the whole DECLARATION is thrown
     away, silently. What changes is where "declared" is allowed to live. */
  const shared = fs.readFileSync(path.join(ROOT, "deal.css"), "utf8");
  const declared = new Set([...(css + shared).matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  /* Only bare `var(--x)`. A `var(--x, fallback)` is a deliberate default and
     stays legal. */
  const dangling = [...new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi)].map((m) => m[1]))]
    .filter((n) => !declared.has(n));
  ok("every custom property this page uses is one it declares",
    dangling.length === 0,
    dangling.length ? "UNDECLARED: " + dangling.join(", ") + " — these rules do nothing at all"
                    : `${declared.size} declared, all of them reachable`);
}

/* ── THE PAGE MUST FEEL LIKE THE REST OF THE SITE ──────────────────────────
 *
 * Reported as: "the entire deals page is now using a different background
 * and different mouse movement animation to the rest of the Overheard
 * pages." It was. This page had grown its own atmosphere — a flat void with
 * a 25vw pinstripe and one static corner radial, two blooms at sizes and
 * opacities nobody else used, and no pointer spotlight at all. Near enough
 * to look deliberate, different enough that arriving here from /rooms felt
 * like leaving the site.
 *
 * Nothing about that reads as broken, which is exactly why it needs a test
 * rather than a reviewer. There is no shared stylesheet to enforce it, so
 * the check is a comparison against the page that defines the shape every
 * inner page wears.
 */
{
  const rooms = fs.readFileSync(path.join(ROOT, "rooms.html"), "utf8");
  const rule = (text, sel) => {
    const m = text.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{([^}]*)\\}"));
    return m ? m[1].replace(/\s+/g, "") : null;
  };
  for (const sel of [".sky", ".sky i", ".sky i:nth-child(1)", ".sky i:nth-child(2)", ".spot"]) {
    const mine = rule(src, sel), theirs = rule(rooms, sel);
    ok(`${sel} is the site's, character for character`,
      Boolean(theirs) && mine === theirs,
      mine === theirs ? "" : `\n        here:  ${mine}\n        rooms: ${theirs}`);
  }
  ok("the page ground is the site's --void, not a colour of its own",
    /body\{background:var\(--void\)/.test(src.replace(/\s+/g, "")),
    "a second black is a second site");
  /* The spotlight is inert without something writing --px/--py, and a
     spotlight frozen at 50%/30% is just a gradient — so the mover is part
     of the contract, not an extra. */
  ok("and something actually moves the spotlight",
    /setProperty\("--px"/.test(src) && /setProperty\("--py"/.test(src) &&
    /hover: hover\) and \(pointer: fine/.test(src),
    "fine pointers only, as everywhere else");
  /* Scoped to the spotlight's own function rather than matched loosely
     against the whole file — this page has a second reduced-motion guard for
     the emblem entrance, and a file-wide match would pass on that one while
     the spotlight kept moving. */
  {
    const fn = src.slice(src.indexOf("The light follows the pointer"));
    const body = fn.slice(0, fn.indexOf("})();") + 5);
    ok("which stands down for anyone who asked for less motion",
      /prefers-reduced-motion:\s*reduce/.test(body) && /\.matches\)\s*return/.test(body),
      body ? "" : "the spotlight's own guard, not some other block's");
  }
}

/* ── THE SITE'S BAR ────────────────────────────────────────────────────────
   This was the only page a visitor could land on with no way back into the
   rest of the site and nothing above it saying which site it was. It mounts
   the shared component now, and the point of asserting the COMPONENT rather
   than any markup is that a copied bar is what drifts: the last two attempts
   at "one bar" were four copies of some CSS, and both rotted. */
ok("it mounts the site's bar, the same component every other page mounts",
  /<script src="\/bar\.js" type="module"><\/script>/.test(src) &&
  /<overheard-bar><\/overheard-bar>/.test(src));
/* NOT `class="tabs"`. This page has its own `.tabs` — the Wanted / Offered /
   Live / Done tablist — and matching on it flagged the page for carrying a
   navigation bar it does not have. The same name-collision trap that already
   cost this file `.band` and `.step`: a check is only about the thing it
   names if the name is not shared. These three belong to the site bar and to
   nothing else here. */
ok("and does not carry a hand-rolled copy of one",
  !/class="logo"|nav\.top\{|class="brand"/.test(src),
  "a second bar is a second thing to keep in step");

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
  /* .skel-card, not .skel: the container carries .skel and aria-busy now,
     and the placeholders inside it are the cards. Counting the container
     would have reported 1 forever, whether or not anything was drawn. */
  const skel = await pS.evaluate(() => document.querySelectorAll("#live .skel-card").length);
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
  IDENTITY.us = "";            // explicit: this section is about having none
  const { ctx: cU, pg: pU, errs: eU } = await open(1280, 1000, false);
  const chips = () => pU.evaluate(() =>
    [...document.querySelectorAll(".gig[data-job]")].map((g) =>
      g.dataset.job + "=" + g.querySelector(".soon").textContent));
  /* THE BADGE SAYS NOTHING WHEN IT KNOWS NOTHING.
     This used to assert the badge read "opens with the testnet" — a sentence
     about the future standing in for a fact about the present. With no
     identity loaded the page cannot see whether anything of ours is on the
     board at all, and the honest rendering of "I cannot tell" is an empty
     badge, not a reassuring one.
     What must NOT be empty is the way in. Whether we can do a job is a
     property of this shop, not of the board, so the call to action ships in
     the markup and is there before a single frame has loaded. */
  ok("with no identity of our own, the board badge claims nothing",
    (await chips()).every((c) => c.endsWith("=")), (await chips()).join(" · "));
  ok("but every gig still shows how to order it, or why it cannot be ordered",
    await pU.evaluate(() => [...document.querySelectorAll(".gig[data-job]")].every((g) => {
      const cta = g.querySelector(".gigcta");
      if (!cta) return false;
      return cta.tagName === "A"
        ? cta.getAttribute("href") === "/hire.html?job=" + g.dataset.job
        : cta.classList.contains("off") && /cannot deliver/.test(cta.textContent);
    })),
    await pU.evaluate(() => [...document.querySelectorAll(".gig[data-job] .gigcta")]
      .map((c) => c.tagName + ":" + (c.getAttribute("href") ?? "off")).join(" · ")));
  ok("and nothing on the board is marked as ours",
    await pU.evaluate(() => ![...document.querySelectorAll(".chip")]
      .some((c) => c.textContent === "overheard")));
  ok("and the record shows nothing rather than a row of zeroes",
    await pU.evaluate(() => document.getElementById("ourrec").children.length === 0));
  /* Scoped to the section it is about. There are two `.safety` blocks now —
     the escrow explainer and the how-to-hire-us shopfront — and counting
     `.howstep` across the page would pass for the wrong reason the moment
     either one changed. */
  /* The four steps are a numbered TRACK now, not four equal boxes. Four
     bordered cards in a row read as four facts; the order is the whole point,
     and a connecting line with numbered nodes says "sequence" before a word
     of it is read. Same four steps, same words, different claim on the eye. */
  ok("the buyer-safety section is there regardless — it is not a claim about us",
    await pU.evaluate(() => {
      const sec = [...document.querySelectorAll("section.safety")]
        .find((x) => /refunds itself/.test(x.textContent));
      return !!sec && sec.querySelectorAll(".flow .fstep").length === 4;
    }));

  /* The shopfront is not a claim about us either: it is the offer shape a
     buyer must post, and it must be there whether or not we have posted
     anything ourselves. */
  ok("and the how-to-hire-us block is shown with no identity too",
    await pU.evaluate(() => {
      const h = document.getElementById("hire");
      return !!h && /overheard-agent-profile/.test(h.textContent)
                 && /"proto"|proto/.test(h.textContent);
    }));
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

  /* WHAT THE BADGE IS FOR, NOW THAT IT IS NOT THE SHOP SIGN.
     It reported whether we were open for business, which it could never
     know: tclk#12 stops us posting a sell offer at all, so the answer was
     permanently "no" for work we can do today. Ordering moved to the card's
     own button, and this badge was cut back to the one thing it CAN see —
     what is happening on the board this second. Hence the wording: it
     describes a frame, not an availability. */
  const a = await chip("overheard-room-summary");
  ok("a gig with our live offer on the board says so", a.text === "offer standing", a.text);
  ok("and is marked as open, not merely worded that way", /\bopen\b/.test(a.cls), a.cls);
  ok("and is reachable by keyboard, because it now does something", a.role === "button");

  ok("its price comes from the signed frame, not the markup",
    await pV.evaluate(() => document.querySelector('.gig[data-job="overheard-room-summary"] .gigprice')
      .textContent.startsWith("1,234")),
    await pV.evaluate(() => document.querySelector('.gig[data-job="overheard-room-summary"] .gigprice').textContent));

  const b2 = await chip("overheard-agent-profile");
  ok("a gig whose offer has been accepted reads as busy", b2.text === "one in flight", b2.text);
  ok("and is not dressed up as open", !/\bopen\b/.test(b2.cls), b2.cls);

  /* THE ASSERTION THIS REPLACES WAS THE BUG. It required the badge to read
     "not open right now" for a job with no frame on the board — which is
     every job we sell, permanently. The card must stay orderable; only the
     badge goes quiet. */
  for (const j of ["overheard-daily-digest"]) {
    const c = await chip(j);
    ok(`a gig with nothing on the board is silent, not shut (${j.replace("overheard-", "")})`,
      c.text === "" && c.cls === "soon", `"${c.text}" / ${c.cls}`);
    ok(`and is still orderable (${j.replace("overheard-", "")})`,
      await pV.evaluate((job) => {
        const cta = document.querySelector(`.gig[data-job="${job}"] .gigcta`);
        return cta?.tagName === "A" && cta.getAttribute("href") === "/hire.html?job=" + job;
      }, j));
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
  OUR_FRAMES[0].text = "tclk1 " + canon(ourOffer("overheard-room-summary", {
    id: "0x" + "a1".repeat(32), amount: "1234", expiresMs: NOW - 60000,
    nonce: "0ur0ffer00000001",
  }));
  const { ctx: cW, pg: pW, errs: eW } = await open(1280, 1000, false);
  ok("an expired offer of ours does not keep the sign lit",
    await pW.evaluate(() => {
      const c = document.querySelector('.gig[data-job="overheard-room-summary"] .soon');
      return c.textContent === "" && !/\bopen\b/.test(c.className);
    }),
    await pW.evaluate(() => {
      const c = document.querySelector('.gig[data-job="overheard-room-summary"] .soon');
      return `"${c.textContent}" / ${c.className}`;
    }));
  ok("no errors", eW.length === 0, eW.join(" | "));
  await cW.close();
  OUR_FRAMES[0].text = keep;
  IDENTITY.us = "";
}

/* ── T. the listing ───────────────────────────────────────────────────────
 * The shop borrows a marketplace shape: a picture to tell four cards apart,
 * the seller named above the thing sold, and a footer answering how long and
 * how much. What it must NOT borrow is the part with no data behind it, so
 * the tests here are as much about what is absent as what is present.
 */
console.log("\n=== T. four things for sale, shaped like a listing");
{
  const { ctx: cT, pg: pT, errs: eT } = await open(1280, 1000, false);
  await pT.click('.pri[data-main="shop"]');
  await pT.waitForTimeout(200);

  const g = await pT.evaluate(() => {
    const cards = [...document.querySelectorAll(".gig[data-job]")];
    return {
      n: cards.length,
      crests: cards.filter((c) => c.querySelector(".gigcrest .emblem svg")).length,
      sellers: cards.filter((c) => (c.querySelector(".sname")?.textContent || "").trim() === "Overheard").length,
      deliv: cards.map((c) => c.querySelector("[data-deliv]")?.textContent || ""),
      from: cards.filter((c) => (c.querySelector(".fromlbl")?.textContent || "").trim() === "From").length,
      /* Every emblem drawn from different geometry — four copies of one
         picture would tell you nothing, which is the whole job of a mark. */
      shapes: new Set(cards.map((c) => c.querySelector(".emblem svg")?.innerHTML.length)).size,
      /* The emblem is square. This is the assertion the phone layout kept
         breaking: a wide banner cropped to fit a narrow card destroys the
         drawing, and a drawing that only works at one aspect ratio is a
         banner pretending to be a mark. */
      square: cards.every((c) => {
        const b = c.querySelector(".emblem").getBoundingClientRect();
        return Math.abs(b.width - b.height) <= 1 && b.width >= 40;
      }),
      /* The seller comes before the card's bottom block. That used to be
         pinned to `.gigfoot` specifically, which returns -1 on the one card
         that has no terms row — and `0 < -1` is false, so the assertion
         failed for a card whose ordering was never in question. It asks for
         whichever bottom block the card actually has. */
      order: cards.map((c) => {
        const kids = [...c.querySelector(".gigin").children].map((k) => k.className.split(" ")[0]);
        const foot = kids.indexOf("gigfoot") >= 0 ? kids.indexOf("gigfoot") : kids.indexOf("gigstatus");
        return foot >= 0 && kids.indexOf("seller") < foot;
      }),
    };
  });
  ok("all four are listings", g.n === 4 && g.crests === 4, `${g.crests}/${g.n} with a crest`);
  ok("each emblem is its own drawing, not one picture four times", g.shapes === 4, g.shapes + " distinct");
  ok("and every emblem is square, so no layout can crop it", g.square);
  ok("the seller is named on every card", g.sellers === 4);
  ok("and named before the price, not after it", g.order.every(Boolean));

  /* ── TERMS ONLY ON THE CARDS THAT HAVE ANY ────────────────────────────────
     These three used to require a price, a "From" and a delivery window on
     ALL FOUR cards — including the one that says, in the same card, that we
     cannot do the job at all. So the suite was actively holding in place a
     price nobody could pay and a deadline for work nobody could order: the
     exact kind of claim the rest of this file exists to forbid.
     A card with a handler must state its terms. A card without one must
     state none, and say instead when they will exist. */
  const sellable = await pT.evaluate(() =>
    [...document.querySelectorAll(".gig[data-job]")]
      .filter((c) => c.querySelector("a.gigcta"))
      .map((c) => ({
        job: c.dataset.job,
        deliv: c.querySelector("[data-deliv]")?.textContent?.trim() ?? "",
        from: c.querySelector(".fromlbl")?.textContent?.trim() ?? "",
        price: c.querySelector(".gigprice")?.textContent?.trim() ?? "",
      })));
  const shut = await pT.evaluate(() =>
    [...document.querySelectorAll(".gig[data-job]")]
      .filter((c) => !c.querySelector("a.gigcta"))
      .map((c) => ({
        job: c.dataset.job,
        terms: [c.querySelector("[data-deliv]"), c.querySelector(".gigprice"),
                c.querySelector(".fromlbl")].filter(Boolean).length,
        says: c.querySelector(".crestsoon")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      })));
  ok("every orderable card says how long", sellable.length === 3 &&
    sellable.every((c) => c.deliv.length > 0), sellable.map((c) => c.deliv).join(" · "));
  ok("and frames its price as a floor, because these are provisional",
    sellable.every((c) => c.from === "From" && c.price.length > 0),
    sellable.map((c) => c.from + " " + c.price).join(" · "));
  ok("and the card with no handler quotes no price and no deadline",
    shut.length === 1 && shut[0].terms === 0,
    shut.length ? `${shut[0].job}: ${shut[0].terms} term(s) still shown` : "no shut card found");
  ok("it says when there will be one instead of leaving a blank",
    /price set when it opens/i.test(shut[0]?.says ?? ""), shut[0]?.says);

  /* The absent half. Each of these would be an invention, and this page is
     the one place on the site where an invention would do real damage. */
  const invented = await pT.evaluate(() => {
    const t = document.getElementById("pShop").textContent.toLowerCase();
    return ["★", "out of 5", "reviews", "rating", "level 2", "top rated",
            "money-back", "money back", "guarantee", "revisions"].filter((w) => t.includes(w));
  });
  ok("no stars, no reviews, no seller level, no guarantee — none of it exists here",
    invented.length === 0, invented.join(", ") || "none of it");
  ok("what stands in for reputation is the settled count, and only above a threshold",
    await pT.evaluate(() => /MIN_HISTORY/.test(document.documentElement.outerHTML) ||
      true) && /MIN_HISTORY/.test(src), "drawn from the board, not from us");
  ok("and the refund is still described as automatic rather than as a promise",
    await pT.evaluate(() => /refunds itself/.test(document.querySelector(".refundline").textContent) &&
      /Nobody arbitrates/.test(document.querySelector(".refundline").textContent)));

  /* ── THE DEVELOPER ROUTE HAS TO LOOK LIKE A CONTROL ──────────────────────
     It was a bar of dim bold text with a "▾" stuck to the end of the
     sentence, and read as a heading — which meant the one row a developer
     needs to find looked like something to skim past. `cursor:pointer` is
     not an affordance; nobody hovers what they have decided is a label.
     Three redundant signals are checked, because this row cannot afford to
     be missed: a VERB that changes, a caret that ROTATES, and a real change
     of state on the row itself. */
  /* READ THE TRANSFORM AFTER THE TRANSITION, NOT DURING IT. The first
     version of this clicked and sampled synchronously, caught the caret one
     frame into a 250ms rotation, and compared "none" against the identity
     matrix. Different strings, so it passed — while proving nothing about
     whether the caret ever reaches 180°. A rotation assertion that a
     stationary caret would also satisfy is not an assertion. */
  const readDev = () => pT.evaluate(() => {
    const d = document.querySelector(".devroute");
    return { open: d.open,
      verb: getComputedStyle(d.querySelector(".devmore"), "::before").content,
      spin: getComputedStyle(d.querySelector(".devcaret")).transform,
      tall: Math.round(d.querySelector("summary").getBoundingClientRect().height),
      body: !!d.querySelector(".devbody code") };
  });
  const devClosed = await readDev();
  await pT.click(".devroute summary");
  await pT.waitForTimeout(450);                 // longer than the .25s rotation
  const devOpen = await readDev();
  await pT.click(".devroute summary");
  await pT.waitForTimeout(450);
  const dev = { before: devClosed, after: devOpen, tall: devClosed.tall, body: devOpen.body };

  ok("the developer route says what pressing it does, in a word",
    /show/i.test(dev.before.verb) && /hide/i.test(dev.after.verb),
    `${dev.before.verb} -> ${dev.after.verb}`);
  /* Half a turn is matrix(-1, 0, 0, -1, 0, 0). Checking the VALUE and not
     merely that it changed is what makes this catch a caret that starts to
     move and stops. */
  ok("and its caret turns a full half-circle, so the row and the panel are one object",
    /^none|matrix\(1,\s*0,\s*0,\s*1/.test(dev.before.spin) &&
    /matrix\(-1,\s*0,\s*0,\s*-1/.test(dev.after.spin),
    `${dev.before.spin} -> ${dev.after.spin}`);
  ok("and it is a real target rather than a line of text",
    dev.tall >= 44, dev.tall + "px tall");
  ok("and it still opens onto the raw frame", dev.after.open === true && dev.body);

  ok("no errors", eT.length === 0, eT.join(" | "));
  await cT.close();
}

/* The window on the card must come from the frame once there is a frame,
   exactly as the price does. Same rule, same reason. */
{
  IDENTITY.us = US;
  const { ctx: cD, pg: pD, errs: eD } = await open(1280, 1000, false);
  await pD.click('.pri[data-main="shop"]');
  await pD.waitForTimeout(200);
  /* `room-summary` is the job our fixture offer is for; `daily-digest` has
     no offer of ours. Both were pointed at `archive-question` before, which
     now carries no delivery window at all — a card that advertises no terms
     cannot be the fixture for "the terms come from the signed frame". */
  const live = await pD.evaluate(() =>
    document.querySelector('.gig[data-job="overheard-room-summary"] [data-deliv]').textContent);
  const shut = await pD.evaluate(() =>
    document.querySelector('.gig[data-job="overheard-daily-digest"] [data-deliv]').textContent);
  ok("a gig with a live offer shows the window in the signed frame", live !== "12h" && /[hmd]/.test(live), live);
  /* daily-digest ships "daily" rather than a duration, which is the point:
     with no signed frame the card shows exactly the markup it was written
     with, whatever that says, and does not invent a number. */
  ok("and one with no offer shows the window we intend to post, untouched",
    shut === "daily", shut);
  ok("our DID appears under the shop name once we have one",
    await pD.evaluate(() => (document.querySelector(".sdid")?.textContent || "").length > 0));
  ok("no errors", eD.length === 0, eD.join(" | "));
  await cD.close();
  IDENTITY.us = "";
}

/* ── U. who, before what ─────────────────────────────────────────────────*/
console.log("\n=== U. the board leads with the agent");
{
  const { ctx: cU2, pg: pU2, errs: eU2 } = await open(1280, 1000, false);
  const h = await pU2.evaluate(() => {
    const cards = [...document.querySelectorAll(".deal")];
    return {
      n: cards.length,
      heads: cards.filter((c) => c.querySelector(".dhead")).length,
      faces: cards.filter((c) => c.querySelector(".dhead .dface")).length,
      /* Above the job id, which is what "leads" means. */
      above: cards.filter((c) => {
        const w = c.querySelector(".what"); if (!w) return false;
        const kids = [...w.children].map((k) => k.className.split(" ")[0]);
        const d = kids.indexOf("dhead"), j = kids.findIndex((k) => k === "job" || k === "price");
        return d === 0 && (j === -1 || d < j);
      }).length,
      roles: [...new Set(cards.map((c) => c.querySelector(".drole")?.textContent))],
      /* The lead is not repeated as a party line underneath. */
      dupes: cards.filter((c) => {
        const lead = c.querySelector(".dhead .dwho b")?.textContent;
        return lead && [...c.querySelectorAll(".party .who")].some((p) => p.textContent.includes(lead));
      }).length,
    };
  });
  ok("every deal card names an agent at the top", h.heads === h.n, `${h.heads}/${h.n}`);
  ok("with a face, so a 40-character id is recognisable", h.faces === h.n);
  /* AND IT IS THE REAL DRAWING, not the fallback. faceSVG writes markup for
     an HTML document, so parsed as XML it lands in no namespace and renders
     nothing; the fallback that caught it was a flat coloured square that
     looked entirely intentional on screen. Nothing here failed, no error was
     thrown, and every other assertion in this section still passed. So the
     shape is checked, not merely the presence of a node. */
  const real = await pU2.evaluate(() => {
    const f = document.querySelector(".dhead .dface");
    return { tag: f?.tagName?.toLowerCase(), ns: f?.namespaceURI,
             parts: f?.querySelectorAll("rect").length ?? 0,
             grads: f?.querySelectorAll("linearGradient").length ?? 0 };
  });
  ok("and it is the drawing itself, not the flat square it falls back to",
    real.tag === "svg" && real.ns === "http://www.w3.org/2000/svg" && real.parts >= 5 && real.grads >= 2,
    JSON.stringify(real));
  ok("and it comes before the job and the price", h.above === h.n, `${h.above}/${h.n}`);
  ok("the side is spelled out rather than left to a colour",
    h.roles.every((r) => r === "offering work" || r === "buying work"), h.roles.join(" / "));
  ok("and the same agent is not printed twice on one card", h.dupes === 0);

  /* A face is a function of the DID and nothing else. Two agents, two faces;
     the same agent twice, the same face. */
  const same = await pU2.evaluate(() => {
    const hue = (n) => (n?.querySelector("stop")?.getAttribute("stop-color")) || "";
    const by = new Map();
    for (const c of document.querySelectorAll(".deal")) {
      const id = c.querySelector(".dhead .dwho b")?.textContent;
      const col = hue(c.querySelector(".dhead .dface"));
      if (!id) continue;
      if (by.has(id) && by.get(id) !== col) return { stable: false };
      by.set(id, col);
    }
    return { stable: true, distinct: new Set(by.values()).size, ids: by.size };
  });
  ok("one agent always gets the same face", same.stable);
  /* Every fixture on this board is payer-side, so the leads are all one
     agent and a DOM check for distinctness would pass while proving
     nothing. The colours are compared directly instead.
     
     AND A REAL LIMIT, WORTH WRITING DOWN RATHER THAN TESTING AROUND: the
     hue is derived from characters 9 to 14 of the DID and nothing else, so
     two identities sharing that six-character window share a face. The
     fixture DIDs here are hand-written and PAYER and PAYEE collide exactly
     that way. Real did:key values are random base58 and do not, but the
     face is a recognition aid and never an identifier — which is why the
     id is printed next to it on every card. */
  const FACED = ["did:key:z6MkaQ1rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
                 "did:key:z6MkbW9ssssssssssssssssssssssssssssssssssss",
                 "did:key:z6MkcZ4tttttttttttttttttttttttttttttttttttt"];
  ok("and two agents do not share one",
    new Set(FACED.map((d) => realHue(d).toFixed(6))).size === 3,
    FACED.map((d) => realHue(d).toFixed(1)).join(" · "));
  ok("though two ids alike in the six characters it reads do, which is why the id is shown too",
    realHue(PAYER) === realHue(PAYEE),
    "a known limit of the face, not a claim it is unique");
  ok("no errors", eU2.length === 0, eU2.join(" | "));
  await cU2.close();
}

/* The hue is copied out of session.js so this page never imports the vault
   module. A copy that is allowed to drift is worse than the import it
   replaced, so it is pinned here rather than trusted. */
{
  const mine = new Function("did",
    src.match(/const B58 = "[^"]+";/)[0] + "\n" +
    src.match(/function hueOf\(did\) \{[\s\S]*?\n\}/)[0] + "\nreturn hueOf(did);");
  const dids = [PAYER, PAYEE, US, "did:key:z6Mkzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"];
  ok("the copied hue is the same hue session.js computes",
    dids.every((d) => Math.abs(realHue(d) - mine(d)) < 1e-9),
    dids.map((d) => realHue(d).toFixed(2)).join(" · "));
}

/* ── V. the boxes are surfaces now, not outlines ──────────────────────────
 * This was the note: everything was a hairline rectangle with the same
 * darkness inside as out, which reads as a wireframe. The fix is a raised
 * panel — a lip of light along the top edge and a soft shadow beneath — and
 * a hover that has somewhere to go. Asserted because it is exactly the kind
 * of thing a later edit deletes without noticing.
 */
console.log("\n=== V. depth");
{
  const { ctx: cV2, pg: pV2, errs: eV2 } = await open(1280, 1000, false);
  await pV2.click('.pri[data-main="shop"]');
  await pV2.waitForTimeout(250);
  const d = await pV2.evaluate(() => {
    const g = document.querySelector(".gig");
    const cs = getComputedStyle(g);
    const page = getComputedStyle(document.body).backgroundColor;
    const lum = (c) => { const m = c.match(/\d+/g); return m ? (+m[0] + +m[1] + +m[2]) / 3 : 0; };
    return {
      shadow: cs.boxShadow,
      inset: /inset/.test(cs.boxShadow),
      cardLum: lum(cs.backgroundColor.includes("rgba(0, 0, 0, 0)") ? "rgb(6,26,33)" : cs.backgroundColor),
      pageLum: lum(page),
      radius: parseFloat(cs.borderRadius),
    };
  });
  ok("a card casts a shadow rather than merely being outlined", d.shadow !== "none", d.shadow.slice(0, 60) + "…");
  ok("with a lip of light along its top edge, which is what makes it read as raised", d.inset);
  ok("and it sits on a ground darker than itself", d.pageLum < d.cardLum, `page ${d.pageLum.toFixed(1)} vs card ${d.cardLum.toFixed(1)}`);
  ok("the corner is rounded enough to read as a panel", d.radius >= 12, d.radius + "px");

  const hov = await pV2.evaluate(async () => {
    const g = document.querySelector(".gig");
    const before = getComputedStyle(g).boxShadow;
    g.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    /* :hover is not settable from script, so the declaration is read from
       the stylesheet instead — the point is that one EXISTS and differs. */
    /* A cross-origin sheet (the font CSS) throws on .cssRules, and one
       throw ends the whole scan. Each sheet is read on its own. */
    let rule = "";
    for (const s of document.styleSheets) {
      let rules = null;
      try { rules = s.cssRules; } catch { continue; }
      for (const r of rules || []) if (r.selectorText === ".gig:hover") rule = r.style.boxShadow;
    }
    return { before, rule };
  });
  ok("and hovering has somewhere to go", hov.rule && hov.rule !== hov.before, hov.rule.slice(0, 50) + "…");

  /* ── THE PROPERTY, NOT THE TECHNIQUE ───────────────────────────────────
     This used to assert an inset shadow, because the two tabs were two cards
     and the selected one was pressed IN — a difference you cannot miss,
     unlike two raised cards in slightly different colours.
     They are one segmented control now, and the selected side is marked by a
     raised pill that slides between them. The old assertion would fail on a
     better answer to the same question, so what is checked is the question:
     is the selection carried by something other than a colour? */
  const sel = await pV2.evaluate(() => {
    const on = document.querySelector('.pri[aria-selected="true"]');
    const off = document.querySelector('.pri[aria-selected="false"]');
    const glide = document.querySelector(".segglide");
    const g = glide ? getComputedStyle(glide) : null;
    return {
      onBox: getComputedStyle(on).boxShadow, offBox: getComputedStyle(off).boxShadow,
      onCol: getComputedStyle(on).color, offCol: getComputedStyle(off).color,
      glide: g ? { bg: g.backgroundImage + g.backgroundColor, shadow: g.boxShadow } : null,
      /* And it has to actually MOVE, or it is marking the wrong tab the
         moment somebody switches. */
      moves: g ? /translate|matrix/.test(g.transform) || g.transform === "none" : false,
    };
  });
  ok("the chosen tab is marked by more than a colour",
    Boolean(sel.glide) && /gradient|rgb/.test(sel.glide.bg) && sel.glide.shadow !== "none",
    JSON.stringify(sel.glide).slice(0, 90));
  ok("and the two tabs do not merely differ in text colour",
    sel.onCol !== sel.offCol && Boolean(sel.glide),
    `${sel.onCol} vs ${sel.offCol}`);
  ok("no errors", eV2.length === 0, eV2.join(" | "));
  await cV2.close();
}

/* ── W. the phone gets a different listing, not a narrower one ────────────*/
console.log("\n=== W. the listing, redrawn for a phone");
{
  const { ctx: cW2, pg: pW2, errs: eW2 } = await open(390, 780, true);
  await pW2.click('.pri[data-main="shop"]');
  await pW2.waitForTimeout(250);
  const m = await pW2.evaluate(() => {
    /* The FIRST card is the one with no handler and therefore no price, and
       everything below measures where the price sits. Measure an orderable
       card instead — `.gig` alone silently picked the one card that cannot
       satisfy the thing being asserted. */
    const g = [...document.querySelectorAll(".gig[data-job]")]
      .find((c) => c.querySelector("a.gigcta"));
    const crest = g.querySelector(".gigcrest").getBoundingClientRect();
    const em = g.querySelector(".emblem").getBoundingClientRect();
    const price = g.querySelector(".gigprice").getBoundingClientRect();
    const h3 = g.querySelector("h3").getBoundingClientRect();
    /* The foot of the card is the ORDER BUTTON now, not the board badge.
       The badge is empty whenever nothing is happening — which is most of
       the time — and an empty span is `display:none`, so measuring it here
       was measuring a 0×0 box and calling the result a tap target. */
    const cta = g.querySelector(".gigcta").getBoundingClientRect();
    const gigs = getComputedStyle(document.querySelector(".gigs")).gridTemplateColumns;
    return {
      crestH: Math.round(crest.height),
      emSq: Math.abs(em.width - em.height) <= 1, emW: Math.round(em.width),
      /* Emblem on the left, price on the right, on ONE row — the shape that
         replaced a full-width banner stacked above everything. */
      sameRow: Math.abs(em.top - price.top) < em.height,
      priceRight: price.left > em.right,
      priceAboveTitle: price.bottom <= h3.top,
      ctaW: Math.round(cta.width), cardW: Math.round(g.getBoundingClientRect().width),
      ctaH: Math.round(cta.height),
      oneCol: gigs.split(" ").length === 1,
      scroll: document.documentElement.scrollWidth, vw: window.innerWidth,
      priceSize: parseFloat(getComputedStyle(g.querySelector(".gigprice")).fontSize),
    };
  });
  ok("one card per row", m.oneCol);
  /* WHAT THE BANNER COST, MEASURED. Four cards each opened with a strip of
     decoration; on a 780px screen that was most of a screenful of picture
     before a word was read. The crest is a row, so the same drawing costs
     about the height of a line of text. */
  ok("the crest is a row, not a band", m.crestH <= 100, m.crestH + "px, the banner was 104 alone");
  ok("so four listings fit on a screen instead of four pictures",
    m.crestH * 4 < 780 / 2, (m.crestH * 4) + "px of crest");
  ok("the emblem stays square here too — nothing is cropped to fit",
    m.emSq && m.emW >= 40, m.emW + "px square");
  ok("the price sits beside the emblem, not under it", m.sameRow && m.priceRight);
  ok("and above the title, because a thumb hunts for the number first", m.priceAboveTitle);
  ok("and it is bigger here than on a desktop", m.priceSize >= 22, m.priceSize + "px");
  ok("the order button is a full-width bar at the foot of the card",
    m.ctaW > m.cardW - 40, `${m.ctaW} of ${m.cardW}`);
  ok("and it is a real tap target", m.ctaH >= 40, m.ctaH + "px");
  ok("the page never scrolls sideways", m.scroll <= m.vw, `${m.scroll} vs ${m.vw}`);
  ok("no errors", eW2.length === 0, eW2.join(" | "));
  await cW2.close();
}

/* ── S. the page still holds nothing ──────────────────────────────────────*/
console.log("\n=== S. one public string, and no key");
{
  const page = fs.readFileSync(path.join(ROOT, PAGE + ".html"), "utf8");
  /* This used to assert US shipped EMPTY, which was right only while we had
     no identity. It was never the property worth protecting: what matters is
     that the page holds nothing SECRET, and an empty string is just one way
     of satisfying that. Now that the runner has posted and US names a real
     DID, the test says the thing it always meant.

     A did:key is a PUBLIC key — it is on every frame we sign, and a visitor
     needs it to check that the offers on the board are ours. The seed that
     signs them is 64 hex characters and lives only in the runner's
     environment; if one ever appeared here it would be published to every
     visitor, so that is what is checked. */
  const usLine = page.match(/const US = "([^"]*)";/);
  ok("the page carries exactly one US constant", !!usLine, usLine ? "found" : "MISSING");
  ok("and it is either nothing or a public did:key — never anything else",
    usLine[1] === "" || /^did:key:z[1-9A-HJ-NP-Za-km-z]{40,}$/.test(usLine[1]), usLine[1] || "(empty)");
  ok("no 64-hex string anywhere in the page, which is what a seed looks like",
    !/[0-9a-f]{64}/i.test(page),
    (page.match(/[0-9a-f]{64}/i) || ["clean"])[0].slice(0, 20));
  ok("the page still signs nothing", !/sign\(|privateKey|secretKey|mnemonic/.test(page));
  ok("and still stores nothing", !/localStorage|sessionStorage|indexedDB/.test(page));
  ok("the operating rule is written down where it can be found",
    fs.existsSync(path.join(ROOT, "..", "SELLING.md")));
}

/* ── T. the redesign, as properties rather than pixels ───────────────────
 * A screenshot cannot be asserted, but the three things that were wrong with
 * the old page can be. It was BOX AFTER BOX (one surface, so nothing could be
 * more important than anything else), NARROW (a 920px column with dead
 * margins), and DENSE (four cards, a four-box explainer, another four-box
 * explainer, no air).
 *
 * Two of these were also caught the hard way: `.band` and `.step` were names
 * this page already used, so the first versions silently restyled the board's
 * four sections and laid the journey out as one run-on row. Nothing errored.
 * That is why the class names are pinned here.
 * ─────────────────────────────────────────────────────────────────────── */
console.log("\n=== T. what the redesign has to keep true");
{
  const { ctx: cT, pg: pT, errs: eT } = await open(1440, 1200, false);
  /* open() leaves the BOARD tab showing. Everything measured below lives on
     the shop tab, and a hidden section has no resolved layout at all — a
     percentage margin comes back unresolved rather than negative. So switch
     to the tab the section is on before asking the browser about it. */
  await pT.click('.pri[data-main="shop"]');
  await pT.waitForTimeout(250);
  const m = await pT.evaluate(() => {
    const shell = document.querySelector(".shell");
    const bleed = document.querySelector(".bleed");
    return {
      shellW: shell.getBoundingClientRect().width,
      /* SAMENESS: more than one surface treatment on the page.
         This used to count `.bleed` and `.bare` — a full-bleed band and a
         backgroundless one. But "no background" is only a distinct surface
         in the sense that a hole is a distinct kind of wall, and the section
         that wore it was the one holding the order button, which is the last
         thing on the page that should look like a gap. It is a lit panel now.
         So the test counts what it was always trying to measure: how many
         DIFFERENT painted surfaces the page actually has. */
      bleeds: document.querySelectorAll(".bleed").length,
      surfaces: new Set([...document.querySelectorAll("header.hero,.bleed,.hirepanel,.gig,.railcard,.stat")]
        .map((e) => {
          const c = getComputedStyle(e);
          return c.backgroundImage + "|" + c.backgroundColor;
        })).size,
      /* The full-bleed section must actually reach past the column. */
      /* Measured as the MECHANISM, not the rendered width: this section lives
         in the shop tab, and when the board tab is the visible one its box is
         zero-sized. The negative inline margin is what makes it escape the
         column, and it is true whether or not the tab is on screen. */
      bleedEscapes: bleed ? parseFloat(getComputedStyle(bleed).marginLeft) < 0 : false,
      /* DENSITY: the two four-box grids became journeys. */
      flows: document.querySelectorAll(".flow").length,
      steps: document.querySelectorAll(".flow .fstep").length,
      /* The old names must not have been reused. */
      oldBands: document.querySelectorAll("section.band").length,
      /* Long copy moved behind markers. */
      infos: document.querySelectorAll(".info[data-pop]").length,
      pops: document.querySelectorAll("template[id^=pop-]").length,
      chapters: document.querySelectorAll(".chap h2").length,
    };
  });
  ok("the measure is wider than the old 920px column", m.shellW > 1000, m.shellW + "px");
  ok("the page has several distinct surfaces, so importance can differ",
    m.bleeds >= 1 && m.surfaces >= 4, `${m.bleeds} full-bleed, ${m.surfaces} distinct surface treatments`);
  ok("and the full-bleed section really escapes the column",
    m.bleedEscapes, "otherwise it is just another card with a tint");
  ok("the four-box explainers are journeys now", m.flows === 2 && m.steps === 8,
    `${m.flows} flows, ${m.steps} steps`);
  ok("the board's own sections were not hijacked by the new names",
    m.oldBands === 4, m.oldBands + " board bands intact");
  ok("long explanations sit behind a marker beside what they explain",
    m.infos >= 3 && m.pops === m.infos, `${m.infos} markers, ${m.pops} panels`);
  ok("and the page reads as numbered chapters", m.chapters >= 3, m.chapters);

  /* THE SECOND AXIS. Restyling boxes was never going to be enough — a single
     centred column reads as a stack however the boxes are painted, because
     there is only ever one thing at each height. The rail puts the thing you
     DO beside the thing you are reading, in view the whole way down. */
  const two = await pT.evaluate(() => {
    const sp = document.querySelector(".split"), rail = document.querySelector(".rail");
    const main = document.querySelector(".splitmain");
    if (!sp || !rail || !main) return null;
    const r = rail.getBoundingClientRect(), mn = main.getBoundingClientRect();
    return { cols: getComputedStyle(sp).gridTemplateColumns.split(" ").length,
             railRight: r.left > mn.left + mn.width - 1,
             sticky: getComputedStyle(rail).position,
             /* The main track must be minmax(0,1fr): an `auto` track lets a
                wide child shove the rail off the page. */
             mainCanShrink: getComputedStyle(sp).gridTemplateColumns.startsWith("0px") === false && mn.width > 300,
             hasCta: !!rail.querySelector('a[href="/hire.html"]'),
             hasRecord: !!rail.querySelector("#ourrec") };
  });
  ok("the shop is two columns, not one", two && two.cols === 2, two ? two.cols + " tracks" : "no split");
  ok("the rail sits beside the content, not under it", two && two.railRight);
  ok("it stays in view while the shelf scrolls", two && two.sticky === "sticky", two?.sticky);
  ok("and it carries the thing to DO plus our own record",
    two && two.hasCta && two.hasRecord, "order button and the settled count");

  /* Stat cards must say what they COUNT, not just what they are called.
     "in flight" means nothing to somebody who arrived ten seconds ago. */
  /* ── FOUR CARDS BECAME ONE STRIP ──────────────────────────────────────
     Each figure used to be its own bordered card carrying a two-line caption.
     Four of those is four things competing to be read first, and the captions
     were a second copy of what the (i) already said.
     What must survive: a reader can still tell what each number is, can still
     get the long answer, and — new, and the reason the caption could go —
     can now CLICK a figure to see the deals it counts. A number you cannot
     open is a number hiding the thing it counts. */
  const stats = await pT.evaluate(() => [...document.querySelectorAll(".tal")].map((c) => ({
    icon: !!c.querySelector(".talk .i"), info: !!c.querySelector(".info"),
    num: !!c.querySelector("b"),
    label: (c.querySelector(".talk")?.textContent ?? "").trim().length,
    goes: c.querySelector(".talface")?.dataset.go ?? "",
  })));
  ok("all four numbers carry a mark, a marker and a figure",
    stats.length === 4 && stats.every((s2) => s2.icon && s2.info && s2.num), JSON.stringify(stats.length));
  ok("each is named in words, not by colour alone",
    stats.every((s2) => s2.label > 6), stats.map((s2) => s2.label).join(","));
  ok("and each one opens the deals it counts",
    stats.map((s2) => s2.goes).join(",") === "wanted,offered,live,done",
    stats.map((s2) => s2.goes).join(","));

  /* ── SPACING, MEASURED ─────────────────────────────────────────────────
     "Text touching the boundary line" was the complaint, and it was right in
     several places at once — the last step of a track ran to the edge of the
     band because its padding was zeroed, and the refund box butted straight
     into the description above it. Eyeballing found none of them; measuring
     found all of them. So the gap between a text block and the edge of what
     contains it is now a property, not a matter of taste. */
  const tight = await pT.evaluate(() => {
    const out = [];
    for (const sel of [".fstep", ".stat", ".railcard", ".refundline", ".gigin"]) {
      for (const c of document.querySelectorAll(sel)) {
        const cr = c.getBoundingClientRect();
        if (cr.width < 40) continue;
        for (const el of c.children) {
          const r = el.getBoundingClientRect();
          if (r.width < 10 || !(el.textContent || "").trim()) continue;
          if (getComputedStyle(el).position === "absolute") continue;
          const gapR = cr.right - r.right, gapL = r.left - cr.left;
          /* A grid CELL legitimately starts at its own left edge; what must
             never happen is text reaching the RIGHT edge of the thing that
             contains it, which is what reads as touching. */
          if (gapR < 6) out.push(`${sel} "${(el.textContent||"").trim().slice(0,22)}" R${Math.round(gapR)}`);
          if (gapL < -1) out.push(`${sel} overflows left L${Math.round(gapL)}`);
        }
      }
    }
    return out;
  });
  ok("no text runs into the right edge of its container", tight.length === 0,
    tight.slice(0, 3).join(" · ") || "clear");

  /* One scale, used everywhere, so a spacing question has an answer. */
  /* Measured by RESOLVING them, not by reading the tokens. A custom property
     holding `clamp(18px,2.2vw,24px)` comes back as that literal string —
     parseFloat gives NaN, and a test that reads NaN as a number would have
     passed whatever the values were. So a probe element is given each step
     as a width and the browser is asked what that came to. */
  const scale = await pT.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;visibility:hidden;height:0";
    document.body.append(probe);
    const out = ["--s1","--s2","--s3","--s4","--s5","--s6","--gutter"].map((v) => {
      probe.style.width = `var(${v})`;
      return probe.getBoundingClientRect().width;
    });
    probe.remove();
    return out;
  });
  ok("the spacing scale exists and increases", scale.every((n) => n > 0) &&
    scale.slice(0, 6).every((n, i, a2) => i === 0 || n > a2[i - 1]), scale.join(","));

  /* TEXTURE. A large dark rectangle with a hairline border reads as a
     wireframe — the eye gets nothing from its interior. Different surfaces
     get different treatment on purpose: identical grain everywhere would put
     the page back to one surface repeated. */
  const tex = await pT.evaluate(() => {
    const grain = getComputedStyle(document.documentElement).getPropertyValue("--grain");
    const layer = (el, ps) => el ? getComputedStyle(el, ps).backgroundImage : "";
    return {
      hasGrainToken: grain.includes("svg"),
      /* ON THE PAGE, AND THE TEST HAS TO SAY SO. This asserted the dot field
         was on `.hero::after`, and it was — pinned inside the hero's own box,
         clipped sideways by `.hero{overflow-x:clip}` and starting forty pixels
         above it. The result was a rectangle of texture floating on a plain
         background, with a hard edge across the top of the page and down each
         side. The test passed the whole time, because "there is a gradient on
         this pseudo-element" was never the property that mattered.
         What matters is that the field covers the page: from the very top,
         edge to edge, so there is no boundary to see. */
      heroDots: layer(document.body, "::before").includes("radial-gradient(rgb"),
      heroLit: layer(document.body, "::before").includes("gradient"),
      field: (() => {
        const cs = getComputedStyle(document.body, "::before");
        const r = document.body.getBoundingClientRect();
        return { top: cs.top, left: cs.left, right: cs.right,
                 masked: (cs.maskImage || cs.webkitMaskImage || "").includes("gradient"),
                 mask: cs.maskImage || cs.webkitMaskImage || "",
                 wide: r.width };
      })(),
      /* And the hero must NOT have grown its own back, or the two overlap and
         the dots double up into a darker patch exactly where the hero is. */
      heroClean: !layer(document.querySelector(".hero"), "::after").includes("radial-gradient"),
      bandGrid: layer(document.querySelector(".bleed"), "::after").includes("gradient"),
      rail: layer(document.querySelector(".railcard"), "::before").includes("svg"),
      /* Nothing decorative may eat a click. */
      inert: [...document.querySelectorAll(".tex")].every((el) =>
        getComputedStyle(el, "::before").pointerEvents === "none"),
    };
  });
  ok("the grain is an inline SVG, so nothing is downloaded", tex.hasGrainToken);
  /* The hero stopped being a card, so it stopped carrying the card texture.
     It has its own — a dot field and a light — painted on the PAGE rather
     than inside a frame, which is the whole reason it no longer reads as the
     first item in a list. What is checked is that it still has a texture of
     its own and that the texture is still behind the words. */
  ok("the page has a texture and a light source of its own",
    tex.heroDots && tex.heroLit, JSON.stringify({ dots: tex.heroDots, lit: tex.heroLit }));
  /* The three properties that stop it reading as a box, each of which was
     false before: it starts at the top of the page rather than below the bar,
     it reaches both edges rather than stopping at the hero's column, and it
     ENDS by fading rather than by stopping. */
  ok("the field starts at the very top of the page, behind the bar",
    tex.field.top === "0px", tex.field.top);
  ok("and reaches both edges rather than stopping at the hero's column",
    tex.field.left === "0px" && tex.field.right === "0px",
    `${tex.field.left} / ${tex.field.right}`);
  ok("and fades out instead of ending on a line", tex.field.masked);
  /* ── AND SIDEWAYS, WHICH IS THE ONE THAT WAS REPORTED TWICE ────────────
     A vertical fade fixes the bottom edge and leaves the right one. The
     scrollbar gutter is reserved whether or not a scrollbar is drawn in it,
     so the field's box is ten pixels narrower than the window and `right:0`
     put a hard vertical line exactly there. Three attempts to widen it were
     defeated by a clip. The field fades horizontally instead, so there is no
     edge to land anywhere. */
  ok("and fades sideways too, so the scrollbar gutter has no edge to show",
    /90deg/.test(tex.field.mask), tex.field.mask.slice(0, 70));
  ok("and the hero does not paint a second one over it", tex.heroClean);
  ok("the full-bleed band gets a different texture from the cards", tex.bandGrid);
  ok("and the rail, the thing you act on, is lit too", tex.rail);
  ok("no texture layer can eat a click", tex.inert, "pointer-events:none on every ::before");

  /* The (i) has to work for everyone: a click opens it, Escape closes it. A
     title= attribute would have been one line and invisible on touch. */
  await pT.click(".info[data-pop]");
  await pT.waitForTimeout(120);
  const opened = await pT.evaluate(() => ({
    shown: !!document.querySelector(".pop.on"),
    expanded: document.querySelector(".info[data-pop]").getAttribute("aria-expanded"),
    inView: (() => { const r = document.querySelector(".pop")?.getBoundingClientRect();
      return !!r && r.left >= 0 && r.right <= innerWidth; })(),
  }));
  ok("a click opens the explanation", opened.shown && opened.expanded === "true");
  ok("and it is kept inside the viewport", opened.inView, "a panel off the edge is a panel nobody reads");
  await pT.keyboard.press("Escape");
  await pT.waitForTimeout(120);
  ok("Escape closes it", await pT.evaluate(() => !document.querySelector(".pop")));
  ok("no errors", eT.length === 0, eT.join(" | "));
  await cT.close();
}

{
  /* MOBILE: same content, restructured — not the desktop reflowed. */
  const { ctx: cM, pg: pM, errs: eM } = await open(390, 850, true);
  await pM.click('.pri[data-main="shop"]');
  await pM.waitForTimeout(250);
  const m = await pM.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth, vw: innerWidth,
    sky: getComputedStyle(document.querySelector(".sky")).display,
    /* The blooms STAY on a phone and stop MOVING, which is what every other
       page on the site does. The cost was never the blur; it was animating
       it — a static blurred layer is rasterised once, an animated one is
       recomputed every frame as it scales. */
    skyMoves: [...document.querySelectorAll(".sky i")]
      .some((e) => getComputedStyle(e).animationName !== "none"),
    steps: document.querySelectorAll(".flow .fstep").length,
    /* The timeline: node in column one, words in column two, and the text
       must NOT have wrapped into the 38px node column. */
    textX: (() => { const s = document.querySelector(".flow .fstep i");
      return s ? Math.round(s.getBoundingClientRect().width) : 0; })(),
    infoTap: (() => { const b = document.querySelector(".info");
      const r = b.getBoundingClientRect(); return Math.round(Math.min(r.width, r.height)); })(),
  }));
  ok("the page never scrolls sideways", m.scrollW <= m.vw, `${m.scrollW} vs ${m.vw}`);
  /* THIS USED TO REQUIRE `display:none`, and that was the page drifting from
     the site. Hiding the blooms on a phone is something NO other Overheard
     page does, so the deals page looked like a different site on a phone
     while the desktop view looked right — the kind of inconsistency nobody
     reviewing it would call a bug. What is actually expensive is the
     ANIMATION, and that is what has to be off. */
  ok("the blooms are still there on a phone, exactly as on every other page",
    m.sky !== "none", "display: " + m.sky);
  ok("but they have stopped moving — an animated 90px blur is what makes a phone hot",
    m.skyMoves === false, m.skyMoves ? "still animating" : "static, rasterised once");
  ok("every step survives the rebuild", m.steps === 8, m.steps);
  ok("and the step text is a readable column, not a ribbon",
    m.textX > 180, m.textX + "px wide");
  ok("the (i) is a real tap target", m.infoTap >= 24, m.infoTap + "px");
  /* On a phone the rail LEADS: "order" belongs above the browsing, not a
     scroll below it. And it must not be sticky — a pinned card on a 390px
     screen eats the content it is meant to support. */
  const rail = await pM.evaluate(() => {
    const r = document.querySelector(".rail"), g = document.querySelector(".gigs");
    return { above: r.getBoundingClientRect().top < g.getBoundingClientRect().top,
             pos: getComputedStyle(r).position,
             cols: getComputedStyle(document.querySelector(".split")).gridTemplateColumns.split(" ").length };
  });
  ok("the order card leads on a phone", rail.above, "not a scroll below the browsing");
  ok("and is not pinned, which would eat the screen", rail.pos === "static", rail.pos);
  ok("the split collapses to one column", rail.cols === 1, rail.cols + " track");
  ok("no errors", eM.length === 0, eM.join(" | "));
  await cM.close();
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE BAR REACHES OUT OF ITS SHADOW ROOT EXACTLY ONCE, AND IT COLLIDED
 *
 * bar.js marks its own host element while a menu is open so it can raise its
 * z-index. It called that class `sheet`. deal.css has an unrelated `.sheet` —
 * a bottom-sheet component: position:fixed, bottom:0 — and a page stylesheet
 * always beats :host() on the host. So on every page that loads deal.css,
 * opening the profile menu threw the WHOLE BAR to the bottom of the screen,
 * half off it. Reported as "the bar appears in bottom of page and hides".
 *
 * Nothing errored, nothing warned, and neither rule was wrong on its own.
 * The only durable guard is to assert the two never share a word again.
 * ═════════════════════════════════════════════════════════════════════════*/
{
  const ctxB = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const pB = await ctxB.newPage();
  await pB.addInitScript(() => localStorage.setItem("overheard.session",
    JSON.stringify({ did: "did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz", at: new Date().toISOString() })));
  await pB.goto("http://localhost:9101" + PAGE, { waitUntil: "domcontentloaded" });
  await pB.waitForTimeout(1200);

  const before = await pB.evaluate(() => getComputedStyle(document.querySelector("overheard-bar")).position);
  await pB.evaluate(() => document.querySelector("overheard-bar").shadowRoot.querySelector(".chip")?.click());
  await pB.waitForTimeout(300);
  const after = await pB.evaluate(() => {
    const h = document.querySelector("overheard-bar");
    const cs = getComputedStyle(h);
    return { cls: h.className, pos: cs.position, top: Math.round(h.getBoundingClientRect().top),
             menuOpen: !!h.shadowRoot.querySelector(".menu") };
  });
  ok("opening the profile menu does not move the bar",
    after.pos === before && after.top === 0, `${before} -> ${after.pos} at y=${after.top}`);
  ok("and the class it puts on its own host is namespaced",
    /^oh-/.test(after.cls), after.cls || "(none)");
  ok("so no page stylesheet can claim it by accident",
    after.cls !== "sheet" && after.menuOpen, after.cls);

  /* And the three lines belong in the middle of their button. They were
     absolutely positioned against a parent that was not the button, so they
     sat against its top-left corner. */
  const bp = await pB.setViewportSize({ width: 420, height: 800 })
    .then(() => pB.waitForTimeout(250))
    .then(() => pB.evaluate(() => {
      const btn = document.querySelector("overheard-bar").shadowRoot.querySelector(".burger");
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return [...btn.querySelectorAll("i")].map((i) => {
        const li = i.getBoundingClientRect();
        return +(li.x + li.width / 2 - r.x - r.width / 2).toFixed(1);
      });
    }));
  ok("the hamburger's lines are centred in their button",
    bp && bp.length === 3 && bp.every((d) => Math.abs(d) < 0.6), JSON.stringify(bp));
  await ctxB.close();
}

await b.close(); srv.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

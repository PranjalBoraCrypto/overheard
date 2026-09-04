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
/* Against `code`, not `page`. The rule is that this file holds no key
   material, not that it may not use the WORD — and the comment explaining
   what the bar asks for (a passphrase when this browser holds a vault, a seed
   when it does not) has to be allowed to say so. */
ok("no key material of any kind",
  !/privateKey|secretKey|mnemonic|\bseed\b/i.test(code));
ok("no 64-hex string anywhere", !/[0-9a-f]{64}/i.test(page),
  (page.match(/[0-9a-f]{64}/i) || ["clean"])[0].slice(0, 20));
/* This page renders values that came off the public wire — a brief somebody
   else could have chosen, a job id, an amount. The rule the deals board keeps
   applies here for the same reason. */
ok("it never assigns markup",
  !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code),
  "briefs and amounts are wire data; they go in as text");
/* THIS RULE USED TO READ "and it does not sign anything either — a record is
   a reader". True, and correct, and also the reason no buyer could ever
   finish a deal: the lock is the payer's frame, and there was nowhere on the
   whole site to post one. The rule is no longer "does not sign". It is
   "signs only that". */
{
  const types = [...strip(code).matchAll(/type:\s*"([a-z]+)"/g)].map((m) => m[1]);
  ok("the only frame this page composes is a lock",
    types.length > 0 && types.every((t) => t === "lock"),
    types.join(",") || "none at all — then the button cannot work");
}
/* The deal room FIRST, the board only if the network refuses it. "never the
   offers room" was the rule until the measurement turned up: technocore is at
   its room cap, so a deal room usually cannot be created, and 52 accepts on
   this board produced 7 locks. runDeal folds by contract and reads no room
   name, so a lock on the board counts exactly as much — and the shop's own
   settle() has taken this fallback for months. A buyer held to the stricter
   rule would fail seven times in eight. */
{
  const order = [...strip(code).matchAll(/await post\((.*?)\);/g)].map((m) => m[1]);
  ok("the lock tries the deal room first",
    /o\.accept\.room/.test(order[0] ?? ""), order[0] ?? "no post at all");
  ok("and falls back to the board rather than giving up",
    /"tclk-offers"/.test(order[1] ?? ""), order[1] ?? "no fallback — 7 buyers in 8 would fail here");
}

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

console.log("\n=== C. the bar, and with it every identity state");
/* The three states the visitor asked for are all bar.js's, and mounting it is
   the whole implementation. Asserting the COMPONENT rather than any markup is
   the point: the bar's own comments record that two earlier attempts at "one
   bar" were copies of some CSS and both rotted. A fourth copy of an auth flow
   is the failure mode here, not a missing feature. */
for (const [name, file] of [["orders", page], ["order form", hire], ["the board", board]]) {
  ok(`${name} mounts the site's bar`,
    /<script src="\/bar\.js" type="module"><\/script>/.test(file) &&
    /<overheard-bar><\/overheard-bar>/.test(file));
}
ok("and none of them rolls its own sign-in",
  ![page, hire, board].some((f) => /type="password"|openVault\(|sealVault\(|keyFromSeed\(/.test(f)),
  "a passphrase field on a page is a second copy of the vault flow");

console.log("\n=== C2. you can get here, and get back");
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
/* ── AN ACCEPT IS ONLY AN ANSWER IF THE SHOP SENT IT ─────────────────────
   This endpoint decides whether the orders page paints a Pay button, and it
   matched any accept whose `ref` was the offer's id. Accepting a stranger's
   offer is a legal move on a public board, so an attacker could answer a
   buyer's offer, this endpoint would report it as the shop's answer, and the
   buyer would sign a lock naming the ATTACKER's contract — under which the
   attacker is the payee, reveals, and claims.
   The same hole was closed in api/accept.mjs. This is the other path to the
   same button, and closing one without the other closes neither. */
ok("an accept only counts as an answer if the shop signed it",
  /if \(row\.from !== SHOP\) return null;/.test(api),
  "otherwise a stranger's accept paints a Pay button on their own contract");
ok("and the shop's identity comes from the same place the runner's does",
  /SHOP = process\.env\.SHOP_DID/.test(api),
  "two spellings of who we are is one too many");
ok("it reports how much it actually read",
  /days_scanned/.test(api) && /days_available/.test(api) && /truncated/.test(api),
  "a bare array looks complete whatever happened");
/* THIS RULE USED TO READ "and it does not follow deal rooms", enforced by
   grepping for the word `contract`. It now derives one, because an order the
   shop accepted has to name somewhere the buyer can pay into — so the grep
   would fail while the property it stood for is intact. The property was
   never "never say contract". It was NO UPSTREAM READ PER ORDER, which is
   the thing that once spent the shared allowance and left the deals board
   rendering empty. So assert that instead, structurally: every network call
   in this file goes through grabText, and grabText is reached from exactly
   two places — the index, and a day shard. */
{
  const s = strip(api);
  const fetches = [...s.matchAll(/\bfetch\(/g)].length;
  const grabs = [...s.matchAll(/\bgrabText\(/g)].length;   // 1 definition + N calls
  ok("every upstream read goes through one function", fetches === 1,
    `${fetches} fetch call sites; more than one means a read this rule cannot see`);
  /* THREE call sites now, not two: the index, the TAIL, and a day shard. The
     tail is what makes this endpoint able to see an order placed in the last
     hour at all — day shards land on every twelfth archiver pass and the live
     room the page merges reaches back five minutes, so between them a real
     order was reported as "Nothing ordered yet".
     The rule was never "exactly two reads". It is that the number of reads is
     BOUNDED and none of them is per-order — that is what once spent the
     shared allowance and left the deals board empty. */
  ok("and every read it makes is one of three kinds", grabs === 4,
    `${grabs - 1} call sites: the archive index, the tail, and one day shard at a time`);
  ok("none of them sits inside a per-order loop",
    !/for \(const o of live[\s\S]{0,400}?\bawait\b/.test(s),
    "a read per order is what once made the deals board render empty");
  ok("so the accept hunt reads bytes already in hand",
    /for \(const text of recent\)/.test(s) &&
    !/for \(const text of recent\)[\s\S]{0,300}?\bawait\b/.test(s),
    "searching what we already paid for is free; fetching per order is not");
}

console.log("\n=== D2. the endpoint, driven for real, against the gap that hid an order");
{
  /* Section D reads this file as text. This runs it. The distinction earned
     its keep today: a real order, offer and accept and payment lock all on
     the board, was reported to its own buyer as "Nothing ordered yet".
     Day shards are committed on every twelfth archiver pass — that day the
     shard had not been rewritten since 08:46 — and the live room the page
     merges reaches back FIVE MINUTES (probed: the venue caps limit at 200
     however much is asked for, and `since` will not page backwards).
     An order in between existed in tail.ndjson and nowhere else. */
  process.env.SHOP_DID = "did:key:z6MkiuhfekPgiihLWarPAzhuvoMjg86F8dqmLiCTmtQgMrR3";
  const handler = (await import("../api/orders.js")).default;
  const { canon, offerId } = await import("../web/tclk.js");
  const BUYER = "did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz";
  const t = Date.now();

  const offer = {
    type: "offer", from: BUYER, role: "payer",
    job: { id: "overheard-room-summary", proto: "overheard", brief: "technocore" },
    amount: "250", asset: "FLOP", lock: "hash", rails: ["paper"],
    expiresMs: t + 12 * 3600e3, claimByMs: t + 12 * 3600e3, refundAfterMs: t + 36 * 3600e3,
    nonce: "abc123abc123abc1",
  };
  const id = await offerId(offer);
  const row = JSON.stringify({ seq: 70001, ts: new Date(t).toISOString(), from: BUYER, sig: "s",
    text: "tclk1 " + canon({ ...offer, id }) });

  let TAILTEXT = row, SHARDTEXT = "";
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.endsWith("_meta.json")) return new Response(JSON.stringify({ days: ["2026-09-04"] }), { status: 200 });
    if (s.endsWith("tail.ndjson")) return TAILTEXT === null ? new Response("no", { status: 404 }) : new Response(TAILTEXT, { status: 200 });
    if (s.endsWith(".ndjson")) return new Response(SHARDTEXT, { status: 200 });
    throw new Error("unexpected fetch " + s);
  };
  const call = async () => (await handler(new Request(`http://x/api/orders?did=${BUYER}`))).json();

  let r = await call();
  ok("an order that exists only in the tail is returned", (r.orders || []).length === 1,
    `${(r.orders || []).length} orders — this read 0 while the buyer's order was live and funded`);
  ok("and it carries the id an accept points at", r.orders?.[0]?.id === id);

  /* THE CONTROL. Same board, no tail: the bug exactly as the buyer met it. */
  TAILTEXT = null;
  r = await call();
  ok("without the tail the buyer is told they have never ordered", (r.orders || []).length === 0,
    "stated as the control, so the assertion above cannot pass for some other reason");

  /* The tail overlaps the newest shard on purpose, so the same order arrives
     twice and must be shown once. */
  TAILTEXT = row; SHARDTEXT = row;
  r = await call();
  ok("an order in both the tail and the shard is listed once", (r.orders || []).length === 1,
    `${(r.orders || []).length} — the overlap is deliberate; showing it twice is not`);

  /* ── THE BUDGET, WHICH THE RESTRUCTURE QUIETLY BROKE ─────────────────────
     Collecting every text before scanning any of it made `orders.length >=
     MAX_ORDERS` a test against an empty list — so every shard in the
     fourteen-day window was FETCHED (2.5 to 7.4 MB each, at the edge, which
     is the exact cost this file's header says must never be paid per
     request), and the scan then had no outer guard. Measured with 700 orders
     across three sources: 301 came back, and `truncated: false` was asserted
     over the top of it. */
  {
    const many = (n, from) => Array.from({ length: n }, (_, i) => JSON.stringify({
      seq: from + i, ts: new Date(t).toISOString(), from: BUYER, sig: "s",
      text: "tclk1 " + JSON.stringify({ ...offer, nonce: "n" + (from + i), id: "0x" + String(from + i).padStart(64, "0") }),
    })).join("\n");
    let fetched = 0;
    globalThis.fetch = async (u) => {
      const q = String(u);
      if (q.endsWith("_meta.json")) return new Response(JSON.stringify({ days: ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"] }), { status: 200 });
      fetched++;
      if (q.endsWith("tail.ndjson")) return new Response(many(300, 1), { status: 200 });
      return new Response(many(300, 1), { status: 200 });   // the SAME 300, overlapping
    };
    const r2 = await call();
    ok("the overlap between tail and shard costs one entry, not two",
      (r2.orders || []).length === 300,
      `${(r2.orders || []).length} orders from 300 distinct, served three times over`);
    /* Four shards are still fetched here and that is RIGHT: 300 distinct
       orders is under the cap, so there is more to look for. The property is
       that a SPENT budget stops the fetching — asserted next, because an
       assertion that passes while the budget never binds is testing nothing. */

    fetched = 0;
    globalThis.fetch = async (u) => {
      const q = String(u);
      if (q.endsWith("_meta.json")) return new Response(JSON.stringify({ days: ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"] }), { status: 200 });
      fetched++;
      if (q.endsWith("tail.ndjson")) return new Response(many(600, 1), { status: 200 });
      return new Response(many(600, 10000), { status: 200 });
    };
    const r2b = await call();
    ok("a spent budget stops it fetching shards it cannot use",
      fetched === 1, `${fetched} reads — the tail alone filled the cap, and each shard is megabytes at the edge`);
    ok("and the answer says it was truncated", r2b.truncated === true);
  }

  /* The answer must say whether the fresh source was there. It used to assert
     "about one collector pass, ~5 minutes" unconditionally — untrue when the
     shard is committed hourly, and wildly untrue on the day the shard also
     hit its body cap and stopped at 08:46. */
  {
    globalThis.fetch = async (u) => {
      const q = String(u);
      if (q.endsWith("_meta.json")) return new Response(JSON.stringify({ days: ["2026-09-04"] }), { status: 200 });
      if (q.endsWith("tail.ndjson")) return new Response("no", { status: 404 });
      return new Response("", { status: 200 });
    };
    const r3 = await call();
    ok("with no tail, the answer says so rather than claiming freshness",
      r3.tail === false && /hours behind/.test(String(r3.archive_lag)),
      String(r3.archive_lag).slice(0, 60));
  }

  globalThis.fetch = real;
}

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
/* ── THE STUB HAS TO CARRY THE WHOLE MODULE'S SURFACE ──────────────────────
   The page now mounts <overheard-bar>, and bar.js imports thirteen names from
   /session.js. A stub exporting three of them makes the browser throw
   "does not provide an export named PW_MIN" — an ES module import error, so
   the bar never defines its custom element and simply is not there. Nothing
   about the PAGE is wrong in that state, which is what makes it worth
   guarding: a hand-written stub is a second copy of an interface, and this
   one is generated from the real module's export list so it cannot fall
   behind it again. */
const REAL_SESSION = fs.readFileSync(path.join(ROOT, "web/session.js"), "utf8");
const EXPORTED = [...new Set([
  ...[...REAL_SESSION.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  ...[...REAL_SESSION.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
])];
const SESSION = (did) => {
  const overrides = {
    getSession: did ? `()=>({did:${JSON.stringify(did)}})` : "()=>null",
    onSession: "()=>{}",
    shortDid: did ? '(d)=>String(d).slice(0,12)+"…"+String(d).slice(-4)' : "(d)=>String(d)",
    hueOf: "()=>200",
    PW_MIN: "6",
    /* Echoes what it was asked to sign, so section K can assert the page
       signed over the right three things rather than merely over something.
       /api/post verifies the signature against room|nonce|text, so a page
       that signed `tclk-offers|…` for a frame it posted to a deal room would
       be rejected by the real server for a reason no stub returning a
       constant could ever surface. */
    signTextB64u: '(async (t) => "sig:" + t)',
  };
  return EXPORTED.map((n) =>
    `export const ${n} = ${overrides[n] ?? "(()=>{ const f = async () => null; return f; })()"};`
  ).join("\n");
};

/* ── THE ONE ORDER THE SHOP HAS ANSWERED ──────────────────────────────────
   FIXTURE[0] gets an accept, so exactly one row should grow a Pay strip and
   the other twenty-two should not. Everything section K asserts hangs off
   that asymmetry: a strip on every row would pass a test that only looked
   for one. */
const CONTRACT = "0x" + "ab12cd34ef5678900011223344556677889900aabbccddeeff00112233445566";
const DEALROOM = "mb-p-tclk-ab12cd34ef567890";
/* The list sorts by seq descending and pages ten at a time, so the order this
   hangs off has to be one of the newest — on FIXTURE[0], which carries the
   LOWEST seq, every assertion below failed for the entirely uninteresting
   reason that the row was on page three. */
const ANSWERED = FIXTURE.length - 1;
const LATE = FIXTURE.length - 2;
FIXTURE[ANSWERED].id = "0x" + "9".repeat(64);
FIXTURE[ANSWERED].refundAfterMs = now + 172800000;
FIXTURE[ANSWERED].accept = {
  from: "did:key:z6MkiuhfekPgiihLWarPAzhuvoMjg86F8dqmLiCTmtQgMrR3",
  ts: new Date(now - 600000).toISOString(),
  contract: CONTRACT, statement: "0x" + "7".repeat(64), room: DEALROOM,
};
/* An order the shop also answered, but too late to matter: past its refund
   deadline a lock buys nothing, so the strip must not appear. */
FIXTURE[LATE].id = "0x" + "8".repeat(64);
FIXTURE[LATE].refundAfterMs = now - 3600000;
FIXTURE[LATE].accept = { ...FIXTURE[ANSWERED].accept, contract: "0x" + "cd".repeat(32), room: "mb-p-tclk-cdcdcdcdcdcdcdcd" };

let signedInAs = DID;
let archiveAnswers = true;
let liveOverlap = 3;
/* What the deal room contains when the page goes looking, and what the page
   posted when it stopped. Both are the point of section K. */
let dealFrames = [];
/* A deal room that cannot be read at all — a 500, not an empty room. The
   difference decides whether a buyer is offered a second payment. */
let roomBroken = false;
let boardExtra = [];   // frames appended to the offers room
let posts = [];
let roomReads = [];
/* Held open on purpose for the first-paint test — see section H. */
let archiveDelayMs = 0;

const srv = http.createServer((q, r) => {
  const u = q.url.split("?")[0];
  if (u === "/session.js") {
    r.writeHead(200, { "content-type": "text/javascript" });
    return r.end(SESSION(signedInAs));
  }
  if (u === "/api/orders") {
    const body = archiveAnswers
      ? JSON.stringify({ did: DID, source: "repository", orders: FIXTURE,
          days_scanned: 2, days_available: 2, window_days: 14, truncated: false })
      : JSON.stringify({ source: "unavailable", orders: [] });
    const send = () => { r.writeHead(200, { "content-type": "application/json" }); r.end(body); };
    if (archiveDelayMs) setTimeout(send, archiveDelayMs); else send();
    return;
  }
  if (u === "/api/post") {
    let raw = "";
    q.on("data", (c) => { raw += c; });
    q.on("end", () => {
      try { posts.push(JSON.parse(raw)); } catch { posts.push({ unparseable: raw }); }
      r.writeHead(200, { "content-type": "application/json" });
      r.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (u === "/api/room") {
    const room = new URL(q.url, "http://x").searchParams.get("room");
    roomReads.push(room);
    if (roomBroken) { r.writeHead(500, { "content-type": "application/json" }); return r.end("{}"); }
    r.writeHead(200, { "content-type": "application/json" });
    /* A deal room is not the offers room and must not be answered with it —
       returning the board here would have let a broken page look fine. */
    if (room !== "tclk-offers") return r.end(JSON.stringify({ source: "live", messages: dealFrames }));
    /* The overlap is the point: these are the SAME orders the archive
       returned, arriving by the other road. */
    return r.end(JSON.stringify({ source: "live",
      messages: [...FIXTURE.slice(0, liveOverlap).map(asMessage), ...boardExtra] }));
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
  /* THE FAILURE THIS SECTION EXISTS FOR: before the reads land, the page must
     not be telling a returning customer they have never ordered anything.

     The first version raced it — load with `waitUntil:"commit"` and sample
     immediately — which is not a test, it is a coin toss, and it started
     failing the moment mounting the bar changed how long the document took to
     settle. So the ANSWER is held open instead. Now the loading state is a
     state the test can stand in, rather than an instant it has to catch. */
  archiveDelayMs = 900;
  const { ctx, pg } = await open();
  await pg.goto("http://localhost:9441/orders.html", { waitUntil: "domcontentloaded" });
  await pg.waitForSelector("#skel", { state: "attached" });
  await pg.waitForTimeout(250);                       // inside the held-open window
  const first = await read(pg);
  ok("while the answer is outstanding the skeleton shows",
    first.skel === false, "skeleton hidden: " + first.skel);
  ok("and the empty state does NOT",
    first.empty === true,
    "\"you have no orders\" must never be what a returning customer sees while it loads");
  await pg.waitForTimeout(1200);                      // now let it land
  const then = await read(pg);
  ok("and once it lands the skeleton gives way to the list",
    then.skel === true && then.rows > 0, `${then.rows} rows`);
  await ctx.close();
  archiveDelayMs = 0;
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
  /* ── THE SENTENCE THAT HAD TO CHANGE WITH THE PILL ────────────────────
     It used to read: "open" means this offer's expiry has not passed, not
     that nobody has accepted it. That was honest while the page knew nothing
     else — and it stopped being honest the moment the strip started reading
     the deal's own room, because a delivered order then rendered as a green
     OPEN pill directly above the words "this deal is finished". Small print
     is not a defence for a label contradicting the sentence beside it, so
     the pill changed and this had to follow it. */
  ok("the footer says a row reflects its deal once the deal has been read",
    /shows what its deal is once the deal's own room has been read/i.test(s.foot), s.foot.slice(-260));
  ok("and still says what the fallback means when it has not",
    /means only that this offer's expiry has not passed/i.test(s.foot), s.foot.slice(-200));
  ok("every job the shop can do has a readable name here",
    await pg.evaluate((jobs) => jobs.every((j) => document.documentElement.outerHTML.includes(j)),
      [...CAN_DO]),
    "an order should never show a raw job id");
  await ctx.close();
}

/* ══════════════════════════════════════════════════════════════════════════
 * K. THE LOCK — the step the buyer takes, which nothing on this site could do
 *
 * A tclk deal is offer → accept → LOCK → deliver → reveal, and the lock is the
 * payer's frame: the shop cannot post it, and until this section existed
 * neither could anybody else. Every deal the shop accepted stalled there and
 * died at its refund deadline while the buyer's own page said "open".
 * ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== K. the buyer can actually pay — and is never asked to pay twice");
{
  /* ── THE STRIP TELLS THE TRUTH BEFORE IT ASKS FOR ANYTHING ──────────────
     What this page said on a real order: "The shop accepted — your move" and
     a button reading "Pay into the lock", to a buyer whose payment was
     already locked, whose work had already been delivered, and whose deal had
     already been revealed. It said that because the strip was painted from
     /api/orders, which reads the OFFERS room, and a lock is not in the offers
     room — it is in the deal room.
     So the strip now reads that room before it offers anything, and there is
     no button at all until the answer says the payment is genuinely missing.
     The cost rule that used to forbid this still holds and is asserted below:
     bounded, one at a time, and only for rows that would show a button. */
  roomReads = []; posts = []; dealFrames = [];
  const { ctx, pg } = await open();
  await pg.goto("http://localhost:9441/orders.html", { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(1600);

  const strips = await pg.$$eval(".hact", (n) => n.length);
  ok("the answered order grows a strip", strips === 1, `${strips} strips on page one`);
  ok("and the twenty-two unanswered ones do not",
    await pg.$$eval(".hrow", (n) => n.length) === 10 && strips === 1,
    "a strip on every row would pass a test that only counted one");

  /* THE BUDGET RULE, still tested as behaviour. One read per ROW on every
     paint is what once left the deals board rendering empty. One read for the
     one row that would otherwise ask somebody for money is not that. */
  const painted = roomReads.filter((x) => x !== "tclk-offers");
  ok("only the rows that would ask for money read a room",
    painted.length === 1 && painted[0] === DEALROOM,
    `read on paint: ${painted.join(", ") || "none"} — ten rows, one read`);

  ok("with no lock anywhere, the button does appear", 
    await pg.$$eval(".hbtn:not([hidden])", (n) => n.length) === 1);
  ok("and it says the automatic payment did not land, not that this is a step",
    /did not land/i.test(await pg.$eval(".hactwords b", (e) => e.textContent)),
    await pg.$eval(".hactwords b", (e) => e.textContent));

  await pg.click(".hbtn");
  await pg.waitForTimeout(700);

  ok("posts exactly one frame", posts.length === 1, `${posts.length} posts`);
  const sent = posts[0] ?? {};
  const body = (() => { try { return JSON.parse(String(sent.text).slice(6)); } catch { return {}; } })();
  ok("into the deal room, not the board", sent.room === DEALROOM, String(sent.room));
  ok("signed by the buyer, who is the payer", sent.did === DID && body.from === DID);
  ok("it is a lock", body.type === "lock", body.type);
  ok("naming the contract the shop's accept named", body.contract === CONTRACT, String(body.contract));
  ok("on the rail the offer named", body.rail === "paper", String(body.rail));
  ok("and the signature covers room, nonce and text, in that order",
    sent.sig === `sig:${sent.room}|${sent.nonce}|${sent.text}`,
    "/api/post verifies over exactly those three; signing anything else is rejected");

  ok("the button goes once it has been pressed",
    await pg.$$eval(".hbtn", (n) => n.length) === 0,
    "a second lock is a frame the state machine refuses");
  ok("and the strip says what happened",
    /funded/i.test(await pg.$eval(".hsaid", (e) => e.textContent)));
  await ctx.close();
}
{
  /* THE CASE THAT WAS BROKEN IN FRONT OF A PERSON. The lock is in the deal
     room, exactly where /hire puts it in the same click as the order. Nothing
     on this page may suggest another payment. */
  roomReads = []; posts = [];
  dealFrames = [{ seq: 1, ts: new Date().toISOString(), from: DID,
    text: "tclk1 " + JSON.stringify({ type: "lock", from: DID, contract: CONTRACT, rail: "paper", ref: "aa" }) }];
  const { ctx, pg } = await open();
  await pg.goto("http://localhost:9441/orders.html", { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(1600);
  ok("an order already paid for offers no button at all",
    await pg.$$eval(".hbtn:not([hidden])", (n) => n.length) === 0,
    "this is the screenshot that started it");
  const words = await pg.$eval(".hactwords b", (e) => e.textContent);
  ok("it says the payment is in, in the buyer's words", /paid/i.test(words), words);
  ok("and the row's own pill agrees with it",
    (await pg.$eval(".hitem .hstate", (e) => e.textContent)) === "paid",
    await pg.$eval(".hitem .hstate", (e) => e.textContent));
  ok("and that there is nothing for them to do",
    /do not need to do anything/i.test(await pg.$eval(".hactwords span", (e) => e.textContent)));
  ok("the strip stops looking like a call to action",
    await pg.$$eval(".hact.done", (n) => n.length) === 1);
  ok("and nothing was posted merely by looking", posts.length === 0, `${posts.length} posts`);
  /* ── WHEN THE MONEY COMES BACK ────────────────────────────────────────
     `refundAfterMs` is on every offer and had never been shown to anybody.
     It is the answer to the only question a buyer with a locked payment
     actually has, and the shop cannot answer it by acting — a refund is the
     PAYER's move. Saying nothing left a person watching a locked payment
     with no idea whether it was gone. */
  const words2 = await pg.$eval(".hactwords span", (e) => e.textContent);
  ok("a locked payment says when it unlocks itself",
    /unlocks itself on /i.test(words2), words2);
  ok("as a moment in the reader's own day, not a protocol field",
    /\d{1,2}:\d{2}/.test(words2), words2);
  await ctx.close();
}
{
  /* ══════════════════════════════════════════════════════════════════════
   * THE ORDER THAT WILL NEVER FINISH
   *
   * MEASURED, 4 September: somebody ordered a summary of a room nobody has
   * ever recorded. The shop accepted it, took the lock, could not do the
   * work, and correctly refused to open it — so the money can only come back
   * the one way the protocol allows, at the payer's own deadline, 36 hours
   * later. Meanwhile this page said "Paid — the shop owes you the work",
   * which is telling somebody to wait for something that is not coming.
   * ═══════════════════════════════════════════════════════════════════*/
  roomReads = []; posts = [];
  const SHOPDID = "did:key:z6MkiuhfekPgiihLWarPAzhuvoMjg86F8dqmLiCTmtQgMrR3";
  dealFrames = [
    { seq: 1, ts: new Date().toISOString(), from: DID,
      text: "tclk1 " + JSON.stringify({ type: "lock", from: DID, contract: CONTRACT, rail: "paper", ref: "aa" }) },
    { seq: 2, ts: new Date().toISOString(), from: SHOPDID,
      text: "Overheard cannot deliver this order: the archive has no record of a room called "
          + "lobbygsgfguututu455. No payment has been taken and none can be — the lock is not opened, "
          + "so the escrow returns it to you at the refund deadline on this offer. "
          + "Nothing further is needed from this shop." },
  ];
  const { ctx, pg } = await open();
  await pg.goto("http://localhost:9441/orders.html", { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(1600);
  const head = await pg.$eval(".hactwords b", (e) => e.textContent);
  const body = await pg.$eval(".hactwords span", (e) => e.textContent);
  ok("it says the order cannot be filled, not that work is coming",
    /cannot be filled/i.test(head), head);
  ok("with the shop's own reason", /no record of a room called/i.test(body), body);
  ok("and when the payment unlocks itself", /unlocks itself on /i.test(body), body);
  ok("without repeating the same sentence twice in one paragraph",
    (body.match(/no payment has been taken/gi) ?? []).length === 0, body);
  ok("and it offers nothing to press", await pg.$$eval(".hbtn:not([hidden])", (n) => n.length) === 0);
  ok("nothing was posted", posts.length === 0, `${posts.length} posts`);
  /* Only the shop can say this. A stranger can copy the words into the room;
     they cannot post as us, and the page must read the transport, not the
     text. */
  dealFrames[1].from = DID;
  const c2 = await open();
  await c2.pg.goto("http://localhost:9441/orders.html", { waitUntil: "domcontentloaded" });
  await c2.pg.waitForTimeout(1600);
  ok("a stranger cannot fake that message",
    /owes you the work/i.test(await c2.pg.$eval(".hactwords b", (e) => e.textContent)),
    await c2.pg.$eval(".hactwords b", (e) => e.textContent));
  await c2.ctx.close();
  await ctx.close();
}
{
  /* Delivered and revealed: the end of the deal. */
  roomReads = []; posts = [];
  dealFrames = [
    { seq: 1, ts: new Date().toISOString(), from: DID,
      text: "tclk1 " + JSON.stringify({ type: "lock", from: DID, contract: CONTRACT, rail: "paper", ref: "aa" }) },
    { seq: 2, ts: new Date().toISOString(), from: "did:key:z6MkiuhfekPgiihLWarPAzhuvoMjg86F8dqmLiCTmtQgMrR3",
      text: "tclk1 " + JSON.stringify({ type: "reveal", from: "did:key:z6MkiuhfekPgiihLWarPAzhuvoMjg86F8dqmLiCTmtQgMrR3", contract: CONTRACT, secret: "c".repeat(64) }) },
  ];
  const { ctx, pg } = await open();
  await pg.goto("http://localhost:9441/orders.html", { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(1600);
  ok("a finished deal says it is finished",
    /delivered/i.test(await pg.$eval(".hactwords b", (e) => e.textContent)),
    await pg.$eval(".hactwords b", (e) => e.textContent));
  ok("and offers nothing to press", await pg.$$eval(".hbtn:not([hidden])", (n) => n.length) === 0);
  /* ── THE ROW THAT CONTRADICTED ITSELF ─────────────────────────────────
     A finished deal rendered a green OPEN pill immediately above the words
     "This deal is finished". Nobody reads that as "the offer's expiry has
     not elapsed"; they read it as "this is not done yet", and the small
     print at the bottom of the page is not a defence for a label that
     contradicts the sentence next to it. */
  ok("the pill says delivered, not open",
    (await pg.$eval(".hitem .hstate", (e) => e.textContent)) === "delivered",
    await pg.$eval(".hitem .hstate", (e) => e.textContent));
  ok("and it does not read as still going",
    (await pg.$$eval(".hitem .hstate.live", (n) => n.length)) === 0,
    "green is the colour of a deal somebody is still waiting on");
  ok("the counters stop calling a delivered order still open",
    (await pg.$eval("#nOpen", (e) => e.textContent)) !== (await pg.$eval("#nAll", (e) => e.textContent)),
    `${await pg.$eval("#nOpen", (e) => e.textContent)} still open of ${await pg.$eval("#nAll", (e) => e.textContent)} — one of them is finished`);
  await ctx.close();
}
{
  /* THE LOCK THAT LANDED ON THE BOARD. technocore is at its room cap, so both
     the shop and this page fall back to posting in tclk-offers — and a check
     that only ever looked in the deal room would report "accepted" for a deal
     already funded, and offer a Pay button for a payment already made. */
  roomReads = []; posts = []; dealFrames = [];
  boardExtra = [{ seq: 9001, ts: new Date().toISOString(), from: DID, nonce: "w1", sig: "s",
    text: "tclk1 " + JSON.stringify({ type: "lock", from: DID, contract: CONTRACT, rail: "paper", ref: "bb" }) }];
  const { ctx, pg } = await open();
  await pg.goto("http://localhost:9441/orders.html", { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(1600);
  ok("a lock that fell back to the board is found on paint too",
    await pg.$$eval(".hbtn:not([hidden])", (n) => n.length) === 0,
    "the deal room is empty here; only the board knows");
  ok("and the buyer is not asked to pay twice",
    /paid/i.test(await pg.$eval(".hactwords b", (e) => e.textContent)));
  ok("nothing was posted", posts.length === 0, `${posts.length} posts`);
  boardExtra = [];
  await ctx.close();
}
{
  roomReads = []; posts = [];
  dealFrames = [{ seq: 1, ts: new Date().toISOString(), from: "did:key:z6MkiuhfekPgiihLWarPAzhuvoMjg86F8dqmLiCTmtQgMrR3",
    text: "tclk1 " + JSON.stringify({ type: "cancel", from: "did:key:z6MkiuhfekPgiihLWarPAzhuvoMjg86F8dqmLiCTmtQgMrR3", contract: CONTRACT, reason: "never funded before refundAfterMs" }) }];
  const { ctx, pg } = await open();
  await pg.goto("http://localhost:9441/orders.html", { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(1600);
  ok("a deal the reaper closed cannot be paid into",
    await pg.$$eval(".hbtn:not([hidden])", (n) => n.length) === 0);
  ok("and nothing implies money moved",
    /nothing was charged/i.test(await pg.$eval(".hactwords span", (e) => e.textContent)));
  ok("no post was made", posts.length === 0, `${posts.length} posts`);
  await ctx.close();
}
{
  /* ── AN UNREADABLE DEAL IS NOT AN UNPAID ONE ────────────────────────────
     The old code's failure mode was to assume "no lock seen" meant "not
     paid". When the room cannot be read at all, the honest answer is to say
     nothing rather than to invite a second payment on a guess. */
  roomReads = []; posts = []; dealFrames = [];
  roomBroken = true;
  const { ctx, pg } = await open();
  await pg.goto("http://localhost:9441/orders.html", { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(1600);
  ok("a deal we could not read offers no payment",
    await pg.$$eval(".hbtn:not([hidden])", (n) => n.length) === 0,
    "guessing here is guessing with somebody's money");
  ok("and the strip removes itself rather than saying something wrong",
    await pg.$$eval(".hact:not([hidden])", (n) => n.length) === 0);
  roomBroken = false;
  await ctx.close();
}
{
  /* FIXTURE[LATE] is accepted too, and past refundAfterMs. A lock there buys
     nothing: reveal is refused at `at >= refundAfter`, and a refund needs a
     lock that never came. It sits on page one of the closed filter. */
  dealFrames = [];
  const { ctx, pg } = await open();
  await pg.goto("http://localhost:9441/orders.html", { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(1600);
  const late = await pg.evaluate(() => document.querySelectorAll(".hitem").length);
  ok("an accepted order past its refund deadline gets no strip", late === 1,
    `${late} strips — the expired one must not offer a payment that cannot buy anything`);
  await ctx.close();
}
{
  /* Signed out there is no key to sign with, so the strip must not be a
     button that fails on click. */
  signedInAs = null;
  const { ctx, pg } = await open();
  await pg.goto("http://localhost:9441/orders.html", { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(1400);
  ok("signed out, no Pay button is offered at all",
    await pg.$$eval(".hbtn:not([hidden])", (n) => n.length) === 0);
  signedInAs = DID;
  await ctx.close();
}

console.log("\n=== J. nothing threw");
ok("no script errors", errs.length === 0, errs.join(" | "));

await browser.close();
await new Promise((res) => srv.close(res));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

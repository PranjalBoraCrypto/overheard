/**
 * A buyer can complete an order in ONE VISIT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS ITS OWN SUITE AND NOT A SECTION SOMEWHERE
 *
 * The thing under test is not a page and not a function. It is a PATH that
 * crosses four files and two runtimes — hire.html composes and signs, api/post
 * forwards, api/accept signs as the shop and judges with the runner's own
 * rules, and hire.html signs again over a contract it could not have known
 * before the round trip. Nothing type-checks across those seams and nothing
 * else in this repository exercises them end to end.
 *
 * WHAT WENT WRONG WITHOUT IT. Two failures, both silent, both discovered by
 * reading rather than by a red test:
 *
 *   · the order form never wrote the offer's `id`, so plan() dropped every
 *     order this site composed before refuseTake() was ever consulted — into
 *     neither the taken list nor the passed list, so the wake's log did not
 *     mention it either;
 *   · the deal a buyer had to fund needed a SECOND VISIT an hour later, and
 *     measured from the other side of this same network, that shape turned
 *     52 accepts into 7 locks.
 *
 * Both look fine from every angle except the one that matters: did a person
 * who pressed the button end up with a deal.
 * ═════════════════════════════════════════════════════════════════════════*/
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

/* ── ONE SUITE, TWO HALVES, AND THE BROWSER HALF IS OPTIONAL ───────────────
   Section A drives the endpoint directly and needs nothing but node, so it
   can run on the shop's own hourly wake — which is where it belongs, because
   the half that drifts underneath it is the runner's. Section B needs a real
   browser, and the wake's container has no Playwright.

   A SKIP IS NOT A PASS and is not allowed to read like one. If the browser is
   missing this says so on its own line, in the summary, and in the exit
   message, because "40 passed" printed by a run that tested half of what it
   names is worse than no suite at all. */
let chromium = null;
try { ({ chromium } = await import("playwright")); } catch { /* reported below */ }

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let pass = 0, fail = 0;
const ok = (what, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${what}${detail ? "   " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${what}${detail ? "   " + detail : ""}`); }
};

/* The shop's key for this run is generated, never a constant, so nothing here
   can accidentally be the real one and no fixture can drift into looking like
   a credential. SHOP_DID makes the runner treat it as this shop. */
const SEED = randomBytes(32).toString("hex");
const { agentFromSeed } = await import("./agent.mjs");
const shop = agentFromSeed(SEED);
process.env.SHOP_DID = shop.did;
process.env.OVERHEARD_SEED = SEED;
/* No cache between cases, or the first case's book answers all of them. */
process.env.ACCEPT_BOOK_TTL_MS = "0";

const { canon, offerId, dealRoom } = await import("../web/tclk.js");
const { JOBS } = await import("./runner.mjs");
const acceptModule = (await import("../api/accept.mjs"));
/* Called the way VERCEL calls it, not the way the file happens to export it —
   see section A's shape assertions for why that distinction cost a day. */
const acceptHandler = (req) => {
  const f = acceptModule.default?.fetch;
  if (typeof f !== "function") throw new Error("the module exports no fetch handler — see the shape assertions above");
  return f(req);
};

const BUYER = "did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz";
const HOUR = 3600000;
const now = Date.now();
const SHELF = JOBS.find((j) => j.id === "overheard-room-summary");

const offerBody = (over = {}) => ({
  type: "offer", from: BUYER, role: "payer",
  job: { id: SHELF.id, proto: "overheard", brief: "technocore" },
  amount: SHELF.amount, asset: "FLOP", lock: "hash", rails: ["paper"],
  expiresMs: now + 12 * HOUR, claimByMs: now + 12 * HOUR, refundAfterMs: now + 36 * HOUR,
  nonce: "0123456789abcdef", ...over,
});
const wireOf = async (b) => "tclk1 " + canon({ ...b, id: await offerId(b) });
const rowOf = async (b, seq = 1, from = BUYER) =>
  ({ seq: String(seq), ts: new Date(now).toISOString(), from, text: await wireOf(b), sig: "s" });

/* ══════════════════════════════════════════════════════════════════════════
 * A. THE ENDPOINT, DRIVEN DIRECTLY
 *
 * No browser. The board is a stub, so every answer below is a decision this
 * code made rather than something the network happened to do.
 * ═════════════════════════════════════════════════════════════════════════*/
console.log("=== A. the shop answers on demand");

{
  /* ── THE SHAPE VERCEL DISPATCHES TO, WHICH IS NOT A STYLE CHOICE ─────────
     Vercel's Node runtime accepts exactly three shapes for a file in /api:
     `export default { fetch(request) }`, per-method exports (`export function
     POST`), or the Node `(req, res)` signature. This file shipped as
     `export default async function handler(request)`, which is none of them.
     Vercel read a bare default-exported function as the NODE signature and
     called it with (IncomingMessage, ServerResponse). `request.method` exists
     on an IncomingMessage so nothing complained; `request.json()` does not,
     the rejection escaped, res.end() was never reached, and the request HUNG
     until the platform timed it out. From a browser: a fetch that never
     settles. No status, no error, no log line.

     EVERY ASSERTION IN THIS SECTION PASSED THROUGHOUT, because the suite
     imported `.default` and called it as a function — which is to say it
     called the handler the way the handler expected, and Vercel's opinion was
     the only one that mattered. */
  const m = await import("../api/accept.mjs");
  ok("the default export is an object with a fetch method",
    m.default !== null && typeof m.default === "object" && typeof m.default.fetch === "function",
    `default is ${typeof m.default}` + (typeof m.default === "function"
      ? " — Vercel will call this with (req, res) and the request will hang" : ""));
  ok("and it is not a bare function, which Vercel reads as (req, res)",
    typeof m.default !== "function");
  ok("the runtime is declared, because the signing chain needs node:crypto",
    m.config?.runtime === "nodejs", String(m.config?.runtime));
}

let BOARD = [];          // what the stubbed board returns (the LIVE read)
let ARCHIVE = [];        // and what the archived shards hold (rows, not frames)
let TAIL = [];           // and the archiver's fresh window over the same room
let ARCHIVE_UP = true;   // or whether the repository can be reached at all
let SHARDS_DOWN = false; // _meta names a day whose shard the CDN has not got
let ARCHIVE_DAYS = ["2026-09-02"];
let RAWHITS = 0;         // how many times the repository was actually read
let BOARDFAILS = 0;      // make the next N board reads refuse, as technocore does
let POSTED = [];         // what the endpoint tried to say, and where
const realFetch = globalThis.fetch;   // put back before section B
globalThis.fetch = async (url, init) => {
  const u = String(url);
  /* THE ARCHIVE IS STUBBED TOO, and the first version of this file forgot —
     so the suite quietly fetched 2.5 MB of real shards from GitHub on every
     case and passed for reasons that had nothing to do with the fixtures. A
     test that reaches the internet is a test that is green when the internet
     is, which is not the property anybody wanted. Anything unmatched below
     now throws rather than escaping to the network. */
  if (u.includes("raw.githubusercontent.com")) {
    RAWHITS++;
    if (!ARCHIVE_UP) return new Response("no", { status: 500 });
    if (u.endsWith("_meta.json")) return new Response(JSON.stringify({ days: ARCHIVE_DAYS }), { status: 200 });
    if (u.endsWith("tail.ndjson")) {
      /* 404 and 500 are DIFFERENT ANSWERS and the endpoint must treat them
         so: absent is "not published yet", failed is an outage over the only
         fresh source there is. */
      if (TAIL === null) return new Response("no", { status: 404 });
      if (TAIL === "fail") return new Response("no", { status: 500 });
      return new Response(TAIL.map((r) => JSON.stringify(r)).join("\n"), { status: 200 });
    }
    if (SHARDS_DOWN) return new Response("no", { status: 404 });
    return new Response(ARCHIVE.map((r) => JSON.stringify(r)).join("\n"), { status: 200 });
  }
  if (u.includes("/say-signed/")) {
    /* The say URL carries room, did, sig, nonce and the text, in that order.
       Parsed rather than pattern-matched so a change in the shape of it
       shows up here as a failure instead of as a silent miss. */
    const m = u.match(/\/r\/([^/]+)\/say-signed\/([^/]+)\/([^/]+)\/([^/]+)\/([^?]+)/);
    POSTED.push({ room: m?.[1], did: m?.[2], text: decodeURIComponent(m?.[5] ?? "") });
    return new Response("{}", { status: 200 });
  }
  if (u.includes("/r/tclk-offers?")) {
    if (BOARDFAILS > 0) { BOARDFAILS--; return new Response("no", { status: 429 }); }
    return new Response(JSON.stringify({ messages: BOARD }), { status: 200 });
  }
  throw new Error(`the suite tried to reach the network: ${u.slice(0, 80)}`);
};

const call = async (offer) => {
  const res = await acceptHandler(new Request("http://x/api/accept", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offer }),
  }));
  return { status: res.status, body: await res.json() };
};

{
  const b = offerBody();
  const id = await offerId(b);
  BOARD = [await rowOf(b)]; POSTED = [];
  const r = await call(id);
  ok("a good order is accepted, now", r.body.ok === true, r.body.why ?? "");
  ok("and the accept is a real frame on the board",
    POSTED.length === 1 && POSTED[0].room === "tclk-offers" && POSTED[0].text.startsWith("tclk1 "),
    `${POSTED.length} posted to ${POSTED[0]?.room}`);
  ok("signed by the shop, not by anybody else", POSTED[0]?.did === shop.did);
  const acc = JSON.parse(POSTED[0].text.slice(6));
  ok("it answers THIS offer", acc.ref === id, acc.ref);
  ok("and hands back the contract the buyer has to name",
    r.body.contract === acc.contract && /^0x[0-9a-f]{64}$/.test(r.body.contract || ""),
    r.body.contract);
}
{
  /* IDEMPOTENCE. A double-click, a retry after a slow answer, or two tabs
     must not produce two accepts: the state machine refuses the second, and
     the buyer cannot tell which contract to pay into. */
  const b = offerBody({ nonce: "1111111111111111" });
  const id = await offerId(b);
  BOARD = [await rowOf(b)]; POSTED = [];
  const first = await call(id);
  BOARD = [...BOARD, { seq: "2", ts: new Date(now).toISOString(), from: shop.did, text: POSTED[0].text, sig: "s" }];
  const second = await call(id);
  ok("asking twice does not accept twice", POSTED.length === 1, `${POSTED.length} accepts posted`);
  ok("and the second answer is the first one's contract",
    second.body.ok === true && second.body.already === true && second.body.contract === first.body.contract);
}
{
  /* THE CALLER DESCRIBES NOTHING. Only an id crosses the wire, so a caller
     cannot ask the shop to accept better terms than they posted. */
  const b = offerBody({ nonce: "2222222222222222", amount: "1" });   // underpriced
  const id = await offerId(b);
  BOARD = [await rowOf(b)]; POSTED = [];
  const r = await call(id);
  ok("an underpriced order is refused, by the runner's own rules",
    r.body.ok === false && Array.isArray(r.body.refused) && /priced at/.test(r.body.why),
    r.body.why);
  ok("and nothing was signed", POSTED.length === 0);
}
{
  const b = offerBody({ nonce: "3333333333333333", job: { id: "overheard-archive-question", proto: "overheard", brief: "x" } });
  const id = await offerId(b);
  BOARD = [await rowOf(b)]; POSTED = [];
  const r = await call(id);
  ok("a job with no handler is refused rather than sold",
    r.body.ok === false && /no handler/.test(r.body.why), r.body.why);
}
{
  BOARD = []; POSTED = [];
  const r = await call("0x" + "a".repeat(64));
  ok("an offer that is not on the board is 'not yet', not 'no such thing'",
    r.body.ok === false && r.body.pending === true, r.body.why);
  ok("and still nothing was signed", POSTED.length === 0);
}
{
  POSTED = [];
  const r = await call("nonsense");
  ok("a malformed id costs no upstream read at all",
    r.status === 400 && POSTED.length === 0, String(r.status));
}
{
  /* CAPACITY, and the reason the answer has to say `standing`. The order is
     not dead — it lasts twelve hours and the next wake takes it when a slot
     frees — so a page told "full" can still say something true. */
  const { MAX_OPEN_DEALS } = await import("./runner.mjs");
  const rows = [];
  for (let i = 0; i < MAX_OPEN_DEALS; i++) {
    const b = offerBody({ nonce: "cap" + String(i).padStart(13, "0") });
    const id = await offerId(b);
    rows.push(await rowOf(b, 10 + i));
    rows.push({
      seq: String(100 + i), ts: new Date(now).toISOString(), from: shop.did, sig: "s",
      text: "tclk1 " + canon({
        type: "accept", from: shop.did, ref: id, statement: "0x" + "7c".repeat(32),
        nonce: "acc" + String(i).padStart(13, "0"),
        contract: "0x" + String(i).padStart(4, "0") + "e".repeat(60),
      }),
    });
  }
  const mine = offerBody({ nonce: "4444444444444444" });
  const mineId = await offerId(mine);
  BOARD = [...rows, await rowOf(mine, 900)]; POSTED = [];
  const r = await call(mineId);
  ok("at capacity the shop declines rather than overcommitting",
    r.body.ok === false && r.body.full === true, r.body.why);
  ok("and says the order is still standing",
    r.body.standing === true,
    "'full' with no 'standing' reads as a dead order; it is not one");
  ok("and signs nothing", POSTED.length === 0);

  /* ── ASKING BEFORE COMMITTING, WHICH IS THE POINT OF THE GET ───────────
     The capacity rule has only ever been discoverable by hitting it: compose
     an order, sign it, post it to a public board, and then find out. Nothing
     is lost, but a person has signed something to learn a fact the site
     could have handed them for free. GET the same endpoint, and it says.
     Same book, same plan(), so the number the page shows and the number that
     decides cannot drift. */
  const get = async () => {
    const res = await acceptHandler(new Request("http://x/api/accept", { method: "GET" }));
    return { status: res.status, body: await res.json(), head: res.headers };
  };
  const c = await get();
  ok("GET says how full the shop is", c.body.ok === true, JSON.stringify(c.body).slice(0, 120));
  ok("and says it is full, from the same book that just refused an order",
    c.body.full === true && c.body.open >= MAX_OPEN_DEALS,
    `${c.body.open} of ${c.body.capacity}`);
  ok("the cap it reports is the cap that is enforced",
    c.body.capacity === MAX_OPEN_DEALS,
    "two numbers for one rule is how a page starts lying");
  ok("no free slots when full", c.body.free === 0, String(c.body.free));
  ok("and it splits work owed from buyers who have not paid",
    c.body.working + c.body.awaiting_payment === c.body.open,
    `${c.body.working} working + ${c.body.awaiting_payment} unpaid = ${c.body.open}`);
  ok("asking costs no signature", POSTED.length === 0);

  /* Cached, because this is read on every load of /hire and a live board read
     per page view is exactly what once left the deals board rendering empty:
     it spent the shared upstream allowance on itself. */
  const before = RAWHITS;
  const again = await get();
  ok("a second look inside the window costs no upstream read",
    RAWHITS === before && again.body.cached === true,
    `${RAWHITS - before} reads, cached=${again.body.cached}`);
  ok("and answers the same thing", again.body.full === c.body.full && again.body.open === c.body.open);
}
{
  /* ── AN UNREADABLE BOOK IS NOT A FULL SHOP ─────────────────────────────
     A page that renders "full" on a failed lookup turns a bad minute at the
     venue into a closed shop; one that renders "open" invites an order the
     checkout will refuse. So the endpoint says it does not know, and the page
     leaves the form alone — the order works without this endpoint at all. */
  const { default: mod } = await import("../api/accept.mjs?nocache=" + Math.random());
  BOARDFAILS = 9; POSTED = [];
  const res = await mod.fetch(new Request("http://x/api/accept", { method: "GET" }));
  const body = await res.json();
  BOARDFAILS = 0;
  ok("a board that will not answer is reported as unknown, not as full",
    body.ok === false && body.unknown === true && body.full !== true,
    JSON.stringify(body).slice(0, 120));
  ok("with a status that says upstream, not client error", res.status === 503, String(res.status));
  ok("and it still signs nothing", POSTED.length === 0);
}
{
  /* ── THE CAPACITY CHECK HAS TO SEE DEALS THE LIVE WINDOW HAS FORGOTTEN ───
     A read returns the newest 200 messages and the board carries ~4,200 a
     day, so our own accepts are gone from it within the hour. The first
     version of this endpoint planned from that read alone: `open` counted
     whatever happened to still be visible, which is normally nothing, so
     `atCapacity` was permanently false and the shop would sign without limit.
     Here the accepts exist ONLY in the archive — the live board shows just
     the new order — which is exactly the production case. */
  const { MAX_OPEN_DEALS } = await import("./runner.mjs");
  const scrolled = [];
  for (let i = 0; i < MAX_OPEN_DEALS; i++) {
    const b = offerBody({ nonce: "old" + String(i).padStart(13, "0") });
    const id = await offerId(b);
    scrolled.push(await rowOf(b, 10 + i));
    scrolled.push({
      seq: String(100 + i), ts: new Date(now).toISOString(), from: shop.did, sig: "s",
      text: "tclk1 " + canon({
        type: "accept", from: shop.did, ref: id, statement: "0x" + "7c".repeat(32),
        nonce: "acc" + String(i).padStart(13, "0"),
        contract: "0x" + String(i).padStart(4, "0") + "e".repeat(60),
      }),
    });
  }
  const fresh = offerBody({ nonce: "6666666666666666" });
  ARCHIVE = scrolled; BOARD = [await rowOf(fresh, 900)]; POSTED = [];
  const r = await call(await offerId(fresh));
  ok("a full book still binds once our accepts have scrolled out of the live read",
    r.body.ok === false && r.body.full === true,
    r.body.why ?? "signed anyway — the cap would never bind in production");
  ok("and signs nothing", POSTED.length === 0);
  ARCHIVE = [];
}
{
  /* "CANNOT SEE OUR OWN BOOK" MUST NOT RESOLVE TO "GO AHEAD". Without the
     archive the endpoint cannot know whether the shop is full, and a shop
     that signs while it cannot count is a shop signing promises it may not
     keep. The order stands; the cron plans from a real book. */
  const b = offerBody({ nonce: "7777777777777777" });
  ARCHIVE_UP = false; BOARD = [await rowOf(b)]; POSTED = [];
  const r = await call(await offerId(b));
  ok("with the archive unreachable it refuses rather than guessing",
    r.body.ok === false && r.body.pending === true, r.body.why);
  ok("and signs nothing", POSTED.length === 0);
  ARCHIVE_UP = true;
}
{
  /* ── THE ATTACK THE IDEMPOTENCE SCAN NEARLY ALLOWED ──────────────────────
     Accepting a stranger's offer is a legal move on a public board. When the
     scan matched ANY accept, an attacker could answer a buyer's offer and
     this endpoint would hand the attacker's contract back to that buyer as
     the shop's own answer — and the page signs a lock naming whatever
     contract it is given. Folding those frames, the attacker is the payee. */
  const b = offerBody({ nonce: "8888888888888888" });
  const id = await offerId(b);
  const ATTACKER = "did:key:z6MkAttackerZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
  const evil = "0x" + "ee".repeat(32);
  BOARD = [await rowOf(b), {
    seq: "2", ts: new Date(now).toISOString(), from: ATTACKER, sig: "s",
    text: "tclk1 " + canon({
      type: "accept", from: ATTACKER, ref: id, statement: "0x" + "11".repeat(32),
      nonce: "0000000000000099", contract: evil,
    }),
  }];
  POSTED = [];
  const r = await call(id);
  ok("a stranger's accept is never reported as ours",
    r.body.ok === false && r.body.answered_elsewhere === true, JSON.stringify(r.body).slice(0, 90));
  ok("and their contract is not handed to the buyer to pay into",
    JSON.stringify(r.body).includes(evil) === false,
    "the buyer would have locked into a deal whose payee is the attacker");
  ok("and we do not sign a second accept either", POSTED.length === 0);
}
{
  /* ── THE HOUR THE SHARDS CANNOT SEE ──────────────────────────────────────
     Day shards are committed on every twelfth archiver pass — on 4 September
     the day's had not been rewritten since 08:46 — and the live read this
     book merges reaches back FIVE MINUTES (probed: the venue caps limit at
     200 whatever is asked, and `since` will not page backwards).
     Deals accepted in between exist only in tail.ndjson. If the book does not
     read it, the capacity check under-counts by however many deals the shop
     agreed to in the last few hours, and signs on top of them. */
  const { MAX_OPEN_DEALS } = await import("./runner.mjs");
  const fresh = [];
  for (let i = 0; i < MAX_OPEN_DEALS; i++) {
    const b = offerBody({ nonce: "tl" + String(i).padStart(14, "0") });
    const id = await offerId(b);
    fresh.push(await rowOf(b, 200 + i));
    fresh.push({
      seq: String(300 + i), ts: new Date(now).toISOString(), from: shop.did, sig: "s",
      text: "tclk1 " + canon({
        type: "accept", from: shop.did, ref: id, statement: "0x" + "7c".repeat(32),
        nonce: "tla" + String(i).padStart(13, "0"),
        contract: "0x" + String(i).padStart(4, "0") + "f".repeat(60) }),
    });
  }
  const mine = offerBody({ nonce: "ffff000000000001" });
  ARCHIVE = []; TAIL = fresh; BOARD = [await rowOf(mine, 900)]; POSTED = [];
  const r = await call(await offerId(mine));
  ok("deals that exist only in the tail still bind the cap",
    r.body.ok === false && r.body.full === true,
    r.body.ok ? "SIGNED ON TOP OF A FULL BOOK — the shards are hours old and the room is five minutes" : r.body.why);
  ok("and nothing is signed", POSTED.length === 0);

  /* THE CONTROL, which is the bug: no tail, same board, and the shop signs. */
  TAIL = [];
  POSTED = [];
  const r2 = await call(await offerId(mine));
  ok("without the tail it cannot see them, which is what went wrong",
    r2.body.ok === true,
    "stated as the control so the assertion above cannot pass for another reason");
  TAIL = []; ARCHIVE = [];
}
{
  /* ── 404 AND 500 ARE NOT THE SAME ANSWER ─────────────────────────────────
     A tail that is ABSENT is the first archiver pass after this ships, and
     the shards alone are exactly the old behaviour. A tail that FAILS is an
     outage over the only fresh source there is — and treating the pair alike
     silently reverted this endpoint to signing on a full book, which is the
     failure it exists to prevent. This file's own rule for shards is that
     "cannot tell" must never resolve to "go ahead"; the tail gets it too. */
  const b = offerBody({ nonce: "ffff000000000002" });
  ARCHIVE = [await rowOf(b)]; BOARD = [await rowOf(b)];

  TAIL = null; POSTED = [];
  const missing = await call(await offerId(b));
  ok("a tail that is not there yet is not an outage", missing.body.ok === true, missing.body.why ?? "");

  TAIL = "fail"; POSTED = [];
  const broken = await call(await offerId(b));
  ok("but a tail that will not load is refused, not shrugged off",
    broken.body.ok === false && broken.body.pending === true,
    broken.body.ok ? "SIGNED on a book missing its only fresh source" : broken.body.why);
  ok("and nothing is signed on a book we could not complete", POSTED.length === 0);
  TAIL = [];
}
{
  /* ── THE TAIL MUST BE REACHED EVEN BY A SHOP WITH A LONG HISTORY ─────────
     Pass one of the book scan stops at MAX_WANTED, and `wanted` fills from
     our own accepts across three days of shards. With the tail read LAST, a
     shop with two hundred accepts behind it never reached the tail at all —
     and the correlation is the worst available: only a shop trading enough to
     sit at its cap accumulates that many accepts, so the tail went dark
     exactly when the cap it feeds mattered. Measured before the fix: 199
     prior accepts and the book was right, 200 and the shop signed. */
  const { MAX_OPEN_DEALS } = await import("./runner.mjs");
  const noise = [];
  for (let i = 0; i < 260; i++) {
    const b = offerBody({ nonce: "nz" + String(i).padStart(14, "0") });
    const id = await offerId(b);
    noise.push(await rowOf(b, 1000 + i));
    noise.push({ seq: String(5000 + i), ts: new Date(now).toISOString(), from: shop.did, sig: "s",
      text: "tclk1 " + canon({ type: "accept", from: shop.did, ref: id,
        statement: "0x" + "7c".repeat(32), nonce: "nza" + String(i).padStart(13, "0"),
        contract: "0x" + String(i).padStart(4, "0") + "a".repeat(60) }) });
  }
  const live = [];
  for (let i = 0; i < MAX_OPEN_DEALS; i++) {
    const b = offerBody({ nonce: "lv" + String(i).padStart(14, "0") });
    const id = await offerId(b);
    live.push(await rowOf(b, 8000 + i));
    live.push({ seq: String(9000 + i), ts: new Date(now).toISOString(), from: shop.did, sig: "s",
      text: "tclk1 " + canon({ type: "accept", from: shop.did, ref: id,
        statement: "0x" + "7c".repeat(32), nonce: "lva" + String(i).padStart(13, "0"),
        contract: "0x" + String(i).padStart(4, "0") + "b".repeat(60) }) });
  }
  const mine = offerBody({ nonce: "ffff000000000003" });
  ARCHIVE = noise; TAIL = live; BOARD = [await rowOf(mine, 9900)]; POSTED = [];
  const r = await call(await offerId(mine));
  ok("260 older accepts in the shards do not starve the tail",
    r.body.ok === false && r.body.full === true,
    r.body.ok ? "SIGNED ON A FULL BOOK — the tail was never reached" : r.body.why);
  ok("and nothing is signed", POSTED.length === 0);
  ARCHIVE = []; TAIL = [];
}
{
  /* ── THE SPINS, RUN IN A CHILD SO THEY CAN BE OBSERVED AT ALL ────────────
     Pass two searches each shard for the offer ids our accepts point at, and
     `ref` came straight off an archived frame with no shape check.
     indexOf("") returns the position it is handed, so the loop never
     advanced. `ref: "a"` matched nearly every line. And a flood of distinct
     refs multiplies |wanted| sweeps of a multi-megabyte shard.

     ALL THREE BLOCK THE EVENT LOOP, which is why this cannot be tested in
     process: the first attempt used Promise.race and simply hung, because a
     synchronous spin means the timer never gets to fire. A child with a wall
     clock on it is the only observer that works — and it is also what the
     failure looks like in production, where the wall clock belongs to Vercel.
     Anyone can post the message; the archiver commits it. */
  const { execFileSync } = await import("node:child_process");
  const probe = (ref, count, sender = "shop") => {
    try {
      const out = execFileSync(process.execPath,
        [path.join(ROOT, "scripts/probe-accept-spin.mjs"), shop.did, SEED, ref, String(count), sender],
        { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
      return /ANSWERED/.test(out) ? "answered" : "no answer";
    } catch (e) { return e.killed || e.signal ? "HUNG" : "threw"; }
  };
  ok("an archived accept whose ref is the empty string does not hang it",
    probe("", 1) === "answered", probe("", 1));
  ok("nor one whose ref is a single character", probe("a", 1) === "answered");
  ok("and a flood of distinct refs still answers",
    probe("unique", 600) === "answered",
    "|wanted| sweeps of a multi-megabyte shard, one per accept");
  /* ── TWO MORE BOUNDS, AND AN HONEST NOTE ABOUT WHAT THIS CAN SEE ────────
     The scan is bounded twice over: rows not SENT by us never reach `wanted`
     (the transport `from` filter), and `wanted` has a hard ceiling whatever
     gets past that. Both are worth having — a bound that depends on another
     check being correct is not a bound — and MEASURED, neither is
     individually observable here: with either one in place, four thousand
     forged accepts finish comfortably inside the child's clock, so removing
     the other changes no timing this suite can afford to detect.
     So they are asserted STRUCTURALLY and labelled as such, rather than
     wrapped in a behavioural claim that would pass for the wrong reason. The
     spins above are the behavioural half; these two are the belt. */
  {
    const src = fs.readFileSync(path.join(ROOT, "api/accept.mjs"), "utf8");
    ok("only rows we sent enter the book (structural)",
      /if \(row\?\.from !== US\) continue;/.test(src),
      "`includes` is a prefilter; the transport says who actually signed it");
    ok("and the set the scan iterates has a hard ceiling (structural)",
      /wanted\.size >= MAX_WANTED/.test(src) && /const MAX_WANTED = \d+/.test(src));
  }
}
{
  /* A SHARD THAT WILL NOT LOAD IS A BOOK WE DO NOT HAVE. This skipped the
     failed shard and carried on, so `rows` came back [] — which is not null,
     so the refusal gate waved it through as a real book and the shop signed
     while it was full. _meta.json and the shards are separate CDN objects
     with independent caches, so _meta naming a day whose file has not
     propagated is ordinary at a day boundary, not exotic. */
  const { MAX_OPEN_DEALS } = await import("./runner.mjs");
  const full = [];
  for (let i = 0; i < MAX_OPEN_DEALS; i++) {
    const b = offerBody({ nonce: "sh" + String(i).padStart(14, "0") });
    const id = await offerId(b);
    full.push(await rowOf(b, 10 + i));
    full.push({
      seq: String(100 + i), ts: new Date(now).toISOString(), from: shop.did, sig: "s",
      text: "tclk1 " + canon({
        type: "accept", from: shop.did, ref: id, statement: "0x" + "7c".repeat(32),
        nonce: "acc" + String(i).padStart(13, "0"),
        contract: "0x" + String(i).padStart(4, "0") + "e".repeat(60),
      }),
    });
  }
  const fresh = offerBody({ nonce: "9999999999999999" });
  ARCHIVE = full; BOARD = [await rowOf(fresh, 900)]; SHARDS_DOWN = true; POSTED = [];
  const r = await call(await offerId(fresh));
  ok("a shard that will not load is refused, not treated as an empty book",
    r.body.ok === false && r.body.pending === true,
    r.body.ok ? "SIGNED WHILE FULL — the cap read zero and nothing said so" : r.body.why);
  ok("and signs nothing", POSTED.length === 0);
  SHARDS_DOWN = false; ARCHIVE = [];
}
{
  /* The prefilter keeps lines that MENTION our DID; only lines we SENT are
     ours. An accept whose body claims to be from the shop, posted by somebody
     else, must not enter the book — ourArchive checks the transport `from`
     for exactly this reason. */
  const b = offerBody({ nonce: "aaaa000000000001" });
  const id = await offerId(b);
  ARCHIVE = [await rowOf(b, 6), {
    seq: "7", ts: new Date(now).toISOString(), from: "did:key:z6MkLiarZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", sig: "s",
    text: "tclk1 " + canon({
      type: "accept", from: shop.did, ref: id, statement: "0x" + "22".repeat(32),
      nonce: "0000000000000077", contract: "0x" + "dd".repeat(32),
    }),
  }];
  BOARD = []; POSTED = [];
  const r = await call(id);
  ok("an accept that only CLAIMS to be ours is not in our book",
    r.body.already !== true,
    "the transport says who signed it; the body is the sender's opinion");
  ARCHIVE = [];
}
{
  /* Caching, both directions. A failed read must not be retried by every
     request during an outage, and N concurrent cold requests must not each
     pull the shards. */
  const keep = process.env.ACCEPT_BOOK_TTL_MS;
  process.env.ACCEPT_BOOK_TTL_MS = "30000";
  const mod = await import(`../api/accept.mjs?cache=${Date.now()}`);
  const hit = async (id) => mod.default.fetch(new Request("http://x/api/accept", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offer: id }),
  }));
  const b = offerBody({ nonce: "cccc000000000001" });
  const id = await offerId(b);
  ARCHIVE = [await rowOf(b, 6)]; BOARD = [await rowOf(b, 7)]; POSTED = [];

  RAWHITS = 0;
  await Promise.all([hit(id), hit(id), hit(id), hit(id)]);
  ok("four concurrent cold requests pull the shards once, not four times",
    RAWHITS <= 4, `${RAWHITS} repository reads for 4 requests`);

  RAWHITS = 0;
  await hit(id);
  ok("and a warm one reads the repository not at all", RAWHITS === 0, `${RAWHITS} reads`);

  ARCHIVE_UP = false;
  RAWHITS = 0;
  await hit("0x" + "1".repeat(64)); await hit("0x" + "2".repeat(64)); await hit("0x" + "3".repeat(64));
  ok("and a failure is not re-fetched by every request during an outage",
    RAWHITS <= 1, `${RAWHITS} reads across 3 requests while the repository was down`);
  ARCHIVE_UP = true;
  process.env.ACCEPT_BOOK_TTL_MS = keep;
  ARCHIVE = [];
}
{
  /* ── THE FLAKY READ, WHICH IS NOT HYPOTHETICAL ───────────────────────────
     OBSERVED on the first two calls this endpoint ever served live: the
     second came back 503 "could not read the board just now", seconds after
     the first read the same room fine. Technocore is a shared venue with a
     rate limit. Giving up on the first refusal makes this a coin-flip
     checkout, and the fallback — honest as it is — sends the buyer away to
     come back and press Pay, which is the failure this endpoint exists to
     remove. */
  const b = offerBody({ nonce: "dddd000000000001" });
  BOARD = [await rowOf(b)]; ARCHIVE = [await rowOf(b)]; POSTED = [];
  BOARDFAILS = 1;
  const r = await call(await offerId(b));
  ok("one refusal from the board is retried, not surrendered to",
    r.body.ok === true, r.body.why ?? "");
  ok("and the accept still goes out", POSTED.length === 1, `${POSTED.length} posted`);

  BOARDFAILS = 5;                       // a venue with a real problem
  POSTED = [];
  const r2 = await call(await offerId(b));
  ok("but a board that keeps refusing is reported rather than waited on",
    r2.status === 503 && r2.body.ok === false, `${r2.status} ${r2.body.why ?? ""}`);
  ok("and nothing is signed on a book we could not read", POSTED.length === 0);
  BOARDFAILS = 0; ARCHIVE = [];
}
{
  /* STALE IS NOT ABSENT. A book a minute old still binds the cap correctly —
     the cap moves when a deal opens or closes, not second by second — so a
     buyer should never wait on a multi-megabyte refresh to replace one.
     MEASURED live: 3,560 ms cold against 573 ms warm, all of it inside
     somebody's click. What must NOT happen is the opposite mistake: a book
     that is missing entirely still refuses. */
  const keep = process.env.ACCEPT_BOOK_TTL_MS;
  process.env.ACCEPT_BOOK_TTL_MS = "1";          // expires immediately, but stays serveable
  const mod = await import(`../api/accept.mjs?swr=${Date.now()}`);
  const hit = async (id) => mod.default.fetch(new Request("http://x/api/accept", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offer: id }),
  }));
  const b = offerBody({ nonce: "eeee000000000001" });
  const id = await offerId(b);
  ARCHIVE = [await rowOf(b)]; BOARD = [await rowOf(b)]; POSTED = [];

  await hit(id);                                  // warms the book
  await new Promise((r) => setTimeout(r, 30));    // and lets the TTL lapse
  ARCHIVE_UP = false;                             // the repository goes away
  const r = await hit(id);
  const body = await r.json();
  ok("a book that has gone stale still answers while the repository is down",
    body.ok === true || body.full === true || body.refused !== undefined,
    `${body.why ?? "answered"} — refusing here would block a buyer on a refresh`);
  ARCHIVE_UP = true;
  process.env.ACCEPT_BOOK_TTL_MS = keep;
  ARCHIVE = [];
}
{
  const src = fs.readFileSync(path.join(ROOT, "api/accept.mjs"), "utf8");
  ok("the shards are fetched at once, not one after another (structural)",
    /await Promise\.all\(/.test(src) && !/for \(const day of[\s\S]{0,120}await grab\(/.test(src),
    "three independent CDN files awaited in a loop was a third of the cold time");
  ok("and the function's time limit is written down rather than inherited",
    /maxDuration:\s*\d+/.test(src));
}
{
  /* NO KEY, NO SIGNING, AND NO DRAMA. This is the state the site ships in
     until somebody deliberately puts the seed in Vercel, and it must read as
     a configuration rather than as a failure. */
  const keep = process.env.OVERHEARD_SEED;
  delete process.env.OVERHEARD_SEED;
  const b = offerBody({ nonce: "5555555555555555" });
  BOARD = [await rowOf(b)]; POSTED = [];
  const r = await call(await offerId(b));
  ok("with no key here it says so plainly",
    r.body.ok === false && r.body.configured === false, r.body.why);
  ok("and does not pretend to have posted anything", POSTED.length === 0);
  process.env.OVERHEARD_SEED = keep;
}
{
  const src = fs.readFileSync(path.join(ROOT, "api/accept.mjs"), "utf8");
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const bare = strip(src);
  /* Every object this endpoint hands back, checked field by field. A regex
     hunting for the word "seed" near the word "json" was the first attempt
     and it failed on its own explanatory comment — the same trap three other
     rules in this repository fell into. Parse the responses instead. */
  const returned = [...bare.matchAll(/json\(\{([\s\S]*?)\}[,)]/g)]
    .flatMap((m) => [...m[1].matchAll(/(\w+)\s*:/g)].map((k) => k[1]));
  ok("nothing the endpoint returns is, or is derived from, the key",
    returned.length > 0 && !returned.some((k) => /seed|key|secret|priv/i.test(k)),
    returned.join(",") || "no responses found, which means this rule read nothing");
  /* Where the seed is ALLOWED to go: read from the environment, tested for
     presence, and handed to the three functions whose whole job is to consume
     a key. Anywhere else — a template string, a URL, a response, a log — is
     a leak, and each of those is how a key gets published. */
  const uses = [...bare.matchAll(/[^\w]seed[^\w]/g)].length;
  const legal = [
    /const seed = process\.env\.OVERHEARD_SEED/, /if \(!seed\)/,
    /agentFromSeed\(seed\)/, /minterFor\(seed\)/, /recoverSecret\(seed,/,
  ].filter((re) => re.test(bare)).length;
  ok("the key goes only to the functions that consume a key",
    uses === legal && !/[`'"][^`'"]*\$\{seed\}/.test(bare),
    `${uses} mentions, ${legal} of them accounted for`);
  ok("and reuses the runner's rules rather than restating them",
    /from "\.\.\/scripts\/runner\.mjs"/.test(src) && !/function refuseTake/.test(src),
    "two copies of the rule that commits this shop to work is one too many");
}

/* Section B drives a real browser against a real local server, so the node
   half's stub has to come off. Kept rather than reconstructed: there is no
   supported way to get the original back once it is gone. */
globalThis.fetch = realFetch;

/* ══════════════════════════════════════════════════════════════════════════
 * B. AND THE PAGE, IN A BROWSER, PRESSING THE BUTTON ONCE
 * ═════════════════════════════════════════════════════════════════════════*/
let skipped = 0;
if (!chromium) {
  skipped = 1;
  console.log("\n=== B. one press, one visit");
  console.log("  SKIP  no Playwright here — the browser half did not run");
} else {

  const PORT = 9443;
  /* ".css" was missing, and a stylesheet served as text/plain is one
     Chromium refuses without saying so — this harness had been running
     the page with deal.css not applied. */
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".svg": "image/svg+xml",
                  ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".json": "application/json" };

  const REAL_SESSION = fs.readFileSync(path.join(ROOT, "web/session.js"), "utf8");
  const EXPORTED = [...new Set([
    ...[...REAL_SESSION.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ...[...REAL_SESSION.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  ])];
  /* Generated from the real module's exports, because a hand-written stub is a
     second copy of an interface — and a missing name is an ES module import
     error, which takes down every script on the page and looks like a page that
     simply did not load. */
  const SESSION = () => {
    const over = {
      getSession: `()=>({did:${JSON.stringify(BUYER)}})`,
      onSession: "()=>{}",
      shortDid: '(d)=>String(d).slice(0,12)+"…"+String(d).slice(-4)',
      hueOf: "()=>200",
      PW_MIN: "6",
      /* THE NONCE, AND WHY THE STUB HAS TO MAKE A REAL ONE. Every other export
       here can be a function returning null; this one cannot, because its
       value is signed AND sent, and the server checks that the two match. The
       generic fallback is an async function, so `nonce` became a Promise, the
       signed string said "[object Promise]" and the body carried `{}` — a
       page that would be refused by the real server for a reason this stub
       had invented. It also has to RISE: Technocore refuses a nonce that is
       not greater than the last one that key used in that room. */
    postNonce: '(() => { let n = 0; return () => String(n = Math.max(Date.now() * 1000, n + 1)); })()',
    signTextB64u: '(async (t) => "sig:" + t)',
    };
    return EXPORTED.map((n) => `export const ${n} = ${over[n] ?? "(()=>{ const f = async () => null; return f; })()"};`).join("\n");
  };

  let acceptReply = null;         // what /api/accept answers
  /* What GET /api/accept answers — how full the shop is. Roomy by default so
     every other case in this section exercises the ordinary path. */
  let capacityReply = { ok: true, capacity: 50, open: 2, free: 48, full: false, working: 1, awaiting_payment: 1 };
  let postFails = () => false;    // (room, nth) -> should /api/post refuse it
  let calls = [];                 // everything the page asked for, in order

  const srv = http.createServer((q, r) => {
    const u = q.url.split("?")[0];
    if (u === "/session.js") { r.writeHead(200, { "content-type": "text/javascript" }); return r.end(SESSION()); }
    if (u === "/api/room") { r.writeHead(200, { "content-type": "application/json" }); return r.end('{"source":"live","messages":[]}'); }
    if (u === "/data/tclk-offers/_meta.json") { r.writeHead(200, { "content-type": "application/json" }); return r.end('{"days":["2026-09-02","2026-09-03"]}'); }
    /* ── THE CAPACITY READ, WHICH IS A GET AND NOT A STEP ─────────────────
       /hire reads GET /api/accept on load to say how full the shop is. It is
       deliberately NOT recorded below: `calls` is the record of what one
       PRESS does, and mixing a page-load read into it makes the sequence
       assertion a test of when the page happened to poll. */
    if (u === "/api/accept" && q.method === "GET") {
      r.writeHead(200, { "content-type": "application/json" });
      return r.end(JSON.stringify(capacityReply));
    }
    if (u === "/api/accept" || u === "/api/post") {
      let raw = "";
      q.on("data", (c) => { raw += c; });
      q.on("end", () => {
        let b = {}; try { b = JSON.parse(raw); } catch { /* recorded as {} */ }
        calls.push({ at: u, body: b });
        r.writeHead(200, { "content-type": "application/json" });
        if (u === "/api/accept") return r.end(JSON.stringify(acceptReply ?? { ok: false, configured: false, why: "no key" }));
        /* Counted, not just named. The offer and the lock both go to
           tclk-offers, so a room-name rule alone cannot say "let the order
           through and refuse the lock" — and the first version of this test
           refused the ORDER and then asserted about the lock that never
           happened. `nth` is 1-based and COUNTS THE CURRENT CALL: the order is 1,
           the lock attempt is 2, its board fallback is 3. */
        const nth = calls.filter((c) => c.at === "/api/post").length;
        return r.end(JSON.stringify(postFails(b.room, nth) ? { ok: false, why: "room limit reached" } : { ok: true }));
      });
      return;
    }
    const f = path.join(ROOT, "web", u);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end("no"); }
    r.writeHead(200, { "content-type": TYPES[path.extname(f)] || "text/plain" });
    r.end(fs.readFileSync(f));
  });
  await new Promise((res) => srv.listen(PORT, res));

  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const errs = [];
  const order = async () => {
    calls = [];
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => errs.push(String(e).slice(0, 140)));
    await pg.goto(`http://localhost:${PORT}/hire.html`, { waitUntil: "domcontentloaded" });
    /* ── WAIT FOR THE THING, NOT FOR A NUMBER OF MILLISECONDS ──────────────
       These were three fixed sleeps — 700, 200, 1500 — and on a machine with
       anything else running they are not long enough. The suite then failed
       at random, and not honestly: `#msg` had not been written yet, so an
       assertion about THIS sub-case read whatever was on the page, and the
       reported failure was a sentence from a different scenario entirely.
       Three different sets of failures came out of three identical runs.

       A suite that fails at random is a suite everybody learns to re-run, and
       that is a worse state to be in than having no suite, because the day it
       is right nobody believes it. Each of these now waits for the condition
       it actually needs, which is both correct and faster. */
    await pg.waitForSelector('.pick[data-job="overheard-room-summary"]', { timeout: 15000 });
    await pg.click('.pick[data-job="overheard-room-summary"]');
    await pg.fill("#brief", "technocore");
    await pg.waitForFunction(() => {
      const b = document.querySelector("#send");
      return b && !b.disabled;
    }, { timeout: 15000 });
    await pg.click("#send");
    /* ── AND WAIT FOR IT TO STOP TALKING ───────────────────────────────────
       One press is three steps, and each writes into #msg as it goes: "posted
       to the board", "the shop accepted", "locking your payment". Waiting for
       the first non-empty message therefore reads a sentence from the MIDDLE
       of the flow — which is what the fixed 1500ms sleep was accidentally
       getting right most of the time and wrong the rest.

       So: wait until the message has not changed for half a second. That is
       the end of the flow whatever the flow turns out to be, and it does not
       have to be updated when a step is added. */
    await pg.waitForFunction(() => {
      const t = (document.querySelector("#msg")?.textContent ?? "").trim();
      if (!t) return false;
      const w = window;
      if (w.__last !== t) { w.__last = t; w.__since = Date.now(); return false; }
      return Date.now() - (w.__since ?? 0) > 500;
    }, { timeout: 25000, polling: 100 });
    const msg = await pg.$eval("#msg", (e) => ({ text: e.textContent, cls: e.className }));
    /* The checklist is read out alongside the message, because the two
       disagreeing is exactly what the first real order surfaced. */
    msg.done = await pg.$$eval(".trackrow.done", (n) => n.map((e) => e.dataset.s ?? ""));
    msg.track = await pg.$eval(".track", (e) => e.textContent);
    await ctx.close();
    return msg;
  };

  /* Just load it and look — no press. Used for the capacity line, which is a
     fact about the shop rather than a consequence of anything the visitor
     did. */
  const look = async () => {
    calls = [];
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => errs.push(String(e).slice(0, 140)));
    await pg.goto(`http://localhost:${PORT}/hire.html`, { waitUntil: "domcontentloaded" });
    /* Same fixed-sleep problem as order(), and the same fix: wait for the
       thing. The capacity line and the button's enabled state both arrive
       from an endpoint, so 900ms was a bet on how fast the machine is — and
       three of this suite's assertions were losing it whenever anything else
       was running. */
    await pg.waitForSelector('.pick[data-job="overheard-room-summary"]', { timeout: 15000 });
    await pg.click('.pick[data-job="overheard-room-summary"]');
    await pg.fill("#brief", "technocore");
    /* The capacity answer has landed and the page has finished reacting to
       it: #cap says something, and the button has settled. */
    await pg.waitForFunction(() => {
      const c = (document.querySelector("#cap")?.textContent ?? "").trim();
      const w = window;
      const state = c + "|" + String(document.querySelector("#send")?.disabled);
      if (w.__lastCap !== state) { w.__lastCap = state; w.__capSince = Date.now(); return false; }
      return Date.now() - (w.__capSince ?? 0) > 400;
    }, { timeout: 20000, polling: 100 });
    const out = {
      cap: await pg.$eval("#cap", (e) => ({ text: e.textContent, hidden: e.hidden, cls: e.className })),
      disabled: await pg.$eval("#send", (e) => e.disabled),
      whynot: await pg.$eval("#whynot", (e) => e.textContent),
    };
    await ctx.close();
    return out;
  };

  const CONTRACT = "0x" + "b7".repeat(32);
  {
    acceptReply = { ok: true, contract: CONTRACT, statement: "0x" + "cc".repeat(32), room: "tclk-offers", next: "lock" };
    postFails = () => false;
    const msg = await order();

    ok("one press produces three steps, in order",
      calls.map((c) => c.at).join(" → ") === "/api/post → /api/accept → /api/post",
      calls.map((c) => c.at).join(" → ") || "nothing happened at all");

    /* PARSED DEFENSIVELY, because the first mutation run proved why: deleting
       the auto-finish left `lock` undefined, JSON.parse threw, and the suite
       DIED after two failures instead of reporting the eight it should have.
       A suite that explodes reports less than a suite that fails, and the
       difference is exactly the diagnosis somebody needs at that moment. */
    const frameAt = (i) => {
      try { return JSON.parse(String(calls[i]?.body?.text).slice(6)); } catch { return {}; }
    };
    const [offer, , lock] = calls;
    ok("the order goes to the board", offer?.body.room === "tclk-offers");
    const ob = frameAt(0);
    ok("carrying its own id", /^0x[0-9a-f]{64}$/.test(ob.id || ""), String(ob.id));
    ok("and the accept is asked for by that same id", calls[1]?.body.offer === ob.id);

    const lb = frameAt(2);
    ok("then the payment is locked without a second visit", lb.type === "lock", lb.type ?? "no second post at all");
    ok("naming the contract the shop just returned", lb.contract === CONTRACT, String(lb.contract));
    ok("in the room derived from it", lock?.body.room === dealRoom(CONTRACT), String(lock?.body.room));
    ok("signed by the buyer over room, nonce and text",
      Boolean(lock) && lock.body.sig === `sig:${lock.body.room}|${lock.body.nonce}|${lock.body.text}`);
    /* ── THE CHECKLIST HAS TO AGREE WITH THE SENTENCE ABOVE IT ──────────────
     The first real order through this path finished with "Ordered, accepted
     and funded" printed directly above a checklist that still read "then,
     without you: the shop accepts it on its next wake", unticked. Both cannot
     be true, and a visitor believes the CHECKLIST — a checklist is a state,
     a message is only a sentence. The list was written for the two-visit flow
     and nobody had told it that flow was gone. */
  ok("every step the press completed is ticked, not just described",
    ["sign", "post", "accept", "lock"].every((k) => msg.done.includes(k)),
    `ticked: ${msg.done.join(",") || "none"} — one press does four things`);
  ok("and nothing still promises the shop will answer later",
    !/accepts it on its next wake/i.test(msg.track),
    "that line described the flow this replaced");
  ok("and the page says nothing else is needed",
      /nothing else is needed/i.test(msg.text) && /ok/.test(msg.cls), msg.text);
  }
  {
    /* THE ROOM CAP. Measured on this network: 52 accepts produced 7 locks,
       because the deal room usually cannot be created. runDeal folds by
       contract, so the board does just as well — and the shop's own settle()
       has taken this fallback for months. */
    acceptReply = { ok: true, contract: CONTRACT, statement: "0x" + "cc".repeat(32), room: "tclk-offers" };
    postFails = (room) => room === dealRoom(CONTRACT);
    const msg = await order();
    const posts = calls.filter((c) => c.at === "/api/post");
    ok("a deal room the network will not create falls back to the board",
      posts.length === 3 && posts[2].body.room === "tclk-offers",
      posts.map((p) => p.body.room).join(" → "));
    ok("and the buyer is still finished", /nothing else is needed/i.test(msg.text), msg.text);
  }
  {
    /* Every degraded answer must still leave the buyer with a true sentence and
       never with a red failure, because in all three the order really is on the
       board and really will be picked up. */
    acceptReply = { ok: false, configured: false, why: "no signing key here" };
    postFails = () => false;
    const msg = await order();
    ok("with no instant accept, the order still stands and says so",
      /stands on the board/i.test(msg.text) && /ok/.test(msg.cls), msg.text);
    ok("and no lock is attempted", calls.filter((c) => c.at === "/api/post").length === 1);
  }
  {
    acceptReply = { ok: false, full: true, standing: true, open: 3, capacity: 3,
                    why: "the shop has 3 deals in flight and takes 3 at once" };
    const msg = await order();
    ok("a full shop says how full, in its own words",
      /3 deals in flight/.test(msg.text) && /stands on the board/i.test(msg.text), msg.text);
    ok("and that is not shown as an error", /ok/.test(msg.cls), msg.cls);
  }
  {
    /* ── THE ANSWER WITH NO BRANCH ─────────────────────────────────────────
       `answered_elsewhere` had none, so it fell to the default: STANDING, in
       green. Every clause of it was false — the first accept wins, so the
       shop will never answer this offer — and it promised a Pay button that
       would have locked the buyer's payment against the STRANGER's contract.
       A default branch that says something reassuring is a wrong answer with
       a wide catchment, so every non-ok shape the endpoint can return is now
       tested here by name. */
    acceptReply = { ok: false, answered_elsewhere: true, why: "another agent answered this offer before we did" };
    const msg = await order();
    ok("an offer somebody else answered is not reported as ours and pending",
      !/stands on the board/i.test(msg.text), msg.text);
    ok("it says another agent took it, and reads as a problem",
      /another agent/i.test(msg.text) && /bad/.test(msg.cls), msg.cls);
    ok("and does not point them at a Pay button that is not theirs",
      !/pay button/i.test(msg.text));
    ok("and no lock is attempted", calls.filter((c) => c.at === "/api/post").length === 1);
  }
  {
    acceptReply = { ok: false, unknown: true, why: "the network did not confirm the accept" };
    const msg = await order();
    ok("an unconfirmed accept says so rather than promising a wake",
      /could not confirm/i.test(msg.text) && /nothing was charged/i.test(msg.text), msg.text);
    ok("and no lock is attempted on a contract we never got",
      calls.filter((c) => c.at === "/api/post").length === 1);
  }
  {
    acceptReply = { ok: false, refused: ["no handler for x"], why: "no handler for x" };
    const msg = await order();
    ok("a refusal says what the shop refused, and reads as one",
      /cannot take this order/i.test(msg.text) && /bad/.test(msg.cls), msg.text);
  }
  {
    acceptReply = { ok: true, contract: CONTRACT, statement: "0x" + "cc".repeat(32) };
    /* The ORDER (post 1) must land; both lock attempts (2 and 3) must not. */
    postFails = (room, nth) => nth >= 2;
    const msg = await order();
    /* Accepted and unfunded is a real state with a button of its own. The one
       thing this must never say is that money moved. */
    ok("if the lock cannot post at all, it sends them to the orders page",
      /orders page/i.test(msg.text), msg.text);
    ok("and never implies a charge", /nothing was charged/i.test(msg.text), msg.text);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * HOW FULL THE SHOP IS, SAID BEFORE ANYBODY SIGNS ANYTHING
   *
   * The cap has always existed and has only ever been discoverable by hitting
   * it: compose an order, sign it, post it to a public board, and only then
   * be told there was no room. Nothing is lost — the offer stands and the
   * next free slot takes it — but a person has signed something to learn a
   * fact the page could have given them for free.
   * ═════════════════════════════════════════════════════════════════════*/
  {
    capacityReply = { ok: true, capacity: 50, open: 6, free: 44, full: false, working: 4, awaiting_payment: 2 };
    const v = await look();
    ok("the page says how much room there is", /44 of 50 slots free/.test(v.cap.text), v.cap.text);
    ok("and splits work owed from buyers who have not paid",
      /4 being worked on/.test(v.cap.text) && /2 awaiting payment/.test(v.cap.text),
      "one combined figure makes a queue of unpaid orders look like a busy shop");
    ok("room is not a warning", !/full/.test(v.cap.cls), v.cap.cls);
    ok("and the button is left alone", v.disabled === false, `disabled=${v.disabled} · cap="${v.cap.text.trim().slice(0,60)}" · whynot="${v.whynot.trim().slice(0,50)}"`);
  }
  {
    capacityReply = { ok: true, capacity: 50, open: 50, free: 0, full: true, working: 40, awaiting_payment: 10 };
    const v = await look();
    ok("at capacity it says so", /Every slot is taken/.test(v.cap.text), v.cap.text);
    ok("with the numbers, not just the word",
      /50 of 50 orders in flight/.test(v.cap.text), v.cap.text);
    ok("and says it clears on its own, because it does",
      /clears on its own/.test(v.cap.text), v.cap.text);
    ok("the order button is disabled", v.disabled === true,
      "letting them sign an order the checkout will refuse is the thing this removes");
    ok("and the reason is stated where the other refusals are",
      /Every slot is taken right now/.test(v.whynot), v.whynot);
  }
  {
    /* ── AN UNREADABLE BOOK MUST NOT CLOSE THE SHOP ──────────────────────
       The order works without this endpoint at all: it goes on the board and
       a wake takes it. So a failed lookup costs the NUMBER and never the
       sale. Rendering "full" on a 503 would turn a bad minute at the venue
       into a closed shop. */
    capacityReply = { ok: false, unknown: true, why: "could not read the book just now" };
    const v = await look();
    ok("an unknown answer shows nothing rather than something wrong", v.cap.hidden === true,
      JSON.stringify(v.cap));
    ok("and the shop stays open", v.disabled === false,
      "the order still works — it goes on the board and a wake takes it");
    ok("with no capacity excuse in the way", !/slot/i.test(v.whynot), v.whynot);
    capacityReply = { ok: true, capacity: 50, open: 2, free: 48, full: false, working: 1, awaiting_payment: 1 };
  }

  ok("no script errors anywhere in this", errs.length === 0, errs.join(" | "));

  await browser.close();
  await new Promise((res) => srv.close(res));
}

const note = skipped ? "  ·  1 half SKIPPED (no browser): section B did not run" : "";
console.log(`\n${pass} passed, ${fail} failed${note}`);
process.exit(fail ? 1 : 0);

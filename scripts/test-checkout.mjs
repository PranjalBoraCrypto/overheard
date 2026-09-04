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
const acceptHandler = (await import("../api/accept.mjs")).default;

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

let BOARD = [];          // what the stubbed board returns (the LIVE read)
let ARCHIVE = [];        // and what the archived shards hold (rows, not frames)
let ARCHIVE_UP = true;   // or whether the repository can be reached at all
let SHARDS_DOWN = false; // _meta names a day whose shard the CDN has not got
let ARCHIVE_DAYS = ["2026-09-02"];
let RAWHITS = 0;         // how many times the repository was actually read
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
  const hit = async (id) => mod.default(new Request("http://x/api/accept", {
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
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".svg": "image/svg+xml" };

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
      signTextB64u: '(async (t) => "sig:" + t)',
    };
    return EXPORTED.map((n) => `export const ${n} = ${over[n] ?? "(()=>{ const f = async () => null; return f; })()"};`).join("\n");
  };

  let acceptReply = null;         // what /api/accept answers
  let postFails = () => false;    // (room, nth) -> should /api/post refuse it
  let calls = [];                 // everything the page asked for, in order

  const srv = http.createServer((q, r) => {
    const u = q.url.split("?")[0];
    if (u === "/session.js") { r.writeHead(200, { "content-type": "text/javascript" }); return r.end(SESSION()); }
    if (u === "/api/room") { r.writeHead(200, { "content-type": "application/json" }); return r.end('{"source":"live","messages":[]}'); }
    if (u === "/data/tclk-offers/_meta.json") { r.writeHead(200, { "content-type": "application/json" }); return r.end('{"days":["2026-09-02","2026-09-03"]}'); }
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
    await pg.waitForTimeout(700);
    await pg.click('.pick[data-job="overheard-room-summary"]');
    await pg.fill("#brief", "technocore");
    await pg.waitForTimeout(200);
    await pg.click("#send");
    await pg.waitForTimeout(1500);
    const msg = await pg.$eval("#msg", (e) => ({ text: e.textContent, cls: e.className }));
    await ctx.close();
    return msg;
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

  ok("no script errors anywhere in this", errs.length === 0, errs.join(" | "));

  await browser.close();
  await new Promise((res) => srv.close(res));
}

const note = skipped ? "  ·  1 half SKIPPED (no browser): section B did not run" : "";
console.log(`\n${pass} passed, ${fail} failed${note}`);
process.exit(fail ? 1 : 0);

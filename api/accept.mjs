/**
 * POST /api/accept   { "offer": "0x…" }
 *
 * The shop answers ONE offer, now, instead of on its next hourly wake.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: A CHECKOUT CANNOT HAVE AN INTERVAL IN THE MIDDLE OF IT
 *
 * tclk runs offer → accept → lock → deliver → reveal, and the LOCK is the
 * buyer's frame. It names a `contract`, and a contract is a hash over the
 * offer TOGETHER WITH the accept's core fields — one of which is `statement`,
 * the hash of a secret the shop mints when it accepts. So the buyer cannot
 * pre-sign their payment. The contract does not exist until the shop answers.
 *
 * With the answer arriving on an hourly cron, that fact turned into a
 * checkout with a gap in it: order, go away, come back within the hour, press
 * Pay. Nobody comes back. Measured on this network from the other side, the
 * same shape produced 52 accepts and 7 locks — seven buyers in eight simply
 * never finished, and every one of them thought they had ordered.
 *
 * Close the gap and the problem disappears. The accept takes about a second,
 * so the buyer's browser can wait for it: place the order, get the contract
 * back, sign the lock, done — one press, one visit. The Pay button on the
 * orders page stays, but as the RECOVERY path for somebody whose tab closed,
 * rather than as a step in the normal flow.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS ENDPOINT CAN AND CANNOT BE TALKED INTO
 *
 * It signs as the shop, and anyone on the internet can call it. That is only
 * safe because it grants no authority the caller did not already have:
 *
 *   · IT NEVER TRUSTS THE CALLER'S DESCRIPTION OF THE OFFER. The request
 *     carries an id and nothing else. The offer is re-read from the public
 *     board and judged there, so a caller cannot describe a better deal than
 *     the one they posted.
 *   · IT REFUSES EXACTLY WHAT THE RUNNER REFUSES, through the runner's own
 *     refuseTake(). Not a copy of those rules — the same function. A rule
 *     added there is enforced here on the next deploy, and a rule that
 *     disagreed between the two would be a hole with no owner.
 *   · IT IS IDEMPOTENT AS FAR AS ONE READ CAN MAKE IT. An offer already
 *     answered on the board returns the existing contract rather than a
 *     second accept, which covers the double-click, the second tab and the
 *     retry. It is NOT a lock: two requests that both read a board with no
 *     accept on it will both post one. The board is the only shared state
 *     here and it has no conditional write, so this is a narrowed window
 *     rather than a closed one — see the note at the say() call, and note
 *     that the client no longer retries the case that could widen it.
 *   · IT OBEYS THE SAME CAPACITY RULE. plan() decides, so the endpoint cannot
 *     be used to take the shop past a cap the cron would have honoured.
 *
 * The worst an attacker achieves is making the shop accept an order it would
 * have accepted anyway, an hour sooner. They still have to pay for it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PART THAT IS A REAL DECISION, NOT A CONFIGURATION STEP
 *
 * This puts OVERHEARD_SEED — the key that IS this shop's identity — in a
 * second place: Vercel's environment, reachable by a public HTTP handler,
 * where before it lived only in a GitHub secret read by a CI job.
 *
 * That is a genuine widening of the blast radius and should be decided
 * deliberately. The mitigations are that the seed is read once into a closure
 * that cannot hand it back (agentFromSeed), never appears in a response,
 * never appears in a log line, and never reaches a URL — but the honest
 * summary is that one more system can now sign as the shop.
 *
 * IF THE VARIABLE IS NOT SET, NOTHING BREAKS. The endpoint answers
 * `configured: false` and the order page falls back to exactly what it did
 * before: the order stands on the board and the hourly wake answers it. That
 * is the fallback, and it is also the way to turn this off — unset the
 * variable and the instant path is gone, with no deploy.
 */

/* NODE, NOT EDGE, and deliberately unlike every other function here. The
   signing chain is scripts/agent.mjs, which uses node:crypto for Ed25519 —
   and importing the runner's real refuseTake/buildAccept/plan is the entire
   point of this file. An edge port would mean a second implementation of the
   rules that decide whether to commit the shop to work, which is the last
   place in this repository that should have two of anything. */
/* maxDuration is stated rather than left to whatever the platform default
   happens to be, because a buyer is watching a spinner for every second of
   it. Fifteen is generous against the 3.5s measured cold — the point is that
   a genuinely stuck read fails at a number written down here rather than at
   one nobody chose. */
export const config = { runtime: "nodejs", maxDuration: 15 };

import {
  US, plan, framesFrom, refuseTake, buildAccept, readOffers, MAX_OPEN_DEALS,
} from "../scripts/runner.mjs";
import { agentFromSeed, say } from "../scripts/agent.mjs";
import { minterFor, recoverSecret } from "../scripts/secret.mjs";
import { checkReveal, OFFERS_ROOM, canon } from "../web/tclk.js";

/* ══════════════════════════════════════════════════════════════════════════
 * SEEING OUR OWN BOOK, WHICH ONE BOARD READ CANNOT DO
 *
 * A live read returns the newest 200 messages. The board carries ~4,200
 * frames a day, so our own accepts scroll out of that window in about an
 * hour — which is why the cron merges an on-disk archive before planning, and
 * why a version of this endpoint that planned from the live read ALONE had a
 * capacity check that never once bound. `open` counted whatever happened to
 * still be visible, which is usually nothing, so `atCapacity` was permanently
 * false and the honest-sounding sentence in the header was not true.
 *
 * A serverless function has no on-disk archive, so it reads the same shards
 * api/orders.js reads, straight from the repository. Two costs, both handled:
 *
 *   · MEGABYTES. A day's shard is ~2.5 MB, so it is fetched at most once per
 *     TTL per warm instance and only the handful of lines mentioning our DID
 *     are ever parsed — a substring test rules out ~99.9% of them first.
 *   · STALENESS. The archive trails by about a collector pass, so the live
 *     read is merged over it. The archive supplies the deals that scrolled
 *     away; the live read supplies the last few minutes. Neither alone is the
 *     book.
 *
 * A cold instance that cannot reach the repository does NOT fall through to
 * "no deals open" — that is the failure this whole block exists to prevent.
 * It refuses, and the order stands for the cron.
 */
/* WHOSE ARCHIVE. Everything else tunable in this repository reaches the code
   through the environment — SHOP_DID, MAX_OPEN_DEALS, TCLK_RAIL, ARCHIVE_DIR
   — and this was hardcoded, so anybody who followed DEPLOY.md and made their
   own repository got an endpoint whose capacity was decided by somebody
   else's archive. It fails closed, but in the worse direction: their DID
   appears nowhere in our shards, so the book reads empty and the cap never
   binds. Vercel sets VERCEL_GIT_REPO_* on every deployment it builds from a
   repository, which is the right default because it is the repository this
   code was deployed from. */
const OWNER = process.env.ARCHIVE_OWNER ?? process.env.VERCEL_GIT_REPO_OWNER ?? "PranjalBoraCrypto";
const REPO = process.env.ARCHIVE_REPO ?? process.env.VERCEL_GIT_REPO_SLUG ?? "overheard";
/* THREE, not two, and the comment that said "36h fits inside two days" was
   confusing calendar shards with elapsed time. Two shards cover between 24
   and 48 hours depending on the hour of day: just after the day rolls over
   they span barely a day, and a deal accepted late on Monday is still open at
   Wednesday morning while the slice reads Tuesday and Wednesday. Invisible
   deal, under-counted cap, every day between midnight and noon. runner.mjs
   uses three for the same window; this is the function that claims to mirror
   it. */
const SHARD_DAYS = 3;
/* How many offer ids pass two will hunt for. Pass two costs |wanted| sweeps
   of each shard, so this multiplies megabytes — and `wanted` is built from
   archived frames, which strangers can add to. The `from === US` filter is
   the first bound and this is the second, because a bound that depends on
   another check being correct is not a bound. Comfortably above any real
   book: MAX_OPEN_DEALS is 50, and this is four times it. */
const MAX_WANTED = 200;
/* One shard fetch per warm instance per half minute. Overridable for the same
   reason MIN_WORK_MS and MAX_OPEN_DEALS are: it trades freshness against
   upstream reads, and the right trade is different during an incident than it
   is on a quiet afternoon. Zero disables the cache. */
const BOOK_TTL_MS = (() => {
  const n = Number(process.env.ACCEPT_BOOK_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
})();

/* An offer id, exactly. Everything derived from an archived frame that is
   then fed to a loop has to be shaped before it is trusted — see the note in
   pass two for what one unshaped value did. */
const OFFER_ID = /^0x[0-9a-f]{64}$/;

/* `rows` is the answer, `at` when it was taken. A FAILED read is cached too,
   briefly: without that, every request during a raw.githubusercontent outage
   re-fetches, and the client retries three times per press. */
let book = { at: 0, rows: null, ok: false };
/* One fetch in flight at a time per instance. N concurrent cold requests were
   otherwise N independent multi-megabyte pulls of the same three files. */
let inFlight = null;

/* Shorter than the success TTL, because a failure is worth re-checking sooner
   than a good answer is worth replacing — but tied to the same switch, so
   "caching off" means both of them off rather than one of them. */
const FAIL_TTL_MS = BOOK_TTL_MS === 0 ? 0 : 5_000;

/* How stale a book may be and still be SERVED while a fresh one is fetched
   behind it. Past this it is not a book any more, it is a memory. */
const BOOK_STALE_MS = BOOK_TTL_MS === 0 ? 0 : 5 * 60_000;

function ourRecentRows() {
  const age = Date.now() - book.at;
  if (book.ok && age < BOOK_TTL_MS) return Promise.resolve(book.rows);
  if (!book.ok && book.at && age < FAIL_TTL_MS) return Promise.resolve(null);

  const fetching = inFlight ?? (inFlight = readBook().finally(() => { inFlight = null; }));

  /* ── STALE WHILE REVALIDATE, BECAUSE THE BUYER IS WATCHING A SPINNER ─────
     MEASURED on the deployed endpoint: 3,560 ms cold, 573 ms warm. The
     difference is this read, and the buyer is inside a checkout for all of
     it. Blocking somebody's click on a multi-megabyte refresh in order to
     replace a book that is forty seconds old is the wrong trade — the cap it
     feeds moves when a deal opens or closes, not second by second.
     So a book inside BOOK_STALE_MS answers immediately and the refresh
     happens behind it. Only a genuinely cold instance waits, and only the
     first buyer to arrive at one.
     A STALE BOOK IS NOT AN ABSENT BOOK: `null` still refuses, which is the
     property that stops the cap being skipped. This serves something known to
     be slightly old; it never invents one. */
  if (book.ok && age < BOOK_STALE_MS) return Promise.resolve(book.rows);
  return fetching;
}

async function readBook() {
  const raw = (p) => `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/web/data/tclk-offers/${p}`;
  /* THREE ANSWERS, NOT TWO. `null` used to mean both "404, not published"
     and "500, could not read", and the tail treated the pair as absence — so
     one bad minute at the CDN silently reverted this endpoint to the
     behaviour that let it sign on a full book. This file's own doctrine
     twenty lines down is that a failed shard is fatal precisely because
     "cannot tell" must never resolve to "go ahead"; the tail gets the same
     rule, minus the one case where absence is genuinely expected. */
  const MISSING = Symbol("missing");
  const grab = async (p) => {
    try {
      const r = await fetch(raw(p), { headers: { "User-Agent": "overheard-accept/1.0" } });
      if (r.ok) return await r.text();
      return r.status === 404 ? MISSING : null;
    } catch { return null; }
  };
  const fail = () => { book = { at: Date.now(), rows: null, ok: false }; return null; };

  const metaText = await grab("_meta.json");
  if (metaText === null) return fail();
  let days = [];
  try { days = JSON.parse(metaText)?.days ?? []; } catch { return fail(); }
  if (!Array.isArray(days) || !days.length) return fail();

  /* ── AND THE TAIL, WHICH IS THE ONLY FRESH THING HERE ────────────────────
     The shards are committed on every twelfth archiver pass, so they can be
     HOURS old — on 4 September the day's shard had not been written since
     08:46. The live read this book is merged with reaches back five minutes,
     PROBED: technocore caps `limit` at 200 whatever is asked for, `since`
     will not page backwards, and the room runs at ~2,600 frames an hour.
     Five minutes and "some hours ago" do not meet, and a deal that lands in
     the gap is invisible to the capacity check — which is the third time that
     check has been wrong today, this time through the data rather than the
     logic.
     tail.ndjson is the archiver's bounded window over the same room, rewritten
     every pass. A few hundred KB against the shard's seven megabytes, so it
     is fetched alongside them and costs almost nothing.
     A MISSING TAIL IS NOT FATAL: it has to be absent for the first archiver
     pass after this ships, and the shards alone are exactly the old
     behaviour. A missing SHARD still refuses, as before. */
  /* Fetched WITH the shards below, not before them. An earlier version
     awaited it on its own line — sixteen lines above the comment explaining
     that serial fetches were a third of the 3,560 ms measured on the buyer's
     click. */

  /* ── A SHARD THAT WILL NOT LOAD IS A BOOK WE DO NOT HAVE ─────────────────
     This used to skip a failed shard and carry on. `texts` could then end up
     empty, `rows` came back as [], and [] is not null — so the refusal gate
     downstream waved it through as a real book and the shop signed while it
     was full. That is the exact failure this whole function exists to
     prevent, restored through the mechanism written to prevent it.
     It is not a rare path: _meta.json and the shards are separate CDN objects
     with independent caches, so _meta naming a day whose file has not
     propagated is the ordinary state of affairs at a day boundary. */
  /* AT ONCE, NOT ONE AFTER ANOTHER. These are three independent files on a
     CDN and nothing about the second depends on the first, so awaiting them
     in a loop was paying three round trips to do one thing's work — a third
     of the 3,560 ms measured on the deployed endpoint, for no reason beyond
     the shape of the loop that fetched them. */
  const [tailText, ...shards] = await Promise.all([
    grab("tail.ndjson"),
    ...[...days].sort().slice(-SHARD_DAYS).map((day) => grab(`${day}.ndjson`)),
  ]);
  if (shards.some((t) => t === null || t === MISSING)) return fail();
  /* A tail that 404s is the first archiver pass after this shipped, and the
     shards alone are exactly the old behaviour. A tail that FAILS is an
     outage over the only fresh source there is, and proceeding without it
     means the capacity check silently stops counting the deals agreed in the
     last few hours — which is the failure this file exists to prevent. */
  if (tailText === null) return fail();

  /* TAIL FIRST. Pass one below stops at MAX_WANTED, and `wanted` fills from
     our accepts in three days of shards — so with the tail last, a shop with
     two hundred accepts behind it never reached the tail at all. The
     correlation is the worst possible: only a shop trading enough to sit at
     its cap accumulates that many accepts, so the tail went dark exactly when
     the cap it feeds mattered. Measured: 199 prior accepts and the book was
     right; 200 and the shop signed on a full book. */
  const texts = tailText === MISSING ? shards : [tailText, ...shards];

  /* ── TWO PASSES, BECAUSE ONE OF THEM RETURNS HALF A DEAL ─────────────────
     Pass one keeps lines mentioning our DID. That is our accepts — and NOT
     the buyers' offers they answer, which mention the buyer and never us.
     ourDeals() pairs an accept to its offer and drops an accept it cannot
     pair, so a single pass hands plan() a book with nothing in it and the
     capacity check reads "no deals open" on a shop with twenty-four. The
     suite caught this on its first run of the scrolled-out case, which is
     the production case.

     Pass two picks up those offers by the ids our accepts point at. */
  const rows = [];
  const wanted = new Set();
  for (const text of texts) {
    if (wanted.size >= MAX_WANTED) break;
    for (const line of text.split("\n")) {
      if (wanted.size >= MAX_WANTED) break;
      if (!line || !line.includes(US)) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      /* `includes` is a prefilter and nothing more. The line that MENTIONS
         our DID is very often not a line we SENT — somebody quoting us, an
         offer addressed to us, an accept claiming to be ours in its body.
         ourArchive() checks the transport `from` for the same reason. */
      if (row?.from !== US) continue;
      rows.push(row);
      const t = String(row?.text ?? "");
      if (!t.startsWith("tclk1 ")) continue;
      try {
        const b = JSON.parse(t.slice(6));
        if (b?.type === "accept" && OFFER_ID.test(String(b.ref ?? ""))) wanted.add(b.ref);
      } catch { /* not a frame we can read */ }
    }
  }

  /* ── THE SHAPE CHECK ON `ref` IS NOT TIDINESS ────────────────────────────
     `wanted` drives indexOf, and before OFFER_ID it accepted any string an
     archived frame happened to carry. `ref: ""` makes indexOf("") return the
     position it was given, so `at` never advances and this loop spins for
     ever — SYNCHRONOUSLY, so it blocks the isolate and no timeout can save
     it. One unsigned message posted to a public room by anyone would have
     hung every cold request until that shard aged out of the window.
     `ref: "a"` was the quieter version: it matches nearly every line, and
     pass two pulls the entire board into memory.
     An offer id is sixty-six characters of hex. Requiring exactly that makes
     the substring both selective and incapable of matching the empty string,
     which is the property the loop actually depends on. */
  for (const text of texts) {
    for (const id of wanted) {
      let at = text.indexOf(id);
      while (at !== -1) {
        const start = text.lastIndexOf("\n", at) + 1;
        let end = text.indexOf("\n", at);
        if (end === -1) end = text.length;
        try { rows.push(JSON.parse(text.slice(start, end))); } catch { /* half-written */ }
        at = text.indexOf(id, end + 1);
      }
    }
  }

  book = { at: Date.now(), rows, ok: true };
  return rows;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      /* Never cached. Two callers asking about the same offer a second apart
         must each get the true current answer — a cached "accepted" for an
         offer that was since cancelled would send a buyer to pay into
         nothing. */
      "Cache-Control": "no-store",
    },
  });

/* ══════════════════════════════════════════════════════════════════════════
 * HOW FULL THE SHOP IS, ASKED BEFORE ANYBODY COMMITS TO ANYTHING
 *
 * The capacity rule has always existed and has only ever been discoverable by
 * hitting it. You compose an order, sign it, post it to a public board — and
 * only then find out the shop cannot take it. The order is not wasted (it
 * stands until its expiry and the next free slot takes it) but the person has
 * signed something and been told "no" by a system that could have told them
 * "not right now" a second earlier, for free.
 *
 * So: GET the same endpoint that answers orders, and it says how full it is.
 * Same book, same plan(), same arithmetic — a number the page shows and the
 * number the shop enforces cannot drift, because they are one number.
 *
 * CACHED, and that is not a performance nicety. This is read on every load of
 * /hire, and a live board read per page view is precisely the mistake that
 * once left the deals board rendering empty: it spent the shared upstream
 * allowance on itself. Ten seconds is fresh enough for a figure that moves
 * when a deal completes, and it bounds this to six reads a minute per
 * instance however hard the page is refreshed.
 * ═════════════════════════════════════════════════════════════════════════*/
const CAP_TTL_MS = Number(process.env.ACCEPT_CAP_TTL_MS ?? 10_000);
let capCache = { at: 0, body: null };

async function capacity() {
  if (capCache.body && Date.now() - capCache.at < CAP_TTL_MS) {
    return json({ ...capCache.body, cached: true });
  }

  let live = null;
  for (let i = 0; i < 2 && live === null; i++) {
    if (i) await new Promise((r) => setTimeout(r, 350));
    try { live = await readOffers(); } catch { /* answered below */ }
  }
  const archived = live === null ? null : await ourRecentRows();
  if (live === null || archived === null) {
    /* ── UNKNOWN IS NOT FULL, AND IT IS NOT OPEN EITHER ────────────────────
       A page that reads "full" on a failed lookup turns a bad minute at the
       venue into a closed shop; one that reads "open" invites an order the
       checkout will then refuse. So it says it does not know, and the page
       shows the order form — because the order still works: it goes on the
       board, and a wake takes it. The only thing lost is the number. */
    return json({ ok: false, unknown: true, why: "could not read the book just now" }, 503);
  }

  const bySeq = new Map();
  for (const m of [...archived, ...live]) {
    if (m?.seq == null) continue;
    bySeq.set(String(m.seq), m);
  }
  const frames = framesFrom(
    [...bySeq.values()].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0)),
  );
  const p = plan(frames, Date.now());

  /* The two halves of "in flight", kept apart because they mean different
     things to the person reading them: one is work this shop owes, the other
     is a buyer who has not paid yet. Collapsing them into one figure would
     make a queue of unpaid orders look like a busy shop. */
  const working = p.owed.length;
  const body = {
    ok: true,
    capacity: MAX_OPEN_DEALS,
    open: p.open,
    free: Math.max(0, MAX_OPEN_DEALS - p.open),
    full: Boolean(p.atCapacity),
    working,
    awaiting_payment: Math.max(0, p.open - working),
  };
  capCache = { at: Date.now(), body };
  return json(body);
}

/* ── THE EXPORT SHAPE, WHICH IS NOT A DETAIL ─────────────────────────────
 * Vercel's Node runtime accepts exactly three shapes for a file in /api:
 *
 *     export default { fetch(request) { … } }      ← this one
 *     export function GET(request) { … }
 *     export default (req, res) => { … }           ← the Node signature
 *
 * This file shipped as `export default async function handler(request)`,
 * which is NONE of them. Vercel read a bare default-exported function as the
 * Node signature and called it with (IncomingMessage, ServerResponse). The
 * body then did what it says: read `request.method` — which an IncomingMessage
 * happens to have, so nothing complained — and then `await request.json()`,
 * which it does not have. The rejection escaped, `res.end()` was never
 * reached, and the request HUNG until the platform timed it out. No error
 * page, no 500, no log line at the top: just a fetch that never settles.
 *
 * The suite did not catch it because the suite imported `.default` and called
 * it as a function — which is to say, it called the handler the way the
 * handler expected to be called, and Vercel is the only thing whose opinion
 * on that mattered. Section A now asserts the shape itself.
 */
async function handler(request) {
  if (request.method === "GET") return capacity();
  if (request.method !== "POST") return json({ ok: false, why: "GET capacity, or POST an offer id" }, 405);

  let want = "";
  try {
    const b = await request.json();
    want = String(b?.offer ?? "").trim();
  } catch { /* falls through to the shape check */ }

  /* An offer id is a sha256 with an 0x on it. Checking the shape here means a
     malformed id costs no upstream read at all. */
  if (!/^0x[0-9a-f]{64}$/i.test(want)) return json({ ok: false, why: "not an offer id" }, 400);

  const seed = process.env.OVERHEARD_SEED;
  if (!seed) {
    /* Not an error. The site is expected to work without this endpoint, and
       saying so plainly is what lets the page choose the slower path instead
       of showing somebody a failure that is really a configuration. */
    return json({ ok: false, configured: false, why: "no signing key here — the hourly wake will answer this" });
  }

  let agent;
  try { agent = agentFromSeed(seed); }
  catch { return json({ ok: false, configured: false, why: "the key in this environment is not usable" }); }
  if (agent.did !== US) {
    return json({ ok: false, configured: false, why: "the key in this environment is not this shop's" });
  }

  /* One live read for what just happened, plus our own archived rows for
     what scrolled away — cached per instance, so a busy checkout does not
     spend the shared 600-a-minute allowance on itself the way the deals board
     once did. Everything after this is arithmetic on frames in hand. */
  /* ── ONE RETRY, BECAUSE THIS FAILS AND IT FAILS TRANSIENTLY ─────────────
     OBSERVED on the first two live calls this endpoint ever served: the
     second came back 503 "could not read the board just now", 573 ms in,
     seconds after the first had read the same room successfully. Technocore
     is a shared venue with a rate limit and its own bad minutes.
     Giving up on the first refusal turns that into a coin-flip checkout —
     and the fallback, honest as it is, sends the buyer away to come back and
     press Pay, which is the entire failure this endpoint exists to remove.
     One retry, with a pause, and then the honest answer. Not a loop: a venue
     that has refused twice half a second apart is having a real problem, and
     a checkout is not the place to sit through it. */
  let live = null;
  for (let i = 0; i < 2 && live === null; i++) {
    if (i) await new Promise((r) => setTimeout(r, 350));
    try { live = await readOffers(); } catch { /* reported below if both fail */ }
  }
  if (live === null) return json({ ok: false, why: "could not read the board just now" }, 503);

  const archived = await ourRecentRows();
  if (archived === null) {
    /* REFUSING IS THE SAFE DIRECTION AND THE ONLY HONEST ONE. Without the
       archive this endpoint cannot see its own open deals, so it cannot know
       whether the shop is full — and "cannot tell" must never resolve to
       "go ahead", because that is a shop signing promises it may not be able
       to keep. The order stands; the cron plans from a real book. */
    return json({
      ok: false, pending: true,
      why: "cannot see the shop's own book just now, so this one waits for the next wake",
    });
  }

  /* Newest-wins on seq, and then SORTED by it, exactly as mergeBySeq does for
     the runner. Two details that a Map alone gets wrong: a live row replacing
     an archived one keeps the archived insertion slot, so the array is not in
     sequence order and anything deciding "who was first" decides by shard
     position instead; and a row with no seq at all would collapse onto the
     key "" and silently evict every other seq-less row. Neither changes the
     answer this file needs today, which is exactly why they are worth fixing
     now rather than after the next caller relies on the order. */
  const bySeq = new Map();
  for (const m of [...archived, ...live]) {
    if (m?.seq == null) continue;
    bySeq.set(String(m.seq), m);
  }
  const frames = framesFrom(
    [...bySeq.values()].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0)),
  );

  const now = Date.now();

  /* ── IDEMPOTENCE, AND THE ATTACK IT VERY NEARLY OPENED ──────────────────
     If this offer already has an answer, the right response is that answer
     and not a second accept: two accepts for one offer is a deal the state
     machine refuses and a buyer who cannot tell which contract to pay into.

     THE FIRST VERSION OF THIS MATCHED ANY ACCEPT, FROM ANYBODY. The board is
     public and answering a stranger's offer is a legal move on it, so an
     attacker could accept a buyer's offer seconds after it landed and this
     endpoint would hand THEIR contract back to that buyer as the shop's own
     answer. The page signs a lock naming whatever contract it is given, and
     folding those frames the attacker is the payee — so the attacker reveals
     and claims. Nothing moves on `paper`, and rail.mjs says switching rails
     is one line.

     `f.from` is the TRANSPORT's word for who signed it, which is exactly why
     framesFrom re-asserts it over the body's own claim. Only an accept that
     is ours may be reported as ours. */
  const answering = frames.filter((f) => f.ok && f.type === "accept" && f.body?.ref === want);
  const ours = answering.find((f) => f.from === US);
  if (ours) {
    return json({
      ok: true, already: true,
      contract: ours.body.contract ?? null,
      statement: ours.body.statement ?? null,
      room: OFFERS_ROOM,
    });
  }
  if (answering.length) {
    /* Somebody else got there first. Under tclk the first accept wins, so
       this offer is not ours to answer, and saying so is better than signing
       a second accept the state machine would refuse — or, worse, than
       forwarding a stranger's contract as though we stood behind it. */
    return json({
      ok: false, answered_elsewhere: true,
      why: "another agent answered this offer before we did",
    });
  }

  const offer = frames.find((f) => f.ok && f.type === "offer" && f.id === want);
  if (!offer) {
    /* Almost always a timing story rather than a missing offer: the board is
       read at limit=200 and the collector runs behind. Saying "not on the
       board yet" invites the caller to retry; "no such offer" does not. */
    return json({ ok: false, pending: true, why: "that offer is not on the board yet" });
  }

  const no = refuseTake(offer, now);
  if (no.length) return json({ ok: false, refused: no, why: no.join("; ") });

  /* CAPACITY, decided by the same function the cron uses. plan() has already
     discounted deals that were agreed and never funded, so a shop full of
     abandoned orders reads as open here — which is the entire reason that
     filter exists. */
  const p = plan(frames, now);
  if (p.atCapacity) {
    return json({
      ok: false, full: true,
      open: p.open, capacity: MAX_OPEN_DEALS,
      why: `the shop has ${p.open} deals in flight and takes ${MAX_OPEN_DEALS} at once`,
      /* The offer is NOT dead. It stands until its own expiry and the next
         wake takes it when a slot frees, so the page can say something true
         and useful instead of "failed". */
      standing: true,
    });
  }

  const a = await buildAccept(offer, offer.id, now, minterFor(seed));

  /* THE CHECK THAT MAKES THIS SAFE TO POST, lifted from the runner and kept
     because it guards the one failure that cannot be undone. The secret is
     derived rather than stored, so the risk is not losing it but being unable
     to get it back — and a statement we cannot reopen is a promise we cannot
     keep. Prove the round trip against the frame as it will go on the wire. */
  const again = await recoverSecret(seed, a.body);
  const opens = await checkReveal(offer.body?.lock ?? "hash", a.body.statement, again);
  if (!opens.ok) return json({ ok: false, why: "refused: this accept could not be reopened" }, 500);

  const text = "tclk1 " + canon(a.body);
  const put = await say(agent, OFFERS_ROOM, text, { exact: true });
  if (!put.ok) {
    /* NOT `pending`, and the distinction is the whole point of this branch.
       `pending` means "your offer has not reached the board yet, ask again" —
       safe, because nothing has been signed. This is the opposite situation:
       an accept HAS been signed and sent, and all we know is that we did not
       get a clean answer. Technocore may well have stored it. Inviting a
       retry here is inviting a SECOND accept for one offer, from a client
       that would look at a board still a beat behind and see nothing.
       So it is a plain failure, the caller does not retry it, and the next
       scheduled wake sorts it out from a board that has settled. */
    return json({ ok: false, unknown: true, why: "the network did not confirm the accept" }, 503);
  }

  return json({
    ok: true,
    contract: a.body.contract,
    statement: a.body.statement,
    room: OFFERS_ROOM,
    /* What the buyer does next, said by the side that knows. */
    next: "lock",
  });
}

/* The shape Vercel's Node runtime actually dispatches to. See the block above
   `handler` for what shipping the wrong one looked like from outside. */
export default { fetch: handler };

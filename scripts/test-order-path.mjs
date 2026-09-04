#!/usr/bin/env node
/**
 * THE HANDSHAKE BETWEEN THE SHOPFRONT AND THE SHOP.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR
 *
 * A visitor clicks "Order a summary" on a gig card, lands on /hire.html,
 * types a brief and presses the button. The page composes a tclk offer,
 * signs it in their browser and posts it to `tclk-offers`. Some minutes
 * later the runner wakes, reads the board, and decides whether to take it.
 *
 * Those two halves are written in different files, in different languages'
 * worth of style, and NOTHING CONNECTS THEM. hire.html hard-codes a price,
 * a rail, a lock kind and three timestamps; refuseTake() checks a price, a
 * rail, a lock kind and three timestamps. If either side moves, every order
 * placed through the site is silently refused: the buyer sees "Ordered", the
 * board shows their offer, the runner's log shows a reason nobody reads, and
 * the deal simply never happens. There is no error anywhere in that story.
 *
 * That is the exact shape of failure this project keeps finding late, so it
 * gets a test. Everything below is READ OUT OF hire.html — the option list,
 * the prices, the window arithmetic, the constant fields — and run through
 * the runner's real refuseTake(). Editing either side without the other
 * fails here rather than in production.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHY IT PARSES THE PAGE INSTEAD OF IMPORTING A SHARED CONSTANT
 *
 * A shared constant would be better and is not available: hire.html must run
 * in a browser with no build step, so it cannot import scripts/runner.mjs,
 * and inlining the shelf into the page is the duplication this test exists
 * to police. Parsing is the honest option — it fails when the page's real
 * text changes, which is the thing we actually care about.
 */
import fs from "node:fs";
import { refuseTake, JOBS } from "./runner.mjs";
import { RAIL } from "./rail.mjs";

let pass = 0, fail = 0;
const ok = (what, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${what}${detail ? "   " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${what}${detail ? "   " + detail : ""}`); }
};

const page = fs.readFileSync(new URL("../web/hire.html", import.meta.url), "utf8");

/* ── what the page says it sells ──────────────────────────────────────────
   The shelf used to be a `<select>` of `<option value=… data-price=…>`. It is
   three `<button data-job=… data-price=…>` cards now, and this parser had to
   move with it — which it announced by failing on all three jobs at once
   rather than by quietly matching nothing and reporting a green zero. That
   is why "the form offers at least one job" exists as its own assertion. */
const options = [...page.matchAll(/data-job="([^"]+)"\s+data-price="([^"]+)"/g)]
  .map((m) => ({ id: m[1], price: m[2] }));

console.log("=== A. the shelf, as the order form states it");
ok("the form offers at least one job", options.length > 0, options.length + " options");

/* ── the window arithmetic, lifted from the page ──────────────────────────*/
const win = page.match(
  /const WINDOW = \{\s*expires:\s*([^,]+),\s*claimBy:\s*([^,]+),\s*refundAfter:\s*([^,}]+)[,\s]*\}/);
ok("the delivery windows are readable from the page", Boolean(win),
  win ? win.slice(1).map((s) => s.trim()).join(" / ") : "WINDOW block not found — this test is blind");
const HOUR = 3600000;
/* `24 * HOUR` and friends. Anything this cannot read becomes NaN rather than
   a plausible zero — a zero would make every offer look expired and send
   somebody hunting a bug in refuseTake that is really a bug in this line. */
const hours = (s) => {
  const m = String(s).match(/^\s*(\d+(?:\.\d+)?)\s*\*\s*HOUR\s*$/);
  return m ? Number(m[1]) * HOUR : NaN;
};
const WINDOW = win
  ? { expires: hours(win[1]), claimBy: hours(win[2]), refundAfter: hours(win[3]) }
  : null;
ok("and are ordinary hour arithmetic this test can evaluate",
  Boolean(WINDOW) && Object.values(WINDOW).every(Number.isFinite),
  WINDOW ? Object.entries(WINDOW).map(([k, v]) => `${k} ${v / HOUR}h`).join(", ") : "—");

/* ── the constant fields, likewise ────────────────────────────────────────*/
const field = (k, re) => { const m = page.match(re); return m ? m[1] : null; };
const composed = {
  role: field("role", /role:\s*"([^"]+)"/),
  asset: field("asset", /asset:\s*"([^"]+)"/),
  lock: field("lock", /lock:\s*"([^"]+)"/),
  rails: field("rails", /rails:\s*\["([^"]+)"\]/),
  proto: field("proto", /proto:\s*"([^"]+)"/),
  room: field("room", /room:\s*"([^"]+)"/),
};

console.log("\n=== B. the fields the runner will judge");
/* Each of these is a whole class of silent refusal on its own. */
ok("the buyer is the PAYER — a payee-opened offer cannot settle at all",
  composed.role === "payer", composed.role ?? "not stated");
ok("priced in FLOP, which is the only asset the shop takes", composed.asset === "FLOP", composed.asset ?? "—");
ok("a HASH lock, because the shop cannot open a point lock",
  composed.lock === "hash", composed.lock ?? "—");
ok("on the rail the shop actually runs, from one constant",
  composed.rails === RAIL, `page says ${composed.rails}, rail.mjs says ${RAIL}`);
ok("addressed to this shop's job protocol", composed.proto === "overheard", composed.proto ?? "—");
ok("posted to the offers room the runner reads", composed.room === "tclk-offers", composed.room ?? "—");

console.log("\n=== C. every job on the form, put through the real refuseTake()");
const now = Date.now();
for (const o of options) {
  /* Byte-for-byte the body offerBody() builds, with the placeholders filled
     in the way a real submission fills them. */
  const body = {
    type: "offer",
    from: "did:key:z6MkBuyerNotUs00000000000000000000000000000000",
    role: composed.role,
    job: { id: o.id, proto: composed.proto, brief: "did:key:z6MkSomeone" },
    amount: o.price,
    asset: composed.asset,
    lock: composed.lock,
    rails: [composed.rails],
    expiresMs: now + (WINDOW?.expires ?? 0),
    claimByMs: now + (WINDOW?.claimBy ?? 0),
    refundAfterMs: now + (WINDOW?.refundAfter ?? 0),
    nonce: "0123456789abcdef",
  };
  const no = refuseTake({ body }, now);
  ok(`the shop would take an order for ${o.id.replace("overheard-", "")}`,
    no.length === 0, no.join("; ") || `${o.price} FLOP, ${Math.round((WINDOW?.claimBy ?? 0) / HOUR)}h to claim`);
}

/* ══════════════════════════════════════════════════════════════════════════
 * C2. AND NOW THROUGH plan(), WHICH IS THE THING THAT ACTUALLY DECIDES
 *
 * Section C asked refuseTake() and got [] for every job. That was true, and
 * the orders were still never taken: plan() drops an offer with no `id`
 * BEFORE refuseTake() is consulted, into neither the taken list nor the
 * passed list — so the wake's log, which prints exactly those two, did not
 * mention it either. The form omitted the field for its whole life, and this
 * suite, whose stated purpose is to guard this one seam, was green the entire
 * time.
 *
 * The lesson is not "add an assertion". It is that a test stopping one
 * function short of the decision is testing a function, not a path. This
 * section goes all the way to plan(), on frames built the way the wire builds
 * them.
 * ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== C2. and through plan(), which is what actually decides");
{
  const { plan, framesFrom } = await import("./runner.mjs");
  const { canon, offerId } = await import("../web/tclk.js");
  const wireUp = async (body, withId = true) => {
    const full = withId ? { ...body, id: await offerId(body) } : body;
    return framesFrom([{
      text: "tclk1 " + canon(full), seq: 1, from: body.from,
      ts: new Date(now).toISOString(), sig: "sig",
    }]);
  };
  const sample = {
    type: "offer", from: "did:key:z6MkBuyerNotUs00000000000000000000000000000000",
    role: composed.role,
    job: { id: options[0].id, proto: composed.proto, brief: "did:key:z6MkSomeone" },
    amount: options[0].price, asset: composed.asset, lock: composed.lock,
    rails: [composed.rails],
    expiresMs: now + (WINDOW?.expires ?? 0),
    claimByMs: now + (WINDOW?.claimBy ?? 0),
    refundAfterMs: now + (WINDOW?.refundAfter ?? 0),
    nonce: "0123456789abcdef",
  };

  const good = plan(await wireUp(sample), now);
  ok("an order composed the way the form composes it is TAKEN",
    good.take.length === 1,
    `taken ${good.take.length}${good.take.length ? "" : ", passed " + JSON.stringify(good.passed)}`);

  const bare = plan(await wireUp(sample, false), now);
  ok("and one without an id is refused rather than vanishing",
    bare.take.length === 0 && bare.passed.length === 1,
    `taken ${bare.take.length}, passed ${bare.passed.length} — silence here is the bug that shipped`);
  ok("  giving a reason a human could find in the log",
    /no id/.test(bare.passed[0]?.why?.join("") ?? ""),
    bare.passed[0]?.why?.join("; ") ?? "nothing said at all");

  /* And the form itself must put it there, or everything above tests a body
     this suite invented rather than the one hire.html posts. */
  /* Matched on the SHAPE rather than on one spelling of the line: the id was
     hoisted into `offerRef` so the accept could be asked for by it, and a
     rule pinned to the old text failed while the property was intact. What
     must hold is that the thing signed and posted carries an id computed by
     offerId — however that value is spelled on the way there. */
  ok("the form puts the id on the wire",
    /canon\(\{\s*\.\.\.body,\s*id:\s*(await offerId\(body\)|offerRef)\s*\}\)/.test(page),
    "the offer hire.html posts must carry its own id");
  ok("and the developer's copy of the frame carries it too",
    /id: await offerId\(body\)/.test(page.slice(page.indexOf("async function paintFrame"))),
    "the JSON in that box is a route people use; without an id it is dead on arrival");
  ok("and canon comes from tclk.js rather than a second copy",
    /import \{[^}]*canon[^}]*\} from "\/tclk\.js"/.test(page) && !/^function canon\(/m.test(page),
    "a second implementation of a hash input is a bug with a delay on it");
}

console.log("\n=== D. the price on the form is the price on the shelf");
/* Underpricing is not refused loudly — refuseTake says "offers 250 for work
   priced at 500" and moves on. A form that quotes below the shelf therefore
   produces orders that always fail, which looks from the buyer's side like
   the shop ignoring them. */
for (const o of options) {
  const shelf = JOBS.find((j) => j.id === o.id);
  ok(`${o.id.replace("overheard-", "")} is on the shelf at all`, Boolean(shelf), shelf ? "" : "the form sells a job the runner has no price for");
  if (shelf) ok(`  and quotes the shelf price`, Number(o.price) >= Number(shelf.amount),
    `form ${o.price} vs shelf ${shelf.amount}`);
}

console.log("\n=== E. the form does not offer what the shop cannot deliver");
/* The board's card for a job with no handler is a dashed note, not a link.
   The form must agree: an option for it would let a buyer place an order
   that is refused every time, for a job we have said plainly we do not do. */
const unhandled = JOBS.filter((j) => refuseTake({
  body: {
    type: "offer", from: "did:key:z6MkBuyer", role: "payer",
    job: { id: j.id, proto: "overheard", brief: "x" },
    amount: j.amount, asset: "FLOP", lock: "hash", rails: [RAIL],
    expiresMs: now + 24 * HOUR, claimByMs: now + 24 * HOUR, refundAfterMs: now + 48 * HOUR,
    nonce: "0123456789abcdef",
  },
}, now).some((r) => r.startsWith("no handler"))).map((j) => j.id);
for (const id of unhandled)
  ok(`${id.replace("overheard-", "")} has no handler, so the form must not sell it`,
    !options.some((o) => o.id === id), options.some((o) => o.id === id) ? "IT IS ON THE FORM" : "correctly absent");
ok("and every job the shop CAN do is on the form",
  JOBS.filter((j) => !unhandled.includes(j.id)).every((j) => options.some((o) => o.id === j.id)),
  JOBS.filter((j) => !unhandled.includes(j.id) && !options.some((o) => o.id === j.id))
     .map((j) => j.id).join(", ") || "all of them");

console.log("\n=== G. the sample frame a developer copies is one the shop takes");
/* The board's dev route shows a ready-to-paste tclk offer with the price,
   the rail, the lock kind and the job id written out by hand. Every one of
   those is a value the runner judges, and none of them is generated — so the
   sample can go stale the moment any of them moves, and the only symptom is
   a developer whose pasted frame is refused with no explanation.
   The `…` timestamps are what the copy button fills in at click time, so
   they are filled the same way here. */
{
  const board = fs.readFileSync(new URL("../web/deals-preview-78cb4a1be923c6b4.html", import.meta.url), "utf8");
  const block = board.match(/<code id="frameSample">([\s\S]*?)<\/code>/);
  ok("the sample frame is where the copy button can reach it", Boolean(block),
    block ? "" : "no #frameSample — the copy button has nothing to copy and this test is blind");
  if (block) {
    const now = Date.now();
    const json = block[1]
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
      .replace('"expiresMs": …', `"expiresMs": ${now + 24 * HOUR}`)
      .replace('"claimByMs": …', `"claimByMs": ${now + 24 * HOUR}`)
      .replace('"refundAfterMs": …', `"refundAfterMs": ${now + 48 * HOUR}`);
    let body = null, why = "";
    try { body = JSON.parse(json); } catch (e) { why = e.message; }
    ok("and once its timestamps are filled it is valid JSON", Boolean(body),
      body ? "" : "a developer would paste this and get a parse error: " + why);
    if (body) {
      /* The placeholders are the two fields a human must replace. Everything
         else has to stand on its own. */
      body.from = "did:key:z6MkBuyerNotUs0000000000000000000000000000";
      body.job.brief = "did:key:z6MkSomeone";
      const no = refuseTake({ body }, now);
      ok("and the shop would accept exactly what it says",
        no.length === 0, no.join("; ") || `${body.amount} ${body.asset} on ${body.rails.join(",")}`);
      ok("and it names a job that has a handler",
        options.some((o) => o.id === body.job.id),
        body.job.id + (options.some((o) => o.id === body.job.id) ? "" : " — the form does not sell this"));
    }
  }
}

console.log("\n=== F. the gig cards link to jobs the form knows");
/* A card whose ?job= names something the form has no option for falls back
   to the default silently — the buyer's click is discarded and they order
   the wrong thing. */
const board = fs.readFileSync(new URL("../web/deals-preview-78cb4a1be923c6b4.html", import.meta.url), "utf8");
const links = [...board.matchAll(/href="\/hire\.html\?job=([^"]+)"/g)].map((m) => m[1]);
ok("the board links at least one gig to the order form", links.length > 0, links.length + " links");
for (const j of links)
  ok(`  the card for ${j.replace("overheard-", "")} names a job the form offers`,
    options.some((o) => o.id === j), options.some((o) => o.id === j) ? "" : "NO SUCH OPTION — the click would be discarded");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

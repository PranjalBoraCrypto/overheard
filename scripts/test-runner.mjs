/**
 * The runner, against a stub Technocore.
 *
 * This is the first thing in the project that can WRITE, so the tests that
 * matter most are the ones proving it does not. Two properties are load
 * bearing and both are asserted here:
 *
 *   the shop stays shut  — no seed, wrong seed, no work side, not asked to go
 *                          live: any one of them and nothing is posted
 *   the seed stays put   — it is not in the repository, not in the workflow,
 *                          not in any log line, not in an error
 *
 * The signing vectors are checked against a key generated here, verified with
 * node's own Ed25519 rather than against a value I typed in — a fixture I
 * produced from the same code it is testing would agree with itself and prove
 * nothing.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { createPublicKey, verify as edVerify, randomBytes } from "node:crypto";
import { agentFromSeed, sweep, nextNonce, say } from "./agent.mjs";
import {
  US, JOBS, WINDOW, MAX_OPEN_DEALS, buildAccept, refuseTake,
  plan, refusals, framesFrom, ourDeals, wake, settle, annotate,
} from "./runner.mjs";
import { secretFor, recoverSecret, minterFor } from "./secret.mjs";
import { RAIL, RAILS, RAILS_WE_TAKE, IS_REHEARSAL } from "./rail.mjs";
import { canon, offerId, lintOffer, readFrame, runDeal, checkReveal, contractId, dealRoom }
  from "../web/tclk.js";
import { CAN_DO } from "./work.mjs";

/* The repository, found from this file rather than from a path typed into it.
   The absolute one was /tmp/oh — the sandbox this was written in — so on any
   other machine section G happily read a directory that was not the tree under
   test, or did not exist at all. A guard that checks somewhere else is worse
   than no guard, because it reports green. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

/* A throwaway identity. Never the shop's — a test that needs the real seed is
   a test that cannot run in CI and a seed that is in CI is a seed that leaks. */
const SEED = randomBytes(32).toString("hex");
const me = agentFromSeed(SEED);
const OTHER = "did:key:z6MkStrangerZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
const THIRD = "did:key:z6MkThirdPartyYYYYYYYYYYYYYYYYYYYYYYYYYYYY";

if (!fs.existsSync(path.join(ROOT, "scripts/runner.mjs")))
  throw new Error(`ROOT does not look like the repository: ${ROOT}`);

/* ── A. the key ──────────────────────────────────────────────────────────── */
console.log("\n=== A. seed in, DID out");
ok("a seed produces a canonical did:key", /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/.test(me.did), me.did);
ok("the same seed always produces the same DID", agentFromSeed(SEED).did === me.did);
ok("0x and whitespace and case are all tolerated",
  agentFromSeed("  0X" + SEED.toUpperCase() + "  ").did === me.did);
for (const bad of ["", "abc", SEED.slice(0, 63), SEED + "aa", "z".repeat(64)]) {
  let threw = false;
  try { agentFromSeed(bad); } catch { threw = true; }
  ok(`a seed that is not 64 hex is refused (${bad.slice(0, 8) || "empty"}…)`, threw);
}
ok("the shop's real DID is a well-formed did:key", /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/.test(US));

/* ── B. the signature Technocore will check ──────────────────────────────── */
console.log("\n=== B. signatures");
{
  const room = "tclk-offers", nonce = "1788356331000123", text = "tclk1 {\"a\":1}";
  const sig = me.sign(`${room}|${nonce}|${text}`);
  ok("a signature is 86 unpadded base64url characters",
    /^[A-Za-z0-9_-]{86}$/.test(sig), `${sig.length} chars`);
  /* Verified with node's own Ed25519 against the public key derived from the
     seed — the check Technocore will make, made here. */
  const spki = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(me.publicKeyHex, "hex")]),
    format: "der", type: "spki",
  });
  ok("and it verifies against the public half of the same seed",
    edVerify(null, Buffer.from(`${room}|${nonce}|${text}`, "utf8"), spki, Buffer.from(sig, "base64url")));
  ok("a different message does not verify",
    !edVerify(null, Buffer.from(`${room}|${nonce}|other`, "utf8"), spki, Buffer.from(sig, "base64url")));
}
ok("the sweep turns invisibles into spaces and trims, as Technocore stores it",
  sweep("  a​b\nc  ") === "a b c", JSON.stringify(sweep("  a​b\nc  ")));
ok("a canonical tclk frame is unchanged by the sweep — it is ASCII by construction",
  (() => { const t = "tclk1 " + canon({ b: "ü", a: 1 }); return sweep(t) === t; })());
ok("a nonce is 1-19 digits and stays a string",
  /^\d{1,19}$/.test(nextNonce()) && typeof nextNonce() === "string");
ok("two nonces in the same millisecond still differ", nextNonce() !== nextNonce());

/* ── C. the accept it would post ─────────────────────────────────────────
 * We sell by ANSWERING a buyer's offer, not by posting our own. The other
 * direction — a `role: "payee"` offer — cannot settle: the acceptor mints the
 * secret and only the payee may reveal, so on a payee-opened deal the secret
 * lands with the one party forbidden to spend it. That is flop-labs/tclk#12,
 * still open, and section I holds the demonstration.
 * ─────────────────────────────────────────────────────────────────────── */
console.log("\n=== C. the accept");
const NOW = Date.now();
const msg = (i, from, text) => ({ seq: String(i), ts: new Date(NOW - i * 1000).toISOString(), from, text, sig: "s" });

/* A buyer's offer, which is what the wire now carries and what we answer.
   Built here rather than imported, because the runner no longer has any
   reason to know how to construct one. */
const BUILT = JOBS.find((j) => j.id === "overheard-agent-profile");
const HOUR_MS = 3600000;
function theirOffer(job = BUILT, over = {}, from = OTHER) {
  return {
    type: "offer", from, role: "payer",
    job: { id: job.id, proto: "overheard" },
    amount: job.amount, asset: "FLOP", lock: "hash", rails: ["paper"],
    expiresMs: NOW + 6 * HOUR_MS,
    claimByMs: NOW + 12 * HOUR_MS,
    refundAfterMs: NOW + 36 * HOUR_MS,
    nonce: "0000000000000001",
    ...over,
  };
}
const frameOf = async (body) => "tclk1 " + canon({ ...body, id: await offerId(body) });

{
  const o = theirOffer();
  ok("a buyer's offer is well formed by the page's own linter",
    lintOffer(o).length === 0, lintOffer(o).join(", "));

  const id = await offerId(o);
  const a = await buildAccept({ body: o }, id, NOW, minterFor(SEED));

  ok("the accept comes from the shop", a.body.from === US);
  ok("it names the offer it answers", a.body.ref === id);
  ok("it carries a statement, which is the field the offer never has",
    /^0x[0-9a-f]{64}$/.test(a.body.statement) && o.statement === undefined);

  /* THE WHOLE REASON THIS DIRECTION WORKS. We mint the secret, so we hold the
     preimage; and because the offer is payer-opened we are also the payee,
     which is the only party the machine lets reveal. Both halves in one hand. */
  const check = await checkReveal("hash", a.body.statement, a.secret);
  ok("and the secret we hold really does open it",
    check.checked && check.ok, check.why);
  ok("the secret is 32 bytes, not something guessable",
    /^0x[0-9a-f]{64}$/.test(a.secret));
  ok("two deals never share a preimage, even for the same offer",
    (await secretFor(SEED, id, "0000000000000001")) !== (await secretFor(SEED, id, "0000000000000002")));

  /* The contract id binds the offer to the accept core, so it cannot be
     computed before the statement exists — a contract named early would name
     a deal with a different statement in it. */
  const expect = await contractId(o, {
    ref: a.body.ref, from: a.body.from, statement: a.body.statement, nonce: a.body.nonce,
  });
  ok("the contract id is the one tclk.js derives from these two frames",
    a.body.contract === expect, a.body.contract.slice(0, 20) + "…");
  ok("and it names a deal room both sides can compute",
    /^mb-p-tclk-[0-9a-f]{16}$/.test(dealRoom(a.body.contract) ?? ""), dealRoom(a.body.contract));

  const text = "tclk1 " + canon(a.body);
  const f = readFrame(text);
  ok("the frame parses as an accept", f.ok && f.type === "accept");
  ok("and reproduces its own bytes exactly", f.exact);
  ok("it fits in a Technocore message", text.length < 4000, text.length + " chars");

  /* End to end through the state machine that will judge it for real. */
  const deal = runDeal(framesFrom([
    msg(1, OTHER, await frameOf(o)),
    msg(2, US, text),
  ]));
  ok("the deal reaches accepted", deal.state === "accepted", deal.state);
  ok("with the buyer as payer and us as payee", deal.payer === OTHER && deal.payee === US);
  ok("so the reveal we are allowed to post is the one we can actually make",
    deal.payee === US && check.ok);
}

/* ── D. what a wake decides ──────────────────────────────────────────────
 * The plan no longer stocks a shelf. It reads the board and decides which of
 * OTHER PEOPLE'S offers this shop may honestly take, which makes every
 * assertion here a refusal rather than a preference.
 * ─────────────────────────────────────────────────────────────────────── */
console.log("\n=== D. the plan");
{
  const good = await frameOf(theirOffer());
  const p = plan(framesFrom([msg(1, OTHER, good)]), NOW);
  ok("a buyer's offer for work we can do is taken",
    p.take.length === 1 && p.take[0].body.job.id === BUILT.id,
    p.take.length + " taken");

  ok("an empty board takes nothing, and that is not an error",
    plan(framesFrom([]), NOW).take.length === 0);

  /* The guard that matters most: never accept work nothing can deliver. */
  const noHandler = await frameOf(theirOffer(JOBS.find((j) => j.id === "overheard-archive-question")));
  const ph = plan(framesFrom([msg(1, OTHER, noHandler)]), NOW);
  ok("an offer for a job with no handler is refused, not taken",
    ph.take.length === 0 && ph.passed.some((x) => x.why.some((w) => /no handler/.test(w))),
    ph.passed[0]?.why.join("; "));

  /* And the one this rewrite exists for. */
  const payeeOpened = await frameOf(theirOffer(BUILT, { role: "payee" }));
  const pp = plan(framesFrom([msg(1, OTHER, payeeOpened)]), NOW);
  ok("a payee-opened offer is refused with the reason written down",
    pp.take.length === 0 && pp.passed.some((x) => x.why.some((w) => /tclk#12/.test(w))),
    pp.passed[0]?.why.join("; "));

  ok("our own offer is never taken by us",
    plan(framesFrom([msg(1, US, await frameOf(theirOffer(BUILT, {}, US)))]), NOW).take.length === 0);

  /* Terms. Each of these is money or a promise we could not keep. */
  const cases = [
    ["underpaid",        { amount: "1" },                       /priced at/],
    ["wrong asset",      { asset: "DOGE" },                     /not FLOP/],
    ["a lock we cannot open", { lock: "point" },                /not one we can open/],
    ["no rail in common", { rails: ["lightning"] },             /no rail in common/],
    ["already expired",  { expiresMs: NOW - 1 },                /expired/],
    ["a claim window too short to work in", { claimByMs: NOW + 60000 }, /too short/],
    ["a refund before the claim closes", { refundAfterMs: NOW + 60000 }, /does not follow/],
    ["not addressed to this shop", { job: { id: BUILT.id, proto: "somebody-else" } }, /job protocol/],
  ];
  for (const [name, over, re] of cases) {
    const why = refuseTake({ body: theirOffer(BUILT, over) }, NOW);
    ok(`refused: ${name}`, why.some((w) => re.test(w)), why.join("; ") || "TAKEN");
  }

  /* All the reasons, not just the first, so a log line cannot teach the
     reader the wrong lesson about why something was passed over. */
  const many = refuseTake({ body: theirOffer(BUILT, { amount: "1", asset: "DOGE" }) }, NOW);
  ok("an offer that misses by two things says both", many.length >= 2, many.join("; "));

  /* An offer somebody else already answered is not ours to take. */
  const o = theirOffer();
  const id = await offerId(o);
  const taken = framesFrom([
    msg(1, OTHER, await frameOf(o)),
    msg(2, THIRD, "tclk1 " + canon({ type: "accept", from: THIRD, ref: id,
      statement: "0x" + "7c".repeat(32), nonce: "0000000000000009",
      contract: "0x" + "cc".repeat(32) })),
  ]);
  ok("an offer already accepted by somebody else is left alone",
    plan(taken, NOW).take.length === 0);
}
{
  /* Capacity. Three deals of ours in flight and we stop taking, however
     good the next offer is — the reserve rule we can actually check. */
  const frames = [];
  for (let i = 0; i < MAX_OPEN_DEALS; i++) {
    const o = theirOffer(BUILT, { nonce: "cap" + String(i).padStart(13, "0") });
    const id = await offerId(o);
    frames.push(msg(10 + i, OTHER, "tclk1 " + canon({ ...o, id })));
    frames.push(msg(20 + i, US, "tclk1 " + canon({
      type: "accept", from: US, ref: id, statement: "0x" + "7c".repeat(32),
      nonce: "acc" + String(i).padStart(13, "0"),
      contract: "0x" + String(i).padStart(4, "0") + "e".repeat(60),
    })));
  }
  frames.push(msg(90, OTHER, await frameOf(theirOffer(BUILT, { nonce: "0000000000000042" }))));
  const p = plan(framesFrom(frames), NOW);
  ok("at capacity nothing new is taken", p.atCapacity && p.take.length === 0, `${p.open} open`);
  ok("and the deals are recognised as ours", p.deals.length === MAX_OPEN_DEALS);
}
{
  /* A frame that lies about who sent it must not become one of our deals. */
  const o = theirOffer(BUILT, {}, US);
  const id = await offerId(o);
  const lying = "tclk1 " + canon({ ...o, id });
  ok("a frame whose BODY claims to be from us, sent by somebody else, is not ours",
    ourDeals(framesFrom([msg(1, OTHER, lying)])).length === 0,
    "the transport decides who signed it, not the body");
}

/* ── E. the refusals ─────────────────────────────────────────────────────── */
console.log("\n=== E. the shop stays shut");
{
  /* An agent whose DID IS the shop's: refusals only cares about the string,
     and the real seed is not available to a test and never should be. */
  const asShop = { did: US };
  const full = { live: true, agent: asShop };
  ok("with everything in place there is nothing holding it", refusals(full).length === 0);
  ok("no --live holds it", refusals({ ...full, live: false }).length === 1);
  ok("no seed holds it", refusals({ ...full, agent: null }).some((r) => /no seed/.test(r)));
  ok("the WRONG seed holds it — a key that is not this shop must not post as it",
    refusals({ ...full, agent: { did: OTHER } }).some((r) => /not this shop/.test(r)));
  /* Capability left refusals(): it is not a fact about the run, it is a fact
     about each job, and plan() drops the ones nothing can deliver. Asserted
     where it now lives, below. */
}

/* ── F. a whole wake, against a stub ─────────────────────────────────────── */
console.log("\n=== F. a wake writes nothing");
{
  let posted = 0;
  const stub = async (url) => {
    if (String(url).includes("say-signed")) { posted++; return { ok: true, status: 200, text: async () => "{}" }; }
    return { ok: true, status: 200, json: async () => ({ messages: [] }) };
  };
  const lines = [];
  const r = await wake({ fetch: stub, base: "http://stub", log: (s) => lines.push(s), now: NOW, seed: SEED });
  ok("an empty board gives it nothing to take", r.plan.take.length === 0);
  ok("and it wrote nothing either way", posted === 0, posted + " writes");
  ok("it says why it is holding", r.refusals.length > 0 && lines.some((l) => /^hold:/.test(l)));
  ok("it noticed the key is not this shop's", lines.some((l) => /NOT THIS SHOP/.test(l)));
  ok("nothing it printed contains the seed", !lines.join("\n").includes(SEED));
  ok("nor any 32-byte hex string at all",
    !/[0-9a-f]{64}/.test(lines.join("\n")), lines.find((l) => /[0-9a-f]{64}/.test(l)) ?? "");
}
{
  /* The one write path, exercised end to end against a stub, so that going
     live later is a flag and not an untested leap. */
  let seen = null;
  const stub = async (url) => { seen = String(url); return { ok: true, status: 200, text: async () => "{}" }; };
  const text = "tclk1 " + canon({ a: 1, b: "two" });
  const r = await say(me, "tclk-offers", text, { fetch: stub, base: "http://stub", exact: true });
  ok("a post is a GET to say-signed", r.ok && /\/r\/tclk-offers\/say-signed\//.test(seen));
  ok("it carries the DID, an 86-char signature and a digit nonce",
    new RegExp(`say-signed/${me.did}/[A-Za-z0-9_-]{86}/\\d{1,19}/`).test(seen), seen.slice(0, 120));
  ok("the text on the wire is the text that was signed",
    decodeURIComponent(seen.split("/").pop().split("?")[0]) === text);
  const long = await say(me, "tclk-offers", "x".repeat(5000), { fetch: stub, base: "http://stub" });
  ok("an over-long message is refused rather than truncated", !long.ok && /longer than/.test(long.why));
  const swept = await say(me, "tclk-offers", "a​b", { fetch: stub, base: "http://stub", exact: true });
  ok("a frame the sweep would change is refused, not posted differently than signed",
    !swept.ok && /changed under the sweep/.test(swept.why));
  const dead = await say(me, "tclk-offers", "hi", { base: "http://stub", fetch: async () => { throw new Error("boom http://x/say-signed/did/SIGNATURE/1/hi"); } });
  ok("a network error does not carry the URL — the URL carries the signature",
    !dead.ok && !/SIGNATURE/.test(JSON.stringify(dead)), JSON.stringify(dead));
}

/* ── G. the seed is nowhere it should not be ─────────────────────────────── */
console.log("\n=== G. where the key is not");
{
  const files = ["scripts/runner.mjs", "scripts/agent.mjs", "RUNNER.md", "SELLING.md"];
  for (const f of files) {
    const s = fs.readFileSync(path.join(ROOT, f), "utf8");
    ok(`${f} contains no 64-hex string`, !/\b[0-9a-f]{64}\b/.test(s),
      (s.match(/\b[0-9a-f]{64}\b/) ?? [""])[0]);
  }
  const wf = path.join(ROOT, ".github/workflows/runner.yml");
  if (fs.existsSync(wf)) {
    const s = fs.readFileSync(wf, "utf8");
    ok("the workflow never echoes a secret", !/echo\s+.*\$\{\{\s*secrets\./.test(s));
    ok("and does not turn on shell tracing, which would print one", !/set -x/.test(s));
    ok("it passes the seed as an env var rather than an argument",
      !/--seed|runner\.mjs.*secrets\./.test(s));
  }
  ok("the runner reads the seed from the environment and nowhere else",
    (() => {
      const s = fs.readFileSync(path.join(ROOT, "scripts/runner.mjs"), "utf8");
      return /process\.env\.OVERHEARD_SEED/.test(s) && !/readFileSync[^)]*seed/i.test(s);
    })());
  ok("agent.mjs never returns or logs what it was given",
    (() => {
      const s = fs.readFileSync(path.join(ROOT, "scripts/agent.mjs"), "utf8");
      return !/console\.(log|error|warn)/.test(s) && !/return .*seedHex/.test(s);
    })());
}

/* ── H. a bad minute upstream is not a failed run ────────────────────────── */
console.log("\n=== H. when the board cannot be read");
{
  const dead = async () => ({ ok: false, status: 502, json: async () => ({}) });
  let err = null;
  try { await wake({ fetch: dead, base: "http://stub", log: () => {} }); } catch (e) { err = e; }
  ok("the read failure is raised", err !== null);
  ok("and is tagged as upstream, so a scheduled run does not cry wolf",
    err?.upstream === true,
    "a job that emails a red cross for somebody else's bad minute teaches you to ignore red crosses");
}

/* ── J. settling where the network will actually take it ─────────────────
 * The spec moves a deal into a room named after its contract. technocore.chat
 * is at its room cap and returns a bare `400 room limit reached` for any new
 * one, which is where 45 of 52 accepts died on the board on 3 September. The
 * state machine folds by contract and never reads a room name, so a frame on
 * the board is worth exactly as much — and falling back is the difference
 * between settling and stalling.
 * ─────────────────────────────────────────────────────────────────────── */
console.log("\n=== J. when the deal room cannot exist");
{
  const posts = [];
  const capped = async (url) => {
    const u = String(url);
    if (u.includes("say-signed")) {
      const room = u.split("/r/")[1].split("/")[0];
      posts.push(room);
      if (room.startsWith("mb-p-tclk-"))
        return { ok: false, status: 400, text: async () => "room limit reached (81920 is the cap)" };
      return { ok: true, status: 200, text: async () => "{}" };
    }
    return { ok: true, status: 200, json: async () => ({ messages: [] }) };
  };
  const lines = [];
  const out = await settle(me, "mb-p-tclk-" + "a".repeat(16), "tclk1 " + canon({ a: 1 }),
    { fetch: capped, base: "http://stub" }, (s2) => lines.push(s2));
  ok("it tries the room the spec names first",
    posts[0]?.startsWith("mb-p-tclk-"), posts.join(" then "));
  ok("and falls back to the board when the venue refuses it",
    posts[1] === "tclk-offers" && /on the board instead/.test(out), out);
  /* Reported, and reported HONESTLY: an earlier version blamed the room cap
     for every failure including a local refusal, which sends a reader to the
     venue looking for a bug that is here. The line names what actually came
     back. */
  ok("the fallback is reported rather than silent",
    lines.some((l) => /would not take it \(400\)/.test(l)), lines.join(" | "));
}

/* ── I. the question that was holding the shop shut, and the one that is ──
 *
 * This section used to record an open question: on a payee-opened offer the
 * statement arrives in the buyer's accept, and only the payee may reveal, so
 * we would have needed the preimage of a hash somebody else chose. We could
 * not tell whether that was the spec's intent or our misreading.
 *
 * ANSWERED, 3 September. It is flop-labs/tclk#12 — filed by another agent on
 * 2 September, still open, and confirmed there by an independent state
 * machine built from SPEC.md's prose rather than ported from the reference
 * implementation. The spec says either side may open; the custody model only
 * works one way. Both candidate fixes change frame shapes, so it is not ours
 * to route around.
 *
 * Our own archive of the board says how much this costs the network: 430 of
 * 2,459 offers are payee-opened, they are accepted 4.4% of the time against
 * 75% for payer-opened ones, and the single one that ever reached a reveal
 * had that reveal posted by the payer, which the machine rejects.
 *
 * So the shop no longer waits on it. We sell by accepting. What remains below
 * is the demonstration — kept because it is the reason the runner is shaped
 * this way, and a later reader deserves to see it fail rather than take it on
 * trust — and the ONE thing that still holds the shop shut, which is now ours
 * to fix rather than Flop Labs'.
 * ─────────────────────────────────────────────────────────────────────── */
console.log("\n=== I. the answered question, and the remaining one");
{
  /* The path we no longer take, still broken, exactly as #12 describes. */
  const o = theirOffer(BUILT, { role: "payee" }, US);   // us opening as payee
  const id = await offerId(o);
  const theirStatement = "0x" + "5c".repeat(32);
  const d = runDeal(framesFrom([
    msg(1, US, "tclk1 " + canon({ ...o, id })),
    msg(2, OTHER, "tclk1 " + canon({ type: "accept", from: OTHER, ref: id,
      statement: theirStatement, nonce: "0000000000000001",
      contract: "0x" + "ab".repeat(32) })),
  ]));
  ok("a payee-opened deal still makes us the payee", d.state === "accepted" && d.payee === US);
  ok("and the buyer the payer, so the reveal must come from us", d.payer === OTHER);
  ok("against a statement they chose and we cannot open",
    d.accept?.body?.statement === theirStatement,
    "knowing that preimage is the thing the lock exists to prevent");
  ok("which is why the planner refuses to open one",
    refuseTake({ body: o }, NOW).some((w) => /tclk#12/.test(w)));

  /* The direction we DO take, end to end, as the contrast that makes the
     point: same shop, same job, secret and reveal right in one hand. */
  const theirs = theirOffer();
  const tid = await offerId(theirs);
  const a = await buildAccept({ body: theirs }, tid, NOW, minterFor(SEED));
  const ours = runDeal(framesFrom([
    msg(1, OTHER, "tclk1 " + canon({ ...theirs, id: tid })),
    msg(2, US, "tclk1 " + canon(a.body)),
  ]));
  const opens = await checkReveal("hash", a.body.statement, a.secret);
  ok("a payer-opened deal makes us the payee too", ours.payee === US);
  ok("but this time we minted the statement and can open it", opens.ok);

  /* ── AND THE PART THAT USED TO HOLD IT SHUT ────────────────────────────
     There is no secret store, because the secret is derived rather than kept.
     What could go wrong is no longer "we lost it" but "we cannot get it
     back", so the wake proves the round trip before it commits to a
     statement — section K is that property on its own. */
  const src = fs.readFileSync(path.join(ROOT, "scripts/runner.mjs"), "utf8");
  ok("the wake re-derives and checks the lock opens before posting an accept",
    /recoverSecret\(seed, a\.body\)/.test(src) && /REFUSED: the secret does not survive/.test(src),
    "a statement we cannot reopen is a promise we cannot keep");
  ok("and nothing writes a preimage anywhere",
    !/randomSecret/.test(src) && !/writeFile[^\n]*secret/i.test(src),
    "the derivation is the store");

  /* ── THE ENFORCEABLE HALF ───────────────────────────────────────────────
     This used to ban the string `--live` outright. That was the right guard
     while there was no safe way to pass it, and the wrong one now: a manual
     live run is a legitimate deliberate act, and a test that cannot tell it
     apart from an armed cron just gets deleted by whoever needs the former.

     So the property under test is the one that actually matters — THE TIMER
     CAN NEVER POST. --live must be reachable only when both halves hold: the
     run was started by a person, and that person ticked the box. The event
     check is load-bearing on its own, because `inputs.live` is empty on a
     schedule and a default flipped to true would otherwise arm the cron
     silently. */
  const wf = fs.readFileSync(path.join(ROOT, ".github/workflows/runner.yml"), "utf8");
  const runLine = wf.split("\n").find((l) => /^\s*run:\s*node scripts\/runner\.mjs/.test(l)) ?? "";
  ok("the wake is invoked exactly once, and this is it", runLine !== "", runLine.trim().slice(0, 60));
  ok("it never passes --live unconditionally",
    !/runner\.mjs\s+--live/.test(runLine), runLine.trim());
  ok("--live needs a human pressing the button, not just an input default",
    !runLine.includes("--live") ||
      (/github\.event_name\s*==\s*'workflow_dispatch'/.test(runLine) && /inputs\.live/.test(runLine)),
    "a schedule leaves inputs.live empty, so the event check is what stops a flipped default arming the cron");
  ok("and the input it reads defaults to off",
    /live:\s*\n\s*description:[^\n]*\n\s*type:\s*boolean\s*\n\s*default:\s*false/.test(wf),
    "so dispatching without thinking about it is still a dry run");

  ok("and the reasoning is written down where the next person will find it",
    /tclk#12/.test(fs.readFileSync(path.join(ROOT, "RUNNER.md"), "utf8")),
    "RUNNER.md must name the upstream issue, not just say 'a protocol question'");
}

/* ── K. the secret, which is derived and never stored ────────────────────
 * The accept commits us to a statement whose preimage only we hold. Every
 * place we could have written that preimage down is worse than not needing
 * to: the repository is public, the archive is the repository, a Technocore
 * note is world-readable, an Actions secret needs an admin token in the
 * environment, and a database is infrastructure whose loss is silent until
 * the day it costs a deal.
 *
 * So it is derived from the seed and from the two values our own accept puts
 * on the wire. These are the properties that makes that safe.
 * ─────────────────────────────────────────────────────────────────────── */
console.log("\n=== K. the secret");
{
  const REF = "0x" + "11".repeat(32);
  const N1 = "00000000000000aa", N2 = "00000000000000ab";
  const s1 = await secretFor(SEED, REF, N1);

  ok("it is 32 bytes of hex", /^0x[0-9a-f]{64}$/.test(s1));

  /* THE WHOLE POINT. A process that dies between the accept and the payer's
     lock must lose nothing, so the same inputs must give the same answer in
     a process that never saw the first one. */
  ok("the same deal always yields the same preimage",
    (await secretFor(SEED, REF, N1)) === s1);
  ok("and it comes back from the accept frame alone, days later",
    (await recoverSecret(SEED, { ref: REF, nonce: N1 })) === s1,
    "this is the reveal path, with nothing but what is already public");

  ok("a different nonce is a different deal and a different secret",
    (await secretFor(SEED, REF, N2)) !== s1);
  ok("a different offer is too",
    (await secretFor(SEED, "0x" + "22".repeat(32), N1)) !== s1);

  /* Uniqueness comes from the fixed widths, not from the separator: a ref is
     always 64 hex and a nonce always 16, so no two different deals can
     concatenate to the same input. Worth pinning as a property over many
     pairs rather than trusting the argument. */
  const seen = new Set();
  for (let i = 0; i < 24; i++) {
    const ref = "0x" + String(i).padStart(64, "0");
    for (let j = 0; j < 4; j++) seen.add(await secretFor(SEED, ref, String(j).padStart(16, "0")));
  }
  ok("96 distinct deals give 96 distinct preimages", seen.size === 96, seen.size + " unique");

  /* KEY SEPARATION. The seed signs frames as this DID. If a preimage were the
     seed, or a slice of it, publishing a reveal would publish the shop. */
  const OTHER_SEED = "b".repeat(64);
  ok("a different seed gives a different secret",
    (await secretFor(OTHER_SEED, REF, N1)) !== s1);
  ok("and the secret is not the seed, nor any slice of it",
    !s1.includes(SEED) && !SEED.includes(s1.slice(2, 34)) && s1.slice(2) !== SEED);

  /* A wrong key produces a plausible-looking secret that opens nothing, so
     bad input must throw rather than return. */
  for (const [what, fn] of [
    ["a short seed", () => secretFor("abc", REF, N1)],
    ["a non-hex seed", () => secretFor("z".repeat(64), REF, N1)],
    ["a ref that is not an offer id", () => secretFor(SEED, "nope", N1)],
    ["a nonce of the wrong length", () => secretFor(SEED, REF, "aa")],
  ]) {
    let threw = false;
    try { await fn(); } catch { threw = true; }
    ok(`${what} throws rather than returning something that opens nothing`, threw);
  }

  /* End to end: the statement an accept commits to must be openable by the
     secret re-derived from that same accept. */
  const o = theirOffer();
  const id = await offerId(o);
  const acc = await buildAccept({ body: o }, id, NOW, minterFor(SEED));
  const back = await recoverSecret(SEED, acc.body);
  const opens = await checkReveal("hash", acc.body.statement, back);
  ok("an accept's statement reopens from the accept itself", opens.checked && opens.ok, opens.why);
  ok("and the recovered secret is the one it was built with", back === acc.secret);

  /* Rotating the seed strands open deals. Not a bug — the same row SELLING.md
     already has for a compromised key — but it must be true on purpose. */
  ok("a rotated seed cannot reopen an old statement",
    !(await checkReveal("hash", acc.body.statement, await recoverSecret(OTHER_SEED, acc.body))).ok,
    "SELLING.md already says a rotated key lapses open deals; this is that, on the sell side");
}

/* ── L. delivery, then reveal, and never the other way round ─────────────
 * The reveal is what lets the payer's money move, and it is irreversible: the
 * preimage goes on a public wire and anyone can complete the deal with it. So
 * the ORDER is the whole safety property. Deliver first; reveal only if the
 * delivery actually landed. A failed handler must leave the deal locked, so
 * the buyer refunds at refundAfterMs and we simply earned nothing — which is
 * the correct direction to fail in.
 *
 * Runs in a CHILD process because `US` is read at import time and this needs
 * a key whose DID is the shop's. The real seed is a repository secret and is
 * not in this tree, so the child sets SHOP_DID to the test key's DID — which
 * grants nothing on its own, since refusals() still demands a matching seed.
 * ─────────────────────────────────────────────────────────────────────── */
console.log("\n=== L. what we owe");
{
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath,
    [path.join(ROOT, "scripts/test-deliver.mjs")],
    { encoding: "utf8", env: { ...process.env, SHOP_DID: me.did, TEST_SEED: SEED } });
  for (const line of out.trim().split("\n")) {
    if (!line.startsWith("RESULT ")) { console.log(line); continue; }
    const r = JSON.parse(line.slice(7));
    ok(r.name, r.pass, r.note);
  }
}

/* ── M. saying what happened where we can read it ────────────────────────
 * We cannot download our own CI logs: results-receiver.actions.githubusercontent.com
 * is outside the egress allowlist, so every wake has been a green tick with
 * nothing behind it — which is how a LIVE run posted nothing and still looked
 * like a success. Annotations ride the check-run API, which is reachable.
 * They also go to a public repository, so what they may contain is a test and
 * not a habit.
 * ─────────────────────────────────────────────────────────────────────── */
console.log("\n=== M. the annotation");
{
  const had = process.env.GITHUB_ACTIONS;
  try {
    delete process.env.GITHUB_ACTIONS;
    ok("outside Actions it emits nothing at all",
      annotate("notice", "t", "m", () => { throw new Error("should not have written"); }) === null);

    process.env.GITHUB_ACTIONS = "true";
    const out = [];
    annotate("notice", "hello", "a plain message", (l) => out.push(l));
    ok("inside Actions it writes one workflow command",
      out.length === 1 && out[0] === "::notice title=hello::a plain message", out[0]);

    /* The rule that matters: a preimage or a seed must not survive contact
       with this function even if a later edit hands one over. */
    const secret = "d".repeat(64);
    const leaked = [];
    annotate("warning", `t ${secret}`, `before ${secret} after`, (l) => leaked.push(l));
    ok("a 64-hex string is scrubbed from the message",
      !leaked[0].includes(secret) && leaked[0].includes("[redacted]"), leaked[0]);
    ok("and from the title too, which is the half easy to forget",
      !leaked[0].split("::")[1].includes(secret), leaked[0].split("::")[1]);

    /* A newline would end the command early and turn the rest into raw log
       output, which is both broken and a way to smuggle text past the scrub. */
    const nl = [];
    annotate("notice", "t", "one\ntwo\r\nthree", (l) => nl.push(l));
    ok("newlines cannot break out of the annotation",
      !/[\r\n]/.test(nl[0]) && nl[0].includes("one · two · three"), JSON.stringify(nl[0]));

    /* And the wake emits one, every time, saying whether it held and why —
       that is the fact that was invisible. */
    const lines = [];
    const stub = async (u) => String(u).includes("say-signed")
      ? { ok: true, status: 200, text: async () => "{}" }
      : { ok: true, status: 200, json: async () => ({ messages: [] }) };
    await wake({ fetch: stub, base: "http://stub", log: (l) => lines.push(l), now: NOW, seed: SEED });
    const ann = lines.filter((l) => l.startsWith("::"));
    /* TWO, and they answer different questions. The first is what the wake
       DECIDED; the second is what reached the WIRE. Collapsing them was how a
       live run that posted nothing still read as a success — the decision
       line looked identical either way. */
    ok("a wake emits both the decision and the outcome", ann.length === 2, ann.length + " emitted");
    ok("the first names the key's verdict", /key (✓|✗)/.test(ann[0]), ann[0].slice(0, 90));
    ok("and says what is holding the shop", /holding:|nothing holding it/.test(ann[0]), ann[0].slice(-60));
    ok("the second says what was written, or that nothing was",
      /what reached the wire|nothing was written/.test(ann[1]), ann[1].slice(0, 90));
    ok("with no 64-hex anywhere in the whole wake",
      !/[0-9a-f]{64}/.test(lines.join("\n")),
      lines.find((l) => /[0-9a-f]{64}/.test(l))?.slice(0, 60) ?? "clean");
  } finally {
    if (had === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = had;
  }
}

/* ── N. one rail, named once ─────────────────────────────────────────────
 * The rail is what actually holds the money while a lock is unopened. Today
 * it is `paper`, which holds nothing — real frames, real state machine, no
 * value. On the day that changes, the change must be one line.
 *
 * It used to be written out four times: our offers, our locks, the runner's
 * shelf, and the sample offer on the deals page. That is fine until it
 * changes, and then it is the exact shape of bug that gets fixed in three
 * places and missed in the fourth — posting on a live rail while locking on a
 * dead one. Nothing would fail loudly; the deals would just never settle.
 * ─────────────────────────────────────────────────────────────────────── */
console.log("\n=== N. the rail");
{
  const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  ok("the shop's frames name the rail from one place",
    /rails: RAILS/.test(src("scripts/buy.mjs")) && /rail = RAIL/.test(src("scripts/buy.mjs")));

  /* The property, not the spelling: no file that BUILDS a frame may spell the
     rail out for itself. Comments are stripped first — the reasoning above
     each of these mentions `paper` constantly, and a test that fails on prose
     is a test that gets weakened rather than obeyed. */
  for (const f of ["scripts/runner.mjs", "scripts/buy.mjs", "scripts/work.mjs"]) {
    const bare = strip(src(f));
    ok(`${f} does not hard-code a rail of its own`,
      !/["']paper["']/.test(bare),
      (bare.match(/.{0,40}["']paper["'].{0,20}/) || ["clean"])[0].trim());
  }

  /* And the shopfront must quote the same rail it will actually be offered,
     because the sample offer on that page is the interface a buyer copies. */
  const page = src("web/deals-preview-78cb4a1be923c6b4.html");
  const quoted = page.match(/"rails":\s*\[([^\]]*)\]/);
  ok("the deals page quotes the rail the shop actually posts",
    !!quoted && quoted[1].replace(/["'\s]/g, "") === RAIL,
    quoted ? quoted[1].trim() : "no sample offer found");

  /* Switching is one line, so prove it moves everything at once rather than
     trusting that it does. */
  ok("RAILS and the accept-set both follow RAIL",
    RAILS.length === 1 && RAILS[0] === RAIL && RAILS_WE_TAKE.has(RAIL),
    `RAIL=${RAIL} RAILS=${JSON.stringify(RAILS)}`);
  ok("and the page's own note is still true while the rail is a rehearsal",
    !IS_REHEARSAL || /testnet is not open|moves nothing/i.test(page),
    "a rehearsal rail must be disclosed on the page, not just in the code");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

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
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createPublicKey, verify as edVerify, randomBytes } from "node:crypto";
import { agentFromSeed, sweep, nextNonce, say } from "./agent.mjs";
import {
  US, JOBS, WINDOW, MAX_OPEN_DEALS, buildAccept, refuseTake,
  plan, refusals, framesFrom, ourDeals, wake, settle, annotate, ourArchive, loop,
} from "./runner.mjs";
import { secretFor, recoverSecret, minterFor } from "./secret.mjs";
import { RAIL, RAILS, RAILS_WE_TAKE, IS_REHEARSAL, LOCK_VERIFIERS } from "./rail.mjs";
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

  /* ── THE ENFORCEABLE HALF, AND HOW IT CHANGED ───────────────────────────
     Two rules have been retired here, each correct in its turn.

     FIRST it banned the string `--live` outright — right while there was no
     safe way to pass it, wrong once a manual live run became a legitimate
     deliberate act.

     THEN the rule was THE TIMER CAN NEVER POST: --live only when a person
     dispatched AND ticked the box. That was right while the buy side was
     unproven. It is wrong now, and not because the risk went away — because
     the thing this shop exists to do is spend on the board repeatedly without
     supervision, and a rule that requires a human every hour does not make
     that safe, it makes it not happen.

     THE RULE NOW: A COMMIT CANNOT ARM THE TIMER. The schedule may post, but
     only when a switch that is NOT in this repository says so. That keeps the
     half that actually protects anything — no branch, however edited, starts
     unattended spending, because the switch is not in the diff — and it moves
     the off switch somewhere it can be thrown in ten seconds without a commit
     or a deploy, which is the direction that has to be fast.

     What is still asserted, and what would be a real regression:
       · --live is never unconditional;
       · the manual route still needs BOTH the event and the ticked box, since
         `inputs.live` is empty on a schedule and a flipped default must not
         arm anything on its own;
       · the scheduled route is gated on a repository variable and on nothing
         else — a literal, an env default or a `secrets.` fallback here would
         all put the switch back inside the repository. */
  const wf = fs.readFileSync(path.join(ROOT, ".github/workflows/runner.yml"), "utf8");
  const runLine = wf.split("\n").find((l) => /^\s*run:\s*node scripts\/runner\.mjs/.test(l)) ?? "";
  ok("the wake is invoked exactly once, and this is it", runLine !== "", runLine.trim().slice(0, 60));
  ok("it never passes --live unconditionally",
    !/runner\.mjs\s+--live\b/.test(runLine), runLine.trim());

  /* The flag is computed in its own step now, so the decision is a block of
     shell rather than one expression — read that block, not the run line. */
  const decide = wf.slice(wf.indexOf("- name: decide whether this wake posts"),
                          wf.indexOf("- name: wake"));
  ok("the decision is made in one place", decide.includes("GITHUB_OUTPUT"), "and read once by the wake");
  ok("the manual route still needs the event AND the ticked box",
    /github\.event_name \}\}" = "workflow_dispatch"/.test(decide) && /inputs\.live \}\}" = "true"/.test(decide),
    "a schedule leaves inputs.live empty, so the event check is what stops a flipped default arming it");
  ok("and the input it reads defaults to off",
    /live:\s*\n\s*description:[^\n]*\n\s*type:\s*boolean\s*\n\s*default:\s*false/.test(wf),
    "so dispatching without thinking about it is still a dry run");
  ok("the timer posts only when a repository VARIABLE says so",
    /vars\.AUTOPILOT/.test(wf) && /"\$AUTOPILOT" = "on"/.test(decide),
    "vars live in GitHub's settings, so no commit can arm the cron and no deploy is needed to stop it");
  ok("and that switch has no fallback inside the repository",
    !/AUTOPILOT:\s*\$\{\{\s*vars\.AUTOPILOT\s*\|\|/.test(wf) &&
    !/secrets\.AUTOPILOT/.test(wf) &&
    !/AUTOPILOT[=:]\s*["']?on/.test(wf.replace(/"\$AUTOPILOT" = "on"/g, "")),
    "a default of \"on\" anywhere in here would put the switch back in the diff");
  ok("every wake says out loud whether it posted",
    /::warning title=Posting real frames/.test(decide) && /::notice title=Dry run/.test(decide),
    "\"did this one post?\" is the first question anybody asks of a log");

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

  /* ── AND THE RAIL SWITCH FAILS CLOSED ────────────────────────────────────
     Switching RAIL is one line, and that is exactly what makes it dangerous:
     everything else carries on working, including the part that reads a
     signed `lock` frame as proof the money is held. On `paper` it IS proof,
     because nothing is held. On a rail with value it is a message anybody can
     post, and a shop that delivers on one gives the work away and never finds
     out — no crash, no warning, nothing failing.
     The verifier for flop-htlc cannot be written: the spec does not yet say
     what such a lock points at, and code written against an imagined shape
     passes its own tests and is wrong in the one way none of them can catch.
     The SEAM can be written, and this is the assertion that keeps it shut. */
  ok("every rail must name a lock verifier before anything is delivered on it",
    /LOCK_VERIFIERS/.test(src("scripts/rail.mjs")) && /verifyLock/.test(strip(src("scripts/runner.mjs"))),
    "without this, flipping RAIL delivers real work against unverified locks");
  ok("and only the rail that holds nothing has one",
    Object.keys(LOCK_VERIFIERS).length === 1 && "paper" in LOCK_VERIFIERS,
    JSON.stringify(Object.keys(LOCK_VERIFIERS)));
  ok("the check happens BEFORE the work, not before the reveal",
    strip(src("scripts/runner.mjs")).indexOf("verifyLock(")
      < strip(src("scripts/runner.mjs")).indexOf("madeThisWake.set("),
    "verifying after the work is done still gives the work away");
}

/* ── O. what we already have standing ────────────────────────────────────
 * MEASURED on the live board: the runner posted two buy offers at 14:24 and
 * the same two again at 16:20, because 2,284 messages landed between the
 * wakes and a read only ever returns the newest 200. Our own offers had
 * scrolled out of every window we can see, `standing` came back empty, and
 * planBuys correctly posted what appeared to be missing.
 *
 * On an hourly live schedule that is ~48 duplicate promises a day, each one
 * signed and permanent. So this stages exactly that board.
 * ─────────────────────────────────────────────────────────────────────── */
console.log("\n=== O. offers that scrolled out of sight");
{
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "arch-runner-"));
  const room = path.join(OUT, "tclk-offers");
  fs.mkdirSync(room, { recursive: true });
  const today = new Date(NOW).toISOString().slice(0, 10);

  /* Our two buy offers, posted hours ago and still well inside their window. */
  const { WANTS, buildWant } = await import("./buy.mjs");
  const rows = [];
  let seq = 9540;
  for (const w of WANTS.slice(0, 2)) {
    const body = buildWant(w, US, NOW - 4 * 3600000);
    rows.push(JSON.stringify({ seq: seq++, ts: new Date(NOW - 4 * 3600000).toISOString(),
      from: US, text: "tclk1 " + canon({ ...body, id: await offerId(body) }), sig: "s" }));
  }
  fs.writeFileSync(path.join(room, `${today}.ndjson`), rows.join("\n") + "\n");

  /* The live window: 200 messages of somebody else's traffic, far past ours. */
  const busy = [];
  for (let i = 0; i < 200; i++)
    busy.push({ seq: 11800 + i, ts: new Date(NOW - 60000).toISOString(),
      from: OTHER, text: "chatter " + i, sig: "s" });

  const stub = async (u) => String(u).includes("say-signed")
    ? { ok: true, status: 200, text: async () => "{}" }
    : { ok: true, status: 200, json: async () => ({ messages: busy }) };

  const seen = [];
  const r = await wake({ fetch: stub, base: "http://stub", log: (l) => seen.push(l),
                         now: NOW, seed: SEED, archive: OUT });

  ok("it finds our standing offers in the archive, not the live window",
    r.buys.want.length === 0,
    r.buys.want.map((w) => w.id).join(", ") || "nothing to post — correct");
  ok("and says how many of ours it could see",
    seen.some((l) => /2 of ours from the archive/.test(l)),
    seen.find((l) => /of ours/.test(l)) ?? "not stated");

  /* The control: same board, no archive. This is the bug, reproduced. */
  const gone = [];
  const r2 = await wake({ fetch: stub, base: "http://stub", log: (l) => gone.push(l),
                          now: NOW, seed: SEED, archive: path.join(OUT, "nothing-here") });
  ok("without the archive it would post them all over again",
    r2.buys.want.length === 2,
    `${r2.buys.want.length} duplicates — this is what happened on the real board`);
  ok("and an unreadable archive is visible in the run, not swallowed",
    gone.some((l) => /0 of ours from the archive/.test(l)),
    gone.find((l) => /of ours/.test(l)) ?? "not stated");

  fs.rmSync(OUT, { recursive: true, force: true });
}

/* ══════════════════════════════════════════════════════════════════════════
 * P. THE SLOT THAT NEVER CAME BACK
 *
 * TERMINAL is {claimed, refunded, cancelled}. A deal we accepted and nobody
 * funded is `accepted`, which is none of those, so it counted against the
 * open-deal cap for ever — no expiry, no timeout, nothing anywhere that ever
 * gave it up. Three abandoned orders shut the shop permanently, and from
 * outside that is indistinguishable from a shop nobody is ordering from.
 *
 * Not hypothetical: every buyer abandoned, because until the lock button
 * shipped there was no way on this site for one to pay.
 * ═════════════════════════════════════════════════════════════════════════*/
/* ══════════════════════════════════════════════════════════════════════════
 * O2. THE GAP BETWEEN A FIVE-MINUTE ROOM AND AN HOURS-OLD SHARD
 *
 * Section O staged an offer that had scrolled out of the live window and was
 * safe because the day shard held it. PROBED on 4 September, that safety was
 * not real:
 *
 *   · the live room is capped at 200 messages BY THE VENUE (limit=5000
 *     returns 200) and `since` will not page backwards;
 *   · the room runs at ~2,600 frames an hour, so 200 messages is FIVE
 *     MINUTES;
 *   · the day shard is committed on every twelfth archiver pass — that day it
 *     had not been written since 08:46.
 *
 * A deal landing between those is invisible. Not theory: a real order at
 * 12:20, offer and accept and payment lock all on the board, was unseen by a
 * live wake at 12:52 that reported `0 owed` and slept while the money sat
 * locked.
 *
 * tail.ndjson is the archiver's bounded window over the same room, written on
 * every pass. This is the test that the shop actually reads it.
 * ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== O2. the deal that is only in the tail");
{
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "arch-tail-"));
  const room = path.join(OUT, "tclk-offers");
  fs.mkdirSync(room, { recursive: true });
  const today = new Date(NOW).toISOString().slice(0, 10);

  /* A funded deal: a buyer's offer, our accept, and their lock. All three are
     in the TAIL and in no shard, which is exactly where a deal accepted since
     the last twelfth pass lives. */
  const o = theirOffer(BUILT, { nonce: "0000000000000501" });
  const id = await offerId(o);
  const contract = "0x" + "51".repeat(32);
  const tail = [
    { seq: 70001, from: OTHER, text: "tclk1 " + canon({ ...o, id }) },
    { seq: 70002, from: US, text: "tclk1 " + canon({
        type: "accept", from: US, ref: id, statement: "0x" + "7c".repeat(32),
        nonce: "0000000000000502", contract }) },
    { seq: 70003, from: OTHER, text: "tclk1 " + canon({
        type: "lock", from: OTHER, contract, rail: "paper", ref: "aabbccdd" }) },
  ].map((r) => JSON.stringify({ ...r, ts: new Date(NOW - 600000).toISOString(), sig: "s" }));

  /* The day shard holds only older, unrelated business — the state the file is
     in when it has not been rewritten for hours. */
  fs.writeFileSync(path.join(room, `${today}.ndjson`), "");
  fs.writeFileSync(path.join(room, "tail.ndjson"), tail.join("\n") + "\n");

  const rowsWith = await ourArchive(US, { archive: OUT, now: NOW });
  /* THREE, not one. Only the accept is ours, but recovering our accept alone
     recovers nothing usable: ourDeals pairs an accept to its OFFER and drops
     one it cannot pair, and the buyer's offer and lock have scrolled out of
     the five-minute live window too. The first version of this fix returned
     just the accept and the deal still did not form — `owed` stayed zero and
     the shop still slept through work it had been paid for. */
  ok("the archive read recovers the whole deal, not just our half",
    rowsWith.length === 3,
    `${rowsWith.length} rows — the buyer's offer and lock are as necessary as our accept`);

  /* And the whole point: plan() must see the deal as OWED, because somebody
     has paid for it and is waiting.
     BUILT FROM WHAT ourArchive ACTUALLY RETURNED, not from the fixture array.
     The first version of this assertion re-parsed the same in-memory rows it
     had just written to disk, so it exercised no changed code at all and
     passed with the tail read deleted. A test that constructs its own input
     is testing the constructor. */
  const p = plan(framesFrom(rowsWith), NOW);
  ok("and a deal only the tail can see is owed, not invisible",
    p.owed.length === 1,
    `${p.owed.length} owed — this is the number that read 0 while a buyer's money sat locked`);

  /* ── THE OVERLAP, WHICH IS DELIBERATE AND MUST COST NOTHING ──────────────
     The tail is a window over the same room the shards hold, so a frame near
     the boundary is in both files. Without a dedupe the shop counts its own
     accept twice — and `open` feeds the capacity cap, so double-counting is a
     shop that shuts itself at half its book. Staged by putting the same rows
     in the shard as in the tail, which is the ordinary steady state. */
  fs.writeFileSync(path.join(room, `${today}.ndjson`), tail.join("\n") + "\n");
  const both = await ourArchive(US, { archive: OUT, now: NOW });
  ok("a frame in both the tail and the shard is returned once",
    both.length === 3,
    `${both.length} rows from three frames duplicated across both files — the overlap is by design; counting it twice would halve the shop's book`);

  /* THE CONTROL: the same board with no tail file is the bug, reproduced.
     The shard is emptied too, or "nothing found" would be true for the
     uninteresting reason that the shard still held it. */
  fs.writeFileSync(path.join(room, `${today}.ndjson`), "");
  fs.rmSync(path.join(room, "tail.ndjson"));
  const rowsWithout = await ourArchive(US, { archive: OUT, now: NOW });
  ok("without the tail the shop sees nothing at all", rowsWithout.length === 0,
    "which is what a live wake reported while the deal was already funded");

  fs.rmSync(OUT, { recursive: true, force: true });
}

console.log("\n=== P. deals that were agreed and never funded");
{
  const build = async (nonce, refundAfterMs) => {
    const o = theirOffer(BUILT, { nonce, refundAfterMs });
    const id = await offerId(o);
    return [
      msg(10, OTHER, "tclk1 " + canon({ ...o, id })),
      msg(20, US, "tclk1 " + canon({
        type: "accept", from: US, ref: id, statement: "0x" + "7c".repeat(32),
        nonce: "acc" + nonce.slice(3), contract: "0x" + nonce.slice(-4) + "e".repeat(60),
      })),
    ];
  };

  const dead = await build("0000000000000101", NOW - HOUR_MS);
  const alive = await build("0000000000000102", NOW + HOUR_MS);

  const pDead = plan(framesFrom(dead), NOW);
  ok("a deal past its refund deadline with no lock stops counting against the cap",
    pDead.open === 0, `${pDead.open} open`);
  ok("and is queued for a cancel", pDead.reap.length === 1, `${pDead.reap.length} to reap`);

  const pAlive = plan(framesFrom(alive), NOW);
  ok("one still inside its window is left entirely alone",
    pAlive.open === 1 && pAlive.reap.length === 0,
    `${pAlive.open} open, ${pAlive.reap.length} to reap — reaping early cancels a deal a slow buyer was about to fund`);

  /* THE LINE THAT MATTERS MOST. A funded deal is money owed, and cancelling
     one is walking away from work somebody paid for. */
  const funded = [...dead, msg(30, OTHER, "tclk1 " + canon({
    type: "lock", from: OTHER, contract: "0x" + "0101" + "e".repeat(60), rail: "paper", ref: "aabbccdd",
  }))];
  const pFunded = plan(framesFrom(funded), NOW);
  ok("a FUNDED deal past the same deadline is never cancelled",
    pFunded.reap.length === 0,
    `${pFunded.reap.length} to reap — this would be walking away from work we were paid for`);
  ok("  it is owed, and stays owed", pFunded.owed.length === 1, `${pFunded.owed.length} owed`);

  /* Capacity, which is the whole reason any of this exists. */
  const many = [];
  for (let i = 0; i < MAX_OPEN_DEALS + 2; i++) {
    many.push(...await build("000000000000" + String(200 + i), NOW - HOUR_MS));
  }
  const pMany = plan(framesFrom(many), NOW);
  ok("a shop full of abandoned orders is not a shop that has stopped trading",
    !pMany.atCapacity,
    `${pMany.open} open of ${MAX_OPEN_DEALS} — before this, ${MAX_OPEN_DEALS} of them closed it for good`);
}

console.log("\n=== S. the shop is full and says so");
{
  /* Its own process, for the same reason section L has one: `US` is read at
     import time and this path only exists where the key in the environment is
     the shop's. See scripts/test-full.mjs. */
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath,
    [path.join(ROOT, "scripts/test-full.mjs")],
    { encoding: "utf8", env: { ...process.env, SHOP_DID: agentFromSeed(SEED).did, TEST_SEED: SEED } });
  for (const line of out.trim().split("\n")) {
    if (!line.startsWith("RESULT ")) { console.log(line); continue; }
    const r = JSON.parse(line.slice(7));
    ok(r.name, r.pass, r.note);
  }
}

console.log("\n=== Q. the cap is not a money number");
{
  /* ── WHY THE RAIL NO LONGER CHANGES IT ─────────────────────────────────
     It was 3 everywhere, then 24 on `paper` and 3 on a rail that settles,
     and both of those were answers to the wrong question. The cap was
     written as a stand-in for a FLOP reserve — but SELLING BRINGS FLOP IN.
     The buyer locks their own money; we spend compute and a claim fee.
     Capping sales to protect a balance throttles the thing that fills it.
     What actually binds is reads (~1 + 2n per wake against 600 a minute)
     and time (a daily digest is 16.5s), and neither of those knows what
     rail it is on. */
  const { execFileSync } = await import("node:child_process");
  const read = (env) => Number(execFileSync(process.execPath,
    ["-e", 'import("./scripts/runner.mjs").then(m=>console.log(m.MAX_OPEN_DEALS))'],
    { encoding: "utf8", cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "ignore"] }).trim());
  const paper = read({ TCLK_RAIL: "paper", MAX_OPEN_DEALS: "" });
  const live = read({ TCLK_RAIL: "flop-htlc", MAX_OPEN_DEALS: "" });
  ok("the rail does not change it any more", paper === live, `paper ${paper} vs live ${live}`);
  ok("and testnet day does not silently shrink the shop", live >= 50,
    `${live} — it used to drop from 24 to 3 the moment the rail changed, on the busiest day`);
  /* The upper bound is not arbitrary either. A wake reads the board once and
     then one room per unfinished deal, and the buy side does it again: about
     1 + 2n. At a wake a minute, n must stay well inside 600 reads a minute. */
  ok("and it is still inside the read allowance at a wake a minute",
    1 + 2 * live <= 300, `${1 + 2 * live} reads a minute of a documented 600`);
  ok("either way it moves without a deploy",
    read({ TCLK_RAIL: "paper", MAX_OPEN_DEALS: "7" }) === 7,
    "an incident wants a number changed now, not merged");
}


/* ── R. the window, because cron is a request and not a promise ───────────
 *
 * MEASURED on this repository: the runner asked to fire every five minutes
 * and fired at 14:34 and then not again until 16:42 — and archive.yml's log
 * has gaps of 49 to 295 minutes. That was survivable while a buyer had to
 * come back and press Pay. It is not survivable now: the accept is on demand
 * and the browser locks in the same click, so somebody who ordered at 16:45
 * had already PAID and was waiting on a firing cron had no intention of
 * delivering.
 *
 * So a firing opens a window and the process wakes on its own clock inside
 * it. What has to hold: it keeps waking, it stops on time, one wake at a
 * time, and a bad minute on the venue does not end the window.
 * ─────────────────────────────────────────────────────────────────────── */
console.log("\n=== R. staying awake for a window");
{
  const quiet = () => {};

  {
    let n = 0, overlapping = 0, inside = 0;
    const r = await loop({
      everyMs: 20, forMs: 260, log: quiet,
      wakeFn: async () => {
        n++;
        inside++; if (inside > 1) overlapping++;
        await new Promise((d) => setTimeout(d, 5));
        inside--;
        return { refusals: [] };
      },
    });
    ok("one firing produces many wakes, not one", n > 3, `${n} wakes in 260ms at 20ms`);
    ok("and the count it reports is the count it did", r.wakes === n, `${r.wakes} vs ${n}`);
    ok("never two at once, whatever a wake costs", overlapping === 0, `${overlapping} overlaps`);
  }

  {
    /* The bound that stops this becoming the outage it fixes: the process has
       to end by itself, well inside the job timeout, so the next firing is a
       clean checkout rather than a queue that never drains. */
    const started = Date.now();
    await loop({ everyMs: 30, forMs: 150, log: quiet, wakeFn: async () => ({ refusals: [] }) });
    const took = Date.now() - started;
    ok("the window closes on time rather than running on", took < 600, `${took}ms for a 150ms window`);
  }

  {
    /* Technocore has bad minutes. One of them must not take the shop off the
       air for the remaining five hours — which is exactly what a throw at the
       top level used to do. */
    let n = 0;
    const r = await loop({
      everyMs: 15, forMs: 200, log: quiet,
      wakeFn: async () => {
        n++;
        if (n === 1) { const e = new Error("board unreadable"); e.upstream = true; throw e; }
        return { refusals: [] };
      },
    });
    ok("an unreadable board does not end the window", n > 2, `${n} wakes after the first one threw`);
    ok("and is counted as the venue's, not ours", r.upstream === 1 && r.failed === 0,
      `upstream ${r.upstream}, failed ${r.failed}`);
  }

  {
    /* A fault in OUR code is different: the window still runs, because five
       dark hours is worse than five noisy ones, but the run must go red so
       somebody looks. */
    const r = await loop({
      everyMs: 15, forMs: 120, log: quiet,
      wakeFn: async () => { throw new Error("a real bug"); },
    });
    ok("a fault in our own code keeps the shop answering", r.wakes > 1, `${r.wakes} wakes`);
    ok("but is reported so the run can go red", r.failed === r.wakes, `${r.failed} of ${r.wakes} failed`);
  }

  {
    /* The switch that decides whether anything is posted has to survive the
       trip through the loop. A window of live wakes that all ran dry would be
       the quietest possible failure. */
    const seen = [];
    await loop({ live: true, everyMs: 40, forMs: 60, log: quiet,
                 wakeFn: async (o) => { seen.push(o.live); return { refusals: [] }; } });
    ok("live carries through to every wake in the window",
      seen.length > 0 && seen.every((v) => v === true), JSON.stringify(seen));
    const dry = [];
    await loop({ everyMs: 40, forMs: 60, log: quiet,
                 wakeFn: async (o) => { dry.push(o.live); return { refusals: [] }; } });
    ok("and so does a dry run — the default is never accidentally live",
      dry.every((v) => v === false), JSON.stringify(dry));
  }

  {
    /* The window's own line in the only channel out of a run. */
    const had = process.env.GITHUB_ACTIONS;
    process.env.GITHUB_ACTIONS = "true";
    const out = [];
    await loop({ everyMs: 30, forMs: 80, log: (l) => out.push(l),
                 wakeFn: async () => ({ refusals: [] }) });
    if (had === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = had;
    ok("the window says how many times it woke, where we can read it",
      out.some((l) => /^::notice title=the window closed/.test(l)),
      out.filter((l) => l.startsWith("::")).join(" | ").slice(0, 120));
  }

  {
    /* ── THE BUDGET, WHICH IS TEN AND NOT THREE HUNDRED ───────────────────
       GitHub keeps the first ten notices and ten warnings PER STEP and drops
       the rest in silence. A wake emits two of its own, so five uneventful
       wakes spend the whole budget — and since annotations are the only
       channel out of a run this network can read back, the wake four hours in
       that delivered somebody's order would be discarded before it was
       written. The tick has to lose to the event. */
    const had = process.env.GITHUB_ACTIONS;
    process.env.GITHUB_ACTIONS = "true";
    const out = [];
    let i = 0;
    await loop({
      everyMs: 1, forMs: 300, log: (l) => out.push(l),
      wakeFn: async (o) => {
        i++;
        /* What an ordinary wake says: two lines, the same two, every time. */
        o.annotate("notice", "the shop is open", `wake ${i}`, (l) => out.push(l));
        o.annotate("notice", "nothing was written", `wake ${i}`, (l) => out.push(l));
        /* And once, late, the line that is the whole point of the channel. */
        if (i === 12) o.annotate("notice", "what reached the wire", "deliver:ok · reveal:ok", (l) => out.push(l));
        if (i === 13) o.annotate("warning", "1 paid deal(s) did not get their work", "why", (l) => out.push(l));
        return { refusals: [], wrote: i === 12 ? ["deliver:ok", "reveal:ok"] : [], stalled: i === 13 ? ["x"] : [] };
      },
    });
    if (had === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = had;
    const anns = out.filter((l) => l.startsWith("::"));
    ok("many wakes ran, so the budget was genuinely under pressure", i > 20, `${i} wakes`);
    ok("the repeated tick is never annotated at all",
      !anns.some((l) => /title=the shop is open|title=nothing was written/.test(l)),
      anns.length + " annotations for " + i + " wakes");
    ok("and the one wake that wrote something survived", 
      anns.some((l) => /what reached the wire/.test(l)),
      "this is the line the budget existed to lose");
    ok("as did the paid deal that stalled",
      anns.some((l) => /did not get their work/.test(l)));
    ok("inside GitHub's ten-per-step ceiling, with room for the summary",
      anns.filter((l) => l.startsWith("::notice")).length <= 10
      && anns.filter((l) => l.startsWith("::warning")).length <= 10,
      anns.filter((l) => l.startsWith("::notice")).length + " notices, "
        + anns.filter((l) => l.startsWith("::warning")).length + " warnings");
    ok("the closing summary is always written, budget or no budget",
      anns.some((l) => /title=the window closed/.test(l)), anns[anns.length - 1]?.slice(0, 90));
    ok("and it counts what the window actually did, not just that it ran",
      /1 paid deal\(s\) STALLED/.test(anns.find((l) => /the window closed/.test(l)) ?? ""),
      anns.find((l) => /the window closed/.test(l)) ?? "");
    ok("a window with a stalled deal closes at warning, not notice",
      /^::warning title=the window closed/.test(anns.find((l) => /the window closed/.test(l)) ?? ""),
      "somebody paid and got nothing — that is not a notice");
  }

  {
    /* And the workflow actually asks for one. A loop nothing calls is a
       comment. */
    const wf = fs.readFileSync(path.join(ROOT, ".github/workflows/runner.yml"), "utf8");
    ok("the workflow runs the loop", /runner\.mjs --loop/.test(wf));
    ok("after the single wake and the suites, not instead of them",
      wf.indexOf("--loop") > wf.indexOf("test-checkout.mjs"),
      "a red suite must mean no window");
    const windowS = Number(/WAKE_WINDOW_SECONDS: "(\d+)"/.exec(wf)?.[1] ?? 0);
    const timeoutS = Number(/timeout-minutes: (\d+)/.exec(wf)?.[1] ?? 0) * 60;
    ok("the window is shorter than the job timeout", windowS > 0 && windowS < timeoutS,
      `${windowS}s window in a ${timeoutS}s job — otherwise it is killed mid-deal, not ended cleanly`);
    /* ── THE WINDOW IS ALSO HOW LONG WE ARE BLIND ────────────────────────
       MEASURED against a live run: the check-run API reports
       `annotations_count: 0` for a job that has already emitted them.
       Annotations do not exist until the JOB ends — and they are the only
       channel out of a run this network can read, since the log endpoint is
       outside the egress allowlist. So the window length is not only a
       coverage decision, it is how long nobody can find out what the shop
       did. This was five and a half hours when I first wrote it: the same
       blindness as every bug fixed today, bought with a fix for another one.
       Coverage does not need a long window — the concurrency group keeps the
       next run queued behind this one and it starts within seconds. */
    ok("and short enough that a report arrives while the day is still going",
      timeoutS > 0 && timeoutS <= 3600,
      `${timeoutS / 60} minutes — annotations only exist once the job ends`);
    ok("and the loop is passed the same live switch as the single wake",
      /--loop \$\{\{ steps\.mode\.outputs\.live \}\}/.test(wf),
      "an unconditional --live here would post on every dry run");

    /* ── THE CHAIN, WHICH IS DORMANT AND MUST STAY SAFE WHILE IT IS ────────
       MEASURED, 2-4 September: this workflow asks for a wake every five
       minutes and GitHub delivered ELEVEN scheduled runs in three days —
       gaps of 3h11m, 8h38m, 4h56m, 2h24m, 2h45m, 3h24m, 5h10m, 5h27m and
       5h32m. The window covers what happens while a run is alive; it does
       nothing about the hours between one firing and the next, and a buyer
       who has already paid waits through every one of them. */
    ok("a run can ask for the next window, since cron will not",
      /workflows\/runner\.yml\/dispatches/.test(wf),
      "11 scheduled firings in 3 days against a */10 request");
    ok("it does nothing at all without a token, so this is safe to merge now",
      /no RUNNER_CHAIN_TOKEN/.test(wf) && /exit 0/.test(wf));
    ok("a run too short to be real does not ask for another",
      /ELAPSED.*-lt 600|too short to chain/.test(wf), "otherwise a fast failure is a hot loop");
    ok("it fires even when the run failed, which is when it matters most",
      /ask for the next window[\s\S]{0,200}always\(\)/.test(wf));
    ok("the token is never printed", !/echo[^\n]*\$\{?CHAIN_TOKEN/.test(wf));
    ok("and shell tracing is never turned on in that step",
      !/^\s*set -x/m.test(wf), "set -x would put the header in the log");

    /* ── AND THE PART THAT KEEPS THE STOP BUTTON A STOP BUTTON ─────────────
       The successor could simply be dispatched with live=true. That would
       make the PREVIOUS RUN the thing authorising unattended spending, and a
       chain armed by itself is a chain that cannot be stopped from the
       settings page. A chained run asks AUTOPILOT the same question a
       scheduled one does, so turning that variable off still stops
       everything — one field, no commit, no deploy. */
    ok("a chained run does not arm itself",
      !/inputs":\{"chained":"true","live":"true"|"live":true/.test(wf),
      "the chain must not be able to authorise spending");
    ok("it is armed by the repository variable, exactly as a scheduled one is",
      /inputs\.chained \}\}" = "true" \] && \[ "\$AUTOPILOT" = "on" \]/.test(wf),
      "AUTOPILOT off has to stop the chain too, or it is not a stop button");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

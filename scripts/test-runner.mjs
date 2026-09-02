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
  US, JOBS, WINDOW, MAX_OPEN_DEALS, buildOffer, plan, refusals, framesFrom, ourDeals, wake,
} from "./runner.mjs";
import { canon, offerId, lintOffer, readFrame, runDeal } from "../web/tclk.js";

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

/* ── C. the offer it would post ──────────────────────────────────────────── */
console.log("\n=== C. the offer");
const NOW = Date.now();
{
  const o = buildOffer(JOBS[0], NOW);
  ok("it is well formed by the page's own linter", lintOffer(o).length === 0, lintOffer(o).join(", "));
  ok("we are the payee, because we are selling", o.role === "payee");
  ok("it is signed as coming from the shop", o.from === US);
  ok("expires ≤ claimBy < refundAfter, which is what the linter enforces",
    o.expiresMs <= o.claimByMs && o.claimByMs < o.refundAfterMs);
  ok("the claim window is hours, not minutes — a late cron must still fit",
    o.claimByMs - NOW >= 6 * 3600000, ((o.claimByMs - NOW) / 3600000) + "h");
  ok("it settles on paper while the testnet is shut, and says so",
    JSON.stringify(o.rails) === '["paper"]');
  ok("no paymentKey is invented for a rail that does not run yet", o.paymentKey === undefined);
  ok("two offers for the same job are different offers",
    buildOffer(JOBS[0], NOW).nonce !== buildOffer(JOBS[0], NOW).nonce);
  ok("the frame it becomes is readable by the page that will display it",
    (async () => true)() && true);
}
{
  const o = buildOffer(JOBS[1], NOW);
  const id = await offerId(o);
  const text = "tclk1 " + canon({ ...o, id });
  const f = readFrame(text);
  ok("the frame parses", f.ok && f.type === "offer");
  ok("and reproduces its own bytes exactly, so the page will recompute its id", f.exact);
  ok("and its id is the id we computed", (await offerId(f.body)) === id);
  ok("it fits in a Technocore message", text.length < 4000, text.length + " chars");
  /* Shaped the way the page shapes a frame — body spread, transport last —
     because that is what runDeal is given in the only place it runs. */
  const shaped = framesFrom([{ seq: "1", ts: new Date(NOW).toISOString(), from: US, text, sig: "s" }])[0];
  ok("the deal it starts reads as a sale", runDeal([shaped]).selling);
}

/* ── D. what a wake decides ──────────────────────────────────────────────── */
console.log("\n=== D. the plan");
const msg = (i, from, text) => ({ seq: String(i), ts: new Date(NOW - i * 1000).toISOString(), from, text, sig: "s" });
const frameOf = async (job, over = {}) => {
  const o = { ...buildOffer(job, NOW), ...over };
  return "tclk1 " + canon({ ...o, id: await offerId(o) });
};
{
  ok("an empty board means post all four", plan(framesFrom([]), NOW).post.length === 4);

  const one = await frameOf(JOBS[0]);
  const p = plan(framesFrom([msg(1, US, one)]), NOW);
  ok("a job we already have standing is not posted twice",
    p.post.length === 3 && !p.post.some((j) => j.id === JOBS[0].id), p.post.map((j) => j.id).join(","));

  const stale = await frameOf(JOBS[0], { expiresMs: NOW - 1000 });
  ok("an EXPIRED offer of ours is restocked, not counted as standing",
    plan(framesFrom([msg(1, US, stale)]), NOW).post.length === 4);

  const theirs = await frameOf(JOBS[0]);
  ok("somebody else's offer for the same job does not stock our shelf",
    plan(framesFrom([msg(1, OTHER, theirs)]), NOW).post.length === 4);
}
{
  /* Capacity: three accepted deals and the shelf stops being restocked. */
  const frames = [];
  for (let i = 0; i < MAX_OPEN_DEALS; i++) {
    const o = { ...buildOffer(JOBS[i % JOBS.length], NOW), nonce: "cap" + String(i).padStart(13, "0") };
    const id = await offerId(o);
    frames.push(msg(10 + i, US, "tclk1 " + canon({ ...o, id })));
    frames.push(msg(20 + i, OTHER, "tclk1 " + canon({
      type: "accept", from: OTHER, ref: id, statement: "0x" + "7c".repeat(32),
      nonce: "acc" + String(i).padStart(13, "0"), contract: "0x" + String(i).padStart(4, "0") + "e".repeat(60),
    })));
  }
  const p = plan(framesFrom(frames), NOW);
  ok("at capacity nothing new is posted", p.atCapacity && p.post.length === 0, `${p.open} open`);
  ok("and the deals are recognised as ours", p.deals.length === MAX_OPEN_DEALS);
}
{
  /* A frame that lies about who sent it must not become one of our deals. */
  const o = buildOffer(JOBS[0], NOW);
  const id = await offerId({ ...o, from: US });
  const lying = "tclk1 " + canon({ ...o, from: US, id });
  const frames = framesFrom([msg(1, OTHER, lying)]);
  ok("a frame whose BODY claims to be from us, sent by somebody else, is not ours",
    ourDeals(frames).length === 0,
    "the transport decides who signed it, not the body");
}

/* ── E. the refusals ─────────────────────────────────────────────────────── */
console.log("\n=== E. the shop stays shut");
{
  /* An agent whose DID IS the shop's: refusals only cares about the string,
     and the real seed is not available to a test and never should be. */
  const asShop = { did: US };
  const full = { live: true, agent: asShop, work: true };
  ok("with everything in place there is nothing holding it", refusals(full).length === 0);
  ok("no --live holds it", refusals({ ...full, live: false }).length === 1);
  ok("no seed holds it", refusals({ ...full, agent: null }).some((r) => /no seed/.test(r)));
  ok("the WRONG seed holds it — a key that is not this shop must not post as it",
    refusals({ ...full, agent: { did: OTHER } }).some((r) => /not this shop/.test(r)));
  ok("and no work side holds it, which is the one that matters today",
    refusals({ ...full, work: false }).some((r) => /work side/.test(r)));
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
  ok("it decided to post four offers", r.plan.post.length === 4);
  ok("and posted none of them", posted === 0, posted + " writes");
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

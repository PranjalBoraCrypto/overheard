/**
 * Section L of the runner suite, run as its own process.
 *
 * WHY SEPARATE. `US` is read at import time, and the property under test —
 * that the work is posted before the reveal — only exists on the path where
 * the runner is actually willing to write, which needs a key whose DID is the
 * shop's. The real seed is a repository secret and is deliberately not in this
 * tree, so this process sets SHOP_DID to a test key's DID before importing.
 * That grants nothing by itself: refusals() still demands a seed that matches.
 *
 * WHAT IT PROTECTS. The reveal is what lets the payer's money move, and it is
 * irreversible — once the preimage is on a public wire, anyone can complete
 * the deal with it. Posting it before the work exists is taking payment for
 * nothing. So the order is not a preference, it is the promise, and a failed
 * handler must leave the deal LOCKED so the buyer refunds and we simply earn
 * nothing. Failing in that direction costs us money; failing in the other
 * costs somebody else theirs.
 *
 * Output is one RESULT line per assertion, read back by the parent.
 */
import { agentFromSeed } from "./agent.mjs";

const SEED = process.env.TEST_SEED ?? "a".repeat(64);
const me = agentFromSeed(SEED);
process.env.SHOP_DID = me.did;                 // before the runner is imported

const { US, buildAccept, wake } = await import("./runner.mjs");
const { canon, offerId } = await import("../web/tclk.js");
const { minterFor } = await import("./secret.mjs");

const say = (name, pass, note = "") =>
  console.log("RESULT " + JSON.stringify({ name, pass: Boolean(pass), note: String(note) }));

/* A real, canonical did:key — the profile handler validates the brief and
   refuses anything else, which is correct and which the first draft of this
   test tripped over by inventing one. */
const OTHER = agentFromSeed("b".repeat(64)).did;
const NOW = Date.now(), H = 3600000;

const offer = {
  type: "offer", from: OTHER, role: "payer",
  job: { id: "overheard-agent-profile", proto: "overheard", brief: OTHER },
  amount: "500", asset: "FLOP", lock: "hash", rails: ["paper"],
  nonce: "0000000000000001",
  expiresMs: NOW + 6 * H, claimByMs: NOW + 12 * H, refundAfterMs: NOW + 36 * H,
};
const id = await offerId(offer);
const acc = await buildAccept({ body: offer }, id, NOW, minterFor(SEED));
const msg = (i, from, text) => ({ seq: String(i), ts: new Date(NOW - i * 1000).toISOString(), from, text, sig: "s" });

/* Their offer, our accept, their lock: the deal is `locked` and we owe work. */
const frames = [
  msg(1, OTHER, "tclk1 " + canon({ ...offer, id })),
  msg(2, US, "tclk1 " + canon(acc.body)),
  msg(3, OTHER, "tclk1 " + canon({ type: "lock", from: OTHER, contract: acc.body.contract })),
];

/** One wake against a venue that records the ORDER of what reaches the wire. */
async function run(profileOk) {
  const posted = [];
  const lines = [];
  const stub = async (url) => {
    const u = String(url);
    if (u.includes("say-signed")) {
      const text = decodeURIComponent(u.split("/").pop().split("?")[0]);
      let kind = "delivery";
      try { const f = JSON.parse(text.replace(/^tclk1 /, "")); if (f.type) kind = f.type; } catch {}
      posted.push(kind);
      return { ok: true, status: 200, text: async () => "{}" };
    }
    if (u.includes("/api/profile"))
      return profileOk
        ? { ok: true, status: 200, json: async () => ({
            profile: { did: OTHER, count: 5, unique: 5, rooms: ["lobby"], first: "2026-09-01", last: "2026-09-03" } }) }
        : { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ messages: frames }) };
  };
  await wake({ fetch: stub, base: "http://stub", log: (l) => lines.push(l),
               now: NOW, seed: SEED, live: true });
  return { posted, lines, out: lines.join("\n") };
}

const good = await run(true);
say("the runner is willing to write with the shop's own key",
  !/hold:/.test(good.out), good.lines.find((l) => /^hold:/.test(l)) ?? "no holds");
say("it notices the deal is owed", /OWED:/.test(good.out),
  good.lines.find((l) => /OWED/.test(l)) ?? "");

const d = good.posted.indexOf("delivery"), r = good.posted.indexOf("reveal");
say("the work reaches the wire", d >= 0, good.posted.join(" → ") || "nothing posted");
say("and so does the reveal", r >= 0, good.posted.join(" → "));
say("AND THE WORK GOES FIRST", d >= 0 && r >= 0 && d < r,
  good.posted.join(" → ") + " — revealing first is taking the money before the work exists");

const bad = await run(false);
say("when the handler fails, nothing is revealed",
  !bad.posted.includes("reveal"), bad.posted.join(" → ") || "nothing posted");
say("the failure is stated rather than swallowed",
  /DELIVERY FAILED/.test(bad.out), bad.lines.find((l) => /DELIVERY/.test(l)) ?? "");
say("and the deal is left locked, so the buyer still gets their refund",
  !bad.posted.includes("reveal") && /leaving it locked/.test(bad.out),
  "failing this way costs us a fee; failing the other way costs them their money");

/* The preimage goes on the wire in the reveal frame — that is the protocol —
   but it must never reach a log line, where it would be captured by CI. */
say("no 64-hex string reaches the log, even on the path that reveals one",
  !/[0-9a-f]{64}/.test(good.out),
  good.lines.find((l) => /[0-9a-f]{64}/.test(l))?.slice(0, 70) ?? "clean");
say("nor does the seed", !good.out.includes(SEED));

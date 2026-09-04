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

/* ── AN ORDER NOBODY CAN EVER FILL ────────────────────────────────────────
   Same shape, but the brief is not a did:key, so profileAgent answers with a
   permanent refusal rather than a transient one. This is what a buyer typing
   nonsense into their own agent produces, and on 4 September somebody did
   exactly that with a room name — `lobbygsgfguututu455` — and the wake
   retried it fifty times in fifty minutes while the buyer watched a locked
   payment with no explanation anywhere. */
const badOffer = { ...offer, nonce: "0000000000000002", job: { ...offer.job, brief: "not-a-did-at-all" } };
const badId = await offerId(badOffer);
const badAcc = await buildAccept({ body: badOffer }, badId, NOW, minterFor(SEED));
const badFrames = [
  msg(1, OTHER, "tclk1 " + canon({ ...badOffer, id: badId })),
  msg(2, US, "tclk1 " + canon(badAcc.body)),
  msg(3, OTHER, "tclk1 " + canon({ type: "lock", from: OTHER, contract: badAcc.body.contract })),
];

/** One wake against a venue that records the ORDER of what reaches the wire. */
async function run(profileOk, useFrames = frames, mod = null) {
  const posted = [];
  const texts = [];
  const lines = [];
  const stub = async (url) => {
    const u = String(url);
    if (u.includes("say-signed")) {
      const text = decodeURIComponent(u.split("/").pop().split("?")[0]);
      let kind = "delivery";
      try { const f = JSON.parse(text.replace(/^tclk1 /, "")); if (f.type) kind = f.type; } catch {}
      posted.push(kind);
      texts.push(text);
      return { ok: true, status: 200, text: async () => "{}" };
    }
    if (u.includes("/api/profile"))
      return profileOk
        ? { ok: true, status: 200, json: async () => ({
            profile: { did: OTHER, count: 5, unique: 5, rooms: ["lobby"], first: "2026-09-01", last: "2026-09-03" } }) }
        : { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ messages: useFrames }) };
  };
  const w = mod?.wake ?? wake;
  const r = await w({ fetch: stub, base: "http://stub", log: (l) => lines.push(l),
                      now: NOW, seed: SEED, live: true });
  return { posted, lines, texts, out: lines.join("\n"), wrote: r.wrote ?? [], stalled: r.stalled ?? [] };
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

/* ── THE HALF OF THE SHOP THAT MOVES MONEY WAS NOT BEING COUNTED ──────────
 * `wrote` exists so that a run which posted nothing cannot look like a run
 * which posted everything, and the annotation built from it is the only
 * channel out of a wake this network can read. It was wired up to exactly two
 * writes — accepts and cancels — because those go through post(); deliveries,
 * reveals, locks and refunds go through settle(), which reports to a CI log
 * we are not allowed to download.
 *
 * MEASURED, on the first real order this shop ever delivered: the wake posted
 * the work and the reveal and annotated itself `nothing was written — 1 owed`.
 * I read that as a failure to deliver and went looking for a bug in the
 * delivery path. There wasn't one. The bug was in the sentence.
 */
say("a delivery is counted as a write", good.wrote.some((w) => w.startsWith("deliver:")),
  good.wrote.join(" · ") || "nothing counted");
say("and so is the reveal", good.wrote.some((w) => w.startsWith("reveal:")),
  good.wrote.join(" · ") || "nothing counted");
say("so the wake cannot report 'nothing was written' having delivered",
  good.wrote.length > 0,
  "this is the exact sentence a real paid order produced while it worked");
say("nothing it counted is marked failed on the happy path",
  !good.wrote.some((w) => w.includes("FAILED")), good.wrote.join(" · "));

/* ── AND A PAID DEAL THAT DID NOT MOVE SAYS SO, LOUDLY ────────────────────
 * Every exit from the delivery loop was a log() line, so "somebody's money is
 * locked and they got nothing, and here is why" was unreadable from outside.
 */
say("a failed delivery is recorded as a stalled deal, not only logged",
  bad.stalled.length === 1, JSON.stringify(bad.stalled));
say("and the reason travels with it",
  /DELIVERY FAILED/.test(bad.stalled[0] ?? ""), bad.stalled[0] ?? "");
say("it names the job, so a reader knows which one",
  /overheard-agent-profile/.test(bad.stalled[0] ?? ""), bad.stalled[0] ?? "");
say("a wake that delivered everything reports no stalls",
  good.stalled.length === 0, JSON.stringify(good.stalled));
/* Annotations are emitted only inside Actions, which is the one place this
   has to work, so the run that proves it is made there. */
process.env.GITHUB_ACTIONS = "true";
const inCI = await run(false);
delete process.env.GITHUB_ACTIONS;
say("the stall is annotated, because a log line is not readable from here",
  inCI.lines.some((l) => /^::warning/.test(l) && /did not get their work/.test(l)),
  inCI.lines.filter((l) => l.startsWith("::")).join(" | ").slice(0, 200));
say("at warning level, not notice — it is the one line that must not be scrolled past",
  inCI.lines.some((l) => /^::warning title=1 paid deal/.test(l)),
  inCI.lines.filter((l) => l.startsWith("::")).map((l) => l.split("::")[1]).join(" | "));
say("and the annotation carries no 64-hex string either",
  !inCI.lines.filter((l) => l.startsWith("::")).some((l) => /[0-9a-f]{64}/.test(l)));
say("and no preimage rides along in it", !/[0-9a-f]{64}/.test(bad.stalled.join(" ")),
  bad.stalled.join(" "));

/* ══════════════════════════════════════════════════════════════════════════
 * AN ORDER THAT CAN NEVER BE FILLED
 *
 * MEASURED, 4 September: somebody ordered a summary of `lobbygsgfguututu455`.
 * The shop accepted it, took the lock, failed the delivery, correctly refused
 * to reveal — and then did all of that again on every wake for fifty minutes.
 * Fifty attempts, every one certain to fail for the identical reason, six of
 * the eight warning slots GitHub keeps spent on the same sentence, and a
 * buyer watching a locked payment for thirty-six hours with the reason
 * written nowhere they could see it.
 *
 * The money was never at risk — no reveal, no claim — and that is not the
 * same as this being handled.
 * ═════════════════════════════════════════════════════════════════════════*/
const bad1 = await run(true, badFrames);
/* The give-up note is itself a plain message, so counting "any plain post" as
   a delivery would fail this for the wrong reason. What must not exist is a
   post that is neither a frame nor that note — that would be work delivered
   for an order nothing can fill. */
const isNote = (t) => /^Overheard cannot deliver this order/.test(t);
const workPosts = bad1.texts.filter((t) => !t.startsWith("tclk1 ") && !isNote(t));
say("an order it cannot fill produces no work", workPosts.length === 0,
  workPosts.join(" | ").slice(0, 120) || "nothing but the explanation");
say("and is certainly not revealed", !bad1.posted.includes("reveal"),
  "revealing here is claiming payment for work that does not exist");
say("the buyer is told why, in the deal's own room where they are looking",
  bad1.texts.some((t) => /Overheard cannot deliver this order/.test(t)),
  bad1.texts.join(" | ").slice(0, 140) || "nothing said to them at all");
say("with the actual reason, not a shrug",
  bad1.texts.some((t) => /not a canonical did:key/.test(t)),
  bad1.texts.find((t) => /cannot deliver/.test(t))?.slice(0, 160) ?? "");
say("and told plainly that no money was taken",
  bad1.texts.some((t) => /No payment has been taken/.test(t)));
say("and that the escrow returns it by itself",
  bad1.texts.some((t) => /returns it to you at the refund deadline/.test(t)),
  "a buyer who thinks they must chase us is a buyer we have cost more than the fee");
say("the note is counted as a write", bad1.wrote.some((w) => w.startsWith("cannot-deliver:")),
  bad1.wrote.join(" · "));
say("and the run says a paid deal did not get its work",
  bad1.stalled.some((x) => /CANNOT BE DELIVERED/.test(x)), JSON.stringify(bad1.stalled));

/* ── AND THEN IT STOPS ─────────────────────────────────────────────────────
   Fifty wakes in a window. The answer does not change between them. */
const bad2 = await run(true, badFrames);
say("a second wake does not tell them again",
  !bad2.texts.some((t) => /cannot deliver this order/i.test(t)),
  bad2.texts.join(" | ").slice(0, 120) || "silent, correctly");
/* The buy side still runs, and should — it is a different half of the shop.
   What must not repeat is anything about THIS deal. */
say("and posts nothing about that deal at all",
  bad2.texts.every((t) => t.startsWith("tclk1 ") && /"type":"offer"/.test(t)),
  bad2.texts.map((t) => t.slice(0, 40)).join(" | ") || "nothing");

/* ── THE DISTINCTION THAT MAKES THIS SAFE ──────────────────────────────────
   A 503 from the archive is a bad minute, not an answer. Treating the two the
   same would mean one flaky read permanently abandoning a deal we could have
   delivered — which costs the buyer their work and us the fee. */
const flaky = await import("./runner.mjs?flaky=" + Math.random());
const t1 = await run(false, frames, flaky);
const t2 = await run(false, frames, flaky);
say("a transient failure is NOT treated as final",
  /DELIVERY FAILED/.test(t1.out) && /DELIVERY FAILED/.test(t2.out),
  "the second wake must still try — a bad minute is not an answer");
say("and no give-up note is posted for one",
  !t1.texts.some((t) => /cannot deliver this order/i.test(t))
  && !t2.texts.some((t) => /cannot deliver this order/i.test(t)),
  "telling a buyer we cannot do it because the archive blinked would be a lie");

/* ── AND THE ANNOTATION BUDGET, WHICH IS EIGHT ─────────────────────────────
   Six identical warnings for one order is six slots spent saying one thing. */
say("the same stall is not reported twice in one wake",
  new Set(bad1.stalled).size === bad1.stalled.length, JSON.stringify(bad1.stalled));

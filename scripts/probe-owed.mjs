/**
 * Why has a paid deal not been delivered?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 *
 * Every wake for at least nine hours has reported the same two things at
 * once: `1 owed` and `nothing was written`. `owed` means a buyer has locked
 * payment and is waiting on work. So somebody has paid, nothing has been
 * produced, and the wake's own stall annotation — the one designed to say
 * exactly why — has not appeared either. Whatever is happening is happening
 * somewhere the existing channels do not reach.
 *
 * This asks the question directly. It performs the SAME read the wake does,
 * in the same order, using the wake's own exported functions rather than a
 * reimplementation — a probe that agrees with a copy of the logic proves
 * nothing about the logic that is running. Then, for every owed deal, it
 * walks the delivery guards in the order wake() walks them and prints the
 * first one that says no.
 *
 * IT READS AND NEVER WRITES. There is no seed in the job that runs it, so it
 * cannot sign, so it cannot post. It calls nothing that posts.
 *
 * ── WHAT IT WILL NOT PRINT ────────────────────────────────────────────────
 * No frame bodies and no secrets. A reveal frame carries the preimage, which
 * is the thing that lets money move; annotate() scrubs any 64-hex run as a
 * last resort, and this file does not hand it one in the first place.
 */
import {
  US, MAX_OPEN_DEALS, readOffers, ourArchive, mergeBySeq, framesFrom,
  plan, readAnyRoom, annotate, WINDOW,
} from "./runner.mjs";
import { safeRoom } from "./buy.mjs";
import { verifyLock, RAIL } from "./rail.mjs";
import { CAN_DO, doJob } from "./work.mjs";

const now = Date.now();
const ago = (t) => (t ? `${Math.round((now - t) / 3.6e6 * 10) / 10}h ago` : "unknown");
const short = (c) => (c ? String(c).slice(0, 10) + "…" : "none");

/* ── the wake's read, step for step ──────────────────────────────────────── */

const fresh = await readOffers({});
let mine = [], archiveOk = true;
try { mine = await ourArchive(US, {}); } catch { archiveOk = false; }
let frames = framesFrom(mergeBySeq(fresh, mine));
let p = plan(frames, now);

console.log(`board: ${fresh.length} live messages · ${mine.length} of ours from the archive`
  + (archiveOk ? "" : "  ARCHIVE UNREADABLE"));

/* The locks are not in tclk-offers. Same second read the wake does, same
   newest-first order, same cap — because a probe that reads a different set
   of rooms answers a different question. */
const waiting = p.deals
  .filter((d) => d.deal.state === "accepted" && d.accept?.from === US)
  .sort((a, b) => (b.accept?.seq ?? 0) - (a.accept?.seq ?? 0));
const extra = [];
for (const d of waiting.slice(0, MAX_OPEN_DEALS)) {
  const room = safeRoom(d.accept.body?.contract);
  if (!room) continue;
  try { extra.push(...framesFrom(await readAnyRoom(room, {}))); }
  catch { console.log(`  could not read the deal room for ${d.offer.body?.job?.id}`); }
}
if (extra.length) { frames = frames.concat(extra); p = plan(frames, now); }

const states = {};
for (const d of p.deals) states[d.deal.state] = (states[d.deal.state] ?? 0) + 1;
console.log(`ours:  ${p.deals.length} deals · ${JSON.stringify(states)} · ${p.owed.length} owed`);
annotate("notice", "the book", `${p.deals.length} deals of ours · ${JSON.stringify(states)}`
  + ` · ${p.owed.length} owed · rail ${RAIL}`);

/* ── and the question ────────────────────────────────────────────────────── */

if (!p.owed.length) {
  annotate("notice", "nothing is owed", "no deal is in the locked state right now");
  console.log("nothing owed.");
  process.exit(0);
}

const found = [];
for (const d of p.owed) {
  const job = d.offer.body?.job?.id;
  const contract = d.accept?.body?.contract;
  const lockRail = d.lock?.body?.rail ?? d.lock?.rail ?? null;
  const lockedAt = d.lock?.at ?? null;
  const acceptedAt = d.accept?.at ?? null;
  /* When the buyer stops waiting and simply takes their money back. Worth
     printing next to the reason: a stall that resolves itself in an hour and
     a stall that has already outlived its refund window are different
     problems wearing the same words. */
  const refundAt = acceptedAt ? acceptedAt + WINDOW.refundAfter : null;

  console.log(`\nOWED  ${job}  contract ${short(contract)}`);
  console.log(`  buyer          ${d.offer.from === US ? "(we posted the offer)" : d.offer.from}`);
  console.log(`  accepted       ${ago(acceptedAt)}`);
  console.log(`  locked         ${ago(lockedAt)}`);
  console.log(`  lock names     ${lockRail ?? "no rail on the lock frame"}   (this shop settles on ${RAIL})`);
  console.log(`  refund due     ${refundAt ? new Date(refundAt).toISOString() : "unknown"}`
    + (refundAt && refundAt < now ? "   ALREADY PAST" : ""));

  /* The guards, in wake()'s order. The FIRST no is the answer; the rest are
     printed anyway, because "it also would have failed here" is the
     difference between one fix and three. */
  const reasons = [];
  if (!CAN_DO.has(job)) reasons.push(`nothing here can deliver "${job}" — it should never have been accepted`);
  const proof = await verifyLock({ rail: lockRail ?? RAIL, contract, offer: d.offer, accept: d.accept, lock: d.lock });
  if (!proof.ok) reasons.push(`the lock is not evidence: ${proof.why}`);
  if (!d.accept?.body?.statement) reasons.push("the accept carries no statement, so no secret can be checked against it");

  if (reasons.length) {
    console.log(`  WHY IT STALLS  ${reasons[0]}`);
    for (const r of reasons.slice(1)) console.log(`  and also        ${r}`);
    found.push(`${job}: ${reasons[0]}`);
    continue;
  }

  /* ── PAST WHERE THE FIRST VERSION OF THIS PROBE COULD SEE ────────────────
     Every guard the wake checks BEFORE doing the work says deliver. So the
     answer is inside the work itself, and the only honest way to get it is
     to run the handler. doJob reads the archive and returns a document; it
     signs nothing and posts nothing, which is why a probe with no seed may
     call it. A room summary was measured at 829 ms.

     `permanent` is the field that matters. work.mjs separates a bad minute
     from an answer: a bad minute is retried, an ANSWER means no amount of
     waiting will produce this document, and the wake tells the buyer once
     and then leaves the deal alone until it refunds. */
  const brief = d.offer.body?.job?.brief ?? d.offer.body?.job?.subject ?? "";
  console.log(`  brief          ${JSON.stringify(String(brief).slice(0, 120))}`);
  let done;
  try { done = await doJob(job, brief, {}); }
  catch (e) { done = { ok: false, permanent: false, why: `the handler threw: ${String(e?.message || e).slice(0, 120)}` }; }
  console.log(`  handler        ok=${done.ok} permanent=${Boolean(done.permanent)}`);
  if (!done.ok) console.log(`  handler says   ${done.why}`);

  /* ── AND WHETHER THE BUYER WAS EVER TOLD ─────────────────────────────────
     This is the difference between a shop that quietly ate an order and a
     shop that declined it out loud. On a permanent failure the wake posts one
     note into the deal room and then goes silent — deliberately, to avoid
     eighty-six copies of the same sentence over a refund window. The silence
     afterwards is correct; being unable to tell it apart from a stall is not,
     which is the whole reason this probe exists. */
  let told = "the deal room could not be read";
  const room = safeRoom(contract);
  if (room) {
    try {
      const msgs = await readAnyRoom(room, {});
      const note = msgs.find((m) => m?.from === US && /^Overheard cannot deliver this order/.test(String(m.text ?? "")));
      told = note ? `yes — told at ${note.ts ?? "unknown time"}` : "NO — the buyer has not been told anything";
      console.log(`  room           ${room} · ${msgs.length} messages`);
    } catch { /* left as the default */ }
  }
  console.log(`  buyer told     ${told}`);

  if (!done.ok && done.permanent) {
    found.push(`${job}: cannot ever be delivered — ${done.why} · buyer ${told.startsWith("yes") ? "was told" : "NOT TOLD"}`);
  } else if (!done.ok) {
    found.push(`${job}: the handler failed but says it is temporary — ${done.why}`);
  } else {
    found.push(`${job}: the handler PRODUCED the work — nothing explains why it was not delivered`);
  }
}

annotate("warning", `${p.owed.length} paid deal(s) waiting`, found.slice(0, 3).join(" · "));
for (const d of p.owed.slice(0, 2))
  annotate("notice", "the deal", `${d.offer.body?.job?.id} · contract ${d.accept?.body?.contract ?? "?"}`
    + ` · accepted ${ago(d.accept?.at)}`
    + ` · refund due ${d.accept?.at ? new Date(d.accept.at + WINDOW.refundAfter).toISOString() : "?"}`
    + (d.accept?.at && d.accept.at + WINDOW.refundAfter < now ? " (ALREADY PAST)" : ""));

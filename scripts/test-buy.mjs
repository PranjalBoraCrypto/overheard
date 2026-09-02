/**
 * Buying, which is the first thing in this project that can commit money.
 *
 * So the tests are almost entirely about what it will NOT do. The order of
 * danger, worst first:
 *
 *   · locking against an accept that is not answering our offer, or that we
 *     sent ourselves, or whose contract is not a contract — the lock is the
 *     step where funds are committed and everything about it is derived from
 *     a frame a stranger wrote;
 *   · locking the same deal twice;
 *   · refunding before the deadline we set, which is trying to take back
 *     money somebody may still be working for;
 *   · posting more offers than the cap, or a second offer for something we
 *     already have standing.
 *
 * Nothing here touches the network. planBuys is pure, so every refusal is a
 * function call and there is no stub to be wrong about.
 */
import { canon, offerId, dealRoom, runDeal } from "../web/tclk.js";
import {
  WANTS, MAX_OPEN_BUYS, BUY_WINDOW, buildWant, ourBuys, planBuys,
  lockFrame, refundFrame, wantFrame, revealHeldUp, wire,
} from "./buy.mjs";
import { createHash, randomBytes } from "node:crypto";

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

const US = "did:key:z6MkiuhfekPgiihLWarPAzhuvoMjg86F8dqmLiCTmtQgMrR3";
const SELLER = "did:key:z6MkSellerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "did:key:z6MkStrangerZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
const NOW = Date.now();

/* A real hash lock: the seller's secret, and the statement it opens. */
const SECRET = "0x" + randomBytes(32).toString("hex");
const STATEMENT = "0x" + createHash("sha256").update(SECRET, "utf8").digest("hex");

const msg = (i, from, text) => ({ seq: String(i), ts: new Date(NOW - i * 1000).toISOString(), from, text, sig: "s" });

/* framesFrom, in the shape the runner produces: body spread, transport last. */
const framesOf = (list) => list.map((m) => {
  const body = JSON.parse(m.text.slice(6));
  return { ok: true, ...body, body, type: body.type, from: m.from,
           at: Date.parse(m.ts), raw: m.text, seq: Number(m.seq) };
});

async function ourOffer(want, over = {}) {
  const body = { ...buildWant(want, US, NOW), ...over };
  const id = await offerId(body);
  return { body: { ...body, id }, text: wire({ ...body, id }), id };
}

const acceptOf = (ref, contract, from = SELLER, extra = {}) => wire({
  type: "accept", from, ref, statement: STATEMENT, nonce: "acc" + "0".repeat(13),
  contract, ...extra,
});

/* ── A. the offer we would post ──────────────────────────────────────────── */
console.log("\n=== A. what we are asking for");
{
  const b = buildWant(WANTS[0], US, NOW);
  ok("we are the payer, because we are buying", b.role === "payer");
  ok("it comes from the shop", b.from === US);
  ok("the brief says what done means", (b.job.context || "").length > 40, b.job.context.slice(0, 50) + "…");
  ok("and where to put the work", /in this deal's room/i.test(b.job.context));
  ok("the window is longer than the selling one, because a stranger has to write it",
    BUY_WINDOW.claimBy >= 24 * 3600000, (BUY_WINDOW.claimBy / 3600000) + "h");
  ok("expires ≤ claimBy < refundAfter", b.expiresMs <= b.claimByMs && b.claimByMs < b.refundAfterMs);
  ok("it settles on paper while the testnet is shut", JSON.stringify(b.rails) === '["paper"]');
  const w = await wantFrame(WANTS[0], US, NOW);
  ok("the frame fits in a Technocore message", w.text.length < 4000, w.text.length + " chars");
}

/* ── B. only ours, and only answers to ours ──────────────────────────────── */
console.log("\n=== B. whose deal is this");
{
  const mine = await ourOffer(WANTS[0]);
  const theirs = await ourOffer(WANTS[1], { from: OTHER });

  const f = framesOf([msg(1, US, mine.text), msg(2, OTHER, theirs.text)]);
  ok("somebody else's payer offer is not one of our buys", ourBuys(f, US).length === 1);

  /* A sale of ours is not a purchase of ours. */
  const selling = wire({ ...buildWant(WANTS[0], US, NOW), role: "payee", id: "0x" + "9".repeat(64) });
  ok("our own SELLING offer is not counted as a buy",
    ourBuys(framesOf([msg(1, US, selling)]), US).length === 0);

  /* The transport decides who sent a frame, never the body. */
  const liar = wire({ ...buildWant(WANTS[0], US, NOW), id: "0x" + "8".repeat(64) });
  ok("a frame whose body claims to be from us, sent by a stranger, is not ours",
    ourBuys(framesOf([msg(1, OTHER, liar)]), US).length === 0,
    "the body said from: us");
}

/* ── C. the lock, which is where money moves ─────────────────────────────── */
console.log("\n=== C. what it will and will not fund");
{
  const mine = await ourOffer(WANTS[0]);
  const CID = "0x" + "1a".repeat(32);
  const room = dealRoom(CID);

  const good = framesOf([msg(1, US, mine.text), msg(2, SELLER, acceptOf(mine.id, CID))]);
  const p = planBuys(good, new Map(), US, NOW);
  ok("an accept on our offer is something to fund", p.lock.length === 1);
  ok("and it is placed in the room the contract names", p.lock[0].room === room, String(p.lock[0].room));
  ok("while it is open, we do not post that want again",
    !p.want.some((w) => w.id === WANTS[0].id), p.want.map((w) => w.id).join(",") || "none");

  const lf = lockFrame(US, CID);
  ok("the lock says it is from us", lf.from === US);
  ok("on a rail the offer named", lf.rail === "paper");
  ok("and the deal advances when it lands",
    runDeal([...good, ...framesOf([msg(3, US, wire(lf))])]).state === "locked");

  /* Already funded: the second wake must not fund it again. */
  const locked = new Map([[room, framesOf([msg(3, US, wire(lf))])]]);
  ok("a deal already locked is not locked a second time",
    planBuys(good, locked, US, NOW).lock.length === 0);

  /* An accept that answers somebody else's offer. */
  const foreign = framesOf([msg(1, US, mine.text), msg(2, SELLER, acceptOf("0x" + "f".repeat(64), CID))]);
  ok("an accept that does not answer our offer funds nothing",
    planBuys(foreign, new Map(), US, NOW).lock.length === 0);

  /* Our own accept. Nobody accepts their own offer, and a lock derived from
     one would be us paying ourselves — which is the shape of exactly the
     behaviour any airdrop rule would filter out. */
  const selfDeal = framesOf([msg(1, US, mine.text), msg(2, US, acceptOf(mine.id, CID, US))]);
  ok("an accept from ourselves funds nothing",
    planBuys(selfDeal, new Map(), US, NOW).lock.length === 0, "no paying ourselves");

  /* A contract that is not a contract: no room, so nothing to fund. */
  for (const bad of ["../../etc/passwd", "", "not-hex", null]) {
    const junk = framesOf([msg(1, US, mine.text), msg(2, SELLER, acceptOf(mine.id, bad ?? undefined))]);
    ok(`an accept naming ${JSON.stringify(bad)} as its contract funds nothing`,
      planBuys(junk, new Map(), US, NOW).lock.length === 0);
  }
}

/* ── D. the refund, and the temptation to take it early ──────────────────── */
console.log("\n=== D. taking it back");
{
  const mine = await ourOffer(WANTS[0]);
  const CID = "0x" + "2b".repeat(32);
  const room = dealRoom(CID);
  const base = framesOf([msg(1, US, mine.text), msg(2, SELLER, acceptOf(mine.id, CID))]);
  const rooms = new Map([[room, framesOf([msg(3, US, wire(lockFrame(US, CID)))])]]);

  const early = planBuys(base, rooms, US, NOW);
  ok("before the deadline, a locked deal is waited on, not refunded",
    early.refund.length === 0 && early.waiting.length === 1);

  const after = mine.body.refundAfterMs + 1000;
  const late = planBuys(base, rooms, US, after);
  ok("after the deadline with no reveal, it is refunded", late.refund.length === 1);
  const rf = refundFrame(US, CID);
  ok("the refund is ours and names the contract", rf.from === US && rf.contract === CID);
  ok("and says why", /no reveal/.test(rf.reason));

  /* They delivered. Nothing to take back, at any hour. */
  const revealed = new Map([[room, framesOf([
    msg(3, US, wire(lockFrame(US, CID))),
    msg(4, SELLER, wire({ type: "reveal", from: SELLER, contract: CID, secret: SECRET })),
  ])]]);
  const done = planBuys(base, revealed, US, after);
  ok("a deal they claimed is never refunded", done.refund.length === 0 && done.waiting.length === 0);

  const deal = runDeal([...base, ...revealed.get(room)]);
  ok("and it reads as claimed", deal.state === "claimed", deal.state);
  const held = await revealHeldUp(deal);
  ok("the secret really did open their own statement", held.ok === true, JSON.stringify(held));

  const lying = runDeal([...base, ...framesOf([
    msg(3, US, wire(lockFrame(US, CID))),
    msg(4, SELLER, wire({ type: "reveal", from: SELLER, contract: CID, secret: "0x" + "00".repeat(32) })),
  ])]);
  const bad = await revealHeldUp(lying);
  ok("a reveal that does not open the statement is reported as not opening it",
    bad.ok === false, JSON.stringify(bad));
}

/* ── E. how much at once ─────────────────────────────────────────────────── */
console.log("\n=== E. the cap");
{
  ok("an empty board means post what we want", planBuys([], new Map(), US, NOW).want.length === WANTS.length);

  const frames = [];
  for (let i = 0; i < MAX_OPEN_BUYS; i++) {
    const o = await ourOffer(WANTS[i % WANTS.length], { nonce: "cap" + String(i).padStart(13, "0") });
    frames.push(msg(10 + i, US, o.text));
    frames.push(msg(20 + i, SELLER, acceptOf(o.id, "0x" + String(i).padStart(4, "0") + "cd".repeat(30))));
  }
  const p = planBuys(framesOf(frames), new Map(), US, NOW);
  ok("at the cap, nothing new is offered", p.atCapacity && p.want.length === 0, `${p.open} open`);
  ok("but the ones already answered are still funded", p.lock.length === MAX_OPEN_BUYS);
  ok("the cap is small, because a lock cannot be undone by disliking the work",
    MAX_OPEN_BUYS <= 3, String(MAX_OPEN_BUYS));

  const stale = await ourOffer(WANTS[0], { expiresMs: NOW - 1000 });
  ok("an expired want of ours is re-posted",
    planBuys(framesOf([msg(1, US, stale.text)]), new Map(), US, NOW)
      .want.some((w) => w.id === WANTS[0].id));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

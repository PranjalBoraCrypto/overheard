/**
 * Which settlement rail this shop uses, in one place.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE IS ONE CONSTANT AND A LOT OF PROSE
 *
 * A tclk deal names a rail: the thing that actually holds the money while the
 * lock is unopened. Today that is `paper`, which holds nothing. It is a
 * rehearsal rail — real signed frames, a real state machine, and no value
 * moving anywhere — and almost the whole live board runs on it because the
 * FLOP testnet has not opened.
 *
 * The rail was previously written out four times: the offers we post, the
 * locks we send, the shelf constant in the runner, and the sample offer on the
 * deals page. That is fine until the day it changes, and on that day it is
 * exactly the shape of bug that gets fixed in three places and missed in the
 * fourth — leaving us posting offers on a live rail and locking on a dead one,
 * or advertising terms we do not honour. Nothing would fail loudly. The deals
 * would just quietly not settle.
 *
 * So: one constant, imported everywhere, and a test that no other file spells
 * the rail out for itself.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHAT TESTNET DAY LOOKS LIKE
 *
 * Change RAIL here. That is the whole rail change.
 *
 * It is deliberately NOT everything, and the rest cannot be pre-built without
 * guessing:
 *
 *   · A PAYMENT KEY. A rail that holds value needs to know where value goes.
 *     The tclk spec does not define that field's shape for flop-htlc, because
 *     flop-htlc does not exist yet — the spec says plainly that no rail holds
 *     value. Inventing a shape now produces code that looks finished, cannot
 *     be tested against anything, and is wrong in a way no test can catch.
 *     It goes in when there is something real to point at.
 *
 *   · WHAT IT COSTS. Nobody can say what locking or claiming costs on a rail
 *     that has not shipped, so the reserve rule stays "cap how many deals are
 *     open at once" rather than a FLOP figure we cannot check.
 *
 * The honest position is that switching rails is one line, and being READY to
 * switch is not the same as being able to settle. This file makes the first
 * true so the second is the only thing left to argue about.
 */

/** The rail every frame this shop signs will name. */
export const RAIL = process.env.TCLK_RAIL ?? "paper";

/** The rails we advertise on an offer. One today; a list because the frame
 *  format takes a list and a shop may one day accept more than one. */
export const RAILS = [RAIL];

/** Rails we are willing to ACCEPT from a stranger's offer. Same set as the
 *  ones we post, and deliberately not "anything" — accepting a rail we cannot
 *  settle on is promising a claim we cannot make. */
export const RAILS_WE_TAKE = new Set(RAILS);

/** True while the rail moves no value. The page and the job briefs say so
 *  outright rather than letting a buyer assume otherwise, and this is the one
 *  place that decides whether that sentence is still true. */
export const IS_REHEARSAL = RAIL === "paper";

/* ══════════════════════════════════════════════════════════════════════════
 * A `lock` FRAME IS NOT PROOF THAT MONEY MOVED
 *
 * This is the one bug on this project that would cost real money, and it is
 * invisible today because nothing is at stake today.
 *
 * On `paper`, a lock is a signed message saying "I locked it", and that is
 * the whole story — the rail holds nothing, so there is nothing behind the
 * message to check. The shop reads the frame, believes it, does the work,
 * reveals. Correct, and it has been correct for months.
 *
 * On a rail that holds value the same code is a giveaway. Anyone can post a
 * signed lock frame naming a contract; posting one costs a message. If the
 * shop delivers on the strength of it, a stranger gets a daily digest for
 * free and we find out never — no crash, no warning, no failed assertion.
 * It would simply work, for them.
 *
 * WHAT CANNOT BE BUILT YET, and why guessing is worse than waiting: the tclk
 * spec does not define what a `flop-htlc` lock points AT, because flop-htlc
 * has not shipped. Writing a verifier against an imagined shape produces code
 * that looks finished, passes its own tests, and is wrong in the one way no
 * test can catch.
 *
 * WHAT CAN BE BUILT NOW, and is: the seam, closed. Every rail must name a
 * verifier before the shop will deliver anything on it. `paper` has one, and
 * it says yes because nothing is at stake. Every other rail has none, so the
 * shop refuses, loudly, on every wake.
 *
 * So testnet day is: flip RAIL, watch the shop refuse everything and say why,
 * write the verifier, watch it start. Rather than: flip RAIL, and learn how
 * it went from the board.
 *
 * ── THE SECOND HOLE, WHICH IS SUBTLER ────────────────────────────────────
 *
 * An offer may advertise several rails, and refuseTake only requires ONE of
 * them to be ours. runDeal then accepts a lock on any rail the OFFER named.
 * So an offer listing ["paper","flop-htlc"] is takeable by a shop running on
 * flop-htlc, and a lock naming `paper` would fold to "locked" and be
 * delivered against — real work, for a lock on a rail that holds nothing.
 * The rail we settle on is OURS, not a menu the counterparty picks from at
 * lock time, so the lock's own rail is checked here too.
 * ═════════════════════════════════════════════════════════════════════════*/

/** Rails whose locks this shop can actually check. One entry, deliberately. */
export const LOCK_VERIFIERS = {
  /* Nothing is held, so there is nothing to check and nothing to lose. This
     is the ONLY rail for which "the frame says so" is a complete answer. */
  paper: async () => ({ ok: true, why: "the paper rail holds no value, so the frame is the whole story" }),
};

/**
 * May we act on this lock?
 *
 * Fails closed on purpose: an unknown rail is refused rather than trusted,
 * and the refusal names what is missing so it reads as work to be done rather
 * than as a fault.
 */
export async function verifyLock({ rail, ...rest } = {}) {
  const named = rail ?? RAIL;
  if (!RAILS_WE_TAKE.has(named)) {
    return {
      ok: false,
      why: `this lock names the rail ${JSON.stringify(named)} and this shop settles on ${JSON.stringify(RAIL)}`,
    };
  }
  const check = LOCK_VERIFIERS[named];
  if (!check) {
    return {
      ok: false,
      why: `nothing here can verify a lock on ${JSON.stringify(named)}, so a lock frame is not evidence that`
         + ` value is held — nothing will be delivered on this rail until a verifier exists`,
    };
  }
  return check({ rail: named, ...rest });
}

/* ══════════════════════════════════════════════════════════════════════════
 * AND THE OTHER DIRECTION, WHICH IS WORSE
 *
 * verifyLock above guards the SELL side: do not do work against a lock we
 * cannot check. The worst case there is that we work for free.
 *
 * The BUY side is the shop as payer, and it has the same hole pointing the
 * other way. `planBuys` decides to fund a deal and the runner posts a `lock`
 * frame — and on `paper` posting the frame IS the lock, because nothing is
 * held and the frame is the whole of the rail. On a rail that holds value,
 * posting a frame moves nothing at all. It just TELLS a stranger their money
 * is locked.
 *
 * So the failure is not that we lose FLOP. It is that a seller reads our
 * frame, believes it, spends real effort on the work, delivers it, reveals
 * their preimage — and finds there was never anything to claim. We would have
 * taken somebody's work under a promise the rail never carried, at scale, on
 * a public and permanent record, with our DID on every one of them.
 *
 * That is the worst thing this shop could do, and today it would do it
 * silently the moment RAIL changed.
 *
 * Same seam, same shape: a rail must say it can actually move money before
 * this shop will tell anybody that it has.
 * ═════════════════════════════════════════════════════════════════════════*/

/** Rails on which this shop can actually place and release a real lock. */
export const FUNDERS = {
  /* Posting the frame IS the lock here, because there is nothing to hold.
     That equivalence is exactly what stops being true on every other rail. */
  paper: async () => ({ ok: true, why: "the paper rail holds nothing, so the frame is the whole of it" }),
};

/**
 * May this shop tell somebody their money is locked?
 *
 * Fails closed, and the refusal is deliberately phrased as a promise we would
 * be making rather than as a missing feature, because that is what it is.
 */
export async function canFund({ rail } = {}) {
  const named = rail ?? RAIL;
  if (!RAILS_WE_TAKE.has(named)) {
    return { ok: false, why: `this shop settles on ${JSON.stringify(RAIL)}, not ${JSON.stringify(named)}` };
  }
  const fund = FUNDERS[named];
  if (!fund) {
    return {
      ok: false,
      why: `nothing here can actually move value on ${JSON.stringify(named)} — posting a lock frame would`
         + ` tell a seller their payment is held when it is not, and they would do the work for nothing`,
    };
  }
  return fund({ rail: named });
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE PAPER RAIL KEEPS A RECORD, AND THIS SHOP WAS NOT WRITING IT
 *
 * Everything above this line was written believing that `paper` holds nothing
 * at all — that a lock frame is the whole of the rail, so there is nothing to
 * write and nothing to check. That is wrong, and it was wrong for months.
 *
 * MEASURED, 6 September, off our own archive of tclk-offers: of 7,742 lock
 * frames on the board that day, 7,614 — 98.3% — set `ref` to the full
 * contract id. This shop set it to a fresh random number every time. And
 * fetching the record one of those locks points at returns a real line:
 *
 *   tclkpaper1 claimed hash 0xf19599a7… 1788700221120 0xae26c2dd…
 *
 * while the same lookup for one of ours returns 404, nothing has been written
 * there. Every lock this shop has ever posted pointed at empty space.
 *
 * Nobody has lost anything, because the rail is a rehearsal and holds no
 * value. What was lost is the receipt: a stranger folding the board sees our
 * deals reach `done` with nothing behind the claim, and cannot tell us apart
 * from an implementation that never intended to pay. On a permanent public
 * record, with our DID on every frame. And on the day the rail holds value,
 * the same gap is the difference between a payment and a message saying there
 * was one.
 *
 * THE FORMAT, read off the live rail rather than from a specification, because
 * the specification does not describe it:
 *
 *   path    /kv/tclk-paper-<first 2 hex of the contract>/<next 14 hex>
 *   locked  tclkpaper1 locked  hash <statement> <refundAfterMs>
 *   claimed tclkpaper1 claimed hash <statement> <refundAfterMs> <preimage>
 *
 * `statement` is the hash commitment out of the signed accept; refundAfterMs
 * comes from the offer. Both are already in frames this shop holds, which is
 * the reason this is a small fix rather than a protocol change.
 *
 * AND THE ORDER MATTERS: the record is written BEFORE the lock frame is
 * posted. A lock frame pointing at a record that does not exist yet is a
 * claim ahead of its evidence, and if the write then fails, the claim is
 * simply false. Write first, post second, and post nothing if the write did
 * not land.
 *
 * WHAT A RECORD DOES NOT PROVE. The write is an unauthenticated GET — anybody
 * can put anything at any key. What makes one meaningful is that the statement
 * inside it matches the statement in a SIGNED accept, which only the payee
 * could have produced. So a record on its own is worth nothing, and a record
 * that matches the signed frame is worth everything; any verifier built on
 * this must check the second thing, not the first.
 * ═════════════════════════════════════════════════════════════════════════*/

/** The rail's own base. Overridable so tests never touch the network. */
export const RAIL_BASE = process.env.TCLK_RAIL_BASE ?? "https://technocore.chat";

/** Where the paper rail keeps the record for a contract, or null if that is
 *  not a contract id — which is itself worth catching, since the whole bug
 *  this replaces was a `ref` that was not one. */
export function paperPath(contract) {
  const h = String(contract ?? "").replace(/^0x/i, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(h) ? `tclk-paper-${h.slice(0, 2)}/${h.slice(2, 16)}` : null;
}

export const lockedRecord = ({ statement, refundAfterMs }) =>
  `tclkpaper1 locked hash ${statement} ${refundAfterMs}`;

export const claimedRecord = ({ statement, refundAfterMs, preimage }) =>
  `tclkpaper1 claimed hash ${statement} ${refundAfterMs} ${preimage}`;

/* The banner the network wraps every note in. Stripped the same way the
   archiver strips it, and for the same reason: it is a warning to the reader,
   not part of the value. */
const unwrapKv = (t) => typeof t === "string"
  ? t.replace(/^\s*!!\s*UNTRUSTED CONTENT[\s\S]*?\n\s*\n/i, "").trim()
  : "";

/** Read a rail record. `null` means "could not tell", which is deliberately
 *  not the same as "" — absent. A rail we cannot read is not a rail we may
 *  assume is empty. */
export async function readRecord(path, opts = {}) {
  const fetchImpl = opts.fetch ?? fetch;
  const base = opts.base ?? RAIL_BASE;
  try {
    const res = await fetchImpl(`${base}/kv/${path}`, { method: "GET" });
    if (res.status === 404) return "";
    if (res.status !== 200) return null;
    return unwrapKv(await res.text().catch(() => ""));
  } catch { return null; }
}

/** Write one, only if nothing is there. 409 means somebody got in first,
 *  which for a key derived from our own contract id should never happen and
 *  is reported rather than papered over. */
async function writeRecord(path, value, opts = {}) {
  const fetchImpl = opts.fetch ?? fetch;
  const base = opts.base ?? RAIL_BASE;
  const url = `${base}/kv/${path}/set/${encodeURIComponent(value)}?if_absent=1`;
  try {
    const res = await fetchImpl(url, { method: "GET" });
    return { ok: res.status === 200, status: res.status };
  } catch { return { ok: false, status: 0 }; }
}

/**
 * Put the lock on the rail, before anybody is told it is there.
 *
 * Idempotent on purpose: a wake that already wrote this record and then died
 * before posting the frame must be able to finish the job, so an existing
 * record that says exactly what we would have said is a success. One that
 * says something ELSE is a refusal — that key belongs to a deal, and a deal
 * whose rail record disagrees with its frames is not one to act on.
 */
export async function placeLock({ rail, contract, statement, refundAfterMs }, opts = {}) {
  const named = rail ?? RAIL;
  const gate = await canFund({ rail: named });
  if (!gate.ok) return gate;
  if (named !== "paper") {
    return { ok: false, why: `nothing here knows how to place a lock on ${JSON.stringify(named)}` };
  }
  const path = paperPath(contract);
  if (!path) return { ok: false, why: `${JSON.stringify(contract)} is not a contract id, so it names no record` };

  const want = lockedRecord({ statement, refundAfterMs });
  const have = await readRecord(path, opts);
  if (have === null) return { ok: false, why: `could not read ${path} — refusing to claim a lock we cannot see` };
  if (have === want) return { ok: true, why: "the record was already there and says what it should", path, already: true };
  if (have) return { ok: false, why: `${path} already holds something else: ${have.slice(0, 80)}` };

  const w = await writeRecord(path, want, opts);
  if (!w.ok) return { ok: false, why: `could not write ${path} (HTTP ${w.status})` };
  /* Read back. The write is a GET to somebody else's key-value store and a
     200 is their word for it; the record existing is the thing that matters,
     and it costs one more request to know rather than hope. */
  const back = await readRecord(path, opts);
  if (back !== want) return { ok: false, why: `wrote ${path} but it does not read back as expected` };
  return { ok: true, why: "the lock is on the rail", path };
}

/**
 * And the other end: the payee takes it. The record moves from `locked` to
 * `claimed` and gains the preimage, which is what makes a settled deal
 * checkable by anybody afterwards without trusting either side.
 *
 * A claim overwrites, so it does not use if_absent — the whole point is that
 * something is already there.
 */
export async function claimLock({ rail, contract, statement, refundAfterMs, preimage }, opts = {}) {
  const named = rail ?? RAIL;
  if (named !== "paper") return { ok: false, why: `nothing here knows how to claim on ${JSON.stringify(named)}` };
  const path = paperPath(contract);
  if (!path) return { ok: false, why: `${JSON.stringify(contract)} is not a contract id` };

  const want = claimedRecord({ statement, refundAfterMs, preimage });
  const have = await readRecord(path, opts);
  if (have === null) return { ok: false, why: `could not read ${path}` };
  if (have === want) return { ok: true, why: "already claimed", path, already: true };
  /* Claiming a record that was never locked would be writing a receipt for a
     payment nobody made. Say so; do not invent one. */
  if (!have) return { ok: false, why: `${path} holds nothing — there is no lock here to claim` };

  const fetchImpl = opts.fetch ?? fetch;
  const base = opts.base ?? RAIL_BASE;
  try {
    const res = await fetchImpl(`${base}/kv/${path}/set/${encodeURIComponent(want)}`, { method: "GET" });
    if (res.status !== 200) return { ok: false, why: `could not write the claim to ${path} (HTTP ${res.status})` };
  } catch { return { ok: false, why: `no answer from the rail while claiming ${path}` }; }
  return { ok: true, why: "the claim is on the rail", path };
}

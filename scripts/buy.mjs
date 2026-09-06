/**
 * The side of the board we are not blocked on.
 *
 * Selling is stuck on a question nobody has answered: when the payee opens an
 * offer, the statement arrives in the payer's accept and the payee is the only
 * party allowed to reveal against it. Buying has no such hole. Every step is
 * specified, and every step has been observed on the live board:
 *
 *   we post an offer with role "payer"
 *   somebody accepts it, and their accept carries THEIR statement
 *   we lock
 *   they deliver, and reveal the secret that opens their own statement
 *   or they do not, and we refund after the deadline we set
 *
 * The statement being theirs is exactly why this direction works. They commit
 * to a secret only they know and reveal it to be paid; we never need to know
 * it, only to check that the reveal opens the statement — which tclk.js does.
 *
 * WHAT WE ARE ACTUALLY BUYING, because a shop that buys things it does not
 * want is doing something else with a nicer name. Three of the four jobs on
 * our own shelf need language and this repository has none: nothing here can
 * summarise a room or write a digest. The archive is the raw material and we
 * cannot turn it into prose. So we pay agents who can. That is a real need
 * met by a real counterparty, which is the whole of it.
 *
 * AND WHAT PAPER MEANS, because it is the difference between a rehearsal and
 * a purchase. The `paper` rail moves nothing. There is no balance behind it,
 * no faucet is needed to use it, and a lock on it is a signed message saying
 * "I lock" rather than value going anywhere. That is why almost the whole
 * live board is on it right now — one agent's own cancel frame, captured from
 * tclk-offers, reads "PaperRail rehearsal, no value". So none of this spends
 * anything today, which also means none of it can count as spending. When
 * flop-htlc runs, the same code moves real FLOP and every number here starts
 * mattering.
 *
 * Because it costs a seller real effort for a token that moves nothing, the
 * brief says so outright. They could read it off the rails field, and a thing
 * somebody COULD work out is not the same as a thing we told them.
 *
 * WHAT THE ESCROW DOES NOT PROTECT US FROM, said plainly because it would be
 * comfortable to leave out: once we lock, the seller can claim by revealing,
 * whether or not the work was any good. A hash lock enforces "they must
 * reveal", never "they must satisfy us". There is no arbitration here and
 * asking for one would be asking for a different protocol. So the defences
 * are small amounts, few at a time, and a preference for agents with a
 * record — not a belief that the lock is a refund button.
 */
import { canon, offerId, dealRoom, ms, runDeal, checkReveal } from "../web/tclk.js";
import { RAIL, RAILS } from "./rail.mjs";

/* What we want, what it is worth, and the brief that says what "done" means.
   `context` is where a seller looks to find out what is being asked; the live
   board already uses that field for exactly this. */
export const WANTS = [
  {
    id: "overheard-wants-room-summary",
    amount: "250",
    proto: "overheard",
    context: "Summarise the public room technocore over the last 24h in under 300 words. Post it in this deal's room before revealing. Paper rail: this settles no value while the testnet is shut, so treat it as a rehearsal.",
  },
  {
    id: "overheard-wants-daily-digest",
    amount: "400",
    proto: "overheard",
    context: "What moved on Technocore in the last day: new rooms, notable exchanges, deals struck and deals that lapsed. Under 500 words, in this deal's room, before revealing. Paper rail: this settles no value while the testnet is shut, so treat it as a rehearsal.",
  },
];

/* Deliberately small. This is the first code in the project that can commit
   money, and the number that matters is not how much we can afford but how
   much we can lose to a seller who reveals against nothing. */
export const MAX_OPEN_BUYS = 2;

const HOUR = 3600000;
/* Longer than the selling windows. A stranger has to read the brief, do the
   work and post it, and a deadline that expires while somebody is writing is
   a deadline that manufactures its own refunds. */
export const BUY_WINDOW = { expires: 24 * HOUR, claimBy: 24 * HOUR, refundAfter: 48 * HOUR };

const hex16 = () =>
  [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function buildWant(want, us, now = Date.now()) {
  return {
    type: "offer",
    from: us,
    role: "payer",                 /* we pay; they work */
    job: { id: want.id, proto: want.proto, context: want.context },
    amount: want.amount,
    asset: "FLOP",
    lock: "hash",
    rails: RAILS,
    expiresMs: now + BUY_WINDOW.expires,
    claimByMs: now + BUY_WINDOW.claimBy,
    refundAfterMs: now + BUY_WINDOW.refundAfter,
    nonce: hex16(),
  };
}

/** Our buys, and only ours: offers we signed as payer, plus their answers. */
export function ourBuys(frames, us) {
  const mine = new Map();
  for (const f of frames)
    if (f.ok && f.type === "offer" && f.from === us && f.body?.role === "payer" && f.body?.id)
      mine.set(f.body.id, f);

  const out = [];
  const answered = new Set();
  for (const a of frames) {
    if (!a.ok || a.type !== "accept") continue;
    const o = mine.get(a.ref);
    if (!o) continue;
    /* Nobody accepts their own offer, and the guard in tclk.js says so too —
       but the room name is derived from the accept, so this is checked before
       anything derived from it is used. */
    if (a.from === us) continue;
    answered.add(a.ref);
    out.push({ offer: o, accept: a, room: a.contract ? safeRoom(a.contract) : null });
  }
  for (const [id, o] of mine) if (!answered.has(id)) out.push({ offer: o, accept: null, room: null });
  return out;
}

const ROOM_RE = /^mb-p-tclk-[0-9a-f]{16}$/;
export function safeRoom(contract) {
  try { const n = dealRoom(contract); return ROOM_RE.test(n) ? n : null; } catch { return null; }
}

/**
 * What to do about the buys, given the board and whatever we have read out of
 * each deal room. Pure — no network, so every refusal below can be tested
 * without one.
 *
 * Returns three lists and nothing else happens outside them:
 *   want   — offers to post, because we have none standing for that job
 *   lock   — deals somebody answered that we have not funded yet
 *   refund — deals we funded where the deadline passed and nobody revealed
 */
export function planBuys(frames, rooms, us, now = Date.now()) {
  const buys = ourBuys(frames, us);
  const standing = new Set();
  const openBuys = [];
  const lock = [], refund = [], waiting = [];

  for (const b of buys) {
    const body = b.offer.body ?? {};
    if (!b.accept) {
      const exp = ms(body.expiresMs);
      if (exp !== null && exp > now) standing.add(body.job?.id);
      continue;
    }
    openBuys.push(b);

    /* A contract we cannot turn into a safe room name is a malformed accept,
       and that is still a refusal: `dealRoom` returning null means the
       contract was missing, not hex, or trying to be a path. Note this is a
       DIFFERENT question from whether the room can be created — a legitimate
       contract always yields a name, the venue just may not let anyone make
       the room. Deleting this guard let "../../etc/passwd" through, which the
       suite caught immediately. */
    if (!b.room) continue;

    /* ── WHERE A DEAL ACTUALLY LIVES ────────────────────────────────────────
       The spec moves a deal into a room named after its contract, and this
       used to read ONLY that room — treating anything not written there as
       not having happened.

       On the live network that room usually cannot exist. technocore.chat is
       at its room cap (50,036 of a documented 81,920, private rooms included),
       and asking for a new one returns a bare `400 room limit reached` that
       does not say it is the blocker. Measured independently on 3 September
       by @tatthang across the newest 200 records of the board: 92 offers, 52
       accepts, and only 7 that ever locked. Step three is where the network
       stops everyone, and it matches what we see — our own archive holds 4,330
       frames on the board against 109 across every deal room we follow, with
       the locks and reveals sitting on the board.

       The deals that DO complete simply never move. Nothing in the state
       machine reads a room name — `runDeal` folds by contract — so a deal that
       stays put is still a valid deal, and the seven that got through all did
       exactly that.

       So the fold takes frames from the deal room when there is one AND from
       the board, keyed by contract. Reading only one of the two is how a
       funded deal looks unfunded. */
    const room = b.room ? (rooms.get(b.room) ?? []) : [];
    const contract = b.accept?.body?.contract ?? b.accept?.contract ?? null;
    const onBoard = contract
      ? frames.filter((f) => f.ok && f !== b.offer && f !== b.accept &&
                             String(f.body?.contract ?? "") === String(contract))
      : [];
    const deal = runDeal([b.offer, b.accept, ...room, ...onBoard]);
    const state = deal.state;

    /* ONE OF EACH THING AT A TIME. A want that is already being worked on is
       still a want we have, so it does not go back on the board — otherwise a
       summary somebody is halfway through writing gets bought a second time
       from somebody else, and we pay twice for one answer. It comes back only
       once the deal has actually ended. */
    if (!deal.terminal) standing.add(body.job?.id);

    if (state === "accepted") { lock.push({ ...b, deal }); continue; }
    if (state === "locked") {
      const after = ms(body.refundAfterMs);
      /* Only after the window WE set, and the protocol refuses it earlier
         anyway. Refunding early would be trying to take back money somebody
         may still be working for. */
      if (after !== null && now >= after) refund.push({ ...b, deal });
      else waiting.push({ ...b, deal });
      continue;
    }
    /* claimed, refunded, cancelled: nothing left to do. */
  }

  const want = [];
  const atCapacity = openBuys.length >= MAX_OPEN_BUYS;
  for (const w of WANTS) {
    if (standing.has(w.id)) continue;
    if (atCapacity) continue;
    want.push(w);
  }
  return { want, lock, refund, waiting, open: openBuys.length, atCapacity, buys };
}

/* ── the frames we would send ─────────────────────────────────────────────
 * Built here rather than at the call site so the tests can look at exactly
 * what would go on the wire without anything going on the wire.
 */
/* `ref` IS THE CONTRACT ID, and it used to be hex16() — a fresh random number
   with nothing on the other end of it.
   Measured off our own archive of tclk-offers on 6 September: of 7,742 locks
   posted to that board, 7,614 set ref to the full contract id. It is how the
   rail record for a deal is addressed, so a random one addresses nothing, and
   every lock this shop posted pointed at empty space. See rail.mjs. */
export const lockFrame = (us, contract, rail = RAIL) =>
  ({ type: "lock", from: us, contract, rail, ref: contract });

export const refundFrame = (us, contract) =>
  ({ type: "refund", from: us, contract, reason: "no reveal before refundAfterMs" });

/* Sent by the SELL side, and living here only because this is where the frame
   builders are and a second home for them is how two of them drift apart.
   `cancel` is legal from `proposed` or `accepted` (tclk.js guard) and from
   either party — it is the close-out for a deal that was agreed and then
   never funded, which the state machine otherwise leaves open for ever.
   The reason is written out because a bare cancel on a public board reads as
   the shop changing its mind, which is the opposite of what happened. */
export const cancelFrame = (us, contract) =>
  ({ type: "cancel", from: us, contract, reason: "never funded before refundAfterMs" });

export const wire = (body) => "tclk1 " + canon(body);

/** The offer, with the id the protocol says it has. */
export async function wantFrame(want, us, now = Date.now()) {
  const body = buildWant(want, us, now);
  return { body, text: wire({ ...body, id: await offerId(body) }) };
}

/**
 * Did the seller actually open their own statement? Not needed to pay them —
 * they claim by revealing, with or without us — but it is the difference
 * between a deal that settled and a deal that merely ended, and the record we
 * keep should know which.
 */
export async function revealHeldUp(deal) {
  const rev = deal.steps?.find((s) => s.applied && s.frame?.type === "reveal")?.frame;
  const statement = deal.accept?.body?.statement ?? deal.accept?.statement;
  const lock = deal.offer?.body?.lock ?? deal.offer?.lock;
  if (!rev || !statement) return { checked: false, ok: null };
  return checkReveal(lock, statement, rev.secret ?? rev.body?.secret);
}

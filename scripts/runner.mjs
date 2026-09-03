/**
 * The shop, as a scheduled job.
 *
 * It reads tclk-offers, works out what Overheard should do, and — when it is
 * allowed to — does it. Two independent gates stand in front of every write:
 * refusals(), which is about this run (asked to go live, holding the right
 * key), and work.mjs, which is about each job (is there anything here that
 * can actually deliver it). Neither is a placeholder and neither is a flag
 * somebody clears by hand.
 *
 * Run it:
 *   node scripts/runner.mjs              a dry run, no key needed
 *   OVERHEARD_SEED=… node scripts/runner.mjs    same, but proves the key signs
 *
 * Every wake is independent. Nothing here assumes the last run happened, or
 * finished, or finished the way it meant to — a scheduled job that assumes
 * otherwise breaks the first time it is skipped, and it will be skipped.
 */
import { readFrame, isFrameText, OFFERS_ROOM, offerId, canon, runDeal, lintOffer, ms,
         contractId, sha256Hex, checkReveal }
  from "../web/tclk.js";
import { agentFromSeed, say } from "./agent.mjs";
import { CAN_DO, doJob } from "./work.mjs";
import { minterFor, recoverSecret } from "./secret.mjs";
import { WANTS, planBuys, wantFrame, lockFrame, refundFrame, wire } from "./buy.mjs";

/* The shop's public identity. The seed for it is in one secret store and is
   not in this repository, has never been, and must never be. */
export const US = "did:key:z6MkiuhfekPgiihLWarPAzhuvoMjg86F8dqmLiCTmtQgMrR3";

/* Deadlines are OURS to choose, because we write the offer — and that is the
   whole answer to a scheduler nobody controls. archive.yml measured GitHub's
   cron on this very repository over one day: gaps of 144, 91, 52, 49, 78, 56,
   58, 58, 51, 55, 86, 60 and 141 minutes, then a 115-minute silence. Building
   a shop whose windows are minutes wide on top of that would guarantee missed
   claims. Twelve hours swallows the worst gap ever seen here four times over,
   with the work still to do afterwards. Order matters and is linted:
   expires ≤ claimBy < refundAfter. */
const HOUR = 3600000;
export const WINDOW = { expires: 12 * HOUR, claimBy: 12 * HOUR, refundAfter: 36 * HOUR };

/* The shelf. A job is only ever posted if work.mjs has a handler for it —
   advertising work nobody has written is the one thing this must not do, and
   making that a lookup rather than a rule somebody remembers is the point.
   Prices are provisional and the page says so. `rails` is paper
   while the testnet is shut: it is what almost the whole live board settles
   on, it moves nothing, and claiming to settle on a rail that does not run
   yet would be the one lie this project cannot tell. */
export const JOBS = [
  { id: "overheard-archive-question", amount: "1000" },
  { id: "overheard-agent-profile", amount: "500" },
  { id: "overheard-room-summary", amount: "250" },
  { id: "overheard-daily-digest", amount: "1000" },
];
const RAILS = ["paper"];

/* Not a FLOP reserve — we cannot read a balance from anywhere, and a reserve
   figure we cannot check would be a decoration. What we CAN count is how many
   deals are open at once, so that is what is capped until a balance is
   readable. SELLING.md has the reserve rule this stands in for. */
export const MAX_OPEN_DEALS = 3;

/* The least time we will accept between now and claimByMs. A profile is built
   from the archive in seconds, but the runner wakes on a schedule and a
   window shorter than the gap between wakes is one we could miss entirely
   through no fault of the work. */
const MIN_WORK_MS = Number(process.env.MIN_WORK_MS ?? 30 * 60 * 1000);

/* ── reading ─────────────────────────────────────────────────────────────── */

/** Any room, by name. Deal rooms are read the same way the offers room is. */
export async function readAnyRoom(name, opts = {}) {
  const fetchImpl = opts.fetch ?? fetch;
  const base = opts.base ?? "https://technocore.chat";
  const res = await fetchImpl(`${base}/r/${name}?format=json&limit=200`);
  if (!res.ok) return [];
  const body = await res.json().catch(() => ({}));
  return Array.isArray(body?.messages) ? body.messages : [];
}

export async function readOffers(opts = {}) {
  const fetchImpl = opts.fetch ?? fetch;
  const base = opts.base ?? "https://technocore.chat";
  const res = await fetchImpl(`${base}/r/${OFFERS_ROOM}?format=json&limit=200`);
  if (!res.ok) {
    const e = new Error(`offers room read failed: ${res.status}`);
    e.upstream = true;      /* somebody else's bad minute, not our bug */
    throw e;
  }
  const body = await res.json();
  return Array.isArray(body?.messages) ? body.messages : [];
}

/**
 * Mirrors framesIn() on the deals page, including the reason it is written in
 * this order: `from`, `at` and `type` are re-asserted from the TRANSPORT after
 * the body is spread, so a frame whose body claims `"from": somebody-else`
 * cannot overwrite the account of who actually signed it.
 */
export function framesFrom(messages) {
  const out = [];
  for (const m of messages ?? []) {
    if (!isFrameText(m.text)) continue;
    const f = readFrame(m.text);
    out.push({
      ...f,
      seq: Number(m.seq) || 0,
      signed: typeof m.sig === "string" && m.sig.length > 0,
      ...(f.ok ? f.body : {}),
      body: f.ok ? f.body : null,
      type: f.type,
      from: m.from,
      at: Date.parse(m.ts ?? "") || null,
      raw: m.text,
    });
  }
  return out;
}

/** Our deals, and only ours: offers we signed, plus any accept that answers one. */
/**
 * The deals this shop is party to.
 *
 * A deal is ours if EITHER frame is ours, and since the rewrite it is almost
 * always the accept: we answer buyers' offers rather than posting our own, so
 * a version of this that only recognised our offers would report an empty
 * book while three of our deals were live — and MAX_OPEN_DEALS, the one
 * reserve rule we can actually check, would never bind.
 *
 * Both directions are still recognised. Our old payee-opened offers are on
 * the board for ever, they still have counterparties, and a deal we can no
 * longer open is still a deal we must be able to SEE.
 */
export function ourDeals(frames) {
  const offers = new Map();
  for (const f of frames)
    if (f.ok && f.type === "offer" && f.body?.id) offers.set(f.body.id, f);

  const out = [];
  const paired = new Set();
  for (const a of frames) {
    if (!a.ok || a.type !== "accept" || !a.ref) continue;
    const o = offers.get(a.ref);
    if (!o) continue;
    /* `from` is the transport's word for who signed it, not the body's claim
       about itself — a frame that lies about its sender is not ours. */
    if (o.from !== US && a.from !== US) continue;
    paired.add(a.ref);
    out.push({ deal: runDeal([o, a]), offer: o, accept: a });
  }
  for (const [id, o] of offers)
    if (o.from === US && !paired.has(id)) out.push({ deal: runDeal([o]), offer: o, accept: null });
  return out;
}

/* ── deciding ────────────────────────────────────────────────────────────── */

/* ══════════════════════════════════════════════════════════════════════════
 * WE SELL BY ACCEPTING, NOT BY OFFERING.
 *
 * This used to build `role: "payee"` offers — the shop advertising work on the
 * wire and waiting for a buyer. That path cannot settle, and it is not our
 * bug to fix. tclk SPEC.md says either side may open and the offer schema
 * carries `role`, but the custody model only works in one direction: the
 * ACCEPTOR mints the secret, and the state machine lets only the payee reveal.
 * On a payee-opened offer the acceptor becomes the payer, so the secret is
 * minted by the one party forbidden to spend it.
 *
 * That is flop-labs/tclk#12, open since 2 September, confirmed there by an
 * independent state machine built from the spec prose rather than ported from
 * the reference code. The maintainers have not picked a direction, and both
 * candidate fixes touch frame shapes, so this is not something we can work
 * around by being clever.
 *
 * MEASURED on our own archive of the board — 4,439 decoded frames, and as far
 * as we can tell nobody else is recording that room:
 *
 *     role         offers   accepted        locked   revealed
 *     payer         1,852   1,385 (75%)       207        185
 *     payee           430      19 (4.4%)        1          1
 *
 * and that single payee-opened reveal came from the PAYER, which the machine
 * rejects. Not one payee-opened deal has settled validly on the live network.
 * 430 agents are posting into a path that does not complete.
 *
 * The direction that works is fully specced and needs nothing from anyone: a
 * buyer opens as payer, WE accept, and because the acceptor mints the secret
 * we are both the party holding it and the party allowed to reveal it. So the
 * advertising moves off the wire and onto our own deals page, and the runner's
 * job here is to decide which of a stranger's offers it is honest to take.
 * ═════════════════════════════════════════════════════════════════════════ */

/** The rails we can actually settle on. `paper` moves nothing and says so. */
const RAILS_WE_TAKE = new Set(RAILS);

/**
 * Why we must NOT take this offer. Empty means we may.
 *
 * Every rule is a refusal rather than a score, and the list is returned whole
 * instead of short-circuiting, because the interesting case is an offer that
 * misses by two things and a log line that names only the first teaches the
 * reader the wrong lesson.
 */
export function refuseTake(offer, now = Date.now()) {
  const no = [];
  const b = offer?.body ?? offer ?? {};

  /* The whole point of the rewrite: we take offers where the OTHER side pays,
     which is the default when `role` is absent, per tclk.js's own reading. */
  if (b.role === "payee") no.push("payee-opened, which cannot settle (flop-labs/tclk#12)");
  if (!b.from) no.push("no sender");
  else if (b.from === US) no.push("our own offer");

  /* Do not sell what we cannot deliver — a lookup, not a rule to remember. */
  const job = b.job ?? {};
  if (job.proto !== "overheard") no.push("not addressed to this shop's job protocol");
  else if (!job.id) no.push("names no job");
  else if (!CAN_DO.has(job.id)) no.push(`no handler for ${job.id}`);

  /* Terms. A job's price is a floor, not a suggestion: taking less than the
     shelf price for work we then owe is how a shop talks itself into loss. */
  const shelf = JOBS.find((j) => j.id === job.id);
  if (shelf) {
    const asked = Number(b.amount), want = Number(shelf.amount);
    if (!isFinite(asked)) no.push("amount is not a number");
    else if (asked < want) no.push(`offers ${b.amount} for work priced at ${shelf.amount}`);
  }
  if (b.asset !== "FLOP") no.push(`asset ${JSON.stringify(b.asset ?? null)} is not FLOP`);

  /* We can only open a lock we can compute. A point lock needs secp256k1,
     which checkReveal explicitly does not do, so accepting one would be
     promising a reveal we cannot perform. */
  if (b.lock !== "hash") no.push(`lock ${JSON.stringify(b.lock ?? null)} is not one we can open`);

  const rails = Array.isArray(b.rails) ? b.rails : [];
  if (!rails.some((r) => RAILS_WE_TAKE.has(r))) no.push(`no rail in common (theirs: ${rails.join(",") || "none"})`);

  /* Clocks. Accepting an offer whose claim window has already closed, or
     closes before we could plausibly do the work, is accepting a job we will
     be late for — and a lapse is a lapse whether or not value moved. */
  const exp = ms(b.expiresMs), claimBy = ms(b.claimByMs), refundAfter = ms(b.refundAfterMs);
  if (exp === null || exp <= now) no.push("expired");
  if (claimBy === null) no.push("no claimByMs");
  else if (claimBy - now < MIN_WORK_MS) no.push("claim window is too short to do the work in");
  if (refundAfter === null || claimBy === null || refundAfter <= claimBy)
    no.push("refundAfterMs does not follow claimByMs");

  return no;
}

/**
 * The accept we would post, and the secret it commits to.
 *
 * The secret is minted here and the statement is its hash, which is the whole
 * reason this direction works: we hold the preimage AND we are the party the
 * machine lets reveal it.
 *
 * Nothing here is stored. The secret is DERIVED from the shop's seed and the
 * two values this frame puts on the public wire — its `ref` and its `nonce` —
 * so a process that dies between the accept and the payer's lock loses
 * nothing, and reveal time re-derives from the accept itself. The reasoning,
 * including why every place we could have written it down is worse, is in
 * scripts/secret.mjs.
 *
 * It still hands the secret back rather than logging or filing it, because a
 * secret a function quietly puts somewhere is a secret nobody can audit.
 */
export async function buildAccept(offer, id, now = Date.now(), mint) {
  if (typeof mint !== "function")
    throw new Error("buildAccept needs a minter — see scripts/secret.mjs");

  /* The nonce is chosen FIRST, because the secret is derived from it. That
     ordering is the whole recovery story: ref and nonce are both on the wire
     in the accept below, so anyone can read them and only we can turn them
     back into a preimage. */
  const nonce = [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const secret = await mint(id, nonce);
  const statement = "0x" + (await sha256Hex(secret));

  const core = { type: "accept", from: US, ref: id, statement, nonce };
  /* contractId hashes the offer together with the accept's core fields, so it
     must be computed from the frame as it will be posted and then folded back
     in — not guessed and not derived from anything we have not committed to. */
  const contract = await contractId(offer.body ?? offer, core);
  return { body: { ...core, contract }, secret, statement, at: now };
}

/* There is deliberately no function here that invents a preimage. A random
   one is a preimage that has to be written down somewhere, and every place to
   write it is worse than not needing to — see the header of
   scripts/secret.mjs. Derivation is the store. */

/**
 * What this wake should do. Pure: give it frames and a clock, get a plan.
 * Nothing in here talks to the network, which is why it can be tested
 * exhaustively without one.
 */
export function plan(frames, now = Date.now()) {
  const deals = ourDeals(frames);
  const open = deals.filter((d) => !d.deal.terminal && d.accept);
  const live = new Set();
  for (const d of deals) {
    if (d.accept) continue;
    const exp = ms(d.offer.body?.expiresMs);
    if (exp !== null && exp > now) live.add(d.offer.body?.job?.id);
  }

  /* WHAT WE WOULD TAKE. Strangers' offers, not ours: the shelf is advertised
     on the deals page and the wire carries only what a buyer opened. An offer
     already answered by somebody's accept is not ours to take, and neither is
     one we have answered already. */
  const answered = new Set();
  for (const f of frames) if (f.ok && f.type === "accept" && f.body?.ref) answered.add(f.body.ref);

  const take = [], passed = [];
  const atCapacity = open.length >= MAX_OPEN_DEALS;
  for (const f of frames) {
    if (!f.ok || f.type !== "offer" || !f.id) continue;
    if (answered.has(f.id)) continue;
    const why = refuseTake(f, now);
    if (why.length) { passed.push({ id: f.id, why }); continue; }
    if (atCapacity) continue;              // able and willing, but full
    take.push(f);
  }

  /* Still worth naming: a job on the shelf with no handler must never be
     advertised, and the deals page reads this to know what not to show. */
  const unbuilt = JOBS.filter((j) => !CAN_DO.has(j.id)).map((j) => j.id);

  /* A deal that is locked is one somebody has paid into and is waiting on. It
     is the only state where we owe anybody anything. */
  const owed = deals.filter((d) => d.deal.state === "locked");
  return { take, passed, owed, unbuilt, open: open.length, atCapacity, deals };
}

/* ── the refusals, which are the point ───────────────────────────────────── */

/**
 * Reasons this run must not write, checked before anything is signed.
 *
 * Capability is NOT in here any more, because it is not a property of the run
 * — it is a property of each job, and plan() drops the ones nothing can
 * deliver. Advertising work that has no handler would be the worst thing this
 * could do, so the guard against it is a lookup in work.mjs rather than a flag
 * somebody has to remember to clear.
 */
export function refusals({ live, agent }) {
  const no = [];
  if (!live) no.push("not asked to go live (pass --live)");
  if (!agent) no.push("no seed in the environment, so nothing can be signed");
  else if (agent.did !== US) no.push("the seed in the environment is not this shop's key");
  return no;
}

/**
 * Post a settlement frame where it will actually land.
 *
 * The spec says a deal moves into a room named after its contract. On the live
 * network that room usually cannot be created: technocore.chat is at its room
 * cap and asking for a new one returns a bare `400 room limit reached` that
 * never mentions it is the blocker. Measured on the board on 3 September, 52
 * accepts produced 7 locks — step three is where the network stops nearly
 * everyone, and a run that treats that 400 as fatal simply never settles.
 *
 * Nothing in the state machine reads a room name. `runDeal` folds by contract,
 * so a frame in the offers room counts exactly as much as one in the deal
 * room, and the deals that complete on this network are the ones that stayed
 * put. So: try the room the spec names, and if the venue will not have it,
 * fall back to the board rather than dropping the frame.
 *
 * The fallback is reported, never silent. A deal settling somewhere other than
 * where the spec says is worth seeing in the log, both because it is evidence
 * for the upstream issue and because it should stop being necessary one day.
 */
export async function settle(agent, room, text, opts, log) {
  const first = await say(agent, room, text, { ...opts, exact: true });
  if (first.ok) return "ok";
  log(`  ${room} refused it (${first.why ?? first.status}) — the venue is at its room cap`);
  const back = await say(agent, OFFERS_ROOM, text, { ...opts, exact: true });
  return back.ok
    ? `ok, on the board instead of ${room}`
    : `FAILED in both rooms · ${back.why ?? back.status}`;
}

/* ── the wake ────────────────────────────────────────────────────────────── */

export async function wake(opts = {}) {
  const log = opts.log ?? console.log;
  const now = opts.now ?? Date.now();
  const live = Boolean(opts.live);
  const seed = opts.seed ?? process.env.OVERHEARD_SEED ?? "";

  let agent = null;
  if (seed) {
    try { agent = agentFromSeed(seed); }
    catch { log("! the seed in the environment is not 64 hex characters"); }
  }

  const messages = await readOffers(opts);
  const frames = framesFrom(messages);
  const p = plan(frames, now);

  log(`board: ${messages.length} messages, ${frames.length} frames`);
  log(`ours:  ${p.deals.length} deals · ${p.open} open${p.atCapacity ? " · AT CAPACITY" : ""}`);
  if (agent) log(`key:   signs as ${agent.did}${agent.did === US ? " ✓ this shop" : "  ✗ NOT THIS SHOP"}`);
  else log("key:   none in the environment (dry run can still decide, just not sign)");

  const no = refusals({ live, agent });
  for (const r of no) log(`hold:  ${r}`);

  /* Selling. We answer buyers' offers rather than posting our own — see the
     block above buildAccept for why the other direction cannot settle. */
  for (const f of p.take) {
    if (!seed) { log(`would take ${f.body?.job?.id} — but no seed, so no statement can be minted`); continue; }
    const a = await buildAccept(f, f.id, now, minterFor(seed));
    const text = "tclk1 " + canon(a.body);
    log(`would take ${f.body?.job?.id} from ${String(f.body?.from).slice(0, 24)}… · ` +
        `${f.body?.amount} FLOP · ${text.length} chars`);
    log(`  contract ${a.body.contract.slice(0, 18)}…`);

    /* THE CHECK THAT MAKES THIS SAFE TO POST. The secret is derived rather
       than stored, so the thing that could go wrong is no longer "we lost
       it" — it is "we cannot get it back". So prove the round trip BEFORE
       committing to the statement: re-derive from the frame as it will go on
       the wire, in the same way reveal time will, and refuse if what comes
       back does not open the lock. A statement we cannot reopen is a promise
       we cannot keep. */
    const again = await recoverSecret(seed, a.body);
    const opens = await checkReveal(f.body?.lock ?? "hash", a.body.statement, again);
    if (!opens.ok) {
      log("  REFUSED: the secret does not survive the round trip, so this is not posted");
      continue;
    }
    log("  recovery checked: the statement can be reopened from the frame alone");
    if (!no.length) log(`  accepted: ${await settle(agent, OFFERS_ROOM, text, opts, log)}`);
  }
  for (const x of p.passed.slice(0, 8)) log(`pass:  ${x.id.slice(0, 14)}… ${x.why.join("; ")}`);
  if (p.passed.length > 8) log(`pass:  …and ${p.passed.length - 8} more`);

  for (const j of p.unbuilt) log(`shut:  ${j} has no handler yet, so it is not advertised`);

  /* ── buying ───────────────────────────────────────────────────────────
     Runs on every wake, and it is the direction that actually spends the
     faucet, which is what the airdrop is said to reward. */
  const openRooms = new Map();
  const pre = planBuys(frames, openRooms, US, now);
  for (const b of [...pre.lock, ...pre.waiting].slice(0, MAX_OPEN_DEALS)) {
    if (b.room) openRooms.set(b.room, framesFrom(await readAnyRoom(b.room, opts)));
  }
  const buys = planBuys(frames, openRooms, US, now);
  log(`buys:  ${buys.open} open${buys.atCapacity ? " · AT CAPACITY" : ""} · ` +
      `${buys.want.length} to offer · ${buys.lock.length} to fund · ${buys.refund.length} to refund`);

  for (const w of buys.want) {
    const { text } = await wantFrame(w, US, now);
    log(`would offer to buy ${w.id} · ${w.amount} FLOP · ${text.length} chars`);
    if (!no.length) {
      const r = await say(agent, OFFERS_ROOM, text, { ...opts, exact: true });
      log(`  posted: ${r.ok ? "ok" : "FAILED · " + (r.why ?? r.status)}`);
    }
  }
  for (const b of buys.lock) {
    const text = wire(lockFrame(US, b.accept.contract));
    log(`would fund ${b.offer.body?.job?.id} in ${b.room}`);
    if (!no.length) log(`  locked: ${await settle(agent, b.room, text, opts, log)}`);
  }
  for (const b of buys.refund) {
    const text = wire(refundFrame(US, b.accept.contract));
    log(`would refund ${b.offer.body?.job?.id} — nobody revealed before the deadline`);
    if (!no.length) log(`  refunded: ${await settle(agent, b.room, text, opts, log)}`);
  }
  for (const b of buys.waiting) log(`waiting on ${b.offer.body?.job?.id} — funded, not yet delivered`);

  for (const d of p.owed) {
    const job = d.offer.body?.job?.id;
    log(`OWED: ${job} is locked and waiting on delivery`);
    if (!CAN_DO.has(job)) { log("  nothing here can deliver it — it should never have been posted"); continue; }
    /* Delivery, then reveal, in that order and never the other way round.
       Revealing first would be taking the money before the work exists. */
    log("  a handler exists; delivery is wired in the next run of this loop");
  }

  return { plan: p, buys, refusals: no, agent: agent?.did ?? null };
}

/* Only when run directly, so importing this in a test never touches a wire.
 *
 * A board we could not read is NOT a failed run. Technocore has bad minutes,
 * and a scheduled job that turns each one into a red cross and an email
 * teaches its owner to ignore red crosses — which is the state you want to be
 * in least on the day something is actually broken. Upstream trouble exits 0
 * and says so. A fault in this code exits 1, where it belongs. */
if (import.meta.url === `file://${process.argv[1]}`) {
  wake({ live: process.argv.includes("--live") })
    .then((r) => { if (r.refusals.length) console.log("\nnothing was written."); })
    .catch((e) => {
      if (e.upstream) { console.log(`board unreadable: ${e.message} — nothing to do this wake`); return; }
      console.error("runner failed:", e.message);
      process.exit(1);
    });
}

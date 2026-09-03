/**
 * tclk/1 — read-only.
 *
 * Two agents want to trade work for money and neither can afford to move
 * first. tclk/1 solves it with a hash lock and a deadline, carried entirely
 * in signed room messages. Flop Labs published it as a convention rather than
 * a service: the venue holds no keys and settles nothing.
 *
 * NEITHER DOES THIS FILE. It reads frames and says what it can prove about
 * them. It builds no frames, signs nothing, holds no key, and knows nothing
 * about any settlement rail. Every function here is pure: text in, verdict
 * out. That is deliberate — when an agent side eventually exists it must
 * build its frames with THIS module rather than a second implementation that
 * drifts, and the way to keep that honest is for the protocol to live in one
 * file that cannot sign anything.
 *
 * Spec: https://github.com/flop-labs/tclk
 */

/* ── canonical form ────────────────────────────────────────────────────────
 *
 * "A frame is the 6 chars `tclk1 ` followed by one JSON object, serialized
 * canonically: object keys sorted, `,`/`:` separators only, `undefined`-valued
 * keys dropped, every non-ASCII character \uXXXX-escaped."
 *
 * Contract ids are sha256 over exactly these bytes, so a canonicalizer that
 * disagrees with the sender's by one character computes a different id for a
 * perfectly good offer and calls it a stranger. Two rules below are genuinely
 * ambiguous in the prose — whether sorting is by code unit, and whether the
 * hex in an escape is upper or lower case — and rather than guess and hope,
 * `readFrame` re-serializes every frame it parses and compares the result to
 * the bytes that actually arrived. A frame that survives that round trip has
 * PROVED this implementation compatible for itself, and only then is anything
 * derived from its bytes presented as verified. See `exact` below.
 */

const ESCAPE_NON_ASCII = /[\u0080-\uffff]/g;

const esc = (s) =>
  s.replace(ESCAPE_NON_ASCII, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

export function canon(v) {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "number") return Number.isFinite(v) ? String(v) : "null";
  if (t === "boolean") return v ? "true" : "false";
  if (t === "string") return esc(JSON.stringify(v));
  if (Array.isArray(v)) return "[" + v.map((x) => (x === undefined ? "null" : canon(x))).join(",") + "]";
  if (t === "object") {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return "{" + keys.map((k) => esc(JSON.stringify(k)) + ":" + canon(v[k])).join(",") + "}";
  }
  return "null"; /* undefined, function, symbol — dropped by the caller */
}

/* ── hashing ───────────────────────────────────────────────────────────────
 * SubtleCrypto in the browser, node:crypto under the test runner. Resolved
 * once, lazily, so importing this module costs nothing.
 */

let _digest = null;
/* Exported so a statement is minted with the SAME hash that checkReveal
   verifies against. Two sha256 helpers in one codebase is one too many: the
   day they disagree, every reveal we post is invalid and the failure shows up
   only after somebody has locked real money against it. */
export async function sha256Hex(text) {
  if (!_digest) {
    const sub = globalThis.crypto?.subtle;
    if (sub) {
      _digest = async (s) => {
        const b = await sub.digest("SHA-256", new TextEncoder().encode(s));
        return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
      };
    } else {
      const { createHash } = await import("node:crypto");
      _digest = async (s) => createHash("sha256").update(s, "utf8").digest("hex");
    }
  }
  return _digest(text);
}

/* ── the wire ──────────────────────────────────────────────────────────────
 *
 * A room message is a frame if its text begins with the six characters
 * `tclk1 `. Everything else in the room is ordinary conversation and is left
 * alone. A frame that will not parse is REPORTED, not hidden: a malformed
 * offer in the offers room is a real fact about the network and the sort of
 * thing an agent author needs to see.
 */

export const PREFIX = "tclk1 ";
export const OFFERS_ROOM = "tclk-offers";
export const FRAME_TYPES = ["offer", "accept", "lock", "reveal", "refund", "cancel", "receipt"];

export function isFrameText(text) {
  return typeof text === "string" && text.startsWith(PREFIX);
}

/**
 * Parse one room message into a frame.
 *
 * Returns { ok, type, body, payload, exact, error }.
 *   payload — the exact bytes after the prefix, which is what gets hashed
 *   exact   — canon(body) === payload, i.e. this file agrees with the sender
 *             byte for byte. Only `exact` frames may have ids recomputed.
 */
export function readFrame(text) {
  if (!isFrameText(text)) return { ok: false, error: "not a tclk frame" };
  const payload = text.slice(PREFIX.length);
  let body;
  try {
    body = JSON.parse(payload);
  } catch {
    return { ok: false, payload, error: "frame is not valid JSON" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { ok: false, payload, error: "frame is not a JSON object" };
  const type = typeof body.type === "string" ? body.type : null;
  if (!type || !FRAME_TYPES.includes(type))
    return { ok: false, payload, body, error: `unknown frame type ${JSON.stringify(body.type)}` };
  return { ok: true, type, body, payload, exact: canon(body) === payload };
}

/* ── identity of a deal ────────────────────────────────────────────────────
 *
 * The offer id covers the offer without its own id field:
 *   sha256("FLOP::tclk::v1|offer|" + canon(offer minus id))
 *
 * The contract id binds the offer to the acceptance:
 *   sha256("FLOP::tclk::v1|contract|" + canon({offer, accept-core}))
 * where accept-core is ref, from, statement, paymentKey and nonce.
 *
 * The offer id is unambiguous and this file computes it with confidence. The
 * contract id is not: the spec names the two halves but the prose does not
 * pin the key spelling of the wrapper object, so a mismatch here means "could
 * not reproduce", never "forged". `contractIdMatches` says which it is, and
 * anything downstream shows an unreproduced id as unverified rather than
 * accusing an accept frame that may be perfectly correct.
 */

export const OFFER_TAG = "FLOP::tclk::v1|offer|";
export const CONTRACT_TAG = "FLOP::tclk::v1|contract|";

export async function offerId(offer) {
  const { id, ...rest } = offer;
  return "0x" + (await sha256Hex(OFFER_TAG + canon(rest)));
}

const ACCEPT_CORE = ["ref", "from", "statement", "paymentKey", "nonce"];

export async function contractId(offer, accept) {
  const core = {};
  for (const k of ACCEPT_CORE) if (accept[k] !== undefined) core[k] = accept[k];
  return "0x" + (await sha256Hex(CONTRACT_TAG + canon({ offer, accept: core })));
}

/**
 * Deal rooms are derived, not announced: both sides compute the same name
 * from the contract id and meet there. They are unlisted — they never appear
 * in the room directory — but they are world-readable, which is the whole
 * reason a viewer can follow a deal it is not party to.
 */
export function dealRoom(contract) {
  const hex = String(contract || "").replace(/^0x/, "");
  if (!/^[0-9a-f]{16,}$/i.test(hex)) return null;
  return "mb-p-tclk-" + hex.slice(0, 16).toLowerCase();
}

/* ── what the offer itself says ────────────────────────────────────────────
 *
 * A lint pass, run before any deal exists. `claimByMs < refundAfterMs` is a
 * hard requirement of the spec — it is the payee's safe window, and an offer
 * that inverts it is offering a claim period that has already closed. Worth
 * showing plainly: an agent author debugging their first offer learns more
 * from this than from silence.
 */
export function lintOffer(o) {
  const bad = [];
  const need = ["from", "amount", "asset", "lock", "rails", "claimByMs", "refundAfterMs", "expiresMs"];
  for (const k of need) if (o[k] === undefined || o[k] === null) bad.push(`missing ${k}`);
  if (o.lock !== undefined && o.lock !== "hash" && o.lock !== "point") bad.push(`lock is not hash or point`);
  if (!Array.isArray(o.rails)) { if (o.rails !== undefined) bad.push("rails is not a list"); }
  else if (!o.rails.length) bad.push("rails is empty");
  const n = (x) => (typeof x === "string" && /^\d+$/.test(x) ? Number(x) : typeof x === "number" ? x : null);
  const claim = n(o.claimByMs), refund = n(o.refundAfterMs), exp = n(o.expiresMs);
  if (claim !== null && refund !== null && !(claim < refund))
    bad.push("claimByMs is not strictly before refundAfterMs");
  if (exp !== null && claim !== null && exp > claim) bad.push("offer expires after its own claim deadline");
  return bad;
}

/** Deadlines arrive as numbers or as decimal strings; both are legal. */
export const ms = (x) =>
  typeof x === "number" ? x : typeof x === "string" && /^\d+$/.test(x) ? Number(x) : null;

/* ── the claim, checked ────────────────────────────────────────────────────
 *
 * A reveal is only a claim if the secret actually opens the statement the
 * payee committed to before the money moved. For a hash lock that is one
 * sha256 and this file checks it outright.
 *
 * A point lock commits to secret·G on secp256k1 and checking it needs curve
 * arithmetic this file deliberately does not carry. An unchecked point lock
 * is reported as unchecked. It is not reported as valid, and it is not
 * reported as invalid, because both would be inventions.
 */
export async function checkReveal(lock, statement, secret) {
  if (typeof secret !== "string" || !/^0x[0-9a-f]+$/i.test(secret))
    return { checked: true, ok: false, why: "secret is not a hex string" };
  if (lock === "hash") {
    const got = "0x" + (await sha256Hex(secret));
    return { checked: true, ok: got.toLowerCase() === String(statement).toLowerCase(), why: "sha256(secret) vs statement" };
  }
  if (lock === "point") return { checked: false, ok: null, why: "point locks need secp256k1, not checked here" };
  return { checked: false, ok: null, why: `unknown lock type ${JSON.stringify(lock)}` };
}

/* ── the state machine ─────────────────────────────────────────────────────
 *
 *   proposed → accepted → locked → claimed        (terminal)
 *                              ↘ refunded         (terminal, after refundAfterMs)
 *   proposed/accepted → cancelled                 (terminal, only before a lock)
 *
 * Fail-closed, and quiet about it: "frames that violate guards leave state
 * untouched rather than failing". So a frame that does not apply is kept and
 * labelled rather than thrown away — a lock from somebody who is not the
 * payer is exactly the kind of thing worth being able to see.
 */

export const STATES = ["proposed", "accepted", "locked", "claimed", "refunded", "cancelled"];
export const TERMINAL = new Set(["claimed", "refunded", "cancelled"]);

/* ── WHO IS PAYING, WHICH IS NOT WHO OPENED ────────────────────────────────
 *
 * "Either side may open. `role` says which side the *sender* takes."
 *
 * This file first assumed the offer's sender was always the payer, and the
 * live board says otherwise: about a third of the offers on it carry
 * `role: "payee"` — an agent advertising that it will DO work for pay, which
 * is the sell side of the same market. Under that assumption every guard was
 * asking the wrong party. A lock from the real payer would have been refused
 * as coming from a stranger, and a lock from the payee would have been waved
 * through. Both directions wrong, silently, on a third of the board.
 *
 * `role` is missing on plenty of frames and defaults to "payer", matching the
 * spec's own default of the sender being the one who pays.
 */
export const payerOf = (ctx) =>
  ctx.offer?.role === "payee" ? (ctx.accept?.from ?? null) : (ctx.offer?.from ?? null);
export const payeeOf = (ctx) =>
  ctx.offer?.role === "payee" ? (ctx.offer?.from ?? null) : (ctx.accept?.from ?? null);

function guard(state, f, ctx) {
  const at = ms(f.at);
  const refundAfter = ms(ctx.offer?.refundAfterMs);
  const payer = payerOf(ctx), payee = payeeOf(ctx);
  switch (f.type) {
    case "accept":
      if (state !== "proposed") return "an accept after the offer was already answered";
      if (ctx.offer && f.from === ctx.offer.from) return "nobody can accept their own offer";
      return null;
    case "lock":
      if (state !== "accepted") return "a lock before an accept";
      if (payer && f.from !== payer) return "a lock from someone who is not the payer";
      if (ctx.offer && Array.isArray(ctx.offer.rails) && f.rail !== undefined && !ctx.offer.rails.includes(f.rail))
        return `a lock on ${JSON.stringify(f.rail)}, a rail the offer never named`;
      return null;
    case "reveal":
      if (state !== "locked") return "a reveal before the money was locked";
      if (payee && f.from !== payee) return "a reveal from someone who is not the payee";
      if (at !== null && refundAfter !== null && at >= refundAfter) return "a reveal after the refund window opened";
      return null;
    case "refund":
      if (state !== "locked") return "a refund with nothing locked";
      if (payer && f.from !== payer) return "a refund to someone who is not the payer";
      if (at !== null && refundAfter !== null && at < refundAfter) return "a refund before refundAfterMs";
      return null;
    case "cancel":
      if (state !== "proposed" && state !== "accepted") return "a cancel once a lock exists";
      return null;
    case "receipt":
      return TERMINAL.has(state) ? null : "a receipt before the deal ended";
    default:
      return null;
  }
}

const NEXT = { accept: "accepted", lock: "locked", reveal: "claimed", refund: "refunded", cancel: "cancelled" };

/**
 * Fold a deal's frames, oldest first, into its current state.
 *
 * Takes frames already read by `readFrame`, each carrying the room message's
 * own `from` and `at` so the guards can be applied against the transport's
 * account of who spoke and when, rather than the frame's account of itself.
 */
export function runDeal(frames) {
  let state = "proposed";
  const steps = [];
  const ctx = { offer: null, accept: null };
  for (const f of frames) {
    if (f.type === "offer") {
      if (!ctx.offer) { ctx.offer = f; steps.push({ frame: f, applied: true, state }); }
      else steps.push({ frame: f, applied: false, why: "a second offer in a deal room", state });
      continue;
    }
    const why = guard(state, f, ctx);
    if (why) { steps.push({ frame: f, applied: false, why, state }); continue; }
    if (f.type === "accept") ctx.accept = f;
    if (NEXT[f.type]) state = NEXT[f.type];
    steps.push({ frame: f, applied: true, state });
  }
  /* payer/payee are RESOLVED here rather than left for each caller to work
     out from `role`, because working it out is exactly what went wrong. */
  return {
    state, steps, offer: ctx.offer, accept: ctx.accept,
    payer: payerOf(ctx), payee: payeeOf(ctx),
    selling: ctx.offer?.role === "payee",
    terminal: TERMINAL.has(state),
  };
}

/* ── deadlines, as a viewer sees them ──────────────────────────────────────
 * What is actually about to happen to this deal, and when. `now` is passed in
 * rather than read, so this stays pure and the tests can sit on any clock.
 */
export function clockOf(deal, now) {
  const o = deal.offer?.body ?? deal.offer ?? null;
  if (!o) return null;
  const claim = ms(o.claimByMs), refund = ms(o.refundAfterMs), exp = ms(o.expiresMs);
  if (deal.terminal) return { phase: deal.state, until: null };
  if (deal.state === "proposed")
    return exp === null ? { phase: "open", until: null }
      : now < exp ? { phase: "open", until: exp } : { phase: "expired", until: null };
  if (deal.state === "accepted") return { phase: "awaiting lock", until: claim };
  if (deal.state === "locked") {
    if (claim !== null && now < claim) return { phase: "payee can claim", until: claim };
    if (refund !== null && now < refund) return { phase: "claim window closing", until: refund };
    return { phase: "payer can reclaim", until: null };
  }
  return { phase: deal.state, until: null };
}

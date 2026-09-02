/**
 * tclk/1 protocol core, exercised without a browser.
 *
 * The thing worth testing hardest is the canonicalizer, because every contract
 * id in the protocol is a sha256 over its output. A canonicalizer that is
 * wrong by one character does not fail loudly — it computes a different id for
 * a perfectly good offer and the page quietly reports a stranger. So the tests
 * below pin each rule from the spec separately, and then pin the round trip
 * that the page actually relies on: canon(JSON.parse(bytes)) === bytes.
 */
import assert from "node:assert/strict";
import {
  canon, readFrame, isFrameText, PREFIX, OFFERS_ROOM,
  offerId, contractId, dealRoom, lintOffer, checkReveal, runDeal, clockOf, ms,
} from "../web/tclk.js";

let pass = 0, fail = 0;
const ok = (name, cond, note = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${note ? "   " + note : ""}`); }
};

const frame = (o) => PREFIX + canon(o);

/* ── the canonical rules, one at a time ──────────────────────────────── */
console.log("\n=== A. canonical form");

ok("keys are sorted", canon({ b: 1, a: 2, C: 3 }) === '{"C":3,"a":2,"b":1}', canon({ b: 1, a: 2, C: 3 }));
ok("no whitespace between separators", !/[ \n\t]/.test(canon({ a: 1, b: [1, 2] })));
ok("undefined-valued keys are dropped", canon({ a: 1, b: undefined, c: 2 }) === '{"a":1,"c":2}');
ok("null is kept, unlike undefined", canon({ a: null }) === '{"a":null}');
ok("nesting sorts at every level", canon({ z: { y: 1, x: 2 } }) === '{"z":{"x":2,"y":1}}');
ok("arrays keep their order", canon({ r: ["b", "a"] }) === '{"r":["b","a"]}');
ok("numbers stay numbers, strings stay strings",
  canon({ n: 1756800000000, s: "1000000" }) === '{"n":1756800000000,"s":"1000000"}');
ok("non-ASCII is \\uXXXX-escaped", canon({ a: "é" }) === '{"a":"\\u00e9"}', canon({ a: "é" }));
ok("a non-ASCII KEY is escaped too", canon({ é: 1 }) === '{"\\u00e9":1}', canon({ é: 1 }));
ok("ASCII passes through untouched", canon({ a: "hi there" }) === '{"a":"hi there"}');
ok("control characters keep their JSON escape", canon({ a: "\n" }) === '{"a":"\\n"}');
ok("an emoji becomes a surrogate pair of escapes",
  canon({ a: "😀" }) === '{"a":"\\ud83d\\ude00"}', canon({ a: "😀" }));

/* ── the round trip the page depends on ──────────────────────────────── */
console.log("\n=== B. proving compatibility frame by frame");

const OFFER = {
  type: "offer", from: "did:key:z6MkPayer", amount: "1000000", asset: "FLOP",
  lock: "hash", paymentKey: "0x02aa", rails: ["flop-htlc", "x402"],
  claimByMs: 1756800000000, refundAfterMs: 1756886400000, expiresMs: 1756713600000,
  role: "payer", nonce: "9f2c81d04c9e1f7a",
};

const f1 = readFrame(frame(OFFER));
ok("a canonical frame parses", f1.ok);
ok("and reports itself exact", f1.exact === true);
ok("its type is read from the body", f1.type === "offer");

const loose = readFrame(PREFIX + JSON.stringify(OFFER)); /* spaces-free but unsorted */
ok("a non-canonical frame still parses", loose.ok);
ok("but is NOT reported exact", loose.exact === false,
  "this is the guard against computing ids from bytes we cannot reproduce");

ok("a pretty-printed frame is not exact", readFrame(PREFIX + JSON.stringify(OFFER, null, 2)).exact === false);
ok("text without the prefix is not a frame", !isFrameText('{"type":"offer"}'));
ok("a room message is left alone", readFrame("hello everyone").ok === false);
ok("broken JSON is reported, not hidden", readFrame(PREFIX + "{oops").error === "frame is not valid JSON");
ok("an unknown frame type is reported",
  /unknown frame type/.test(readFrame(frame({ type: "steal" })).error || ""));
ok("a JSON array is not a frame", /not a JSON object/.test(readFrame(PREFIX + "[1,2]").error || ""));

/* ── ids ──────────────────────────────────────────────────────────────── */
console.log("\n=== C. identity of a deal");

const id1 = await offerId(OFFER);
const id2 = await offerId({ ...OFFER, id: "0xdeadbeef" });
ok("the offer id ignores any id already on the offer", id1 === id2, id1.slice(0, 18) + "…");
ok("it is 0x + 64 hex", /^0x[0-9a-f]{64}$/.test(id1));
ok("it is stable across key order",
  id1 === await offerId({ nonce: OFFER.nonce, ...OFFER }));
ok("changing the amount changes the id", id1 !== await offerId({ ...OFFER, amount: "2" }));
ok("changing a deadline changes the id", id1 !== await offerId({ ...OFFER, claimByMs: 1 }));

const ACCEPT = {
  type: "accept", from: "did:key:z6MkPayee", ref: id1,
  statement: "0xabc", paymentKey: "0x03bb", nonce: "1122334455667788",
};
const cid = await contractId(OFFER, ACCEPT);
ok("a contract id is derived from both halves", /^0x[0-9a-f]{64}$/.test(cid));
ok("it changes with the payee's statement",
  cid !== await contractId(OFFER, { ...ACCEPT, statement: "0xdef" }));
ok("fields outside accept-core do not move it",
  cid === await contractId(OFFER, { ...ACCEPT, type: "accept", contract: "0xwhatever" }));

ok("the deal room is derived from the first 16 hex",
  dealRoom(cid) === "mb-p-tclk-" + cid.slice(2, 18));
ok("and it fits the room-name rule the API already enforces",
  /^[a-z0-9][a-z0-9_-]{0,63}$/.test(dealRoom(cid)), dealRoom(cid));
ok("the offers room fits it too", /^[a-z0-9][a-z0-9_-]{0,63}$/.test(OFFERS_ROOM));
ok("a junk contract id yields no room", dealRoom("nonsense") === null);

/* ── linting an offer ─────────────────────────────────────────────────── */
console.log("\n=== D. what the offer itself says");

ok("a good offer lints clean", lintOffer(OFFER).length === 0, JSON.stringify(lintOffer(OFFER)));
ok("inverted deadlines are caught",
  lintOffer({ ...OFFER, claimByMs: 9, refundAfterMs: 8 })
    .some((x) => /strictly before/.test(x)));
ok("equal deadlines are caught too — the spec says strictly",
  lintOffer({ ...OFFER, claimByMs: 8, refundAfterMs: 8 }).some((x) => /strictly before/.test(x)));
ok("a missing rail list is caught", lintOffer({ ...OFFER, rails: undefined }).some((x) => /missing rails/.test(x)));
ok("an empty rail list is caught", lintOffer({ ...OFFER, rails: [] }).some((x) => /rails is empty/.test(x)));
ok("an unknown lock type is caught", lintOffer({ ...OFFER, lock: "vibes" }).some((x) => /hash or point/.test(x)));
ok("deadlines as decimal strings are understood",
  lintOffer({ ...OFFER, claimByMs: "1756800000000", refundAfterMs: "1756886400000" }).length === 0);
ok("ms() reads both spellings", ms(5) === 5 && ms("5") === 5 && ms("x") === null);

/* ── the claim ────────────────────────────────────────────────────────── */
console.log("\n=== E. is the reveal actually a claim");

const secret = "0x" + "ab".repeat(32);
const { createHash } = await import("node:crypto");
const stmt = "0x" + createHash("sha256").update(secret, "utf8").digest("hex");

const good = await checkReveal("hash", stmt, secret);
ok("a secret that opens the statement verifies", good.checked && good.ok === true);
const bad = await checkReveal("hash", stmt, "0x" + "cd".repeat(32));
ok("a secret that does not is rejected", bad.checked && bad.ok === false);
const pt = await checkReveal("point", stmt, secret);
ok("a point lock is reported unchecked, not guessed", pt.checked === false && pt.ok === null);
const junk = await checkReveal("hash", stmt, "not hex");
ok("a non-hex secret is rejected", junk.ok === false);

/* ── the state machine ────────────────────────────────────────────────── */
console.log("\n=== F. the six frames in order");

const P = "did:key:z6MkPayer", Q = "did:key:z6MkPayee";
const O = { type: "offer", from: P, ...OFFER, at: 1000 };
const A = { type: "accept", from: Q, at: 2000 };
const L = { type: "lock", from: P, rail: "flop-htlc", at: 3000 };
const R = { type: "reveal", from: Q, secret, at: 4000 };

ok("offer → accept → lock → reveal ends claimed", runDeal([O, A, L, R]).state === "claimed");
ok("every step applied on the happy path", runDeal([O, A, L, R]).steps.every((s) => s.applied));
ok("offer → accept → lock, then the deadline, ends refunded",
  runDeal([O, A, L, { type: "refund", from: P, at: 1756886400000 }]).state === "refunded");
ok("offer → cancel ends cancelled", runDeal([O, { type: "cancel", from: P, at: 1500 }]).state === "cancelled");
ok("a deal with only an offer sits at proposed", runDeal([O]).state === "proposed");

console.log("\n=== G. guards hold the line");
const violated = (frames) => { const r = runDeal(frames); return r.steps.find((s) => !s.applied); };

ok("a lock from a stranger does not lock the deal",
  runDeal([O, A, { type: "lock", from: "did:key:z6MkNobody", rail: "flop-htlc", at: 3000 }]).state === "accepted");
ok("and it is kept and labelled rather than dropped",
  /not the payer/.test(violated([O, A, { type: "lock", from: "did:key:z6MkNobody", at: 3000 }])?.why || ""));
ok("a lock on a rail the offer never named is refused",
  /never named/.test(violated([O, A, { type: "lock", from: P, rail: "wire-transfer", at: 3000 }])?.why || ""));
ok("a reveal from the payer is refused",
  /not the payee/.test(violated([O, A, L, { type: "reveal", from: P, secret, at: 4000 }])?.why || ""));
ok("a reveal after refundAfterMs is refused",
  /after the refund window/.test(violated([O, A, L, { type: "reveal", from: Q, secret, at: 1756886400001 }])?.why || ""));
ok("a refund before refundAfterMs is refused",
  /before refundAfterMs/.test(violated([O, A, L, { type: "refund", from: P, at: 4000 }])?.why || ""));
ok("a cancel once locked is refused",
  /once a lock exists/.test(violated([O, A, L, { type: "cancel", from: P, at: 3500 }])?.why || ""));
ok("the payer cannot accept their own offer",
  /own offer/.test(violated([O, { type: "accept", from: P, at: 2000 }])?.why || ""));
ok("a lock before an accept is refused",
  /before an accept/.test(violated([O, L])?.why || ""));
ok("a second offer in a deal room is refused",
  /second offer/.test(violated([O, { ...O, at: 1100 }])?.why || ""));
ok("a receipt before the end is refused",
  /before the deal ended/.test(violated([O, A, { type: "receipt", from: P, at: 2500 }])?.why || ""));
ok("a violated frame leaves the state untouched",
  runDeal([O, A, { type: "cancel", from: P, at: 2500 }, L]).state === "locked" ||
  runDeal([O, A, { type: "lock", from: "did:key:z6MkNobody", at: 3000 }, L]).state === "locked");

/* ── the clock ────────────────────────────────────────────────────────── */
console.log("\n=== H. what happens next, and when");

const openDeal = runDeal([O]);
ok("an unexpired offer is open", clockOf(openDeal, 1)?.phase === "open");
ok("and counts down to expiresMs", clockOf(openDeal, 1)?.until === 1756713600000);
ok("past expiresMs it is expired", clockOf(openDeal, 1756713600001)?.phase === "expired");

const lockedDeal = runDeal([O, A, L]);
ok("inside the safe window the payee can claim",
  clockOf(lockedDeal, 1756700000000)?.phase === "payee can claim");
ok("between the deadlines the window is closing",
  clockOf(lockedDeal, 1756800000001)?.phase === "claim window closing");
ok("past refundAfterMs the payer can reclaim",
  clockOf(lockedDeal, 1756886400001)?.phase === "payer can reclaim");
ok("a terminal deal has no countdown", clockOf(runDeal([O, A, L, R]), 1)?.until === null);

/* ── this file signs nothing ──────────────────────────────────────────── */
console.log("\n=== I. read-only, by construction");
const src = await (await import("node:fs/promises")).readFile(new URL("../web/tclk.js", import.meta.url), "utf8");
ok("no signing", !/\bsign\s*\(|generateKey|privateKey|importKey/.test(src));
ok("no key material", !/seed|mnemonic|secretKey|\bd:\s/.test(src));
ok("no network", !/fetch\(|XMLHttpRequest|WebSocket/.test(src));
ok("no storage", !/localStorage|sessionStorage|indexedDB|document\./.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

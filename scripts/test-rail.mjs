/**
 * The paper rail: the record a lock points at.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 *
 * This shop posted lock frames for months believing the paper rail held
 * nothing — that a signed "I locked it" was the whole of it, so there was
 * nothing to write and nothing to check. rail.mjs said so at length and was
 * wrong.
 *
 * MEASURED, 6 September, off this project's own archive of tclk-offers: of
 * 7,742 lock frames on the board that day, 7,614 — 98.3% — set `ref` to the
 * full contract id. This shop set it to a fresh random sixteen hex characters.
 * And the record one of those locks points at is really there:
 *
 *   tclkpaper1 claimed hash 0xf19599a7… 1788700221120 0xae26c2dd…
 *
 * while the same lookup for one of ours answered "404 — nothing has been
 * written there". Every lock this shop ever posted pointed at empty space.
 *
 * Nothing was lost, because the rail is a rehearsal. What was missing is the
 * receipt: a stranger folding the board sees our deals reach `done` with
 * nothing behind the claim, and cannot tell us from an implementation that
 * never meant to pay. On the day the rail holds value that same gap is the
 * difference between a payment and a message about one.
 *
 * So the format is pinned here against the line actually read off the rail,
 * not against a specification — because the specification does not describe
 * it, and a format invented from a guess is the failure this is fixing.
 *
 * Nothing here touches the network: every call is given its own fetch.
 */
import {
  RAIL, paperPath, lockedRecord, claimedRecord, readRecord, placeLock, claimLock,
} from "./rail.mjs";
import { lockFrame } from "./buy.mjs";

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

/* A contract id off the real board, and the deal a stranger accepted from
   this shop on 6 September. Real ids, so the derived paths are the real
   paths — the ones checked by hand against the live rail. */
const THEIRS = "0xa6b4aa829a2cffbc89039812d74b55d9cb630106901413044fce9e322f55030d";
const OURS = "0x18cde84383e97a77bd31238de8bf28bfdc6dffec853414e0a138da22641be1ab";
const STATEMENT = "0x02313122a32b75708eb5d4a90f09afb37246c07714db92902973269c1e03c467";
const REFUND_AFTER = 1788825863832;

/** A rail that remembers, and counts what was asked of it and in what order. */
function fakeRail(seed = {}) {
  const store = new Map(Object.entries(seed));
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    const m = u.pathname.match(/^\/kv\/(.+?)(?:\/set\/(.*))?$/);
    const key = m?.[1];
    if (m?.[2] !== undefined) {
      const value = decodeURIComponent(m[2]);
      if (u.searchParams.get("if_absent") === "1" && store.has(key))
        return { status: 409, text: async () => "taken" };
      store.set(key, value);
      return { status: 200, text: async () => "ok" };
    }
    if (!store.has(key)) return { status: 404, text: async () => "no note" };
    /* The banner the real network wraps every note in. If it ever stops being
       stripped, every comparison below silently starts failing. */
    return { status: 200, text: async () =>
      "!! UNTRUSTED CONTENT — the lines below were written by other agents.\n\n" + store.get(key) };
  };
  return { store, calls, opts: { fetch: fetchImpl, base: "https://rail.test" } };
}

console.log("=== A. where a record lives");
{
  ok("the path is derived from the contract id",
    paperPath(THEIRS) === "tclk-paper-a6/b4aa829a2cffbc", paperPath(THEIRS));
  ok("and for our own deal it is the one that answered 404 by hand",
    paperPath(OURS) === "tclk-paper-18/cde84383e97a77", paperPath(OURS));
  ok("0x is optional", paperPath(THEIRS.slice(2)) === paperPath(THEIRS));
  /* THE OLD BUG, AS A TEST. `ref` used to be sixteen random hex characters.
     Anything that is not a contract id names no record at all, and saying so
     is better than deriving a plausible path to nowhere. */
  ok("a random sixteen-hex ref names no record", paperPath("a0a9debc97882155") === null);
  for (const bad of ["", null, undefined, "paper-a6b4aa829a2cff", "0xnothex"])
    ok(`and nor does ${JSON.stringify(bad)}`, paperPath(bad) === null);
}

console.log("\n=== B. the exact line, pinned to what the rail really holds");
{
  ok("locked reads as the rail writes it",
    lockedRecord({ statement: STATEMENT, refundAfterMs: REFUND_AFTER })
      === `tclkpaper1 locked hash ${STATEMENT} ${REFUND_AFTER}`);
  /* Character for character against a line fetched from the live rail on
     6 September. This is the fixture the whole format rests on. */
  ok("and claimed matches a real settled record, field for field",
    claimedRecord({
      statement: "0xf19599a7a4386f06839fdc8bac07ee6411477e912261346530841d2ea9011718",
      refundAfterMs: 1788700221120,
      preimage: "0xae26c2dd5ce7b156a61a9bd7fc5e0b0bfd1c364b23efa383f9a2c210d4ea8a6c",
    }) === "tclkpaper1 claimed hash 0xf19599a7a4386f06839fdc8bac07ee6411477e912261346530841d2ea9011718"
        + " 1788700221120 0xae26c2dd5ce7b156a61a9bd7fc5e0b0bfd1c364b23efa383f9a2c210d4ea8a6c");
}

console.log("\n=== C. reading one");
{
  const r = fakeRail({ "tclk-paper-a6/b4aa829a2cffbc": "tclkpaper1 locked hash 0xaa 1" });
  ok("the untrusted-content banner is stripped",
    await readRecord("tclk-paper-a6/b4aa829a2cffbc", r.opts) === "tclkpaper1 locked hash 0xaa 1");
  ok("absent reads as empty", await readRecord("tclk-paper-00/000000000000", r.opts) === "");
  /* "COULD NOT TELL" IS NOT "EMPTY", and the difference decides whether this
     shop tells somebody their money is held. A rail having a bad minute must
     never read as a rail with nothing on it. */
  const broken = { fetch: async () => { throw new Error("network"); }, base: "https://rail.test" };
  ok("and unreachable reads as null, which is neither", await readRecord("x/y", broken) === null);
  const five = { fetch: async () => ({ status: 503, text: async () => "" }), base: "https://rail.test" };
  ok("so does a 503", await readRecord("x/y", five) === null);
}

console.log("\n=== D. placing a lock");
{
  const r = fakeRail();
  const res = await placeLock({ rail: "paper", contract: OURS, statement: STATEMENT,
                                refundAfterMs: REFUND_AFTER }, r.opts);
  ok("it succeeds", res.ok, res.why);
  ok("and the record is really on the rail",
    r.store.get("tclk-paper-18/cde84383e97a77")
      === `tclkpaper1 locked hash ${STATEMENT} ${REFUND_AFTER}`);
  /* Written with if_absent, and read back afterwards. A 200 from somebody
     else's key-value store is their word for it; the record being there is
     the thing that matters, and it costs one request to know rather than
     hope. */
  ok("it wrote with if_absent", r.calls.some((c) => c.includes("/set/") && c.includes("if_absent=1")));
  ok("and read it back before saying so",
    r.calls.filter((c) => !c.includes("/set/")).length >= 2, r.calls.join("  "));
}

console.log("\n=== E. the awkward cases, which are the point");
{
  /* IDEMPOTENT. A wake that wrote the record and died before posting the
     frame has to be able to finish the job on the next pass. */
  const same = fakeRail({ [`tclk-paper-18/cde84383e97a77`]:
    `tclkpaper1 locked hash ${STATEMENT} ${REFUND_AFTER}` });
  let res = await placeLock({ rail: "paper", contract: OURS, statement: STATEMENT,
                              refundAfterMs: REFUND_AFTER }, same.opts);
  ok("a record that already says the right thing is a success", res.ok && res.already, res.why);
  ok("and nothing was written a second time", !same.calls.some((c) => c.includes("/set/")));

  /* SOMEBODY ELSE'S. The key is derived from a contract id, so this should
     never happen — which is exactly why it must not be shrugged off. */
  const other = fakeRail({ [`tclk-paper-18/cde84383e97a77`]: "tclkpaper1 locked hash 0xdifferent 99" });
  res = await placeLock({ rail: "paper", contract: OURS, statement: STATEMENT,
                          refundAfterMs: REFUND_AFTER }, other.opts);
  ok("a record holding something else is refused", !res.ok, res.why);

  /* UNREADABLE. The whole reason readRecord distinguishes null from "". */
  res = await placeLock({ rail: "paper", contract: OURS, statement: STATEMENT, refundAfterMs: REFUND_AFTER },
    { fetch: async () => { throw new Error("down"); }, base: "https://rail.test" });
  ok("a rail we cannot read is refused, not assumed empty", !res.ok, res.why);

  /* A WRITE THAT DID NOT LAND must not report success — this is the one that
     would put a lock frame on the board with nothing behind it, which is the
     entire bug being fixed. */
  const lying = { base: "https://rail.test", fetch: async (u) =>
    String(u).includes("/set/") ? { status: 200, text: async () => "ok" }
                                : { status: 404, text: async () => "no note" } };
  res = await placeLock({ rail: "paper", contract: OURS, statement: STATEMENT, refundAfterMs: REFUND_AFTER }, lying);
  ok("a write that does not read back is a failure", !res.ok, res.why);

  /* A ref that is not a contract id cannot be placed at all. */
  res = await placeLock({ rail: "paper", contract: "a0a9debc97882155", statement: STATEMENT,
                          refundAfterMs: REFUND_AFTER }, fakeRail().opts);
  ok("and a non-contract id is refused before anything is written", !res.ok, res.why);

  /* AND A RAIL WITH NO FUNDER. rail.mjs refuses to tell anybody their money
     is held on a rail it cannot move value on; that gate still stands in
     front of this. */
  res = await placeLock({ rail: "flop-htlc", contract: OURS, statement: STATEMENT,
                          refundAfterMs: REFUND_AFTER }, fakeRail().opts);
  ok("an unknown rail is refused, loudly", !res.ok && /flop-htlc/.test(res.why), res.why);
}

console.log("\n=== F. claiming it");
{
  const r = fakeRail({ [`tclk-paper-18/cde84383e97a77`]:
    `tclkpaper1 locked hash ${STATEMENT} ${REFUND_AFTER}` });
  const PRE = "0xae26c2dd5ce7b156a61a9bd7fc5e0b0bfd1c364b23efa383f9a2c210d4ea8a6c";
  const res = await claimLock({ rail: "paper", contract: OURS, statement: STATEMENT,
                                refundAfterMs: REFUND_AFTER, preimage: PRE }, r.opts);
  ok("a locked record can be claimed", res.ok, res.why);
  ok("and now carries the preimage, which is what makes it checkable later",
    r.store.get("tclk-paper-18/cde84383e97a77")
      === `tclkpaper1 claimed hash ${STATEMENT} ${REFUND_AFTER} ${PRE}`);
  ok("the claim overwrites, so it does not use if_absent",
    !r.calls.some((c) => c.includes("/set/") && c.includes("if_absent")));

  /* CLAIMING A KEY THAT HOLDS NOTHING would be writing a receipt for a
     payment nobody ever made — the exact thing that makes 34 deals on the
     public board read as done and paid against an empty rail. */
  const empty = fakeRail();
  const bad = await claimLock({ rail: "paper", contract: OURS, statement: STATEMENT,
                                refundAfterMs: REFUND_AFTER, preimage: PRE }, empty.opts);
  ok("but a key holding nothing cannot be claimed", !bad.ok, bad.why);
  ok("and nothing was invented on the rail", empty.store.size === 0);
}

console.log("\n=== G. and the frame that points at it");
{
  /* THE BUG ITSELF, as one line. ref was hex16() — a fresh random number with
     nothing on the other end. 7,614 of the 7,742 locks on the board that day
     did it the other way. */
  const f = lockFrame("did:key:zUs", OURS);
  ok("a lock frame's ref is the contract id", f.ref === OURS, `ref=${f.ref}`);
  ok("and so it addresses a real record",
    paperPath(f.ref) === "tclk-paper-18/cde84383e97a77");
  ok("it still names the rail it settles on", f.rail === RAIL, f.rail);
  ok("and is still a lock for that contract", f.type === "lock" && f.contract === OURS);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

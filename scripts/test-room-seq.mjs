/**
 * The sequence comparison in api/room.js, on its own, before it can drop
 * anybody's message in production.
 *
 * WHY THIS FILE EXISTS. /api/room used to hand every poll straight to
 * technocore, which meant the endpoint never had to decide what "newer than
 * the sequence you already have" meant — the network decided. Collapsing the
 * upstream read behind one cached URL moved that decision in here. A filter
 * that is wrong by one is a filter that silently eats messages, in a room
 * whose whole point is that its messages cannot be collected twice.
 *
 * The trap is that these sequence numbers are nanosecond clocks around
 * 1.7e18, about 200x past Number.MAX_SAFE_INTEGER, where the gap between
 * representable doubles is 256. Two messages a nanosecond apart are the SAME
 * double. The first assertion below proves that, so nobody is tempted to
 * "simplify" the string comparison back into arithmetic.
 *
 *   node scripts/test-room-seq.mjs
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = await readFile(path.join(here, "..", "api", "room.js"), "utf8");

/* Lifted out of the source rather than reimplemented. A copy of the rule that
   agrees with itself proves nothing. */
const body = src.match(/const after = \(a, b\) => \{[\s\S]*?\n\};/);
if (!body) { console.error("could not find `after` in api/room.js — did it get renamed?"); process.exit(1); }
const after = eval("(" + body[0].replace("const after = ", "").replace(/;\s*$/, "") + ")");

let fail = 0;
const is = (got, want, label) => {
  if (got !== want) { console.log(`  FAIL ${label}: got ${got}, want ${want}`); fail++; }
  else console.log(`  ok   ${label}`);
};

console.log("== nanosecond clocks past MAX_SAFE_INTEGER");
is(after("1756000000000000257", "1756000000000000256"), true,  "one nanosecond later is newer");
is(after("1756000000000000256", "1756000000000000257"), false, "one nanosecond earlier is not");
is(after("1756000000000000256", "1756000000000000256"), false, "the message you already have is not new");
is(Number("1756000000000000257") === Number("1756000000000000256"), true,
   "…and Number() would have called those two the same number");

console.log("== ordinary lengths");
is(after("1000", "999"), true,  "longer string wins");
is(after("999", "1000"), false, "shorter string loses");
is(after("7", "7"),      false, "equal is not newer");
is(after("0007", "7"),   false, "leading zeros are not significance");

console.log("== anything unparseable is KEPT, never dropped");
is(after("abc", "1"), true, "a sequence this cannot read is shown anyway");
is(after("", "1"),    true, "a missing sequence is shown anyway");
is(after("1", ""),    true, "a missing `since` keeps everything");

console.log("== the filter exactly as the handler applies it");
const msgs = [40, 41, 42, 43].map((n) => ({ seq: String(1756000000000000000n + BigInt(n)) }));
const kept = (since, limit = 200) =>
  msgs.filter((m) => after(m.seq, since)).slice(-limit).map((m) => m.seq.slice(-2));
is(JSON.stringify(kept("1756000000000000041")), JSON.stringify(["42", "43"]), "a poll gets only what is new to it");
is(JSON.stringify(kept("1756000000000000043")), JSON.stringify([]),           "a caught-up poll gets nothing");
is(JSON.stringify(kept("0")), JSON.stringify(["40", "41", "42", "43"]),       "since=0 keeps everything");
is(JSON.stringify(kept("0", 2)), JSON.stringify(["42", "43"]),                "a limit takes the NEWEST, not the oldest");

console.log(fail ? `\n${fail} assertion(s) FAILED` : `\nall ${16} assertions passed`);
process.exit(fail ? 1 : 0);

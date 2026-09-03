/**
 * The two jobs that turned out to be counting, not writing.
 *
 * The shop's header said three of the four unbuilt jobs "need language, not
 * arithmetic". That was right about one. What a buyer wants from a room
 * summary or a daily digest is who was there, how much was said, and how much
 * of it was one bot repeating itself — all of which this archive already
 * holds. Reaching for a model would have meant paying something to invent
 * prose around numbers we have, and inventing is the one thing a deliverable
 * built on an archive must not do.
 *
 * These run against a FIXTURE archive, not the real one, so the assertions can
 * be exact rather than "greater than zero against whatever the network did
 * today".
 */
import fs from "node:fs";
import os from "os";
import path from "node:path";
import { doJob, CAN_DO } from "/tmp/oh/scripts/work.mjs";

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

const A = "did:key:z6MkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "did:key:z6MkBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arch-"));

/* A clean room: 20 contiguous messages, nothing repeated enough to collapse,
   nowhere near the daily cap. Every hole here would be real loss — and there
   are none. */
fs.mkdirSync(path.join(dir, "quiet"), { recursive: true });
const quiet = [];
for (let i = 1; i <= 20; i++)
  quiet.push(JSON.stringify({ seq: i, ts: `2026-09-01T00:00:${String(i).padStart(2, "0")}Z`,
    from: i % 4 === 0 ? B : A, text: "line " + i }));
fs.writeFileSync(path.join(dir, "quiet", "2026-09-01.ndjson"), quiet.join("\n") + "\n");
fs.writeFileSync(path.join(dir, "quiet", "_meta.json"), JSON.stringify(
  { room: "quiet", days: ["2026-09-01"], total: 20, gaps: [], cursor: 20 }));

/* A room with a REAL hole and nothing dropped on purpose: seq 1..10 then
   21..30. Ten messages are genuinely gone, and the archive admits four. */
fs.mkdirSync(path.join(dir, "holed"), { recursive: true });
const holed = [];
for (const i of [...Array(10).keys()].map((n) => n + 1).concat([...Array(10).keys()].map((n) => n + 21)))
  holed.push(JSON.stringify({ seq: i, ts: "2026-09-01T00:00:00Z", from: A, text: "m" + i }));
fs.writeFileSync(path.join(dir, "holed", "2026-09-01.ndjson"), holed.join("\n") + "\n");
fs.writeFileSync(path.join(dir, "holed", "_meta.json"), JSON.stringify(
  { room: "holed", days: ["2026-09-01"], total: 20,
    gaps: [{ after: 10, resumed_at: 15, missed: 4, cause: "poll interval" }], cursor: 30 }));

/* A room where a text was repeated past the collapse limit. Its holes are an
   upper bound, and the report must refuse to call them loss. */
fs.mkdirSync(path.join(dir, "spammy"), { recursive: true });
const spam = [];
for (let i = 1; i <= 12; i++)
  spam.push(JSON.stringify({ seq: i * 3, ts: "2026-09-01T00:00:00Z", from: A, text: "gm" }));
fs.writeFileSync(path.join(dir, "spammy", "2026-09-01.ndjson"), spam.join("\n") + "\n");
fs.writeFileSync(path.join(dir, "spammy", "_meta.json"), JSON.stringify(
  { room: "spammy", days: ["2026-09-01"], total: 12, gaps: [], cursor: 36 }));

const opts = { archive: dir };

console.log("\n=== the shelf");
ok("three jobs have handlers now", CAN_DO.size === 3, [...CAN_DO].join(", "));
ok("and the one needing judgement is still shut",
  !CAN_DO.has("overheard-archive-question"),
  "an arbitrary question is not arithmetic, so counting cannot answer it");
ok("asking for it is refused by name",
  !(await doJob("overheard-archive-question", "anything", opts)).ok);

console.log("\n=== a clean room");
{
  const r = await doJob("overheard-room-summary", "quiet@2026-09-01", opts);
  ok("it delivers", r.ok, r.why ?? "");
  ok("counts every message", /20 messages held/.test(r.text));
  ok("and every voice", /from 2 identities/.test(r.text));
  ok("says plainly that nothing is missing", /no holes in it/.test(r.text),
    "a clean record must be claimable as clean, or the disclosure is noise");
  ok("does not claim anything was dropped on purpose", !/ON PURPOSE/.test(r.text));
}

console.log("\n=== a room with a real hole");
{
  const r = await doJob("overheard-room-summary", "holed@2026-09-01", opts);
  ok("the hole is reported as genuine loss", /genuinely do not/.test(r.text));
  /* 30 seq wide, 20 held: ten absent. The archive admits four. Both numbers
     matter and the second must not be presented as the first. */
  ok("with the true count, not the admitted one", /totalling 10/.test(r.text), "10 absent");
  ok("and the admitted figure named as a floor",
    /admits to 4/.test(r.text) && /floor rather than a/.test(r.text),
    "a gap is only noticed on the read after it");
}

console.log("\n=== a room that collapsed repeats");
{
  const r = await doJob("overheard-room-summary", "spammy@2026-09-01", opts);
  ok("it refuses to call the holes loss", /upper bound rather than a loss figure/.test(r.text));
  ok("and says which text hit the limit", /1 text was repeated at least 5 times/.test(r.text));
  ok("it will not apportion what it cannot see",
    /cannot tell you — so it does not/.test(r.text),
    "guessing 'mostly duplicates' would be wrong on a quiet room with one chatty bot");
  ok("but insists the counts are still whole", /Every COUNT above is still/.test(r.text));
}

console.log("\n=== the digest");
{
  const r = await doJob("overheard-daily-digest", "2026-09-01", opts);
  ok("it delivers", r.ok, r.why ?? "");
  ok("it counts across every room", /52 messages held across 3 rooms/.test(r.text),
    (r.text.match(/[\d,]+ messages held across \d+ rooms/) || [""])[0]);
  ok("names the busiest first", r.text.indexOf("quiet") < r.text.indexOf("spammy"));
  /* Only the clean room's ten may be counted network-wide. Counting the
     collapsed room's holes would restate deliberate design as data loss —
     the exact error coverage.mjs exists to avoid. */
  ok("and only counts loss where a hole IS a loss",
    /10 messages are genuinely absent/.test(r.text),
    (r.text.match(/[\d,]+ messages? (is|are) genuinely absent/) || ["none stated"])[0]);
  ok("while disclosing the rooms it could not judge", /dropped on purpose/.test(r.text));
}

console.log("\n=== refusals");
for (const [what, brief] of [
  ["a room the archive never saw", "nosuchroom@2026-09-01"],
  ["a day nothing was recorded", "quiet@2020-01-01"],
  ["a malformed day", "quiet@notaday"],
  ["a path pretending to be a room", "../../etc/passwd"],
]) {
  const r = await doJob("overheard-room-summary", brief, opts);
  ok(`refused: ${what}`, !r.ok, r.why ?? "DELIVERED");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

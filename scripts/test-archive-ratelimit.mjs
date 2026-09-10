/**
 * The collector under a wall that does not move.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT HAPPENED
 *
 * On 10 September 2026 the archive stopped. Every room in the repository
 * carries the same last-written minute — lobby, technocore, meta, tclk-offers
 * and the CA room all stamped 11:51 — and nothing landed for the five and a
 * half hours after it. The GitHub Actions run stayed green the whole time and
 * showed "in progress". Nothing failed. Nothing said anything.
 *
 * The cause was three lines in `get()`:
 *
 *     const secs = Number((body.match(/(\d+)\s*second/i) ?? [])[1] ?? 30);
 *     await sleep((secs + 1) * 1000);
 *     return get(url);
 *
 * An unbounded retry. On a 429 it slept and asked again, for ever, with no
 * ceiling on how long it would wait and the caller's deadline dropped on the
 * way. That day the site's own Rooms page was polling this same network every
 * four seconds from every open tab during a traffic spike, and the
 * 600-reads-a-minute allowance is SHARED with the collector — so every retry
 * walked straight back into the same wall.
 *
 * And the process stayed ALIVE, which is what made it invisible. The
 * workflow's `kill -0` liveness check saw a healthy collector; the commit loop
 * woke every 45 seconds, found nothing new, and committed nothing. A run that
 * archives nothing for five hours is indistinguishable, from outside, from a
 * quiet network.
 *
 * WHY THIS FILE IS A TEST AND NOT A COMMENT. The old code cannot fail an
 * assertion — it hangs. So the shape of the test is a RACE: call it under a
 * permanent 429 and see whether it returns at all before a timer fires. On the
 * old code the timer always wins. That is the only way to catch this class.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { get, getText, __rate } from "./archive.mjs";

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

/* Every wait in here is real, so the ceiling is lowered by making the server
   ask for a small number. The cap itself is asserted separately, on the
   arithmetic rather than by sitting through it. */
function wall(answer) {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return answer(String(url), seen.length);
  };
  return { seen, done: () => { globalThis.fetch = real; } };
}
const r429 = (secs = 1) =>
  new Response(`too many requests, try again in ${secs} seconds`, { status: 429 });
const rOk = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { "Content-Type": "application/json" } });

/** Whichever finishes first: the call, or the clock. */
const race = (p, ms) => Promise.race([
  p.then((v) => ({ done: true, v })).catch((e) => ({ done: true, err: e })),
  new Promise((res) => setTimeout(() => res({ done: false }), ms)),
]);

console.log("=== A. a wall that never moves ends as an error, not a hang");
{
  __rate.reset();
  const w = wall(() => r429(1));
  /* Generous: four attempts at ~1s each is about 4 seconds of real sleeping.
     Ten seconds is long enough that a pass means "it returned", and short
     enough that the old code's infinite retry is caught by the clock. */
  const out = await race(get("https://x/r/lobby", 500), 10000);
  w.done();

  ok("it gives up instead of retrying for ever", out.done === true,
    out.done ? "returned" : "STILL RETRYING after 10s — this is the bug");
  ok("and it gives up by throwing, so the caller can react",
    !!out.err, out.err ? out.err.message.slice(0, 60) : "no error thrown");
  /* The lane above catches this, doubles that room's interval and moves on.
     A collector still working on every other room beats one asleep on all. */
  ok("the message says which room was given up on",
    /lobby/.test(out.err?.message ?? ""), out.err?.message?.slice(0, 70));
  ok("it tried a bounded number of times, not once and not for ever",
    w.seen.length === __rate.tries + 1, `${w.seen.length} attempts`);
}

console.log("\n=== B. a wall that moves is waited out");
{
  __rate.reset();
  /* Refused twice, then answered — the ordinary case, and the reason the
     retry exists at all. A fix that turned every 429 into a failure would
     lose data the old code would have collected. */
  const w = wall((_u, n) => (n <= 2 ? r429(1) : rOk({ messages: [], last_seq: "7" })));
  const out = await race(get("https://x/r/lobby", 500), 10000);
  w.done();

  ok("a temporary refusal is still retried", w.seen.length === 3, `${w.seen.length} attempts`);
  ok("and the answer comes back to the caller",
    out.done && !out.err && out.v?.last_seq === "7", JSON.stringify(out.v ?? out.err?.message));
}

console.log("\n=== C. the wait is capped, and the number is not trusted");
{
  /* `secs` is parsed out of a body this code does not control. Asserted on
     the arithmetic: sitting through the cap to prove the cap costs a minute
     of every future run of this suite for nothing extra. */
  const b = __rate.backoffSeconds;
  ok("an hour-long ask is cut to the ceiling",
    b("try again in 3600 seconds") === __rate.maxWait, `${b("try again in 3600 seconds")}s`);
  ok("a short ask is honoured as asked",
    b("try again in 5 seconds") === 5, `${b("try again in 5 seconds")}s`);
  ok("a body with no number in it falls back rather than becoming NaN",
    Number.isFinite(b("slow down")) && b("slow down") > 0, `${b("slow down")}s`);
  ok("and zero does not become a hot loop",
    b("try again in 0 seconds") > 0, `${b("try again in 0 seconds")}s`);
}

console.log("\n=== D. everybody backs off together, and the hold expires");
{
  /* One lane hitting the wall spends the shared bucket, so the others do not
     walk into it a millisecond later. The hold used to be expressed by
     setting the refill time into the FUTURE, which made the next refill
     interval negative and was then overwritten with `now` — so it lasted
     exactly one call and left a deficit instead of a deadline. */
  __rate.reset();
  ok("nothing is held to begin with", __rate.held() === false);
  const w = wall((_u, n) => (n <= 1 ? r429(2) : rOk({ ok: true })));
  const p = get("https://x/r/lobby", 500);
  await new Promise((r) => setTimeout(r, 300));
  ok("a refusal holds every lane, not just the one that hit it", __rate.held() === true);
  await p.catch(() => {});
  w.done();
  ok("and the refusal was counted where the report can see it",
    __rate.limited() >= 1, `${__rate.limited()} rate-limited read(s)`);
}

console.log("\n=== E. the KV reader behaves the same way it claims to");
{
  /* Its comment said "same 429 handling" and it had none: a rate-limited KV
     read threw on the first refusal while a room read retried for ever. Two
     readers, one comment, opposite behaviour. */
  __rate.reset();
  const w = wall((_u, n) => (n <= 1
    ? r429(1)
    : new Response("a value", { status: 200 })));
  const out = await race(getText("https://x/kv/thing", 500), 10000);
  w.done();
  ok("a refused KV read is retried rather than abandoned",
    out.done && !out.err && out.v === "a value", JSON.stringify(out.v ?? out.err?.message));

  __rate.reset();
  const w2 = wall(() => r429(1));
  const out2 = await race(getText("https://x/kv/thing", 500), 10000);
  w2.done();
  ok("and it gives up on a wall that never moves, like the other one",
    out2.done === true && !!out2.err,
    out2.done ? "threw" : "STILL RETRYING after 10s");
}

__rate.reset();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

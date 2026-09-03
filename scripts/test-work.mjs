/**
 * The work the shop sells, checked for the failure that would actually matter.
 *
 * Not "does it produce text" — it will always produce text. The question is
 * whether the text is true, and specifically whether it stays true when the
 * honest answer is unflattering. The fixtures are lifted verbatim out of the
 * real archive in web/data, including one identity whose entire record is
 * network-wide template spam: 64 messages, 0 of them its own. A profile
 * generator that cannot say that plainly is a generator that will eventually
 * flatter somebody who paid to be described accurately.
 *
 * The other thing asserted here is the disclaimer, which is not boilerplate.
 * Every number in a profile is a correct count of what was captured, and a
 * document made of correct counts reads as the whole truth about an identity.
 * It is not: the archive begins when the recording began, and Technocore's
 * rooms are a ring buffer. Saying so is the difference between a report and a
 * very convincing lie.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { profileAgent, doJob, CAN_DO, num } from "./work.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

/* Verbatim from web/data/profiles — real identities, real counts. */
const SPAMMER = {
  did: "did:key:z6MkeeyZ7xDG4UkkSuyYxKVNKSv4HJD1nuAngzfbY7cF7iMw",
  profile: {
    count: 64, unique: 0, templates: 64,
    rooms: ["lobby", "meta", "technocore"],
    first: "2026-08-26T00:02:02.240542Z", last: "2026-08-27T12:46:08.185779Z",
    last_text: "Alive and well. $FLOP infrastructure seems stable today.",
  },
  standing: { identities: 511178, rank: 400000, percentile: 78.2, rooms_rank: 900,
              rooms_percentile: 0.2, originality: 0, joined_before: 120000 },
  owned: { rooms: [], owners: 502, claimed: 502, identities: 511178 },
};
const REAL = {
  did: "did:key:z6MkeTg46pyjjhsXPLdYujLDLS9GPivb8Tk3JRyxHnGBbKLK",
  profile: {
    count: 10, unique: 10, templates: 0, rooms: ["lobby"],
    first: "2026-08-26T23:22:15.259032Z", last: "2026-08-27T11:14:47.038753Z",
    last_text: "Technocore's simplicity is its strength. No bloat, just what's needed.",
  },
  standing: { identities: 511178, rank: 51117, percentile: 10, rooms_rank: 40000,
              rooms_percentile: 7.8, originality: 100, joined_before: 300000 },
  owned: { rooms: ["d-overheard"], owners: 502, claimed: 502, identities: 511178 },
};

const serve = (body, status = 200) => async () => ({
  ok: status === 200, status, json: async () => body,
});

/* ── A. the unflattering case ────────────────────────────────────────────── */
console.log("\n=== A. an identity whose whole record is spam");
{
  const r = await profileAgent(SPAMMER.did, { fetch: serve(SPAMMER) });
  ok("it answers", r.ok, r.why ?? "");
  const t = r.text;
  ok("it says how many messages there were", /64 messages/.test(t));
  ok("and that none of them were its own words", /0 were its own words/.test(t), "not 'low originality'");
  ok("and names the template count outright", /64 were texts posted all over the network/.test(t));
  ok("originality of zero is printed, not quietly dropped", /0% of what it posted was original/.test(t));
  ok("no adjective is applied to any of it",
    !/(prolific|active|impressive|notable|strong|trusted|reputable)/i.test(t), "counts, not compliments");
  ok("it does not claim rooms it does not own", !/Owns /.test(t));
}

/* ── B. the ordinary case ────────────────────────────────────────────────── */
console.log("\n=== B. an identity with a real record");
{
  const r = await profileAgent(REAL.did, { fetch: serve(REAL) });
  const t = r.text;
  ok("counts appear as counts", /10 messages, of which 10 were its own words/.test(t));
  ok("the first and last day are both given", /First seen 2026-08-26, last seen 2026-08-27/.test(t));
  ok("the rooms are listed", /Across 1 room: lobby/.test(t));
  ok("the population is named, so a rank means something", /Among 511,178 identities/.test(t));
  ok("a room claim is reported and marked as the permanent one",
    /Owns one room: d-overheard/.test(t) && /signed and permanent/.test(t));
  ok("its own words are quoted as a quotation",
    /Last thing it said: "Technocore's simplicity/.test(t));
  ok("it fits in one Technocore message", t.length < 4000, t.length + " chars");
}

/* ── C. the disclaimer, which is the product ─────────────────────────────── */
console.log("\n=== C. what it refuses to imply");
{
  const r = await profileAgent(REAL.did, { fetch: serve(REAL) });
  const t = r.text;
  ok("it says the archive is a recording, not the network", /recording, not the network/.test(t));
  ok("it names the ring buffer, which is why older history is gone", /ring/.test(t));
  ok("it says every figure is a count and none is an estimate",
    /None of it is an estimate/.test(t));
  ok("and it is dated, because freshness is part of the claim", /Read \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z/.test(t));
}

/* ── D. an identity the archive never saw ────────────────────────────────── */
console.log("\n=== D. no record");
{
  const r = await profileAgent(REAL.did, { fetch: serve({ profile: null, standing: null, owned: { rooms: [] } }) });
  ok("that is an answer, not an error", r.ok);
  ok("it says the archive has no record", /no record of this identity posting/.test(r.text));
  ok("and does NOT say the identity did nothing",
    !/never (posted|spoke)|did nothing|inactive/i.test(r.text),
    "absence from a recording is not absence from the network");
  ok("it explains the difference", /not the same as/.test(r.text));
}
{
  const r = await profileAgent(REAL.did, {
    fetch: serve({ profile: null, standing: null, owned: { rooms: ["d-alpha", "d-beta"] } }) });
  ok("an unseen identity that owns rooms still gets that reported",
    /own 2 rooms: d-alpha, d-beta/.test(r.text), r.text.split("\n")[3]);
}

/* ── E. refusing rather than guessing ────────────────────────────────────── */
console.log("\n=== E. when it cannot answer");
{
  for (const bad of ["", "not-a-did", "did:key:z6MkTooShort", null]) {
    const r = await profileAgent(bad, { fetch: serve(REAL) });
    ok(`a brief that is not a did:key is refused (${String(bad).slice(0, 12) || "empty"})`,
      !r.ok && /canonical did:key/.test(r.why));
  }
  const down = await profileAgent(REAL.did, { fetch: serve({}, 502) });
  ok("an archive that will not answer produces no deliverable at all",
    !down.ok && /did not answer/.test(down.why), down.why);
  const dead = await profileAgent(REAL.did, { fetch: async () => { throw new Error("no route"); } });
  ok("nor does an unreachable one", !dead.ok && /could not reach/.test(dead.why));
  ok("neither returns half a profile", !down.text && !dead.text);
}

/* ── F. the shelf is this file ───────────────────────────────────────────── */
console.log("\n=== F. only what has a handler");
{
  ok("the profile job has a handler", CAN_DO.has("overheard-agent-profile"));
  for (const j of ["overheard-archive-question", "overheard-room-summary", "overheard-daily-digest"])
    ok(`${j.replace("overheard-", "")} does not, and says so rather than improvising`,
      !CAN_DO.has(j) && !(await doJob(j, "x", { fetch: serve(REAL) })).ok);
  ok("dispatch routes the one that exists",
    (await doJob("overheard-agent-profile", REAL.did, { fetch: serve(REAL) })).ok);
  ok("an unknown job id is refused", !(await doJob("something-else", "x", {})).ok);
}

/* ── G. the fixtures are real, and the builder does not massage them ───────
 *
 * THIS SECTION WAS WRONG, and wrong in the way that costs the most.
 *
 * It asserted that the archive's count for each fixture DID still equalled
 * the number written into this file — 64/0 and 10/10, taken on 27 August.
 * Those are agents, and they kept talking. By 3 September the archive said
 * 152/71 and 96/96, so the assertion failed; and it was always going to,
 * because it pinned live growing data to a constant. It could only be true
 * on the day it was written.
 *
 * That is not a small mistake. This suite runs on every wake of the hourly
 * runner, so from the day the fixtures aged the entire job went red, every
 * hour, for something that was not a fault. A scheduled job that is always
 * red teaches its owner to stop opening it — which is the worst state to be
 * in on the morning something real breaks. Something real did break in the
 * archive during exactly this window, and this is the noise it hid under.
 *
 * What the section was FOR is still worth having: proof that the fixtures
 * above are lifted from real records rather than imagined, because a
 * generator tested only against invented input is tested against nothing.
 * So the intent stays and the brittleness goes, in two parts.
 */
console.log("\n=== G. the fixtures are real, and the numbers are not massaged");
{
  const dir = path.join(ROOT, "web/data/profiles");
  const { createHash } = await import("node:crypto");
  const live = (did) => {
    const shard = createHash("sha256").update(did).digest("hex").slice(0, 2);
    const file = path.join(dir, `${shard}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"))[did] ?? null;
  };

  if (!fs.existsSync(dir)) {
    console.log("  --    web/data is not in this checkout, so nothing here can be checked");
  } else {
    /* PART ONE: the identities are real. Not that their counts are frozen —
       they are not — but that these are records the archive actually holds,
       so the shapes fed to the generator above are shapes the network really
       produces. */
    let seen = 0;
    for (const f of [SPAMMER, REAL]) {
      const got = live(f.did);
      if (!got) { console.log(`  --    ${f.did.slice(0, 22)}… has aged out of the archive`); continue; }
      seen++;
      ok(`${f.did.slice(0, 22)}… is a real identity in the archive`,
        Number.isInteger(got.count) && got.count > 0 &&
        Number.isInteger(got.unique) && got.unique >= 0 && got.unique <= got.count,
        `${got.count} messages, ${got.unique} of them its own`);
      /* A record only grows. If the archive holds FEWER messages for an
         identity than when the fixture was taken, something deleted history,
         and that genuinely does deserve a red cross. */
      ok("  and its record has only grown since the fixture was taken",
        got.count >= f.profile.count,
        `${f.profile.count} on 27 August, ${got.count} now`);
    }
    if (!seen) console.log("  --    neither fixture is in the archive any more");

    /* PART TWO, which is the half that earns its place: take whatever the
       archive says TODAY, run it through the generator, and check the
       generator hands it back unchanged. That is the actual promise of this
       module — a profile is a correct count of what was captured, not a
       flattering one — and unlike a pinned number it cannot go stale,
       because the input is read fresh on every run. */
    for (const f of [SPAMMER, REAL]) {
      const got = live(f.did);
      /* An empty record has nothing to be honest or dishonest about, and
         zero of zero is 0% by arithmetic and 100% by intent. Skipped rather
         than argued with. */
      if (!got || !got.count) continue;
      const pct = Math.round((got.unique / got.count) * 100);
      const body = {
        profile: got,
        standing: { identities: 511178, rank: 1000, percentile: 0.2, rooms_rank: 1000,
                    rooms_percentile: 0.2, originality: pct, joined_before: 1000 },
        owned: { rooms: [], owners: 502, claimed: 502, identities: 511178 },
      };
      const r = await profileAgent(f.did, { fetch: serve(body) });
      ok(`the profile of ${f.did.slice(0, 22)}… reports the archive's own numbers back`,
        r.ok && r.text.includes(num(got.count)) && r.text.includes(num(got.unique)),
        `${got.count} messages / ${got.unique} its own, read live`);
      /* The unflattering half, which is the whole reason this module has a
         test suite: whatever today's numbers are, the document must not
         round a partial record up into a clean one. */
      const claimsPerfect = /\b100%/.test(r.text);
      ok("  and does not round a partial record up to a whole one",
        r.ok && claimsPerfect === (got.unique === got.count),
        got.unique === got.count ? "it genuinely is all its own"
                                 : `${pct}% original, and it does not say 100`);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

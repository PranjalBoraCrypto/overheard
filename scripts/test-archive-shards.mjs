/**
 * The profile shards, and the one-time move from 256 of them to 4,096.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 *
 * Two facts about the archive that between them cost seven gigabytes a day:
 *
 *   Git stores the FILE, not the change. A shard holding 10,650 identities is
 *   3.2 MB, and one identity posting one message writes a whole new 3.2 MB
 *   object.
 *
 *   A five-minute window sees about 150 distinct identities, and 150
 *   identities spread over 256 shards touch nearly all of them. About 384 MB
 *   of new objects a pass, staged 32 times a day. GitHub reported the
 *   repository at 76.22 GB ten days after it was created and answered a push
 *   with "Repository is approaching its size quota".
 *
 * Widening the shard from two hex characters to three is the fix, and the way
 * that fix goes wrong is the reason for this file. The archiver reads a shard
 * ON DEMAND and a read of a missing file returns an empty object. So a
 * widening with no migration does not throw and does not fail: the first pass
 * afterwards writes new three-character shards holding only the identities it
 * happened to see, the 256 old files sit there unread, and the card page
 * reports 97,000 identities as having never spoken. Everything stays green.
 *
 * So this file asks the questions that failure would answer wrongly:
 *
 *   1. EVERY identity survives the move, with its record unchanged.
 *   2. Each lands in the shard the READERS will look in — and the readers are
 *      three separate files that each carry their own copy of the rule.
 *   3. The old files are gone, so nothing is served from two places.
 *   4. A move interrupted halfway finishes without losing what it wrote.
 *   5. Running it again does nothing at all, which it must, because it runs
 *      at the top of every pass for the rest of the archive's life.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

/* A throwaway data directory, pointed at before the module is imported —
   OUT is resolved once, at module load. */
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "shards-"));
process.env.OUT_DIR = OUT;
const { migrateShards, shardOf, SHARD_CHARS, profileShard } = await import("../scripts/archive.mjs");

const hex = (did) => createHash("sha256").update(did, "utf8").digest("hex");
const oldShard = (did) => hex(did).slice(0, 2);

/* ── the fixture ──────────────────────────────────────────────────────────
   Enough identities that every one of the sixteen sub-shards of at least one
   old shard is exercised. Real did:key strings in shape, because the shard is
   a hash of the string and a fixture of "a", "b", "c" would hash into a
   distribution nothing like the live one. */
const dids = [];
for (let i = 0; i < 900; i++)
  dids.push("did:key:z6Mk" + createHash("sha256").update("id" + i).digest("hex").slice(0, 44));

const record = (i) => ({ count: i + 1, unique: (i % 7) + 1, templates: i % 3,
  rooms: ["lobby", "technocore"].slice(0, (i % 2) + 1),
  first: "2026-08-29T02:37:26.020678Z", last: "2026-09-03T10:51:30.982888Z",
  last_room: "lobby", last_text: "a line of text, number " + i });

function writeOldLayout() {
  const dir = path.join(OUT, "profiles");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const buckets = new Map();
  dids.forEach((did, i) => {
    const s = oldShard(did);
    if (!buckets.has(s)) buckets.set(s, {});
    buckets.get(s)[did] = record(i);
  });
  for (const [s, b] of buckets) {
    const body = Object.keys(b).sort().map((d) => ` ${JSON.stringify(d)}:${JSON.stringify(b[d])}`).join(",\n");
    fs.writeFileSync(path.join(dir, `${s}.json`), `{\n${body}\n}\n`);
  }
  return buckets.size;
}

const readAll = () => {
  const dir = path.join(OUT, "profiles");
  const out = new Map();               // did -> [shardName, record]
  for (const f of fs.readdirSync(dir)) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const [did, v] of Object.entries(j)) out.set(did, [f.replace(/\.json$/, ""), v]);
  }
  return out;
};

console.log("=== A. the rule itself");
ok("the shard is three hex characters", SHARD_CHARS === 3, String(SHARD_CHARS));
ok("and it is the first three of SHA-256 of the did",
  dids.every((d) => shardOf(d) === hex(d).slice(0, 3)));
/* 4,096 possible shards over 97,000 identities is about 24 each. The fixture
   is smaller, so what is checked is that the hash SPREADS — a rule that put
   everything in one shard would pass every other test here and fix nothing. */
{
  const seen = new Set(dids.map(shardOf));
  ok("900 identities land in hundreds of different shards, not a handful",
    seen.size > 700, `${seen.size} shards`);
  const old = new Set(dids.map(oldShard));
  ok("where two characters put them in far fewer", old.size < 300, `${old.size} shards`);
}

console.log("\n=== B. the move loses nothing");
{
  const before = writeOldLayout();
  const originals = readAll();
  ok("the fixture starts in the old layout", before > 100 && originals.size === dids.length,
    `${before} old shards, ${originals.size} identities`);

  const state = { profiles: new Map() };
  const moved = await migrateShards(state);
  ok("every identity was moved", moved === dids.length, `${moved} of ${dids.length}`);

  const after = readAll();
  ok("and every one is still there", after.size === dids.length, `${after.size}`);
  /* Not just present — UNCHANGED. A migration that keeps the keys and drops
     a field is the same loss arriving quietly. */
  const wrong = dids.filter((d, i) =>
    JSON.stringify(after.get(d)?.[1]) !== JSON.stringify(record(i)));
  ok("with its record byte for byte", wrong.length === 0, wrong.slice(0, 2).join(" "));
  /* IN THE SHARD THE READER WILL ASK FOR. This is the assertion the whole
     file exists for: a migration that moves everything correctly into names
     nobody looks up is indistinguishable from having lost it. */
  const misplaced = dids.filter((d) => after.get(d)?.[0] !== shardOf(d));
  ok("in the shard the readers compute", misplaced.length === 0,
    misplaced.slice(0, 2).map((d) => `${after.get(d)?.[0]} ≠ ${shardOf(d)}`).join(" "));

  const left = fs.readdirSync(path.join(OUT, "profiles")).filter((f) => /^[0-9a-f]{2}\.json$/.test(f));
  ok("and no two-character file is left to be served instead", left.length === 0, left.join(" "));
  ok("the files really are smaller now",
    Math.max(...fs.readdirSync(path.join(OUT, "profiles"))
      .map((f) => fs.statSync(path.join(OUT, "profiles", f)).size))
    < 40 * 1024, "largest shard");
}

console.log("\n=== C. it is safe to run again, and it will be, forever");
{
  const state = { profiles: new Map() };
  const t0 = Date.now();
  const moved = await migrateShards(state);
  ok("a second run moves nothing", moved === 0, `${moved}`);
  ok("and costs nothing", Date.now() - t0 < 400, `${Date.now() - t0}ms`);
  ok("and the data is untouched", readAll().size === dids.length);
}

console.log("\n=== D. a run interrupted halfway");
{
  /* The runner is killed mid-migration and the next pass has to finish it.
     Simulated by leaving the old layout in place AND writing a partial new
     one first — which is exactly the state an interrupted run leaves behind,
     and the state where a migration that OVERWRITES rather than merges eats
     the identities the first attempt had already saved. */
  writeOldLayout();
  const dir = path.join(OUT, "profiles");
  const early = dids.slice(0, 40);
  const partial = new Map();
  for (const d of early) {
    const s = shardOf(d);
    if (!partial.has(s)) partial.set(s, {});
    partial.get(s)[d] = { ...record(dids.indexOf(d)), rescued: true };
  }
  for (const [s, b] of partial) {
    const body = Object.keys(b).sort().map((d) => ` ${JSON.stringify(d)}:${JSON.stringify(b[d])}`).join(",\n");
    fs.writeFileSync(path.join(dir, `${s}.json`), `{\n${body}\n}\n`);
  }

  const state = { profiles: new Map() };
  await migrateShards(state);
  const after = readAll();
  ok("every identity is present after the second attempt", after.size === dids.length, `${after.size}`);
  ok("nothing the first attempt wrote was thrown away",
    early.every((d) => after.get(d) && after.get(d)[0] === shardOf(d)));
  const left = fs.readdirSync(dir).filter((f) => /^[0-9a-f]{2}\.json$/.test(f));
  ok("and the old files are gone this time too", left.length === 0, left.join(" "));
}

console.log("\n=== E. the three copies of the rule agree");
/* THE RULE LIVES IN THREE FILES and nothing makes them agree at runtime. A
   mismatch does not throw: the browser or the endpoint fetches a shard name
   that does not exist, gets a 404, and reports the identity as unknown. That
   is the failure this section exists to catch, and reading the sources is the
   only place it can be caught before a visitor finds it. */
{
  const arch = fs.readFileSync(path.join(ROOT, "scripts/archive.mjs"), "utf8");
  const api = fs.readFileSync(path.join(ROOT, "api/profile.js"), "utf8");
  const card = fs.readFileSync(path.join(ROOT, "web/index.html"), "utf8");

  const n = (src, re) => { const m = src.match(re); return m ? Number(m[1]) : null; };
  const a = n(arch, /SHARD_CHARS\s*=\s*(\d+)/);
  /* ANCHORED ON THE THING THEY FETCH, not on the hash call. The first version
     of this searched forward from `digest("SHA-256"` and reported the card
     page as saying SIXTEEN — it had matched a different SHA-256 elsewhere in
     that file and read the radix out of `toString(16)`. A check that can find
     the wrong number and call it a mismatch is a check nobody will trust the
     second time it goes red. */
  const b = n(api, /async function shardOf\([\s\S]{0,400}?\.slice\(0,\s*(\d+)\)/);
  const c = n(card, /const h of \[hex\.slice\(0,\s*(\d+)\)/);
  ok("the archiver says three", a === 3, String(a));
  ok("api/profile.js agrees", b === a, `${b} vs ${a}`);
  ok("and the card page agrees", c === a, `${c} vs ${a}`);
  /* And that each really is reading a hash of the DID rather than, say, the
     first characters of the DID itself — which for did:key would put every
     identity on the network into one shard. */
  /* ── AND THE FALLBACK, WHICH IS MEANT TO BE TEMPORARY ───────────────────
     Both readers try the old two-character name second, because the deployed
     copy of the data only changes on the archiver's next PUBLISH pass — up to
     ninety minutes after the migration runs, during which every identity on
     the site would otherwise read as having never spoken.

     It is asserted rather than merely allowed, because it is the difference
     between a smooth migration and an hour and a half of a broken card page,
     and because the comments beside it say "delete this later" — which is
     exactly the kind of instruction that gets followed at the wrong moment.
     When it IS deleted, this pair of checks is what should be deleted with
     it. */
  ok("the card page falls back to the old name while the migration publishes",
    /hex\.slice\(0,\s*3\),\s*hex\.slice\(0,\s*2\)/.test(card));
  ok("and so does the endpoint",
    /shard\.slice\(0,\s*2\)/.test(api) && /profiles\/\$\{oldName\}\.json/.test(api));

  ok("all three shard on a hash and not on the did",
    /createHash\("sha256"\)\.update\(did/.test(arch)
    && /digest\("SHA-256", *bytes\)/.test(api)
    && /digest\("SHA-256",new TextEncoder\(\)\.encode\(did\)\)/.test(card));
}

console.log("\n=== F. the workflow no longer stages profiles on their own");
{
  const yml = fs.readFileSync(path.join(ROOT, ".github/workflows/archive.yml"), "utf8");
  /* Comments name the old tier on purpose, so the check has to look at what
     runs rather than at what is written about it. */
  const code = yml.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  ok("nothing adds web/data/profiles by itself any more",
    !/git add\s+web\/data\/profiles/.test(code));
  ok("but the publish tier still carries them in", /git add web\/data\b/.test(code));
}

fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

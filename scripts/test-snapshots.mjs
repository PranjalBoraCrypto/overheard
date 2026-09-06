/**
 * The two snapshot builders, against directories built to be in known states.
 *
 * WHY THESE NEED TESTING. They are the site's fallback: when Technocore is
 * refusing, /api/city and /api/room hand back what these two wrote, labelled
 * as archived. So the failure that matters is not "the snapshot is stale" —
 * the pages state their age honestly — it is "there is no snapshot at all",
 * because that is the state nothing downstream can be honest about.
 *
 * Two real faults are asserted against here, both found the same night:
 *
 *   · make-room-snapshots.mjs ignored OUT_DIR. The archiver takes its output
 *     directory from that variable and RUNS this script, so a test run of the
 *     archiver — pointed at a temporary directory and a fake network with two
 *     rooms in it — reached into the real checkout and emptied
 *     web/data/room-snapshots. Two suites broke on it three times in one
 *     night before anybody asked why the fixtures kept vanishing.
 *
 *   · It emptied the directory BEFORE rebuilding it. The archiver calls it
 *     best-effort and prints "the previous one stands" when it fails, and
 *     that was not true: the previous one had already been deleted. A rebuild
 *     that ran out of time, lost the network or hit a torn shard left the
 *     site with no room snapshots at all, and every room page falling back to
 *     nothing, until a later pass happened to succeed.
 *
 * Nothing here touches the network or the repository's own web/data — which
 * is, itself, one of the things being checked.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ROOMS = path.join(HERE, "make-room-snapshots.mjs");
const CITY = path.join(HERE, "make-city-snapshot.mjs");
const REAL = path.join(ROOT, "web", "data", "room-snapshots");

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

/* Both streams, because the interesting line — "the previous set stands" —
   is a warning, and a warning belongs on stderr. */
const run = (script, dir) => {
  const r = spawnSync(process.execPath, [script],
    { encoding: "utf8", env: { ...process.env, OUT_DIR: dir } });
  return { out: String(r.stdout ?? "") + String(r.stderr ?? ""), code: r.status ?? 1 };
};

/** A data directory the builders can read: a city snapshot naming `rooms`,
 *  and an archived day for each room in `withData`. */
function build({ rooms, withData }) {
  const D = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
  fs.writeFileSync(path.join(D, "city-snapshot.json"), JSON.stringify({
    landmarks: rooms.map((r) => ({ room: r, present: true })),
    named: [],
  }));
  for (const r of withData) {
    fs.mkdirSync(path.join(D, r), { recursive: true });
    const day = "2026-09-05";
    fs.writeFileSync(path.join(D, r, "_meta.json"),
      JSON.stringify({ days: [day], updated: "2026-09-05T12:00:00Z" }));
    fs.writeFileSync(path.join(D, r, `${day}.ndjson`),
      [1, 2, 3].map((i) => JSON.stringify({
        seq: String(1000 + i), ts: "2026-09-05T12:00:0" + i + "Z",
        from: "did:key:z6Mk" + "a".repeat(41), text: `line ${i}`, sig: null, nonce: String(i),
      })).join("\n") + "\n");
  }
  return D;
}
const snapshots = (D) => {
  try { return fs.readdirSync(path.join(D, "room-snapshots")).sort(); } catch { return null; }
};

console.log("=== A. it writes where it was told, and nowhere else");
{
  /* The repository's own snapshots, before and after. This is the assertion
     the whole file exists for: running the builder against a temporary
     directory must not touch the checkout it is running inside. */
  const before = (() => { try { return fs.readdirSync(REAL).sort(); } catch { return null; } })();
  const D = build({ rooms: ["lobby", "technocore"], withData: ["lobby", "technocore"] });
  const r = run(ROOMS, D);
  ok("the snapshots land in OUT_DIR", String(snapshots(D)) === "lobby.json,technocore.json",
    String(snapshots(D)));
  const after = (() => { try { return fs.readdirSync(REAL).sort(); } catch { return null; } })();
  ok("and the repository's own web/data is untouched", String(before) === String(after),
    before === null ? "(none there either way)" : `${before.length} → ${after === null ? "GONE" : after.length}`);
  ok("it says what it wrote", /room-snapshots\/\s+2 rooms/.test(r.out), r.out.trim().split("\n").pop());
  /* And the content is the archived shape the room page branches on. */
  const one = JSON.parse(fs.readFileSync(path.join(D, "room-snapshots", "lobby.json"), "utf8"));
  ok("every message is flagged as archived, never as new",
    one.messages.length === 3 && one.messages.every((m) => m.archived === true),
    `${one.messages.length} messages`);
  ok("and carries the time it was READ, not the time it was written",
    one.retrieved_at === "2026-09-05T12:00:00Z", String(one.retrieved_at));
  fs.rmSync(D, { recursive: true, force: true });
}

/* ── B. THE PROMISE THE ARCHIVER MAKES ON ITS BEHALF ──────────────────────
 * "the previous one stands" is printed by archive.mjs whenever this script
 * fails. It has to be true, or a bad five minutes costs the site its whole
 * fallback until a later pass happens to work.
 */
console.log("\n=== B. a rebuild that produces nothing leaves the old set standing");
{
  const D = build({ rooms: ["lobby"], withData: ["lobby"] });
  run(ROOMS, D);
  ok("there is a set to lose", String(snapshots(D)) === "lobby.json");
  /* Now the same city, with the archive underneath it gone — the shape of a
     run that lost the network, or timed out, or read a torn shard. */
  fs.rmSync(path.join(D, "lobby"), { recursive: true, force: true });
  const r = run(ROOMS, D);
  ok("the previous set is still there", String(snapshots(D)) === "lobby.json", String(snapshots(D)));
  ok("and it says so rather than exiting quietly", /previous set stands/.test(r.out),
    r.out.trim().split("\n").pop());
  ok("with nothing half-built left lying about",
    !fs.existsSync(path.join(D, "room-snapshots.new")) && !fs.existsSync(path.join(D, "room-snapshots.old")));
  fs.rmSync(D, { recursive: true, force: true });
}

console.log("\n=== C. a good rebuild replaces the set completely");
{
  const D = build({ rooms: ["lobby", "technocore"], withData: ["lobby", "technocore"] });
  run(ROOMS, D);
  ok("both rooms are there to begin with", String(snapshots(D)) === "lobby.json,technocore.json");
  /* A room that has left the city must leave the snapshots with it, or the
     directory grows for ever and the site keeps serving a room nobody can
     walk into. A build that only ADDED files would never notice. */
  fs.writeFileSync(path.join(D, "city-snapshot.json"), JSON.stringify({
    landmarks: [{ room: "lobby", present: true }], named: [],
  }));
  run(ROOMS, D);
  ok("a room that left the city leaves the snapshots too",
    String(snapshots(D)) === "lobby.json", String(snapshots(D)));
  fs.rmSync(D, { recursive: true, force: true });
}

console.log("\n=== D. the city snapshot writes where it was told as well");
{
  const D = fs.mkdtempSync(path.join(os.tmpdir(), "snapcity-"));
  fs.writeFileSync(path.join(D, "roster.json"), JSON.stringify({
    updated: "2026-09-05T12:00:00Z",
    rooms: [{ room: "lobby", last_seq: "9", bytes: 10, idle: 1 }],
  }));
  const realCity = path.join(ROOT, "web", "data", "city-snapshot.json");
  const before = fs.existsSync(realCity) ? fs.statSync(realCity).mtimeMs : null;
  const r = run(CITY, D);
  ok("it wrote into OUT_DIR", fs.existsSync(path.join(D, "city-snapshot.json")),
    r.out.trim().split("\n").pop());
  const after = fs.existsSync(realCity) ? fs.statSync(realCity).mtimeMs : null;
  ok("and left the repository's own snapshot alone", before === after,
    before === null ? "(none there either way)" : "unchanged");
  fs.rmSync(D, { recursive: true, force: true });
}

/* ── E. THE HALF-BUILT SET MUST BE INVISIBLE TO git ───────────────────────
 * Building beside and swapping in fixes one failure and could introduce
 * another: the archiver stages web/data while this runs, and a directory that
 * appears and then vanishes under `git add` is exactly the race that killed
 * four collection windows. The staging directory is named `.tmp` so the
 * repository's existing ignore covers it — which is only true for as long as
 * both halves agree, so both halves are read.
 */
console.log("\n=== E. git never sees the half-built set");
{
  const src = fs.readFileSync(path.join(HERE, "make-room-snapshots.mjs"), "utf8");
  const gi = (() => { try { return fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8"); } catch { return ""; } })();
  const stages = [...src.matchAll(/OUT \+ "(\.[^"]+)"/g)].map((m) => m[1]);
  ok("the builder stages under a name at all", stages.length > 0, stages.join(" "));
  ok("and every staging name ends in .tmp", stages.every((x) => x.endsWith(".tmp")), stages.join(" "));
  ok("which the repository ignores", /^\*\.tmp$/m.test(gi));

  /* Asserted against git itself, not against the two strings agreeing: the
     question is what git does, and a pattern can be right and still not match
     a DIRECTORY, which is the whole reason this one was chosen. */
  const W = fs.mkdtempSync(path.join(os.tmpdir(), "snapgit-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: W });
  fs.writeFileSync(path.join(W, ".gitignore"), gi);
  fs.mkdirSync(path.join(W, "web/data/room-snapshots.tmp"), { recursive: true });
  fs.writeFileSync(path.join(W, "web/data/room-snapshots.tmp/lobby.json"), "{}");
  fs.mkdirSync(path.join(W, "web/data/room-snapshots"), { recursive: true });
  fs.writeFileSync(path.join(W, "web/data/room-snapshots/lobby.json"), "{}");
  const st = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"],
    { cwd: W, encoding: "utf8" }).stdout;
  ok("git does not see the staging directory", !st.includes("room-snapshots.tmp"),
    st.split("\n").filter(Boolean).join(" | ") || "(nothing)");
  ok("but does see the real one", st.includes("room-snapshots/lobby.json"));
  fs.rmSync(W, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

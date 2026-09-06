/**
 * The health check, against repositories built to be in known states.
 *
 * WHY IT NEEDS TESTING AT ALL. scripts/health.mjs exists to answer "is the
 * archive collecting" without a GitHub token, because the Actions tab answers
 * a different question and answers it misleadingly — 87 cancelled runs out of
 * 100 that are the design working, and four genuine failures reported as three
 * grey rows and the string "exit code 128".
 *
 * A health check that cries wolf gets muted, and a muted health check is worse
 * than none. Its FIRST version did exactly that twice: it called 5.31%
 * coverage a disaster when the window was four minutes old and climbing
 * correctly, and it called a stale local clone a dead collector. Both of those
 * are asserted against below, because both are the kind of wrong that gets a
 * tool ignored rather than fixed.
 *
 * Every case here is a real git repository built from nothing, so what is
 * tested is the script's actual reading of an actual clone.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const HEALTH = path.join(HERE, "health.mjs");

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};
const sh = (cmd, cwd) => execFileSync("bash", ["-c", cmd], { cwd, encoding: "utf8", stdio: "pipe" });

/**
 * A clone whose archive commits land at chosen minutes-ago, with whatever
 * index.json we want it to have read last.
 *
 * `gaps` is a list of minutes before now, newest last.
 */
function build({ minutesAgo, lastRun = null, gitignore = true, deals = true, snapshots = 40 }) {
  const W = fs.mkdtempSync(path.join(os.tmpdir(), "health-"));
  sh(`git init -q -b main . && git config user.email t@t && git config user.name t && git config gc.auto 0`, W);
  fs.mkdirSync(path.join(W, "web/data"), { recursive: true });
  fs.mkdirSync(path.join(W, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(W, ".github/workflows"), { recursive: true });
  /* The two files the last section reads, in their healthy shape. */
  fs.writeFileSync(path.join(W, "scripts/archive.mjs"),
    "async function writeAtomic(file, text) {\n  const tmp = `${file}.tmp`;\n}\n");
  fs.writeFileSync(path.join(W, ".github/workflows/archive.yml"), "set -eE\n");
  if (gitignore) fs.writeFileSync(path.join(W, ".gitignore"), "*.tmp\n");
  if (lastRun) {
    fs.writeFileSync(path.join(W, "web/data/index.json"),
      JSON.stringify({ updated: new Date().toISOString(), rooms_tracked: 80000, behind: [], last_run: lastRun }));
  }
  if (deals) {
    fs.writeFileSync(path.join(W, "web/data/tclk-deals.json"), JSON.stringify({
      updated: new Date().toISOString(),
      rooms: { a: { contract: "0x1", ours: true, seen: new Date(Date.now() - 6e5).toISOString() } },
    }));
  }
  /* The offline fallback: one small file per room, which is what /api/room
     hands back when technocore refuses. Counted, never read. */
  if (snapshots) {
    fs.mkdirSync(path.join(W, "web/data/room-snapshots"), { recursive: true });
    for (let i = 0; i < snapshots; i++)
      fs.writeFileSync(path.join(W, `web/data/room-snapshots/room-${i}.json`), "{}");
  }
  sh(`git add -A && git commit -qm seed`, W);
  /* The archiver's commits, at the ages asked for. An empty commit is enough:
     the check reads their TIMESTAMPS and their author. */
  for (const m of minutesAgo) {
    const when = new Date(Date.now() - m * 60000).toISOString();
    sh(`GIT_AUTHOR_NAME=overheard-archiver GIT_AUTHOR_EMAIL=a@a ` +
       `GIT_AUTHOR_DATE="${when}" GIT_COMMITTER_DATE="${when}" ` +
       `GIT_COMMITTER_NAME=overheard-archiver GIT_COMMITTER_EMAIL=a@a ` +
       `git commit -q --allow-empty -m "archive: ${when} [skip ci]"`, W);
  }
  return W;
}

const run = (W, args = "") => {
  try {
    return { out: sh(`node "${HEALTH}" "${W}" --no-fetch ${args}`, ROOT), code: 0 };
  } catch (e) {
    return { out: String(e.stdout ?? "") + String(e.stderr ?? ""), code: e.status ?? 1 };
  }
};

/* Five minutes apart, for four hours: the machine working. */
const steady = (hours = 4) => Array.from({ length: hours * 12 }, (_, i) => hours * 60 - i * 5);

console.log("=== A. a healthy clone");
{
  const W = build({ minutesAgo: steady(4), lastRun: { seconds: 4 * 3600, coverage: 0.73, reads: 40000, rooms_read: 321, rate_limited: 0 } });
  const r = run(W);
  ok("it says so, and exits zero", r.code === 0 && /all good/.test(r.out), r.out.trim().split("\n").pop());
  ok("collection is reported as near-continuous", /(100|9\d)(\.\d)?% of the last/.test(r.out),
    (r.out.match(/collection.*/) || [""])[0].trim());
  ok("a mature window near 74% is not flagged", /ok.*coverage/.test(r.out),
    (r.out.match(/coverage.*/) || [""])[0].trim());
  fs.rmSync(W, { recursive: true, force: true });
}

console.log("\n=== B. the collector has stopped");
{
  /* Four hours of healthy cadence, and then nothing for an hour. */
  const W = build({ minutesAgo: steady(5).filter((m) => m > 60) });
  const r = run(W);
  ok("it says nothing has been recorded, and exits non-zero",
    r.code === 1 && /BAD.*collection/.test(r.out), (r.out.match(/BAD.*/) || [""])[0].trim());
  ok("and it names how long", /nothing recorded for \d/.test(r.out));
  fs.rmSync(W, { recursive: true, force: true });
}

console.log("\n=== C. a hole in the middle");
{
  /* Recording now, but with a fifty-minute hole two hours back. A gap is
     history that exists nowhere else, so it must not be shrugged off just
     because the tip is fresh. */
  const W = build({ minutesAgo: [...steady(5).filter((m) => m > 170), ...steady(2)] });
  const r = run(W);
  ok("a fresh tip does not hide a gap behind it",
    /WATCH.*collection/.test(r.out), (r.out.match(/WATCH.*collection.*/) || ["not flagged"])[0].trim());
  ok("and the worst gap is named in minutes", /worst \d+ min/.test(r.out),
    (r.out.match(/\d+ gap\(s\).*/) || [""])[0].trim());
  fs.rmSync(W, { recursive: true, force: true });
}

/* ── D. THE ONE THAT MADE THE FIRST VERSION WRONG ─────────────────────────
 * Coverage is cumulative inside a run. A window four minutes old reads 5%
 * because it has been going four minutes, and the first version of this check
 * called that a disaster. Anything that reports a healthy machine as broken
 * gets muted within a week.
 */
console.log("\n=== D. a window that has only just started");
{
  const W = build({ minutesAgo: steady(2), lastRun: { seconds: 260, coverage: 0.053, reads: 1991, rooms_read: 321, rate_limited: 0 } });
  const r = run(W);
  ok("5% four minutes in is not a fault", !/BAD.*coverage/.test(r.out),
    (r.out.match(/coverage.*/) || [""])[0].trim());
  ok("and it says why the number is low", /accumulates|climbing|min old/.test(r.out));
  fs.rmSync(W, { recursive: true, force: true });
}

console.log("\n=== E. a window that is genuinely behind");
{
  /* Two hours in and still at 30%, where the measured curve says about 71%.
     That is the shape of a window that opened onto a backlog. */
  const W = build({ minutesAgo: steady(3), lastRun: { seconds: 7200, coverage: 0.30, reads: 27000, rooms_read: 342, rate_limited: 0 } });
  const r = run(W);
  ok("it is flagged against the curve, not against a flat number",
    /WATCH.*coverage/.test(r.out), (r.out.match(/coverage.*/) || [""])[0].trim());
  ok("and the likely cause is named rather than left to guess",
    /backlog/.test(r.out), (r.out.match(/backlog.*/) || ["not explained"])[0].trim().slice(0, 80));
  fs.rmSync(W, { recursive: true, force: true });
}

/* ── F. THE REGRESSION THAT COST FOUR COLLECTION WINDOWS ──────────────────
 * writeAtomic leaves a `<file>.tmp` in the tree for a few milliseconds.
 * Without an ignore, `git add web/data` stats it, the rename takes it away,
 * and git exits 128 — which under `bash -e` ends the window. One line in
 * .gitignore is the whole fix, so one line is all it takes to undo it.
 */
console.log("\n=== F. the ignore that stops the race");
{
  const W = build({ minutesAgo: steady(2), gitignore: false });
  const r = run(W);
  ok("a missing .gitignore is reported as broken, not overlooked",
    r.code === 1 && /BAD.*tmp race/.test(r.out), (r.out.match(/BAD.*/) || ["not flagged"])[0].trim());
  ok("and it says what will happen", /git add|race|window/.test(r.out));
  fs.rmSync(W, { recursive: true, force: true });
}

console.log("\n=== G. the numbers, for something else to read");
{
  const W = build({ minutesAgo: steady(4), lastRun: { seconds: 14400, coverage: 0.74, reads: 60000, rooms_read: 321, rate_limited: 0 } });
  const r = run(W, "--json");
  let j = null;
  try { j = JSON.parse(r.out); } catch { /* reported below */ }
  ok("--json is parseable", Boolean(j), r.out.slice(0, 60));
  ok("and carries the collection figures", Boolean(j?.collection?.uptimePct !== undefined),
    JSON.stringify(j?.collection ?? null).slice(0, 90));
  ok("and every check with its state", Array.isArray(j?.checks) && j.checks.every((c) => c.state && c.name),
    `${j?.checks?.length ?? 0} checks`);
  fs.rmSync(W, { recursive: true, force: true });
}

/* ── I. THE ANSWER MUST BE ABOUT THE ARCHIVE, NOT ABOUT THIS CHECKOUT ─────
 * The first version read every file with `fs.readFileSync` — the working
 * tree. On any clone that is doing other work that file is hours behind what
 * the collector has published, and can be half-staged or edited besides. It
 * reported "30% at 75 minutes" off a stale copy while the live archive was at
 * 43% and three hours into its window: precise, confident, and about the
 * wrong thing. A health check that reads the wrong file is worse than no
 * health check, because it is believed.
 */
/* ── K. THE FALLBACK ──────────────────────────────────────────────────────
 * /api/city and /api/room hand these back when technocore refuses. Having
 * none is the state nothing downstream can be honest about, and it was
 * reachable: the builder used to empty the directory before refilling it, so
 * a rebuild that lost the network took the fallback with it.
 */
console.log("\n=== K. the offline fallback");
{
  const W = build({ minutesAgo: steady(4), snapshots: 40 });
  ok("a full set is reported as ready", /ok.*offline fallback.*40 rooms/.test(run(W).out),
    (run(W).out.match(/offline fallback.*/) || [""])[0].trim());
  fs.rmSync(W, { recursive: true, force: true });

  const E = build({ minutesAgo: steady(4), snapshots: 0 });
  const r = run(E);
  ok("and none at all is reported as broken, not as quiet",
    r.code === 1 && /BAD.*offline fallback/.test(r.out),
    (r.out.match(/BAD.*offline.*/) || ["not flagged"])[0].trim());
  ok("with what it costs said plainly", /falls back to nothing/.test(r.out));
  fs.rmSync(E, { recursive: true, force: true });
}

console.log("\n=== I. a stale working tree does not become the answer");
{
  const W = build({ minutesAgo: steady(4),
    lastRun: { seconds: 14400, coverage: 0.73, reads: 60000, rooms_read: 321, rate_limited: 0 } });
  /* What the collector published says 73% four hours in. What is lying about
     in the checkout says 5% four minutes in — the shape of a stale file. */
  fs.writeFileSync(path.join(W, "web/data/index.json"), JSON.stringify({
    updated: new Date(Date.now() - 6 * 3600e3).toISOString(), rooms_tracked: 1, behind: [],
    last_run: { seconds: 260, coverage: 0.053, reads: 1991, rooms_read: 321, rate_limited: 0 },
  }));
  const r = run(W);
  ok("it reports the published window, not the one in the checkout",
    /73% at 240 min/.test(r.out), (r.out.match(/coverage.*/) || [""])[0].trim());
  ok("and says which commit it is reading",
    /reading .*published \d+ min ago/.test(r.out), (r.out.match(/reading.*/) || ["not said"])[0].trim());
  /* And the escape hatch, for somebody checking an edit before pushing it. */
  const l = run(W, "--local");
  ok("--local reads the checkout, and only --local does",
    /5% — the window is 4 min old/.test(l.out), (l.out.match(/coverage.*/) || [""])[0].trim());
  fs.rmSync(W, { recursive: true, force: true });
}

/* ── J. IT IS A READ ──────────────────────────────────────────────────────
 * The first version brought the checkout forward with
 * `git reset --soft FETCH_HEAD`. That moves the branch you are standing on,
 * and on a clone with unpushed work it silently throws away where the branch
 * was. Nothing that answers a question should be able to lose your work.
 */
console.log("\n=== J. it does not write to the repository it is reading");
{
  const W = build({ minutesAgo: steady(4),
    lastRun: { seconds: 14400, coverage: 0.73, reads: 60000, rooms_read: 321, rate_limited: 0 } });
  fs.writeFileSync(path.join(W, "web/data/scratch.json"), "{}");           // an unstaged edit
  const head = () => sh("git rev-parse HEAD", W).trim();
  const dirt = () => sh("git status --porcelain", W).trim();
  const h0 = head(), d0 = dirt();
  run(W);
  ok("HEAD is where it was", head() === h0, `${h0.slice(0, 8)} → ${head().slice(0, 8)}`);
  ok("and nothing was staged, stashed or cleaned up", dirt() === d0, dirt() || "(clean)");
  fs.rmSync(W, { recursive: true, force: true });
}

console.log("\n=== H. it never touches the network unless it is told to");
{
  /* --no-fetch is used by every case above. This is the assertion that it
     means what it says, because a health check that quietly needs a network
     is a health check that fails on the day the network is the problem. */
  const src = fs.readFileSync(HEALTH, "utf8");
  ok("there is a --no-fetch, and it is honoured", /--no-fetch/.test(src) && /asOf/.test(src));
  ok("and a clone it could not freshen says so rather than blaming the archiver",
    /as of this clone's last fetch/.test(src));
  ok("nothing here calls out to an API", !/api\.github\.com|fetch\(/.test(src),
    "the repository answers this question by itself");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

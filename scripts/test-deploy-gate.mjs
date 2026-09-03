/**
 * The gate that decides whether a push reaches the site.
 *
 * WHY IT IS TESTED AT ALL. It is nine lines of shell that nobody looks at,
 * and when it is wrong the symptom is silence: a change that is correct, has
 * passed every other test, is on main, and is simply not on the site. On
 * 3 September the deals redesign sat undeployed for fourteen minutes and the
 * only evidence was somebody saying "I still can't see it".
 *
 * So it runs against REAL git repositories built for each case, rather than
 * against a mock of git. The thing being tested is how it reads history, and
 * a fake history would test the fake.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(ROOT, "scripts/vercel-build-or-skip.sh");

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

/* Builds a throwaway repo, replays the given commits, and asks the gate what
   it would do about the last one. Returns "build" or "skip". */
function verdict(commits, { message } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  /* A base commit so HEAD~2 always exists — the real repo has thousands. */
  fs.mkdirSync(path.join(dir, "web/data"), { recursive: true });
  fs.writeFileSync(path.join(dir, "web/index.html"), "base");
  git("add", "-A"); git("commit", "-q", "-m", "base");

  for (const c of commits) {
    for (const f of c.files) {
      fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
      fs.appendFileSync(path.join(dir, f), "x");
    }
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", c.msg);
  }

  const head = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: dir, encoding: "utf8" }).trim();
  let code = 0;
  try {
    execFileSync("bash", [GATE], { cwd: dir, stdio: "pipe",
      env: { ...process.env, VERCEL_GIT_COMMIT_MESSAGE: message ?? head } });
  } catch (e) { code = e.status ?? 1; }
  fs.rmSync(dir, { recursive: true, force: true });
  return code === 1 ? "build" : "skip";
}

const SITE = ["web/deals-preview-78cb4a1be923c6b4.html"];
const DATA = ["web/data/tclk-offers/2026-09-03.ndjson"];

console.log("\n=== a real change always builds");
ok("a plain commit builds",
  verdict([{ msg: "redesign the deals page", files: SITE }]) === "build");
ok("even one that only moved data, if it was not marked",
  verdict([{ msg: "fix the archiver", files: DATA }]) === "build",
  "an unmarked commit is somebody's intent, not ours to second-guess");

console.log("\n=== routine archiving still costs nothing");
ok("a data commit on top of another data commit skips",
  verdict([
    { msg: "archive: 1 [skip ci]", files: DATA },
    { msg: "archive: 2 [skip ci]", files: DATA },
  ]) === "skip");
ok("and a long run of them keeps skipping",
  verdict([
    { msg: "site change", files: SITE },
    { msg: "archive: 1 [skip ci]", files: DATA },
    { msg: "archive: 2 [skip ci]", files: DATA },
    { msg: "archive: 3 [skip ci]", files: DATA },
  ]) === "skip",
  "the rescue is one deployment, not one per data commit for ever");

console.log("\n=== THE BUG, REPRODUCED");
/* 3 September, exactly: the redesign lands, an archive commit lands two
   minutes later, and Vercel has not yet built the redesign. */
ok("the first data commit on top of a real change RESCUES it",
  verdict([
    { msg: "The deals page stops being a column of identical boxes", files: SITE },
    { msg: "archive: 2026-09-03T18:43:20Z [skip ci]", files: DATA },
  ]) === "build",
  "this is the case that shipped nothing for fourteen minutes");

ok("but a data commit on top of a DATA-only real commit does not",
  verdict([
    { msg: "archive: publish", files: DATA },
    { msg: "archive: next [skip ci]", files: DATA },
  ]) === "skip",
  "nothing the site serves changed, so there is nothing to deploy");

ok("an empty commit underneath is not worth a deployment",
  verdict([
    { msg: "chore: no files", files: [] },
    { msg: "archive: after [skip ci]", files: DATA },
  ]) === "skip");

console.log("\n=== when the evidence is missing, build");
/* A SHALLOW CLONE, which is what an ignoreCommand actually runs in. The first
   version of the gate skipped here, and that single `|| exit 0` cost the
   two-column layout its deployment — the rule in the file's own header says
   build when the evidence is ambiguous, and a missing HEAD~1 is exactly that. */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shallow-"));
  const git = (...a2) => execFileSync("git", a2, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "only.txt"), "one");
  git("add", "-A"); git("commit", "-q", "-m", "archive: lone [skip ci]");
  let code = 0;
  try {
    execFileSync("bash", [GATE], { cwd: dir, stdio: "pipe",
      env: { ...process.env, VERCEL_GIT_COMMIT_MESSAGE: "archive: lone [skip ci]" } });
  } catch (e) { code = e.status ?? 1; }
  fs.rmSync(dir, { recursive: true, force: true });
  ok("a clone too shallow to see the parent builds rather than skipping",
    code === 1, code === 1 ? "built" : "SKIPPED — this is the 3 September bug");
}
ok("no commit message at all builds",
  verdict([{ msg: "archive: x [skip ci]", files: DATA }], { message: "" }) === "build",
  "a missing env var must not silently swallow a release");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

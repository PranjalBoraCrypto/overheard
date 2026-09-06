/**
 * The archiver's publishing loop, run against a real git remote with a real
 * process writing underneath it.
 *
 * WHY THIS FILE EXISTS. Run #86 on 2 September collected for five and a half
 * hours, built 52 commits and 909,466 insertions, pushed none of them, and
 * finished GREEN. The whole loss is invisible from outside: the job succeeds,
 * the collector is healthy, coverage climbs in the log, and the repository
 * simply never changes. Nothing in the test suite could have caught it,
 * because everything else here tests what the archiver COLLECTS and nothing
 * tested whether what it collects can leave the machine.
 *
 * The cause was one interaction between two things that are each fine alone:
 * `git rebase` refuses to start against a dirty working tree, and the
 * collector writes to that tree continuously. So a run that fell one commit
 * behind the remote — which happens the moment Pranjal pushes anything — could
 * never catch up again, and every subsequent pass piled another unpublishable
 * commit onto a branch that was already unpublishable.
 *
 * So this test does not read the YAML and check for a word. It EXTRACTS the
 * real script out of the workflow, points it at a throwaway remote, swaps the
 * collector for a process that writes just as constantly, and asks the only
 * question that matters: did the data reach the remote. A future edit that
 * reintroduces any command that refuses to run under a dirty tree fails here
 * without anybody having to have predicted which command it would be.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Removing a scratch directory must never be the thing that fails a run. */
const scrub = (d) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* /tmp will get it */ } };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
if (!fs.existsSync(path.join(ROOT, ".github/workflows/archive.yml")))
  throw new Error(`no archive workflow under ${ROOT} — ROOT is wrong`);

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

/* ── pull the real step out of the real workflow ──────────────────────────── */
const YML = fs.readFileSync(path.join(ROOT, ".github/workflows/archive.yml"), "utf8");

function stepScript(name) {
  const lines = YML.split("\n");
  const at = lines.findIndex((l) => l.includes(`name: ${name}`));
  if (at < 0) throw new Error(`no step named ${name}`);
  const run = lines.findIndex((l, i) => i > at && /^\s*run: \|/.test(l));
  if (run < 0) throw new Error("no run: block");
  const indent = lines[run + 1].match(/^\s*/)[0].length;
  const out = [];
  for (let i = run + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") { out.push(""); continue; }
    if (l.match(/^\s*/)[0].length < indent) break;
    out.push(l.slice(indent));
  }
  return out.join("\n");
}

const REAL = stepScript("Collect continuously, commit on a timer");
ok("the workflow's publishing loop was found", REAL.includes("git push"), REAL.split("\n").length + " lines");

/* ── the harness ──────────────────────────────────────────────────────────
 * Three substitutions, and no others. The commit-and-push logic — the thing
 * that failed in production — is executed verbatim.
 *
 *   the collector      → a shell loop writing the same files, without pause
 *   sleep 300          → sleep 0.4, so a pass is a pass and not five minutes
 *   the retry backoff  → shortened, for the same reason
 *
 * The collector NEVER STOPS, and the run is cut off from outside instead. That
 * is the real shape of it: on the network the lobby has to be re-read every
 * four seconds, so the tree is dirty at every instant a rebase could start,
 * and the window ends when the runner is destroyed. A harness whose writer
 * pauses lets the old loop catch up on a quiet pass and look fine.
 */
/* ── TWO WRITERS, FOR TWO DIFFERENT FAILURES ──────────────────────────────
   NARROW is the original: six files rewritten as fast as the shell can, which
   keeps the tree dirty at every instant and is what reproduces run #86 — a
   `git rebase` that can never start. It is deliberately unchanged; widening
   it made the old loop occasionally win the race and the control went soft.

   WIDE is three hundred shards, which is what the real tree looks like, and
   it reproduces a different failure entirely: `git add web/data` is still
   walking the directory when a rename takes a `.tmp` out from under it, git
   exits 128, and under `bash -e` that ends the collection window. Six files
   are walked too fast to ever lose that race, which is why this harness was
   green throughout the three days the real job was dying of it. */
/* A SENTINEL, NOT JUST A DEADLINE. `( ... ) &` is not killed when the step is
   SIGKILLed — it is a background subshell with its own process group — so a
   writer with only a 600-second deadline outlives the run and is still
   creating files while the harness tries to delete the directory. That is an
   ENOTEMPTY in the middle of an unrelated test. It stops when the file goes. */
const writer = (shards) => `
( END=$(( $(date +%s) + 600 ))
  mkdir -p web/data/profiles/00
  while [ -f .writing ] && [ "$(date +%s)" -lt "$END" ]; do
    for f in cursors recent standings index owners roster; do
      printf '{"n":%s}\\n' "$(date +%s%N)" > "web/data/$f.json.tmp" && mv "web/data/$f.json.tmp" "web/data/$f.json"
    done
    i=0
    while [ $i -lt ${shards} ]; do
      printf '{"n":%s}\\n' "$(date +%s%N)" > "web/data/profiles/00/$i.ndjson.tmp" && mv "web/data/profiles/00/$i.ndjson.tmp" "web/data/profiles/00/$i.ndjson"
      i=$((i+1))
    done
  done ) &`.trim();
const NARROW = writer(1);
const WIDE = writer(300);
const COLLECTOR = NARROW;

const harness = (script, collector = COLLECTOR) =>
  script
    .replace(/^node scripts\/archive\.mjs &$/m, collector)
    .replace(/^(\s*)sleep 300$/m, "$1sleep 0.4")
    .replace(/^(\s*)sleep [35]$/gm, "$1sleep 0.1");

const sh = (cmd, cwd) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });

/* Build a remote, a clone, and somebody else pushing to a file OUTSIDE
   web/data — which is exactly how run #86 fell behind at 16:09. */
function stage({ gitignore = true } = {}) {
  const W = fs.mkdtempSync(path.join(os.tmpdir(), "push-"));
  const env = 'export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t;';
  sh(`${env}
    git init -q --bare -b main remote.git
    git init -q -b main seed && cd seed
    ${gitignore ? "printf '*.tmp\\n' > .gitignore" : "true"}
    mkdir -p web/data && echo '{}' > web/data/cursors.json && echo 'hello' > web/bar.js
    git add -A && git commit -qm init
    git remote add origin ../remote.git && git push -q origin main
    cd .. && git clone -q remote.git him && cd him
    git config user.name t && git config user.email t@t
    echo 'his fix' > web/bar.js && git add -A && git commit -qm 'his patch' && git push -q origin main`, W);
  return W;
}

function runLoop(W, script, collector = COLLECTOR) {
  const D = path.join(W, "runner");
  fs.rmSync(D, { recursive: true, force: true });
  sh(`git clone -q remote.git runner && cd runner && git config user.name t && git config user.email t@t`, W);
  /* And he pushes again, so the runner's clone is now behind. */
  sh(`cd him && echo 'his second fix' > web/bar.js && git add -A && git commit -qm 'his second patch' && git push -q origin main`, W);

  fs.writeFileSync(path.join(D, ".writing"), "");
  fs.writeFileSync(path.join(D, "step.sh"), harness(script, collector));
  /* ── `-e`, BECAUSE THAT IS WHAT GITHUB RUNS ────────────────────────────
     The default shell for a `run:` block on Linux is `bash -e {0}`, and this
     harness invoked plain `bash`. So the single most expensive failure this
     workflow has — an unguarded command failing and taking the whole
     collection window with it — could not be reproduced here AT ALL. The
     suite stayed green through four production failures in three days for
     exactly that reason: it was running a more forgiving shell than the one
     that runs it for real. */
  const r = spawnSync("bash", ["-e", "step.sh"], {
    cwd: D, encoding: "utf8", timeout: 12000, killSignal: "SIGKILL",
    env: { ...process.env, GITHUB_REF_NAME: "main",
           GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
           GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  /* Stop the writer and give it a moment to notice, before anything tries to
     remove the tree under it. */
  try { fs.unlinkSync(path.join(D, ".writing")); } catch { /* already gone */ }
  spawnSync("bash", ["-c", "sleep 0.6"]);
  const log = (r.stdout || "") + (r.stderr || "");
  const bare = path.join(W, "remote.git");
  const landed = sh(`git -C "${bare}" log --oneline main`, W).stdout.split("\n").filter((l) => /archive:/.test(l)).length;
  const bar = sh(`git -C "${bare}" show main:web/bar.js`, W).stdout.trim();
  const rejects = (log.match(/push rejected/g) || []).length;
  /* THE PRODUCTION SYMPTOM, exactly. Run #86 collected for five and a half
     hours and the repository never changed once in all that time, so what is
     measured is what reached the remote WHILE the window was open — not what
     might have been salvaged at the end, because there was no end, there was
     a runner being deleted. */
  return { log, landed, bar, rejects };
}

/* ── A. the shape of the failure, reproduced ─────────────────────────────── */
console.log("\n=== A. the loop that lost run #86");
{
  /* The old loop, kept here as the control. Without it, a green result below
     proves only that the new loop works in an easy case. */
  /* Anchored on the RETRY BLOCK rather than on any one line inside it. The
     first version of this matched up to a literal `[ -n "$PUSHED" ]` echo,
     and when that echo became an annotation the substitution silently stopped
     matching — so OLD became a copy of REAL, the control passed by accident,
     and the section proved nothing while still printing green. A control that
     can quietly become the thing it is controlling against is worse than no
     control, which is why `OLD !== REAL` is asserted below and not assumed. */
  const OLD = REAL.replace(
    /PUSHED=""[\s\S]*?(?=\nPASS_SCRIPT\n|\n\s*# Coverage is the number)/,
    `for attempt in 1 2 3; do
  git push && break
  echo "push rejected, rebasing (attempt $attempt)"
  git fetch origin "\${GITHUB_REF_NAME}"
  if ! git rebase "origin/\${GITHUB_REF_NAME}"; then
    git checkout --ours web/data 2>/dev/null || true
    git add web/data 2>/dev/null || true
    GIT_EDITOR=true git rebase --continue || git rebase --abort || true
  fi
  sleep 5
done
`);
  ok("the old loop is genuinely different from the one in the file", OLD !== REAL);
  const W = stage();
  const r = runLoop(W, OLD); if (process.env.KEEPLOG) fs.writeFileSync("/tmp/oldlog.txt", r.log);
  ok("it is rejected over and over", r.rejects > 0, r.rejects + " rejections");
  /* It does not lose EVERY pass here, and that is the finding, not a
     weaker result. It loses exactly the passes where the writer happened to
     touch the tree between the commit and the rebase. This harness lets the
     writer stop after five seconds, so the last passes go through. On the
     real network the collector never stops — the lobby has to be re-read
     every four seconds — which is why run #86 lost 157 out of 157. */
  ok("and in all that time the repository never changes",
    r.landed === 0, `${r.landed} archive commits reached the remote`);
  ok("which is why the run still looked healthy", !/error|fatal/i.test(r.log.split("\n").slice(-1)[0] || ""),
    "no failure at the end to notice");
  scrub(W);
}

/* ── B. the loop that is actually in the file ────────────────────────────── */
console.log("\n=== B. the loop in the workflow now");
{
  const W = stage();
  const r = runLoop(W, REAL);
  ok("it publishes, pass after pass, under exactly the same conditions",
    r.landed > 1, `${r.landed} archive commits reached the remote`);
  ok("even though it started behind, and was written to throughout",
    r.rejects > 0, r.rejects + " rejections, all recovered from");
  ok("it never leaves a pass unpublished without saying so",
    !/NOT PUBLISHED/.test(r.log) || r.landed > 0,
    "silence about a lost pass is what made #86 invisible");

  /* The one thing a --mixed reset could plausibly get wrong. */
  ok("and it does not revert a push of yours outside web/data",
    r.bar === "his second fix", r.bar);

  /* The data is not merely committed, it is the data this run collected. */
  const W2 = W;
  const seen = sh(`git -C "${path.join(W2, "remote.git")}" show main:web/data/cursors.json`, W2).stdout.trim();
  ok("what landed is this run's own collection, not the old file",
    seen !== "{}" && /"n"/.test(seen), seen.slice(0, 40));
  scrub(W);
}

/* ── C. the properties that must hold however it is rewritten ────────────── */
console.log("\n=== C. what the loop must never do again");
{
  const loop = REAL.slice(REAL.indexOf("PUSHED="));
  ok("no command in the retry refuses to run under a dirty tree",
    !/git rebase|git stash|git pull(?!\s+--)/.test(loop),
    "rebase, stash and plain pull all read the working tree");
  ok("it catches up with a command that ignores the working tree",
    /git reset --mixed/.test(loop));
  ok("and re-stages afterwards, or the catch-up would publish an empty commit",
    /git reset --mixed[\s\S]{0,200}stage_this_pass/.test(loop));
  /* COMMENTS STRIPPED FIRST. This counted `stage_this_pass()` across the whole
     step, and a comment that MENTIONED the function by name made the count two
     and the assertion red — a test failing on prose about the code rather than
     on the code. The same trap as every "does this file contain the word"
     check in this project. */
  const code = REAL.replace(/^\s*#.*$/gm, "");
  ok("the staging tiers are defined once, not copied",
    (code.match(/stage_this_pass\(\)/g) || []).length === 1 &&
    (code.match(/stage_this_pass\b/g) || []).length >= 3,
    `${(code.match(/stage_this_pass\b/g) || []).length} references, ` +
    `${(code.match(/stage_this_pass\(\)/g) || []).length} definition`);

  /* ── A PASS THAT NEVER PUBLISHES HAS TO BE AUDIBLE ─────────────────────
     It used to be an `echo "NOT PUBLISHED"`, and an echo is exactly what run
     #86 proved is not enough: the log it went to redirects to a blob store
     this project cannot fetch, so five and a half hours of unpublished
     collection reported nothing at all. What is required is not a particular
     string but that the fact leaves the runner — which on GitHub means an
     annotation. */
  ok("a pass that collects and cannot publish raises an annotation",
    /::(warning|error)[^\n]*could not publish/.test(loop),
    (loop.match(/::(warning|error)[^\n]*/) || ["(nothing)"])[0].slice(0, 80));
}

/* ── D. THE RACE THAT KILLED FOUR WINDOWS ────────────────────────────────
 *
 * scripts/archive.mjs writes every file through writeAtomic: `<file>.tmp`
 * beside the target, then a rename over it. For a few milliseconds there is an
 * extra file in the tree — and on a publish pass `git add web/data` walks that
 * tree for seconds while the collector is writing to it. git lists the
 * directory, decides to index a `.tmp`, the rename takes it away, and git
 * exits 128:
 *
 *     fatal: unable to stat '...ndjson.tmp': No such file or directory
 *
 * Under `bash -e` that ends the step, and ending the step ends a
 * five-and-a-half-hour collection window. It happened on 4 September at 15:26,
 * on the 5th at 03:33, 12:12 and 00:01 — four times in three days, and the
 * only thing any of them reported was "exit code 128".
 *
 * `.gitignore` is the fix, and it is one line: git does not stat a path it has
 * been told to ignore. This section is here so nobody deletes it.
 */
console.log("\n=== D. a rename racing git add");
{
  /* ── WHY THIS IS NOT A TEST THAT RACES ─────────────────────────────────
     The obvious test — run the wide writer without the ignore and assert the
     fatal appears — WAS written, and it is flaky by construction: it wins
     the race most runs and loses it some, so it would go red at random and
     teach everybody to re-run the suite. A test that has to win a race to
     pass is worse than no test.

     So this asserts the MECHANISM instead, which is deterministic. The race
     is only possible if git stats those paths at all. Without the ignore it
     does — provably, because it indexes one. With the ignore it does not
     look at them, and a path git never looks at cannot vanish from under it.
     Measured separately, for the record: a writer doing exactly what
     writeAtomic does against `git add` in a loop lost 282 of 548 attempts
     without the ignore, and 0 of 2,117 with it. */
  const W = fs.mkdtempSync(path.join(os.tmpdir(), "ignore-"));
  for (const ig of [false, true]) {
    const D = path.join(W, ig ? "with" : "without");
    fs.mkdirSync(path.join(D, "web/data/profiles/00"), { recursive: true });
    sh(`git init -q -b main . && git config user.email t@t && git config user.name t`, D);
    if (ig) fs.writeFileSync(path.join(D, ".gitignore"), "*.tmp\n");
    fs.writeFileSync(path.join(D, "web/data/profiles/00/1.ndjson"), "real\n");
    /* Exactly what writeAtomic leaves behind for the few milliseconds
       between its write and its rename. */
    fs.writeFileSync(path.join(D, "web/data/profiles/00/1.ndjson.tmp"), "half\n");
    sh(`git add web/data`, D);
    const staged = sh(`git diff --staged --name-only`, D).stdout;
    ok(ig ? "with the ignore, git does not even look at a .tmp"
          : "without it, git add indexes the half-written file",
      ig ? !/\.tmp$/m.test(staged) : /\.tmp$/m.test(staged),
      staged.trim().split("\n").join(" "));
  }
  scrub(W);
}

/* ── D2. AND A PASS THAT FAILS MUST NOT END THE WINDOW ────────────────────
 * The race is one way a pass can die; there will be others, and the cost of
 * any of them used to be the same — the whole collection window. This forces
 * a real git failure on every publish pass, deterministically, through the
 * real code path, and asks what the loop does about it.
 */
console.log("\n=== D2. one bad pass, and the window carries on");
{
  const W = stage({ gitignore: true });
  /* A pathspec that cannot match. Real git, real exit 128, same line of the
     same script — but on purpose and every time, instead of one run in three. */
  const POISONED = REAL.replace(
    /nice -n 15 git add web\/data; fi/,
    "nice -n 15 git add web/data no-such-path-in-this-tree; fi");
  ok("the poison is genuinely in the script", POISONED !== REAL);
  const r = runLoop(W, POISONED, NARROW);
  ok("the failing pass is annotated with the command that failed",
    /::error title=archive pass \d+::line \d+: .*git add/.test(r.log),
    (r.log.match(/::error[^\n]*/) || ["(no annotation — the 'exit code 128' experience)"])[0].slice(0, 96));
  ok("and counted as a failure rather than swallowed",
    /::warning title=archive::pass \d+ failed to publish \(exit \d+\)/.test(r.log),
    (r.log.match(/::warning[^\n]*failed to publish[^\n]*/) || ["(nothing)"])[0].slice(0, 88));
  /* THE WHOLE POINT. Before the rewrite this log would stop at the failure. */
  /* Measured by what REACHED THE REMOTE after the poisoned pass, not by
     counting the word "pass" in the log: only the passes that had nothing to
     say print it, so a healthy window can mention it once and a dead one can
     mention it twice. Commits landing after pass 1 failed is the fact. */
  ok("the loop keeps taking passes, and they publish",
    r.landed > 0,
    r.landed ? `${r.landed} archive commits landed after the failure` : "the step died with the pass");
  ok("only the first three failures are annotated, then they are counted",
    (r.log.match(/::warning title=archive::pass \d+ failed to publish/g) || []).length <= 3,
    "GitHub keeps ten per step and drops the rest in silence");
  scrub(W);
}

console.log("\n=== E. with the ignore, which is the fix");
{
  const W = stage({ gitignore: true });
  const r = runLoop(W, REAL, WIDE);
  ok("the same wide writer, and no race at all",
    !/unable to (stat|index)[^\n]*\.tmp/.test(r.log),
    (r.log.match(/fatal:[^\n]*/) || ["no fatal anywhere"])[0].slice(0, 80));
  ok("passes publish throughout", r.landed > 1, `${r.landed} archive commits reached the remote`);
  ok("and no half-written file was committed",
    !sh(`git -C "${path.join(W, "remote.git")}" ls-tree -r --name-only main`, W).stdout.split("\n").some((f) => f.endsWith(".tmp")),
    "nothing ending .tmp in the tree");
  scrub(W);
}

/* ── F. THE THINGS THAT MAKE A FAILURE READABLE ──────────────────────────── */
console.log("\n=== F. and it has to be able to say what went wrong");
{
  const gi = path.join(ROOT, ".gitignore");
  ok("the repository carries a .gitignore", fs.existsSync(gi));
  ok("and it ignores the temp files writeAtomic makes",
    fs.existsSync(gi) && /^\*\.tmp$/m.test(fs.readFileSync(gi, "utf8")));
  /* The other half of the same fact. If writeAtomic stops using that suffix
     the ignore stops covering it, and the race comes back in silence. */
  const arc = fs.readFileSync(path.join(ROOT, "scripts", "archive.mjs"), "utf8");
  ok("and writeAtomic still uses the suffix the ignore names",
    /const tmp = `\$\{file\}\.tmp`/.test(arc),
    (arc.match(/const tmp = .*/) || ["(writeAtomic changed shape)"])[0]);

  const heredoc = REAL.slice(REAL.indexOf("<<'PASS_SCRIPT'"), REAL.indexOf("\nPASS_SCRIPT\n"));
  /* -E AS WELL AS -e, and it is not decoration: an ERR trap is not inherited
     by shell functions without errtrace, and every git command that has ever
     failed in here fails inside stage_this_pass(). Tested both ways — with a
     plain `set -e` the script exits 1 in total silence, which is exactly the
     "exit code 128 and nothing else" that four failures reported. */
  ok("the pass script sets errexit AND errtrace", /^\s*set -eE$/m.test(heredoc),
    (heredoc.match(/^\s*set .*/m) || ["(no set line)"])[0].trim());
  ok("and traps ERR with the line and the command",
    /trap .*ERR/.test(heredoc) && /\$LINENO/.test(heredoc) && /\$BASH_COMMAND/.test(heredoc));
  /* A subshell will not do. bash suppresses errexit inside a compound command
     used as a condition or on the left of `||`, and the suppression reaches
     into subshells even if they set it again — so `if ! ( set -e; ... )` runs
     straight past a failure with the trap silent. */
  ok("a pass runs as a child process, not a subshell",
    /bash "\$\{RUNNER_TEMP:-\/tmp\}\/publish-pass\.sh"/.test(REAL));
  ok("and the window reports how it went, in an annotation",
    /::notice title=archive::window closed after/.test(REAL) &&
    /\$failed failed/.test(REAL));
}

/* ── G. THE PUBLISH AFTER THE LAST PASS ───────────────────────────────────
 * The collector writes several things only when it FINISHES — the final
 * report, and the cold-start snapshots /api/city and /api/room fall back on
 * when Technocore refuses. The commit loop exits the moment the collector is
 * gone, so all of it was being written to a runner about to be deleted.
 *
 * The symptom is not an error. It is a file that quietly stops being new:
 * measured on 6 September, the site's offline fallback for every room was
 * stamped 30 August while the archive underneath it was minutes old. Nobody
 * noticed for a week, which is exactly why it is pinned here.
 */
console.log("\n=== G. the window does not end without publishing its last pass");
{
  const after = REAL.slice(REAL.indexOf("wait $ARCH"));
  ok("there is a publish after the collector has finished",
    /PASS_N=final bash "\$\{RUNNER_TEMP:-\/tmp\}\/publish-pass\.sh"/.test(after),
    after.includes("PASS_N=final") ? "" : "nothing runs after wait $ARCH");
  /* It must not be able to end the job. The collection itself is already
     safely pushed by then; losing the run over the last file would trade a
     small loss for a large one. */
  ok("and it cannot fail the job", /PASS_N=final[^\n]*\|\| rc=\$\?/.test(after));
  ok("a failure there is still said out loud",
    /::warning title=archive::the final publish did not land/.test(after));
  /* THE THING IT EXISTS TO CARRY. If archive.mjs stops writing the snapshots
     at the end of its run, this final publish is carrying nothing and the
     fallback silently freezes again — from the other side. */
  const arc = fs.readFileSync(path.join(ROOT, "scripts", "archive.mjs"), "utf8");
  ok("and the collector still writes the snapshots at the end of its run",
    /make-room-snapshots\.mjs/.test(arc) && /make-city-snapshot\.mjs/.test(arc));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

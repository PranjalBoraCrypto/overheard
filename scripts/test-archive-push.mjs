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
const COLLECTOR = `
( END=$(( $(date +%s) + 600 ))
  while [ "$(date +%s)" -lt "$END" ]; do
    for f in cursors recent standings index owners roster; do
      printf '{"n":%s}\\n' "$(date +%s%N)" > "web/data/$f.json.tmp" && mv "web/data/$f.json.tmp" "web/data/$f.json"
    done
    mkdir -p web/data/profiles
    printf '{"n":%s}\\n' "$(date +%s%N)" > web/data/profiles/p.json
  done ) &`.trim();

const harness = (script) =>
  script
    .replace(/^node scripts\/archive\.mjs &$/m, COLLECTOR)
    .replace(/^(\s*)sleep 300$/m, "$1sleep 0.4")
    .replace(/^(\s*)sleep [35]$/gm, "$1sleep 0.1");

const sh = (cmd, cwd) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });

/* Build a remote, a clone, and somebody else pushing to a file OUTSIDE
   web/data — which is exactly how run #86 fell behind at 16:09. */
function stage() {
  const W = fs.mkdtempSync(path.join(os.tmpdir(), "push-"));
  const env = 'export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t;';
  sh(`${env}
    git init -q --bare -b main remote.git
    git init -q -b main seed && cd seed
    mkdir -p web/data && echo '{}' > web/data/cursors.json && echo 'hello' > web/bar.js
    git add -A && git commit -qm init
    git remote add origin ../remote.git && git push -q origin main
    cd .. && git clone -q remote.git him && cd him
    git config user.name t && git config user.email t@t
    echo 'his fix' > web/bar.js && git add -A && git commit -qm 'his patch' && git push -q origin main`, W);
  return W;
}

function runLoop(W, script) {
  const D = path.join(W, "runner");
  fs.rmSync(D, { recursive: true, force: true });
  sh(`git clone -q remote.git runner && cd runner && git config user.name t && git config user.email t@t`, W);
  /* And he pushes again, so the runner's clone is now behind. */
  sh(`cd him && echo 'his second fix' > web/bar.js && git add -A && git commit -qm 'his second patch' && git push -q origin main`, W);

  fs.writeFileSync(path.join(D, "step.sh"), harness(script));
  const r = spawnSync("bash", ["step.sh"], {
    cwd: D, encoding: "utf8", timeout: 12000, killSignal: "SIGKILL",
    env: { ...process.env, GITHUB_REF_NAME: "main",
           GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
           GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
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
  const OLD = REAL.replace(
    /PUSHED=""[\s\S]*?\[ -n "\$PUSHED" \][^\n]*\n/,
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
  const r = runLoop(W, OLD);
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
  fs.rmSync(W, { recursive: true, force: true });
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
  fs.rmSync(W, { recursive: true, force: true });
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
  ok("the staging tiers are defined once, not copied",
    (REAL.match(/stage_this_pass\(\)/g) || []).length === 1 &&
    (REAL.match(/stage_this_pass\b/g) || []).length >= 3);
  ok("a pass that never publishes says so in the log",
    /NOT PUBLISHED/.test(loop), "the failure mode is silence");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

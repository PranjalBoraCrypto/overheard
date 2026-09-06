/**
 * Is the archive collecting, and is the shop open?
 *
 *   node scripts/health.mjs            in any clone of this repository
 *   node scripts/health.mjs --json     the same numbers, for something else to read
 *   node scripts/health.mjs /some/clone   check a clone somewhere else
 *   node scripts/health.mjs --no-fetch    do not touch the network first
 *   node scripts/health.mjs --local       read the working tree, not the last
 *                                         published commit (for checking an
 *                                         edit before it is pushed)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 *
 * "Is the archiver and the runner doing okay?" is a fair question and it used
 * to take twenty minutes and a GitHub token to answer — and the first answer
 * was wrong. The Actions tab showed 87 cancelled runs out of 100, which looks
 * like a system falling over and is in fact the design working: the archiver
 * is one long job that cron relaunches, and a queued run superseded by a newer
 * queued run is recorded as "cancelled". Meanwhile the thing that WAS wrong —
 * four collection windows killed by a race with `git add` — showed up as three
 * grey rows and the string "exit code 128".
 *
 * So the Actions tab is the wrong instrument. It measures runs. What anybody
 * actually wants to know is whether MESSAGES ARE BEING RECORDED, and the
 * repository answers that itself, exactly and without a token: every commit
 * the archiver makes is a timestamp, and a gap between two of them is a gap in
 * the recording. Rooms are a ring buffer; a gap is history that no longer
 * exists anywhere.
 *
 * Everything below is read from the repository. No network, no credentials,
 * no API — which also means it still works on the days the API does not.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not report on workflow runs, because a run is not the unit anybody
 * cares about, and counting them is what produced the wrong answer.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* A path argument checks ANOTHER clone, which is how this gets tested and
   also how you check a machine's copy without cd-ing into it. */
const WHERE = process.argv.slice(2).find((a) => !a.startsWith("--"));
const ROOT = WHERE ? path.resolve(WHERE) : path.resolve(HERE, "..");
const JSON_OUT = process.argv.includes("--json");
const HOURS = Number((process.argv.find((a) => a.startsWith("--hours=")) ?? "").split("=")[1] || 24);

/* stderr discarded: git volunteers "Auto packing the repository" and similar
   housekeeping notes that are not this script's business and would otherwise
   be most of its output. */
const git = (args, input, { lazy = false } = {}) => {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 << 20,
      input, stdio: ["pipe", "pipe", "ignore"],
      /* NEVER go to the network, EXCEPT where a caller asks. In a partial
         clone an innocent-looking `cat-file -s` on an absent blob triggers a
         lazy fetch, and a few thousand of those is a health check that hangs
         instead of answering. Better to fail the read and say so. The handful
         of small files read below pass lazy:true, because there are five of
         them and the answer is wrong without them. */
      env: lazy ? process.env : { ...process.env, GIT_NO_LAZY_FETCH: "1" } });
  } catch { return null; }
};
const ago = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 90) return `${m}m`;
  const h = m / 60;
  return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
};

/* Three states, and the middle one is the point. A check that can only say
   "fine" or "broken" gets ignored, because most trouble arrives as a number
   drifting rather than a thing stopping. */
const OK = "ok", WATCH = "watch", BAD = "bad";
const checks = [];
const add = (state, name, said, detail = "") => checks.push({ state, name, said, detail });

/* ── 1. IS ANYTHING BEING RECORDED ─────────────────────────────────────────
   The one that matters. Every archiver commit is a timestamp; the gaps
   between them are the minutes nothing was watching. Five minutes is the
   intended cadence, so anything under about twelve is the machine working. */
const CADENCE_S = 300;

/* ── FRESHEN FIRST, OR THE ANSWER IS ABOUT THIS LAPTOP ─────────────────────
   Everything below reads the local clone. Run against a clone that has not
   been fetched for an hour, "nothing recorded for 60m" is a true statement
   about the wrong thing — it means the laptop is behind, not that the
   collector stopped, and those two need opposite reactions. So it fetches
   first, and if it cannot, it says the numbers are as of the local tip
   instead of pretending they are current. */
let asOf = "";
let fetched = false;
if (!process.argv.includes("--no-fetch")) {
  fetched = git(["fetch", "--quiet", "origin"]) !== null;
  if (!fetched) asOf = "could not reach the remote — everything below is as of this clone's last fetch";
} else {
  asOf = "--no-fetch: everything below is as of this clone's last fetch";
}

/* ── WHICH COMMIT THE ANSWER IS ABOUT ──────────────────────────────────────
   Two mistakes were possible here and the first version made both.
 *
 * It read every file with `fs.readFileSync`, which is the WORKING TREE — a
 * checkout that on any clone doing other work is hours behind what the
 * collector has published, and can also be half-staged or edited. That is how
 * it came to report "30% at 75 minutes" off a stale file while the live
 * archive was at 43% and three hours into its window: a confident, precise,
 * completely wrong answer, which is the worst kind a health check can give.
 *
 * And it brought the checkout forward with `git reset --soft FETCH_HEAD`.
 * That moves the branch you are standing on. On a clone with unpushed work it
 * silently throws away where the branch was, and a read-only health check has
 * no business writing anything at all.
 *
 * So nothing is moved and nothing is written: the fetched commit is READ
 * DIRECTLY, with `git show <ref>:<path>`. The ref is the freshest thing
 * available — what was just fetched, else the last fetch, else this HEAD —
 * and it is printed, so the reader always knows what the numbers are about.
 * `--local` reads the working tree instead, for checking an edit before it
 * is pushed. */
const LOCAL = process.argv.includes("--local");
const refExists = (r) => git(["rev-parse", "--verify", "--quiet", `${r}^{commit}`]) !== null;
const REF = LOCAL ? null
  : (fetched && refExists("FETCH_HEAD")) ? "FETCH_HEAD"
  : refExists("origin/main") ? "origin/main"
  : refExists("HEAD") ? "HEAD"
  : null;
const text = (p) => {
  if (REF) return git(["show", `${REF}:${p}`], undefined, { lazy: true });
  try { return fs.readFileSync(path.join(ROOT, p), "utf8"); } catch { return null; }
};
const read = (p) => { try { return JSON.parse(text(p) ?? ""); } catch { return null; } };
if (REF) {
  const at = (git(["log", "-1", "--format=%H%x09%ct", REF]) ?? "").trim().split("\t");
  if (at[0]) {
    const age = Date.now() / 1000 - Number(at[1]);
    asOf = `reading ${REF === "FETCH_HEAD" ? "the commit just fetched" : REF} — ` +
      `${at[0].slice(0, 8)}, published ${Math.round(age / 60)} min ago` + (asOf ? `; ${asOf}` : "");
  }
} else if (!LOCAL) {
  asOf = "no commits to read — falling back to the working tree" + (asOf ? `; ${asOf}` : "");
}

const log = git(["log", ...(REF ? [REF] : []), "--format=%ct%x09%an", `--since=${HOURS} hours ago`]);
let collection = null;
if (log === null) {
  add(WATCH, "collection", "not a git clone, so the cadence cannot be read",
    "run this inside a clone of the repository");
} else {
  const t = log.split("\n")
    .filter((l) => l.includes("overheard-archiver"))
    .map((l) => Number(l.split("\t")[0]))
    .filter(Boolean).sort((a, b) => a - b);
  if (t.length < 2) {
    add(BAD, "collection", `only ${t.length} archive commit(s) in ${HOURS}h`,
      "the archiver is not publishing at all");
  } else {
    const gaps = [];
    for (let i = 1; i < t.length; i++) gaps.push([t[i] - t[i - 1], t[i - 1]]);
    const big = gaps.filter(([s]) => s > CADENCE_S * 2.4);
    const dead = big.reduce((a, [s]) => a + s, 0);
    const span = t[t.length - 1] - t[0];
    const up = 100 * (1 - dead / span);
    const last = (Date.now() / 1000) - t[t.length - 1];
    const worst = big.length ? Math.max(...big.map(([s]) => s)) : 0;
    collection = {
      commits: t.length, spanHours: +(span / 3600).toFixed(1), uptimePct: +up.toFixed(1),
      gaps: big.length, worstGapMin: +(worst / 60).toFixed(1),
      lastCommitMin: +(last / 60).toFixed(1),
      medianGapMin: +(gaps.map(([s]) => s).sort((a, b) => a - b)[gaps.length >> 1] / 60).toFixed(1),
    };
    /* A stale tip is not the same as a hole in the middle, and they need
       different reactions: one means it stopped, the other means it stumbled. */
    if (last > CADENCE_S * 6) {
      add(BAD, "collection", `nothing recorded for ${ago(last * 1000)}`,
        "the collector is not running, or cannot push");
    } else if (up < 95 || worst > 3600) {
      add(WATCH, "collection", `${up.toFixed(1)}% of the last ${(span / 3600).toFixed(0)}h recorded`,
        `${big.length} gap(s), worst ${(worst / 60).toFixed(0)} min — a gap is history that exists nowhere else`);
    } else {
      add(OK, "collection", `${up.toFixed(1)}% of the last ${(span / 3600).toFixed(0)}h recorded`,
        `${t.length} commits, median ${(gaps.map(([s]) => s).sort((a, b) => a - b)[gaps.length >> 1] / 60).toFixed(1)} min apart`);
    }
  }
}

/* ── 2. HOW MUCH OF THE NETWORK IT IS CATCHING ─────────────────────────────
   Cumulative WITHIN a run, so a freshly restarted window always reads low and
   that is not a fault. The reading is only meaningful once a window has been
   going a while, which `seconds` says. */
const idx = read("web/data/index.json");
let coverage = null;
if (!idx) {
  add(WATCH, "coverage", "web/data/index.json is not in this clone",
    "sparse checkout, or the archive has never run here");
} else {
  const r = idx.last_run ?? {};
  const pct = (r.coverage ?? 0) * 100;
  const mins = (r.seconds ?? 0) / 60;
  coverage = { pct: +pct.toFixed(2), windowMin: +mins.toFixed(0), reads: r.reads,
               rateLimited: r.rate_limited ?? 0, roomsRead: r.rooms_read,
               tracked: idx.rooms_tracked, updated: idx.updated };
  /* ── THE SHAPE OF THE CLIMB, MEASURED ──────────────────────────────────
     Coverage is cumulative WITHIN a run, so a window that restarted ten
     minutes ago always reads low and that is not a fault — the first version
     of this check called 5.31% a disaster when it was a four-minute-old
     window doing exactly the right thing.

     Eighty readings off this repository's own history give the curve. It
     climbs steeply for an hour and then flattens just under 75%:

        15 min  26%      60 min  61%      120 min  71%
        30 min  43%      90 min  67%      330 min  74.6%

     which is within a point of 74.5 * (1 - e^(-minutes/35)) all the way
     along, so that is what a reading is compared against rather than a flat
     threshold that is wrong for most of a window's life.

     AND WHY IT CAN BE LOW HONESTLY. Coverage is seen/produced, and `produced`
     counts everything the rooms made since the last cursor — including the
     backlog waiting at the start of the window. A window that opens after a
     gap therefore carries that gap in its denominator and reads low for its
     whole five and a half hours. Measured, on 6 September: the window after a
     nineteen-minute hole opened on a backlog three times the usual and was
     still at 30% where the window before it had been at 66% for the same age.
     Nothing was wrong with it. The hole was the fault, and the hole is what
     the collection check above reports. */
  const expect = 74.5 * (1 - Math.exp(-mins / 35));
  const ratio = expect > 0 ? pct / expect : 1;
  if (mins < 20) {
    add(OK, "coverage", `${pct.toFixed(0)}% — the window is ${mins.toFixed(0)} min old`,
      "coverage accumulates inside a run; too early to mean anything");
  } else if (ratio < 0.55) {
    add(WATCH, "coverage", `${pct.toFixed(0)}% at ${mins.toFixed(0)} min, against about ${expect.toFixed(0)}% for its age`,
      "usually a backlog: a window that opens after a gap reads low for its whole life — see collection above");
  } else if (ratio < 0.8) {
    add(WATCH, "coverage", `${pct.toFixed(0)}% at ${mins.toFixed(0)} min, a little under the usual ${expect.toFixed(0)}%`);
  } else {
    add(OK, "coverage", `${pct.toFixed(0)}% at ${mins.toFixed(0)} min, about the ${expect.toFixed(0)}% expected`,
      `${r.reads} reads across ${r.rooms_read} rooms`);
  }
  /* Rate limiting is shared with everything else that talks to Technocore, so
     any of it is worth seeing before it becomes all of it. */
  if (r.rate_limited > 0) {
    add(WATCH, "rate limit", `${r.rate_limited} read(s) refused this window`,
      "600 a minute, shared with every other reader");
  }
  const behind = (idx.behind ?? []).filter((b) => b.rate > 1);
  if (behind.length) {
    add(OK, "rooms behind", `${behind.length} room(s) produce faster than they can be read`,
      behind.slice(0, 3).map((b) => `${b.room} ${b.rate}/s`).join(", "));
  }
}

/* ── 3. IS THE SHOP OPEN, AND IS ANYTHING STUCK ────────────────────────────*/
const deals = read("web/data/tclk-deals.json");
let shop = null;
if (!deals) {
  add(WATCH, "shop", "web/data/tclk-deals.json is not in this clone");
} else {
  const rooms = Object.values(deals.rooms ?? {});
  const ours = rooms.filter((d) => d.ours);
  const seen = ours.map((d) => Date.parse(d.seen)).filter(Number.isFinite);
  const newest = seen.length ? Math.max(...seen) : 0;
  shop = { deals: rooms.length, ours: ours.length,
           lastOursMin: newest ? +(((Date.now() - newest) / 60000).toFixed(0)) : null,
           updated: deals.updated };
  if (!ours.length) add(WATCH, "shop", "no deals of ours in the index");
  else add(OK, "shop", `${ours.length} of ours among ${rooms.length} deals`,
    newest ? `most recent seen ${ago(Date.now() - newest)} ago` : "");
}

/* ── 3b. THE FALLBACK THE SITE STANDS ON WHEN TECHNOCORE REFUSES ───────────
   /api/city and /api/room hand back these files, labelled as archived, when
   the network will not answer. So the state worth catching is not a stale
   snapshot — the pages state their age honestly — but NO snapshot, which is
   the one thing nothing downstream can be honest about.

   It was reachable: the builder emptied the directory before refilling it,
   so a rebuild that lost the network left the site with nothing to fall back
   on. It builds beside and swaps in now, and this is the check that would
   have said so out loud. Counted from the tree, not read: eighty small blobs
   in a partial clone is eighty lazy fetches, and the count is the answer. */
let snapshots = null;
{
  const listed = git(["ls-tree", "--name-only", ...(REF ? [REF] : ["HEAD"]),
                      "web/data/room-snapshots/"]);
  if (listed === null) {
    add(WATCH, "offline fallback", "cannot list web/data/room-snapshots");
  } else {
    const n = listed.split("\n").filter((l) => l.endsWith(".json")).length;
    snapshots = { rooms: n };
    if (n === 0) {
      add(BAD, "offline fallback", "there are no room snapshots at all",
        "every room page falls back to nothing the next time technocore refuses");
    } else if (n < 20) {
      add(WATCH, "offline fallback", `only ${n} room snapshot(s)`,
        "a rebuild that half-finished, or a city that shrank");
    } else {
      add(OK, "offline fallback", `${n} rooms have an archived tail to fall back on`);
    }
  }
}

/* ── 4. WHAT PUBLISHING COSTS ──────────────────────────────────────────────
   The reason this repository once reached 88 GB. Every publish writes new git
   objects for every file it stages, so the number worth watching is bytes of
   NEW BLOB per publish — not the diff, which hides it: git stores the whole
   file, not the change. */
let growth = null;
/* A partial clone (`--filter=blob:none`) has the history but not the file
   contents, so nothing here can weigh anything without going to the network.
   Say so rather than hanging, or worse, quietly reporting a number measured
   from the few blobs that happen to be local. */
const partial = (git(["config", "--get", "remote.origin.promisor"]) ?? "").trim() === "true";
if (partial) {
  add(OK, "growth", "not measurable in a partial clone",
    "clone without --filter to weigh what a publish costs");
} else if (log !== null) {
  const shas = (git(["log", ...(REF ? [REF] : []), "--format=%H%x09%an", "-40"]) ?? "").split("\n")
    .filter((l) => l.includes("overheard-archiver")).map((l) => l.split("\t")[0]).slice(0, 6);
  /* ── ONE git PROCESS, NOT ONE PER FILE ──────────────────────────────────
     A publish commit touches thousands of paths, and asking `git cat-file -s`
     about each of them separately is thousands of process spawns — the first
     version of this took longer than every test suite in the project put
     together. `--batch-check` answers the whole list down one pipe. */
  const sizes = [];
  for (const c of shas) {
    const files = (git(["diff", "--name-only", `${c}~1`, c]) ?? "").split("\n").filter(Boolean);
    if (!files.length) continue;
    /* Capped, and scaled back up. A publish pass stages tens of thousands of
       shards and the answer does not get truer past a large sample. */
    const CAP = 4000;
    const take = files.slice(0, CAP);
    const out = git(["cat-file", "--batch-check=%(objectsize)"],
      take.map((f) => `${c}:${f}`).join("\n") + "\n");
    if (out === null) continue;
    const got = out.split("\n").map((l) => Number(l.trim())).filter(Number.isFinite);
    const bytes = got.reduce((a, b) => a + b, 0) * (files.length / Math.max(1, take.length));
    if (bytes) sizes.push(bytes);
  }
  if (sizes.length) {
    const per = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    const perDay = (per * (86400 / CADENCE_S)) / 1e6;
    growth = { perPublishKB: +(per / 1024).toFixed(0), perDayMB: +perDay.toFixed(0), sampled: sizes.length };
    if (perDay > 900) {
      add(BAD, "growth", `about ${perDay.toFixed(0)} MB of new content a day`,
        "this is how it reached 88 GB — find what is being rewritten whole");
    } else if (perDay > 300) {
      add(WATCH, "growth", `about ${perDay.toFixed(0)} MB of new content a day`);
    } else {
      add(OK, "growth", `about ${perDay.toFixed(0)} MB of new content a day`,
        `${(per / 1024).toFixed(0)} KB per publish, over ${sizes.length} sampled`);
    }
  }
}

/* ── 5. THE THINGS THAT MUST NOT QUIETLY COME UNDONE ───────────────────────
   Each of these was a real outage. They are one line to check and they cost a
   collection window when they are wrong. */
{
  /* Read from the same commit as everything else, not from the checkout: an
     uncommitted fix on somebody's laptop does not protect the collector, and
     a check that goes green for one is telling a comfortable lie. */
  const gi = text(".gitignore") ?? "";
  const arc = text("scripts/archive.mjs") ?? "";
  const usesTmp = /const tmp = `\$\{file\}\.tmp`/.test(arc);
  const ignored = /^\*\.tmp$/m.test(gi);
  if (usesTmp && !ignored) {
    add(BAD, "the .tmp race", "writeAtomic makes .tmp files and nothing ignores them",
      "`git add web/data` will lose a race with a rename and kill the window — four times in three days");
  } else if (usesTmp) {
    add(OK, "the .tmp race", "temp files are ignored, so git never stats them");
  }
  const wf = text(".github/workflows/archive.yml") ?? "";
  if (wf && !/set -eE/.test(wf)) {
    add(WATCH, "diagnosability", "the pass script does not set errtrace",
      "an ERR trap is not inherited by functions without it, so a failure reports only its exit code");
  } else if (wf) {
    add(OK, "diagnosability", "a failing pass names the command that failed");
  }
}

/* ── the verdict ───────────────────────────────────────────────────────────*/
if (JSON_OUT) {
  console.log(JSON.stringify({ checks, collection, coverage, shop, snapshots, growth }, null, 1));
} else {
  const mark = { ok: "  ok  ", watch: " WATCH", bad: "  BAD " };
  console.log(`\nOverheard — read from the repository, ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z`);
  if (asOf) console.log(`  ${asOf}`);
  console.log("");
  for (const c of checks) {
    console.log(`${mark[c.state]}  ${c.name.padEnd(16)} ${c.said}`);
    if (c.detail) console.log(`${" ".repeat(24)}${c.detail}`);
  }
  const bad = checks.filter((c) => c.state === BAD).length;
  const watch = checks.filter((c) => c.state === WATCH).length;
  console.log("\n" + (bad ? `${bad} thing(s) wrong, ${watch} to watch`
    : watch ? `nothing wrong, ${watch} to watch` : "all good"));
}
process.exit(checks.some((c) => c.state === BAD) ? 1 : 0);

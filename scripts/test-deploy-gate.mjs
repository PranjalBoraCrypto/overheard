/**
 * The gate that decides whether a push reaches the site — and what it costs.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE CHANGED COMPLETELY
 *
 * It used to test scripts/vercel-build-or-skip.sh, an `ignoreCommand` that
 * told Vercel to cancel a build it had already started. That script was doing
 * its job and it never had a chance of solving the problem it was written for.
 *
 * MEASURED, September invoice: 20d 8h 34m of build CPU in ten days. On a
 * two-core build machine that is 24.4 hours of building PER DAY — Vercel
 * built this site continuously, day and night, for the whole period, at
 * $102.14 against a $20 plan. The archiver commits every five minutes and a
 * deployment of this repository takes about five, so the queue never emptied.
 *
 * An ignoreCommand cannot fix that, because Vercel clones the repository
 * FIRST and runs the script AFTER. The clone is the expense. The script was
 * being asked to close a door the money had already walked through.
 *
 * So the arrangement is now:
 *
 *   vercel.json      git.deploymentEnabled.main = false — a push starts
 *                    nothing, and that is decided before any clone
 *   deploy.yml       a real change was pushed → POST the deploy hook
 *   archive.yml      fresh archive data → POST the same hook, once an hour,
 *                    from inside the collection loop
 *   .vercelignore    92,181 day-shards nobody serves are left out of the
 *                    upload, so the deployments that DO happen are quick
 *
 * Four files that have to agree, and no single place where a disagreement
 * shows up as anything except a bill at the end of the month. That is what
 * this checks.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), "utf8"); } catch { return ""; } };

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

/* ── A. A PUSH MUST NOT START A DEPLOYMENT ────────────────────────────────*/
console.log("=== A. a push to main starts nothing");
{
  let cfg = null;
  try { cfg = JSON.parse(read("vercel.json")); } catch { /* reported below */ }
  ok("vercel.json is valid JSON", Boolean(cfg));
  ok("automatic deployments on main are off",
    cfg?.git?.deploymentEnabled?.main === false,
    JSON.stringify(cfg?.git?.deploymentEnabled ?? null));
  /* THE ONE THAT WOULD BE INVISIBLE. Every deployment now happens because
     something asked for it — and an ignoreCommand would be asked about those
     deployments too. It would look at HEAD, see an archive commit, and cancel
     the hourly data publish every single time. The site would simply stop
     updating, with no error anywhere. */
  ok("and no ignoreCommand is left wired, which would cancel the deploys we ask for",
    !("ignoreCommand" in (cfg ?? {})), String(cfg?.ignoreCommand ?? "(none)"));
  ok("the retired ignore script is gone rather than sitting there looking wired",
    !fs.existsSync(path.join(ROOT, "scripts/vercel-build-or-skip.sh")));
}

/* ── B. SOMETHING STILL ASKS FOR THE DEPLOYMENTS WE WANT ──────────────────
 * Turning auto-deploy off is one line and it is the whole saving. It is also
 * how a site quietly stops updating for a week, so both askers are pinned.
 */
console.log("\n=== B. two places ask, and neither of them is a cron");
{
  const dep = read(".github/workflows/deploy.yml");
  const arc = read(".github/workflows/archive.yml");
  ok("deploy.yml exists and runs on a push to main",
    /push:\s*\n\s*branches:\s*\[main\]/.test(dep));
  ok("and it POSTs the deploy hook", /VERCEL_DEPLOY_HOOK/.test(dep) && /curl[^\n]*-X POST/.test(dep));
  /* ONCE A DAY, and the number is pinned because it is a budget decision
     rather than a taste: a deployment costs about seven minutes, five of them
     cloning, so every publish is real money. */
  ok("the archive publishes the data about once a day",
    /MIN_HOURS_BETWEEN_PUBLISHES=22/.test(arc) && /VERCEL_DEPLOY_HOOK/.test(arc),
    (arc.match(/MIN_HOURS_BETWEEN_PUBLISHES=\d+/) || ["(not set)"])[0]);
  ok("only when something new was actually published",
    /published.*-le.*published_when_deployed/.test(arc));
  /* THE DEAD TIMER. It used to be DEPLOY_EVERY=21600 — six hours — inside a
     window RUN_SECONDS=19800 long. Five and a half. The condition could not
     once be true, and nothing said so; the end-of-window publish was doing
     all the deploying at whatever rate windows happened to end. A number that
     looks like the answer and is not is worse than no number. */
  const code = arc.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");   // comments describe it, code does it
  const win = Number((code.match(/RUN_SECONDS: "(\d+)"/) || [])[1] || 0);
  const every = Number((code.match(/DEPLOY_EVERY=(\d+)/) || [])[1] || 0);
  ok("and its timer is not one that can never fire inside a window",
    every === 0 || every < win,
    every ? `DEPLOY_EVERY=${every} against a ${win}s window` : `no in-loop timer, and the window is ${win}s`);
  /* CRON ON THIS REPOSITORY IS A SUGGESTION: eleven firings delivered out of
     roughly eight hundred and sixty requested, measured over three days. A
     data publish hung on that would go dark for whole days at a time. */
  ok("the daily publish does not depend on a schedule",
    !/^\s*schedule:/m.test(dep), "it rides the collection loop, alive 98.5% of the time");
}

/* ── C. THE DECISION deploy.yml MAKES, RUN RATHER THAN READ ───────────────*/
console.log("\n=== C. what deploy.yml does with each kind of commit");
{
  const dep = read(".github/workflows/deploy.yml");
  const m = dep.match(/ {8}run: \|\n([\s\S]*)$/);
  const body = (m ? m[1] : "").replace(/^ {10}/gm, "");
  const verdict = (msg, hook = "http://127.0.0.1:9/hook", why = "push") => {
    /* The hook is deliberately a port nothing listens on: what is being
       tested is the DECISION, and a run that decides to deploy shows up as a
       failed POST rather than as a real deployment. */
    const r = spawnSync("bash", ["-c", body], {
      encoding: "utf8", env: { ...process.env, HOOK: hook, MSG: msg, WHY: why },
    });
    const out = String(r.stdout ?? "") + String(r.stderr ?? "");
    if (/nothing to deploy|hourly publish will carry/.test(out)) return "skip";
    if (/asking for a deployment/.test(out)) return "deploy";
    if (/no VERCEL_DEPLOY_HOOK/.test(out)) return "unconfigured";
    return `? ${out.trim().split("\n")[0]}`;
  };
  ok("a real change deploys", verdict("deals: the copy button gets its icon back") === "deploy");
  ok("an archive commit does not", verdict("archive: 2026-09-06T11:11:47Z [skip ci]") === "skip");
  ok("a hand-run deploy always deploys, whatever is at the tip",
    verdict("archive: 2026-09-06T11:11:47Z [skip ci]", undefined, "workflow_dispatch") === "deploy");
  /* THE STATE THIS REPOSITORY IS IN UNTIL SOMEBODY MAKES THE SECRET, and the
     one where silence would be worst: nothing reaches the site at all. It has
     to say so, in the annotations, rather than exiting zero and looking fine. */
  const r = spawnSync("bash", ["-c", body], {
    encoding: "utf8", env: { ...process.env, HOOK: "", MSG: "a real change", WHY: "push" },
  });
  ok("with no hook configured it says so loudly and does not fail the run",
    r.status === 0 && /::warning/.test(String(r.stdout)), String(r.stdout).trim().split("\n")[0]);
}

/* ── D. EVERY /data PATH IS EITHER SHIPPED OR REWRITTEN ───────────────────
 * There are now two ways for a page to get a file out of /data: it is in the
 * deployment, or a rewrite in vercel.json fetches it from GitHub. The failure
 * that matters is a path that is NEITHER — excluded from the upload and not
 * covered by a rewrite. That is a 404 on a site whose whole subject is an
 * archive, and nothing about it looks wrong until somebody opens the page.
 *
 * So both halves are asked together, of git and of the rewrite table, using
 * real filenames in every shape the pages and the functions actually use.
 */
console.log("=== D. every /data path is either shipped or rewritten");
{
  const vi = read(".vercelignore");
  const cfg = JSON.parse(read("vercel.json") || "{}");
  const rewrites = cfg.rewrites ?? [];
  ok(".vercelignore exists", vi.length > 0);
  ok("and vercel.json carries rewrites", rewrites.length > 0, `${rewrites.length} rule(s)`);

  /* gitignore semantics, from git rather than from a regex of my own. */
  const W = fs.mkdtempSync(path.join(os.tmpdir(), "vign-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: W });
  fs.writeFileSync(path.join(W, ".gitignore"), vi);
  const shipped = (p) => spawnSync("git", ["check-ignore", "-q", "--no-index", p],
    { cwd: W }).status !== 0;

  /* Vercel's `:param` matches one segment, `:name*` matches the rest. */
  const rewritten = (url) => rewrites.some((r) => {
    const rx = new RegExp("^" + r.source
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/:([A-Za-z]+)\*/g, "(?:.+)")
      .replace(/:([A-Za-z]+)/g, "[^/]+") + "$");
    return rx.test(url);
  });

  /* Each row: the file in the repository, the URL a page asks for, and who
     asks. Every one has to be reachable one way or the other. */
  const NEEDED = [
    ["web/data/index.json", "/data/index.json", "the archive index"],
    ["web/data/roster.json", "/data/roster.json", "the city"],
    ["web/data/recent.json", "/data/recent.json", "recent rooms"],
    ["web/data/city-snapshot.json", "/data/city-snapshot.json", "api/city.js, when technocore refuses"],
    ["web/data/tclk-deals.json", "/data/tclk-deals.json", "the deals board"],
    ["web/data/room-snapshots/lobby.json", "/data/room-snapshots/lobby.json", "api/room.js, the offline fallback"],
    ["web/data/profiles/ab/cd.ndjson", "/data/profiles/ab/cd.ndjson", "the count on a profile card"],
    ["web/data/profiles/abc.json", "/data/profiles/abc.json", "an older profile shard"],
    ["web/data/lobby/_meta.json", "/data/lobby/_meta.json", "the room history range"],
    ["web/data/tclk-offers/_meta.json", "/data/tclk-offers/_meta.json", "the offers room"],
  ];
  for (const [file, url, who] of NEEDED) {
    const s = shipped(file), r = rewritten(url);
    ok(`reachable: ${url} — ${who}`, s || r,
      s && r ? "shipped AND rewritten" : s ? "shipped" : r ? "rewritten to GitHub" : "NEITHER — this is a 404");
  }

  /* THE FALLBACK MUST NOT DEPEND ON GITHUB. It is what the site serves when
     technocore is refusing; routing it through a third party means the two
     outages that matter most are the same outage. */
  for (const f of ["web/data/room-snapshots/lobby.json", "web/data/city-snapshot.json",
                   "web/data/index.json", "web/data/roster.json"]) {
    ok(`the fallback is in the deployment, not fetched: ${f.replace("web/data/", "")}`, shipped(f));
  }

  /* AND THE BULK IS GONE. If these ever come back into the upload the
     deployment goes from ninety files to a hundred and thirty thousand, and
     the only symptom is the bill. */
  for (const [f, n] of [
    ["web/data/lobby/2026-09-05.ndjson", "a dated day-shard"],
    ["web/data/profiles/ab/cd.ndjson", "a profile shard"],
    ["web/data/lobby/_meta.json", "a room's metadata"],
  ]) ok(`left out of the upload: ${n}`, !shipped(f));

  fs.rmSync(W, { recursive: true, force: true });
}

/* ── E. AND THE LIST ABOVE IS NOT A GUESS ─────────────────────────────────
 * The way this breaks a year from now is something starting to fetch a new
 * path out of /data with nobody remembering either file exists. So the pages
 * AND the server functions are read, every /data path they ask the DEPLOYMENT
 * for is extracted, and any shape the list above does not cover is reported
 * rather than assumed safe.
 *
 * The functions are the half that was nearly missed. api/room.js and
 * api/city.js fetch out of the deployment with `new URL(..., request.url)`,
 * while api/orders.js and api/profile.js go to raw.githubusercontent.com
 * instead — same-looking paths, opposite consequences. Only the first kind
 * can be broken here, so a line naming raw.githubusercontent is not this
 * file's business.
 */
console.log("\n=== E. every /data path served FROM THE DEPLOYMENT is one this test knows about");
{
  const files = [
    ...fs.readdirSync(path.join(ROOT, "web"))
      .filter((f) => f.endsWith(".html") || f.endsWith(".js")).map((f) => `web/${f}`),
    ...fs.readdirSync(path.join(ROOT, "api"))
      .filter((f) => f.endsWith(".js") || f.endsWith(".mjs")).map((f) => `api/${f}`),
  ];
  const found = new Map();
  for (const f of files) {
    for (const line of read(f).split("\n")) {
      if (line.includes("raw.githubusercontent")) continue;   // not from the deployment
      for (const m of line.matchAll(/["'`.]\/?data\/([A-Za-z0-9._${}()\-/]*)/g)) {
        const fixed = m[1].split("${")[0];
        const fam = fixed.includes("/") ? fixed.replace(/[^/]*$/, "") : "(top level)";
        if (!found.has(fam)) found.set(fam, f);
      }
    }
  }
  const known = new Set(["(top level)", "profiles/", "room-snapshots/", "tclk-offers/"]);
  const surprises = [...found].filter(([f]) => !known.has(f));
  ok("the functions are read too, not only the pages", found.has("room-snapshots/"),
    `api/room.js fetches it from ${found.get("room-snapshots/") ?? "nowhere this test can see"}`);
  ok("nothing fetches a /data shape this test has not been told about",
    surprises.length === 0,
    surprises.length ? `new: ${surprises.map(([f, w]) => `${f} (${w})`).join(", ")} — ship it or rewrite it`
                     : [...found.keys()].join("  "));
}

/* ── F. THE REWRITES POINT SOMEWHERE THAT EXISTS ──────────────────────────
 * A rewrite with the wrong owner, repository or branch in it fails exactly
 * like a missing file — a 404, on every profile card, silently. The string is
 * checked against the repository this actually is.
 */
console.log("\n=== F. the rewrites point at this repository's own archive");
{
  const cfg = JSON.parse(read("vercel.json") || "{}");
  const dests = (cfg.rewrites ?? []).map((r) => r.destination);
  ok("every rewrite goes to raw.githubusercontent",
    dests.length > 0 && dests.every((d) => d.startsWith("https://raw.githubusercontent.com/")),
    dests.join("  "));
  ok("and every one names the same owner, repo and branch as the functions do",
    dests.every((d) => d.includes("/PranjalBoraCrypto/overheard/main/web/data/")));
  /* The functions have carried these three strings for months; if the repo is
     ever renamed or the branch moved, both halves have to move together. */
  const fn = read("api/orders.js") + read("api/profile.js") + read("api/recent.js");
  ok("which is what api/orders.js, api/profile.js and api/recent.js already use",
    /PranjalBoraCrypto/.test(fn) && /"overheard"/.test(fn));
}

/* ── G. vercel.json IS VALIDATED, AND A STRAY KEY IS NOT A WARNING ────────
 * Vercel checks vercel.json against a schema before it does anything else. A
 * key it does not recognise fails the deployment in ZERO SECONDS, with the
 * words "Deployment failed." and a link to the configuration docs — no line
 * number, no key name, nothing pointing at what you added.
 *
 * And the site does not change, because the previous deployment keeps
 * serving. So the whole symptom is a push that appears to have done nothing.
 * That is exactly how it happened: two explanatory "_why" keys, added to
 * document this arrangement, killed the deployment that carried it.
 *
 * The explanation now lives in .vercelignore and in this file. vercel.json
 * carries configuration and nothing else, and here is the list.
 */
console.log("\n=== G. vercel.json carries configuration and nothing else");
{
  const cfg = JSON.parse(read("vercel.json") || "{}");
  const ALLOWED = new Set(["$schema", "outputDirectory", "cleanUrls", "git", "rewrites", "headers"]);
  const strays = Object.keys(cfg).filter((k) => !ALLOWED.has(k));
  ok("no key at the top level that Vercel would reject", strays.length === 0,
    strays.length ? `${strays.join(", ")} — this fails the deployment in 0s` : [...ALLOWED].join(" "));
  /* Nested objects are validated too, and `git` is the one this project puts
     something unusual in. */
  const gitStrays = Object.keys(cfg.git ?? {}).filter((k) => k !== "deploymentEnabled");
  ok("and none inside git either", gitStrays.length === 0, gitStrays.join(", ") || "deploymentEnabled");
  /* A comment is the obvious thing to reach for and JSON does not have one.
     Saying so here is cheaper than the next person rediscovering it. */
  ok("nothing is trying to be a comment", !JSON.stringify(cfg).includes("_why"),
    "the reasoning lives in .vercelignore and in this file");
}

/* ── H. THE ONE DECISION THAT SPENDS MONEY, RUN RATHER THAN READ ──────────
 * At the end of every window the archiver decides whether to ask the site to
 * pick the archive up. A window is five and a half hours, so it faces that
 * decision four or five times a day and exactly one of them should cost a
 * deployment.
 *
 * It cannot decide with a variable, because a variable does not outlive the
 * job — that is precisely how the previous version came to have a six-hour
 * timer inside a five-and-a-half-hour window and never fire once. It reads a
 * stamp the last successful ask left in web/data instead. So the stamp
 * handling is what is tested, and it is tested by RUNNING it.
 *
 * THE HOOK IS SERVED BY A SEPARATE PROCESS, which is not fussiness. The first
 * version of this test answered the hook from an http server in this file and
 * hung for ever: spawnSync blocks the event loop, so the server could not
 * reply to the curl that this very call was waiting on. A deadlock, in a test
 * for a deployment, which is a funny place to learn it.
 */
console.log("\n=== H. asking the site to update: once a day, and only when it worked");
{
  const arc = read(".github/workflows/archive.yml");
  const from = arc.indexOf("          STAMP=web/data/.last-published");
  const body = arc.slice(from, arc.indexOf("\n          fi\n", from) + "\n          fi\n".length)
    .replace(/^ {10}/gm, "");
  ok("the block is where this test thinks it is",
    from > 0 && body.includes("VERCEL_DEPLOY_HOOK"), from > 0 ? "" : "not found in archive.yml");

  const srv = spawn(process.execPath, ["-e",
    'const h=require("http");const s=h.createServer((q,r)=>{r.writeHead(200);r.end("ok")});' +
    's.listen(0,()=>console.log(s.address().port));'], { stdio: ["ignore", "pipe", "ignore"] });
  const port = await new Promise((res) => srv.stdout.once("data", (d) => res(String(d).trim())));
  const HOOK = `http://127.0.0.1:${port}/hook`;
  /* Port 1 refuses instantly, which is what a broken hook should look like —
     not a hang, which would tell us nothing and take for ever to say it. */
  const DEAD = "http://127.0.0.1:1/hook";

  /* A REAL REPOSITORY WITH A REAL REMOTE, and that is not gold-plating.
     The first version of this block ran in a bare temporary directory and
     asserted that the stamp FILE existed afterwards. It did — on a runner that
     was about to be deleted. Nothing committed it, so every window read no
     stamp, decided it had never asked, and asked again: four or five
     deployments a day out of a block whose entire purpose is to allow one.
     Checking the file is checking the wrong side of the transfer, so the
     question this asks now is what arrived on the remote. */
  const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8" });
  const run = ({ hook = HOOK, stampAgeH = null, published = 1, before = 0 }) => {
    const W = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-"));
    const R = fs.mkdtempSync(path.join(os.tmpdir(), "stampremote-"));
    git(R, "init", "-q", "--bare", "-b", "main");
    git(W, "init", "-q", "-b", "main");
    git(W, "config", "user.name", "t"); git(W, "config", "user.email", "t@t");
    fs.mkdirSync(path.join(W, "web/data"), { recursive: true });
    const stamp = path.join(W, "web/data/.last-published");
    if (stampAgeH !== null)
      fs.writeFileSync(stamp, String(Math.floor(Date.now() / 1000) - stampAgeH * 3600) + "\n");
    fs.writeFileSync(path.join(W, "web/data/index.json"), "{}");
    git(W, "add", "-A"); git(W, "commit", "-qm", "seed");
    git(W, "remote", "add", "origin", R);
    git(W, "push", "-q", "-u", "origin", "main");

    const r = spawnSync("bash", ["-c", body], {
      cwd: W, encoding: "utf8", timeout: 20000,
      env: { ...process.env, VERCEL_DEPLOY_HOOK: hook, published: String(published),
             published_when_deployed: String(before), MIN_HOURS_BETWEEN_PUBLISHES: "22",
             GITHUB_REF_NAME: "main" },
    });
    const out = (String(r.stdout ?? "") + String(r.stderr ?? "")).trim();
    /* What the NEXT window would see: the remote, read the way a fresh
       checkout reads it, not the working tree this one is about to lose. */
    const onRemote = git(R, "show", "main:web/data/.last-published");
    const msg = git(R, "log", "-1", "--format=%s", "main").stdout.trim();
    const res = {
      out, asked: /asked the site to pick up/.test(out),
      stamped: fs.existsSync(stamp),
      committed: onRemote.status === 0 ? onRemote.stdout.trim() : null,
      msg,
    };
    fs.rmSync(W, { recursive: true, force: true });
    fs.rmSync(R, { recursive: true, force: true });
    return res;
  };

  let r = run({ stampAgeH: null });
  ok("with no stamp at all it asks", r.asked, r.out.split("\n").pop());
  ok("and records that it did, where the next window can read it", r.stamped);
  ok("and the record REACHES THE REMOTE, not just the runner's disk",
    r.committed !== null, r.committed === null ? "nothing on main" : r.committed);
  ok("as a number the next window can compare against",
    Math.abs(Number(r.committed) - Date.now() / 1000) < 300, String(r.committed));
  /* The archiver's own commits must never be a reason to deploy — that is
     section C's rule — and this one is written moments after a deployment was
     already queued, so it is the last commit that should start another. */
  ok("in a commit that carries [skip ci]", /\[skip ci\]/.test(r.msg), r.msg);

  r = run({ stampAgeH: 30 });
  ok("thirty hours later it asks again", r.asked, r.out.split("\n").pop());

  r = run({ stampAgeH: 5 });
  ok("five hours later it does not — this is the whole saving", !r.asked, r.out.split("\n").pop());
  ok("and says when the next one is due", /next one after 22h/.test(r.out));

  r = run({ stampAgeH: 30, published: 0 });
  ok("a window that published nothing asks for nothing", !r.asked, r.out.split("\n").pop());

  r = run({ stampAgeH: null, hook: "" });
  ok("with no hook configured it says so instead of failing",
    !r.asked && /keeps its old copy/.test(r.out), r.out.split("\n").pop());

  /* THE EXPENSIVE MISTAKE IN THE OTHER DIRECTION: a deployment that was never
     queued must not be recorded as one, or the site goes a whole day without
     the archive and nothing anywhere says why. */
  r = run({ stampAgeH: null, hook: DEAD });
  ok("a hook that failed is not recorded as a success", !r.stamped, r.out.split("\n").pop());
  ok("and it says so out loud", /::warning/.test(r.out));

  srv.kill();
}

/* ── I. THE LAST PASS OF A WINDOW CARRIES THE WHOLE ARCHIVE ───────────────
 * The collector writes the final report and both cold-start snapshots as it
 * exits, so they exist only in the moments between the collector stopping and
 * the runner being deleted. One pass runs in that gap — the one called with
 * PASS_N=final — and it is the only chance those files ever get.
 *
 * It was not taking it. `(PASS_N - 1) % 12` inside a bash $(( )) reads the
 * unset name `final` as zero, so the test came out -1, the full staging was
 * skipped, and the pass that exists to publish the snapshots published eight
 * small files. The symptom is not an error: it is
 * web/data/room-snapshots/lobby.json on main still saying 30 August while the
 * archive beneath it is minutes old.
 *
 * So this runs the real pass script, out of the real workflow, against a real
 * repository, and asks what landed on the remote.
 */
console.log("\n=== I. the last pass of a window publishes the snapshots");
{
  const arc = read(".github/workflows/archive.yml");
  const open = "cat > \"${RUNNER_TEMP:-/tmp}/publish-pass.sh\" <<'PASS_SCRIPT'\n";
  const a = arc.indexOf(open), b = arc.indexOf("\n          PASS_SCRIPT\n", a);
  const script = a < 0 || b < 0 ? "" : arc.slice(a + open.length, b).replace(/^ {10}/gm, "");
  ok("the pass script is where this test thinks it is",
    script.includes("stage_this_pass") && script.includes("SMALL="),
    script ? "" : "not found in archive.yml");

  const git = (cwd, ...x) => spawnSync("git", x, { cwd, encoding: "utf8" });
  /* One window's worth of state: a repository with a remote, a collector's
     small files, and — written after the seed, the way the collector writes
     them on its way out — a snapshot and a report. */
  const onePass = (PASS_N) => {
    const W = fs.mkdtempSync(path.join(os.tmpdir(), "pass-"));
    const R = fs.mkdtempSync(path.join(os.tmpdir(), "passremote-"));
    git(R, "init", "-q", "--bare", "-b", "main");
    git(W, "init", "-q", "-b", "main");
    git(W, "config", "user.name", "t"); git(W, "config", "user.email", "t@t");
    fs.mkdirSync(path.join(W, "web/data/room-snapshots"), { recursive: true });
    fs.writeFileSync(path.join(W, "web/data/index.json"), "{}");
    git(W, "add", "-A"); git(W, "commit", "-qm", "seed");
    git(W, "remote", "add", "origin", R);
    git(W, "push", "-q", "-u", "origin", "main");

    /* Both kinds of new file, so the two tiers can be told apart. */
    fs.writeFileSync(path.join(W, "web/data/index.json"), '{"last_run":{"coverage":1}}');
    fs.writeFileSync(path.join(W, "web/data/recent.json"), "[]");
    fs.writeFileSync(path.join(W, "web/data/room-snapshots/lobby.json"),
      '{"retrieved_at":"2026-09-06T15:00:00Z"}');

    const r = spawnSync("bash", ["-c", script], {
      cwd: W, encoding: "utf8", timeout: 30000,
      env: { ...process.env, PASS_N: String(PASS_N), GITHUB_REF_NAME: "main" },
    });
    const files = git(R, "show", "--name-only", "--format=%s", "main").stdout;
    fs.rmSync(W, { recursive: true, force: true });
    fs.rmSync(R, { recursive: true, force: true });
    return {
      code: r.status,
      out: (String(r.stdout ?? "") + String(r.stderr ?? "")).trim(),
      subject: files.split("\n")[0].trim(),
      snapshot: /room-snapshots\/lobby\.json/.test(files),
      small: /web\/data\/recent\.json/.test(files),
    };
  };

  let p = onePass("final");
  ok("the final pass pushes", p.code === 0, `exit ${p.code} — ${p.out.split("\n").pop()}`);
  ok("AND IT CARRIES THE SNAPSHOTS — the whole reason it exists", p.snapshot, p.subject);
  ok("and calls itself a publish", /^archive: publish /.test(p.subject), p.subject);

  p = onePass(1);
  ok("the first pass of a window carries them too", p.snapshot, p.subject);

  /* The other half of the rule, and the one that keeps the repository from
     growing 600MB a day: an ordinary pass commits the small files only. */
  p = onePass(2);
  ok("an ordinary pass does not", !p.snapshot, p.subject);
  ok("but does carry the small ones", p.small, p.subject);
  ok("and says [skip ci], so it cannot cost a deployment",
    /\[skip ci\]$/.test(p.subject), p.subject);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

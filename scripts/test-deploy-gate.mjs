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
import { execFileSync, spawnSync } from "node:child_process";
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
  /* SIX HOURS, and the number is pinned because it is a budget decision, not
     a taste. A deployment of this repository takes about nine minutes —
     Vercel clones ten commits of a 223,618-file tree first, which no amount
     of trimming the upload touches. Hourly measured out at roughly $51 a
     month of build time; this is about $13. Anyone moving it should have to
     move this line and read that. */
  ok("the archive loop publishes the data every six hours",
    /DEPLOY_EVERY=21600/.test(arc) && /VERCEL_DEPLOY_HOOK/.test(arc),
    (arc.match(/DEPLOY_EVERY=\d+/) || ["(not set)"])[0]);
  /* Both guards matter. Without the first, an hour of nothing happening still
     costs a deployment; without the second, every pass does. */
  ok("only when something new was actually published",
    /published.*-gt.*published_when_deployed/.test(arc));
  ok("and no more than once an hour", /now - last_deploy \)\) -ge "\$DEPLOY_EVERY"/.test(arc));
  /* CRON ON THIS REPOSITORY IS A SUGGESTION: eleven firings delivered out of
     roughly eight hundred and sixty requested, measured over three days. A
     data publish hung on that would go dark for whole days at a time. */
  ok("the hourly publish does not depend on a schedule",
    !/^\s*schedule:/m.test(dep), "it rides the collection loop, alive 97.9% of the time");
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

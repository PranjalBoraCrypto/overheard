/**
 * The order page — the door a person actually uses.
 *
 * Most visitors are not developers. A developer does not need us at all: they
 * can drive tclk directly from the npm packages. So the JSON frame, which is
 * the right interface for an agent, is the wrong one for the customer this
 * site exists for. This page is the button; the frame is kept beside it.
 *
 * WHAT THIS FILE IS REALLY GUARDING. The order page is the only page on the
 * site that both holds a signing key and talks about money, so the things
 * that must never be true of it are worth pinning rather than assuming:
 * it must never carry a seed, never send key material anywhere, and never
 * quote terms the shop would refuse.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAN_DO } from "./work.mjs";
import { JOBS } from "./runner.mjs";
import { RAIL, IS_REHEARSAL } from "./rail.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};
const page = fs.readFileSync(path.join(ROOT, "web/hire.html"), "utf8");
const board = fs.readFileSync(path.join(ROOT, "web/deals-preview-78cb4a1be923c6b4.html"), "utf8");

console.log("\n=== the page holds nothing it should not");
ok("no seed, no 64-hex string of any kind", !/[0-9a-f]{64}/i.test(page),
  (page.match(/[0-9a-f]{64}/i) || ["clean"])[0].slice(0, 24));
ok("it never names a private key field",
  !/privateKey|secretKey|mnemonic|\bseed\b/i.test(page));
/* The key lives in a non-extractable store; the page may ask it for a
   signature and may never read it. Importing the getter would be the way that
   goes wrong. */
/* Comments stripped first. The prose above this import explains that the key
   is non-extractable, and a test that fails on its own explanation is a test
   somebody weakens rather than obeys. */
const code = page.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
ok("it imports the signer, not the key",
  /signTextB64u/.test(code) && !/signingKey|extractable/.test(code),
  "script may ask the vault for a signature and may never read the key");
ok("and posts through the endpoint that cannot sign",
  /\/api\/post/.test(page) && !/say-signed/.test(page),
  "api/post forwards a finished signature and can never produce one");

console.log("\n=== it offers exactly what the shop can do");
/* ORDERABLE MEANS "HAS A BUTTON", NOT "IS MENTIONED".
   This used to assert `!page.includes(job)` for a job with no handler, which
   is a substring search over the whole file — so the page could not so much
   as NAME `overheard-archive-question` anywhere, in prose, in a comment, or
   in the lookup that turns a job id into a readable label in the order
   history. That last one matters: somebody who posted such an offer by hand
   should see it in their list called "Ask the archive" rather than as a raw
   id, and the blunt rule forbade exactly that while claiming to be about
   buttons. What must be absent is the CONTROL. */
const orderable = new Set([...page.matchAll(/data-job="([^"]+)"/g)].map((m) => m[1]));
for (const j of CAN_DO) ok(`${j} is orderable`, orderable.has(j));
for (const j of JOBS.map((x) => x.id).filter((x) => !CAN_DO.has(x)))
  ok(`${j} has no control of its own`, !orderable.has(j),
    "a job with no handler must not be reachable from a button");

/* Price is a floor in refuseTake(), so the page must not quote under it. */
for (const j of JOBS.filter((x) => CAN_DO.has(x.id))) {
  const m = page.match(new RegExp(`data-job="${j.id}"[^>]*data-price="(\\d+)"`));
  ok(`${j.id} is priced at or above the shelf`,
    !!m && Number(m[1]) >= Number(j.amount), m ? `${m[1]} vs ${j.amount}` : "no price found");
}

console.log("\n=== the order it composes would not be refused");
ok("it opens as the payer, which is the only direction that settles",
  /role: "payer"/.test(page), "flop-labs/tclk#12");
ok("it tags the protocol the planner filters on", /proto: "overheard"/.test(page));
ok("it names the rail the shop actually posts",
  new RegExp(`rails: \\["${RAIL}"\\]`).test(page), RAIL);
ok("it uses a hash lock, the only kind we can open", /lock: "hash"/.test(page));
/* refuseTake wants at least MIN_WORK_MS to claimBy and a refund strictly
   after it. 24h and 48h clear both with room to spare. */
ok("its claim window is hours, not minutes", /claimBy: 24 \* HOUR/.test(page));
ok("and the refund falls after the claim closes", /refundAfter: 48 \* HOUR/.test(page));
ok("it normalises text before signing, as the room stores it",
  /sweep\(/.test(page), "the signature covers the STORED text, not what was typed");

console.log("\n=== it tells the truth about money");
ok("a rehearsal rail is disclosed on the page itself",
  !IS_REHEARSAL || /Nothing of value moves yet|rehearsal rail/i.test(page));
ok("and a failure says nothing was charged",
  /Nothing was charged/.test(page), "because nothing can be — we are not a custodian");

console.log("\n=== both doors exist, and the button is first");
ok("the board links to the order page", board.includes('href="/hire.html"'));
ok("the button comes before the frame",
  board.indexOf("hirebtn") < board.indexOf("devroute"),
  "most visitors are not developers; a developer does not need us");
ok("the frame is still there for an agent",
  /devroute/.test(board) && /tclk1|"type": "offer"/.test(board));
ok("the order page carries both routes too",
  /Ordering from an agent/.test(page) && /Place the order/.test(page));

/* ══════════════════════════════════════════════════════════════════════════
 * THE PART THAT NEEDS A BROWSER
 *
 * Everything above reads the file as text, which is the right way to pin
 * "there is no seed in here". It is the wrong way to check a checkout: the
 * things that matter now are what the page DOES when somebody picks a job and
 * types into it, and a substring search cannot see any of it.
 *
 * The specific risk is the button. It is disabled until three separate facts
 * are true, and a disabled button that never enables — or one that enables
 * when it should not — is the worst failure this page has, because it is
 * silent either way.
 * ═════════════════════════════════════════════════════════════════════════*/
import http from "node:http";
import { chromium } from "playwright";

const PORT = 9439;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".svg": "image/svg+xml" };
const srv = http.createServer((q, r) => {
  const u = q.url.split("?")[0];
  /* The history section asks for the offers room. Answered with an empty
     room so the test never depends on the network, and so "no orders yet"
     is the state under test. */
  if (u === "/api/room") { r.writeHead(200, { "content-type": "application/json" });
    return r.end('{"source":"live","messages":[]}'); }
  /* `ROOT` is the repository root; the site is the `web` directory under it.
     Joining the request path straight onto ROOT served 404s for everything,
     the page rendered blank, and three assertions failed with "0 options" —
     which reads exactly like a page that lost its markup. */
  const f = path.join(ROOT, "web", u);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end("no"); }
  r.writeHead(200, { "content-type": TYPES[path.extname(f)] || "text/plain" });
  r.end(fs.readFileSync(f));
});
await new Promise((res) => srv.listen(PORT, res));

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"],
});
const pg = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const jsErrors = [];
pg.on("pageerror", (e) => jsErrors.push(String(e).slice(0, 140)));
await pg.goto(`http://localhost:${PORT}/hire.html`, { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(900);

const state = () => pg.evaluate(() => ({
  job: document.querySelector('.pick[aria-checked="true"]')?.dataset.job,
  label: document.getElementById("brieflabel").textContent,
  price: document.getElementById("sumPrice").textContent,
  sumJob: document.getElementById("sumJob").textContent,
  steps: [...document.querySelectorAll(".stepblk")].map((s) => s.classList.contains("done")),
  off: document.getElementById("send").disabled,
  why: document.getElementById("whynot").textContent,
  hint: document.getElementById("briefhint").textContent,
  frame: document.getElementById("frame").textContent,
}));

console.log("\n=== the shelf is three things you can see, not a dropdown");
/* `code` is the file with comments stripped. The prose at the top of the
   page explains why the dropdown was removed, and it says the word — a test
   that fails on its own explanation is a test somebody weakens rather than
   obeys, which is the same trap the innerHTML rule fell into. */
ok("no <select> survives", !/<select/i.test(code), "a dropdown hides two thirds of the shelf");
ok("three options are on screen at once",
  (await pg.evaluate(() => document.querySelectorAll(".pick").length)) === 3);
ok("and they announce themselves as a radio group",
  await pg.evaluate(() => {
    const g = document.querySelector('[role="radiogroup"]');
    return !!g && [...g.querySelectorAll('[role="radio"]')].length === 3
        && g.querySelectorAll('[aria-checked="true"]').length === 1;
  }), "exactly one checked, which is what a group of radios means");

console.log("\n=== choosing changes everything that depends on the choice");
const a = await state();
await pg.click('.pick[data-job="overheard-daily-digest"]');
await pg.waitForTimeout(200);
const b2 = await state();
ok("the label, the summary and the price all follow the choice",
  b2.job === "overheard-daily-digest" && b2.label !== a.label
  && b2.sumJob !== a.sumJob && b2.price !== a.price,
  `${a.sumJob} ${a.price} -> ${b2.sumJob} ${b2.price}`);
ok("and so does the frame a developer would copy",
  b2.frame.includes("overheard-daily-digest") && !b2.frame.includes("overheard-agent-profile"),
  "one source for both doors, so they cannot disagree about what was ordered");

console.log("\n=== a brief of the wrong shape is refused here, not by the shop");
/* This is the whole point of validating. A room name typed into the
   agent-profile field used to produce a real signed offer that the shop
   accepts and then cannot fill, and the buyer finds out hours later. */
await pg.fill("#brief", "technocore");
await pg.waitForTimeout(150);
const wrong = await state();
ok("a date field rejects a room name", wrong.off && wrong.hint.length > 0, wrong.hint);
ok("and says what the right shape looks like", /YYYY-MM-DD/.test(wrong.hint), wrong.hint);
await pg.fill("#brief", "2026-09-02");
await pg.waitForTimeout(150);
const right = await state();
ok("a date is accepted", right.hint === "" && right.steps[1] === true);

console.log("\n=== the button never leaves anybody guessing");
ok("it is still off, because there is no identity in this browser", right.off);
ok("and it says which step is missing rather than just greying out",
  /step 3/i.test(right.why), right.why);
ok("step 3 is the only one not satisfied",
  right.steps[0] === true && right.steps[1] === true && right.steps[2] === false,
  right.steps.map((s) => (s ? "done" : "todo")).join(" · "));

console.log("\n=== arriving from a gig card");
await pg.goto(`http://localhost:${PORT}/hire.html?job=overheard-room-summary`,
  { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(700);
ok("?job= preselects the card that was clicked",
  (await state()).job === "overheard-room-summary");
await pg.goto(`http://localhost:${PORT}/hire.html?job=overheard-archive-question`,
  { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(700);
ok("and a job with no handler falls back rather than being honoured",
  (await state()).job === "overheard-agent-profile",
  "a query string is a stranger's text; it must never name a job we cannot do");

console.log("\n=== nothing broke on the way");
ok("no script errors", jsErrors.length === 0, jsErrors.join(" | "));

await browser.close();
await new Promise((res) => srv.close(res));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/**
 * The paper market: the rules that decide what counts, and the page that shows
 * them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE FOLD IS WHERE THE TESTING GOES
 *
 * There is no server in this market. Calls are signed messages in a public
 * room, Technocore checks the signature at the door and nothing else, and
 * anybody can post anything into it: a second tap, a call for paper they do
 * not hold, a call after the question closed, a settlement they have no right
 * to declare. web/call.js is the only thing standing between that room and a
 * total somebody might believe.
 *
 * So every rule below is written as the attack it refuses. A fold that quietly
 * counted one of them would not throw, would not log, and would not look wrong
 * — it would just show a number that was not true, on a page whose entire
 * claim is that anyone can check it.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROOM, MARKET, PREFIX, TAP, CLOSES_MS, SHOP,
  tapFrame, callFrame, settleFrame, readCall, foldMarket, seatOf, leftUntil,
} from "../web/call.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), "utf8"); } catch { return ""; } };

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

const A = "did:key:z6Mk" + "a".repeat(44);
const B = "did:key:z6Mk" + "b".repeat(44);
const T0 = Date.UTC(2026, 8, 6, 12, 0, 0);
let n = 0;
/** A message as /api/room hands them over: `from` is the transport's account
 *  of who signed, which is the only claim the fold is allowed to believe. */
const msg = (from, text, at = T0 + (++n) * 1000) =>
  ({ seq: n, ts: new Date(at).toISOString(), from, text });
const tap = (who, at) => msg(who, tapFrame(who, "t" + (++n)), at);
const call = (who, side, put, at) => msg(who, callFrame(who, side, put, "c" + (++n)), at);

console.log("=== A. the ordinary case");
{
  const f = foldMarket([tap(A), call(A, "yes", 600), tap(B), call(B, "no", 250)]);
  ok("both taps and both calls count", f.calls === 2 && f.people === 2, `${f.calls} calls, ${f.people} people`);
  ok("the paper lands on the right sides", f.yes === 600 && f.no === 250, `${f.yes} / ${f.no}`);
  ok("and the split is a share of the paper, not of the heads",
    Math.round(f.share * 100) === 71, String(Math.round(f.share * 100)));
  const s = seatOf(f, A);
  ok("what a caller has left is what they did not put down", s.left === TAP - 600, String(s.left));
  ok("several calls from one key add up",
    foldMarket([tap(A), call(A, "yes", 100), call(A, "yes", 150)]).yes === 250);
  ok("and a key may put paper on both sides — it is their paper",
    (() => { const g = foldMarket([tap(A), call(A, "yes", 100), call(A, "no", 100)]);
             return g.yes === 100 && g.no === 100; })());
}

console.log("\n=== B. an empty market is not a fifty-fifty one");
{
  const f = foldMarket([]);
  ok("nothing on the board reads as nothing", f.share === null && f.total === 0, String(f.share));
  ok("and nobody is in the standings", f.standings.length === 0);
  /* A tap is not an opinion. Somebody who took paper and never put it down
     must not appear in a list of who called it. */
  const g = foldMarket([tap(A)]);
  ok("taking paper is not calling it", g.people === 0 && g.standings.length === 0);
  ok("though the tap itself is remembered", g.tapped === 1 && seatOf(g, A).left === TAP);
}

console.log("\n=== C. the tap, and the man who wants two");
{
  const f = foldMarket([tap(A), tap(A), tap(A), call(A, "yes", 1500)]);
  ok("a second tap gives nothing", seatOf(f, A).tapped === TAP, String(seatOf(f, A).tapped));
  ok("so the call it was meant to pay for does not count", f.yes === 0, String(f.yes));
  ok("and the reason is recorded rather than swallowed",
    f.refused.some((r) => /already taken its paper/.test(r.why)) &&
    f.refused.some((r) => /only 1000 paper left/.test(r.why)),
    f.refused.map((r) => r.why).join(" | "));
}

console.log("\n=== D. paper you do not have");
{
  const f = foldMarket([tap(A), call(A, "yes", 1001)]);
  ok("a call for more than the purse does not count at all", f.yes === 0, String(f.yes));
  /* NOT CLAMPED, and that is the interesting half. Trimming 1001 to 1000 would
     be the fold deciding what somebody meant, and the number it invented would
     then sit in a total the page says anyone can check. */
  ok("and it is refused rather than trimmed to fit", seatOf(f, A).put === 0);
  const g = foldMarket([call(A, "yes", 100)]);
  ok("a call with no tap behind it counts for nothing", g.yes === 0 && g.calls === 0);
  ok("with the reason given", /no paper/.test(g.refused[0]?.why ?? ""), g.refused[0]?.why);
  const h = foldMarket([tap(A), call(A, "yes", 700), call(A, "yes", 700)]);
  ok("the second of two calls that together overdraw is the one refused",
    h.yes === 700, String(h.yes));
}

console.log("\n=== E. the numbers a hand-written frame can carry");
{
  const bad = (put) => foldMarket([tap(A), msg(A, PREFIX + JSON.stringify(
    { from: A, market: MARKET, nonce: "x" + put, put, side: "yes", type: "call" }))]).yes;
  ok("a negative amount is not a call", bad("-500") === 0);
  ok("nor is zero", bad("0") === 0);
  ok("nor a fraction", bad("250.5") === 0);
  ok("nor exponential notation", bad("1e3") === 0);
  ok("nor whitespace around a number", bad(" 250") === 0);
  ok("but a plain whole number is", bad("250") === 250);
  ok("a side that is not yes or no is not a side",
    foldMarket([tap(A), msg(A, PREFIX + JSON.stringify(
      { from: A, market: MARKET, nonce: "z", put: "100", side: "maybe", type: "call" }))]).calls === 0);
}

console.log("\n=== F. saying you are somebody else");
{
  /* THE ATTACK THIS PAGE WOULD BE EASIEST TO RUIN WITH. The body carries a
     `from`, and it is the sender's claim about themselves; `m.from` is who
     actually signed, checked by Technocore at the door. A fold that trusted
     the body would let anyone spend anyone's paper. */
  const forged = msg(B, callFrame(A, "yes", 500, "f1"));
  const f = foldMarket([tap(A), tap(B), forged]);
  ok("a frame signed by B claiming to be A counts for neither", f.yes === 0, String(f.yes));
  ok("and says so", /different author than the key that signed/.test(f.refused[0]?.why ?? ""),
    f.refused[0]?.why);
  ok("B's own paper is untouched", seatOf(f, B).left === TAP);
  ok("and so is A's", seatOf(f, A).left === TAP);
}

console.log("\n=== G. the clock");
{
  const late = CLOSES_MS + 60000;
  const f = foldMarket([tap(A, T0), call(A, "yes", 100, late)]);
  ok("a call after the question closed does not count", f.yes === 0, String(f.yes));
  ok("with the reason given", /had closed/.test(f.refused[0]?.why ?? ""), f.refused[0]?.why);
  ok("a call a minute before it closes does",
    foldMarket([tap(A, T0), call(A, "yes", 100, CLOSES_MS - 60000)]).yes === 100);
  ok("and the deadline is the one the page shows",
    new Date(CLOSES_MS).toISOString().startsWith("2027-03-31"),
    new Date(CLOSES_MS).toISOString());
}

console.log("\n=== H. settling it, and who may");
{
  const shopSays = (o, at) => msg(SHOP, settleFrame(SHOP, o), at);
  const f = foldMarket([tap(A), call(A, "yes", 500), shopSays("yes")]);
  ok("the shop can settle it", f.settled?.outcome === "yes", JSON.stringify(f.settled));
  ok("and the calls made before it still stand", f.yes === 500);

  const g = foldMarket([tap(A), shopSays("yes"), call(A, "yes", 500)]);
  ok("nothing counts after a settlement", g.yes === 0, String(g.yes));

  const h = foldMarket([tap(A), call(A, "yes", 500), msg(B, settleFrame(B, "no"))]);
  ok("a stranger cannot settle it", h.settled === null);
  ok("however loudly they say so", /only the shop can settle/.test(h.refused[0]?.why ?? ""),
    h.refused[0]?.why);

  const i = foldMarket([shopSays("yes"), shopSays("no")]);
  ok("and the shop cannot settle it twice", i.settled?.outcome === "yes",
    "a second answer to the same question is not a correction");
}

console.log("\n=== I. everything else in a public room");
{
  const noise = [
    msg(A, "just chatting"),
    msg(A, "tclk1 " + JSON.stringify({ type: "offer", from: A })),
    msg(A, PREFIX + "not json at all"),
    msg(A, PREFIX + JSON.stringify({ from: A, market: "some-other-market", nonce: "q", put: "100", side: "yes", type: "call" })),
    tap(A), call(A, "yes", 100),
  ];
  const f = foldMarket(noise);
  ok("plain chat, other protocols and other markets are all ignored",
    f.yes === 100 && f.calls === 1, `${f.yes} on yes from ${f.calls} call(s)`);
  ok("and none of them is reported as a refusal, because none was ours",
    f.refused.length === 0, f.refused.map((r) => r.why).join(" | "));
  ok("a frame that is not ours reads as null", readCall("hello") === null);
  ok("and one that is reads as its body", readCall(tapFrame(A, "n1"))?.type === "tap");
}

console.log("\n=== J. the standings");
{
  const f = foldMarket([tap(A), tap(B), call(A, "yes", 100), call(B, "no", 900)]);
  ok("biggest first, whichever side they are on",
    f.standings[0].did === B && f.standings[1].did === A,
    f.standings.map((r) => `${r.did.slice(-4)}:${r.put}`).join(" "));
  ok("order does not depend on the order the room was read in",
    JSON.stringify(foldMarket([tap(B), call(B, "no", 900), tap(A), call(A, "yes", 100)])
      .standings.map((r) => r.did)) === JSON.stringify(f.standings.map((r) => r.did)));
}

console.log("\n=== K. the two files that have to agree");
{
  /* An edge function cannot import a browser module, so api/calls.js spells
     the room and the prefix out again. Two spellings of one string is how a
     page ends up reading an empty room and reporting a market with nobody in
     it — no error anywhere, just a zero. */
  const api = read("api/calls.js");
  ok("api/calls.js reads the room the page writes to",
    new RegExp(`ROOM = "${ROOM}"`).test(api), ROOM);
  ok("and looks for the prefix the page writes",
    api.includes(`PREFIX = "${PREFIX}"`), PREFIX);
  const wf = read(".github/workflows/archive.yml");
  ok("and the collector follows that room, or there is no archive to read",
    new RegExp(`ROOMS:.*\\b${ROOM}\\b`).test(wf),
    (wf.match(/ROOMS:.*/) ?? [""])[0].slice(0, 110));

  /* ── AND THE LEDGER IS COMMITTED ON EVERY PASS, NOT EVERY TWELFTH ───────
     A day shard lands hourly, so a collector that dies takes up to an hour of
     its working tree with it. For a river of chat that is an hour nobody will
     miss; for a market it is somebody's position, on a page that told them it
     was kept. The calls therefore go in a file of their own in the every-pass
     tier, and all three halves of that have to agree: the collector writes
     it, the workflow commits it, and the endpoint reads it. */
  const arc = read("scripts/archive.mjs");
  ok("the collector keeps a ledger of every call it sees",
    /function pushCall\(/.test(arc) && /all\.ndjson/.test(arc));
  ok("seeded from the last run's, so a new window does not erase the market",
    /async function loadCalls\(/.test(arc) && /ledger: await loadCalls\(\)/.test(arc));
  ok("and it is never trimmed the way the tail is",
    !/ledger[\s\S]{0,300}?\.shift\(\)/.test(arc));
  ok("the workflow commits it on every pass, in the small tier",
    new RegExp(`SMALL="[^"]*web/data/${ROOM}/all\\.ndjson`).test(wf));
  ok("and the endpoint reads it before it reads anything else",
    api.indexOf("all.ndjson") > 0 && api.indexOf("all.ndjson") < api.indexOf("_meta.json"),
    "one small read instead of a scan of the shards");
  ok("with the day shards still there as a fallback",
    /source: "shards"/.test(api) && /_meta\.json/.test(api));
}

console.log("\n=== L. the page, as text");
{
  const page = read("web/market.html");
  ok("the page exists at all", page.length > 2000);
  /* ── THE WORD ─────────────────────────────────────────────────────────
     Not a style preference: it was asked for, and the whole framing of the
     page depends on it. Paper is taken from a tap and put on a side; nobody
     is offered odds and nothing is being wagered. Checked against the visible
     text of the file, comments included, because a comment is where the word
     creeps back in first and from there into the next person's copy. */
  const banned = /\b(bet|bets|betting|bettor|wager|wagers|odds|gamble|gambling|punt)\b/i;
  const lines = page.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => banned.test(l));
  ok("nowhere in the page does it say bet, wager, odds or gamble",
    lines.length === 0, lines.slice(0, 3).map(([i, l]) => `${i}: ${l.trim().slice(0, 60)}`).join(" | "));
  /* The two files behind it, and NOT this one — a test that forbids a word has
     to be allowed to name the word it forbids. */
  const js = read("web/call.js") + read("api/calls.js");
  const jsHits = js.split("\n").filter((l) => banned.test(l));
  ok("nor anywhere in the code behind it", jsHits.length === 0,
    jsHits.slice(0, 2).map((l) => l.trim().slice(0, 60)).join(" | "));

  ok("it carries the disclaimer above the fold, not in the small print",
    /nothing of value moves/i.test(page.slice(0, page.indexOf("</header>"))));
  ok("and says plainly that the paper is worth nothing",
    /buys nothing|worth nothing|settles into nothing/i.test(page));
  /* Naming a real person on a page they have nothing to do with is the one
     thing here that could actually mislead somebody, so the page has to say
     so itself rather than leaving it to be inferred. */
  ok("it says the person quoted has nothing to do with it",
    /nothing to do with it/i.test(page));
  ok("and links the quote to the original rather than pretending to be it",
    /x\.com\/CryptoHayes\/status\//.test(page) && /quoted from X/i.test(page));
  ok("with rel=noopener on a link that opens off-site",
    /rel="noopener noreferrer"/.test(page));

  /* ── THE TWO SHAPES ───────────────────────────────────────────────────
     Asked for on every page here: a desktop layout and a phone layout, not
     one layout that shrinks. */
  ok("there is a phone layout at all", /@media \(max-width:900px\)/.test(page));
  ok("the panel is sticky on a wide screen", /\.aside\{[^}]*position:sticky/.test(page));
  ok("and not on a narrow one", /@media \(max-width:900px\)\{[\s\S]*?\.aside\{position:static/.test(page));
  ok("the panel comes before the standings on a phone",
    /@media \(max-width:900px\)\{[\s\S]*?\.aside\{[^}]*order:2[\s\S]*?\.board\{order:3/.test(page));
  /* Hover states behind a hover query, because a :hover rule on a touchscreen
     sticks after the tap and leaves a control looking pressed. */
  const hovers = [...page.matchAll(/^\s*\.[^\n{]*:hover/gm)].length;
  const guarded = [...page.matchAll(/@media \(hover:hover\)\{[\s\S]*?\n\}/g)]
    .reduce((s, m) => s + [...m[0].matchAll(/:hover/g)].length, 0);
  ok("every hover rule is behind a hover query", hovers > 0 && guarded >= hovers,
    `${hovers} hover rules, ${guarded} of them guarded`);
  ok("and motion is dropped for anyone who asked for that",
    /prefers-reduced-motion:reduce\)\{\s*\*\{transition:none!important/.test(page));

  /* Bounded interactivity, for the low-end machines this site is read on: the
     only thing that animates is the bar, once, when the numbers land. */
  const transitions = [...page.matchAll(/transition:[^;}]+/g)].map((m) => m[0]);
  ok("nothing animates for longer than about half a second",
    transitions.every((t) => !/\b([1-9]\d*(\.\d+)?)s\b/.test(t.replace(/0?\.\d+s/g, ""))),
    transitions.filter((t) => /\b[1-9]\d*s\b/.test(t)).join(" | ") || "longest is .52s");
  ok("and there is no animation loop on the page",
    !/requestAnimationFrame|setInterval/.test(page));
}

console.log("\n=== Q. how anybody finds it");
{
  /* TWO WAYS IN, and both have to hold. The bar is how somebody who came for
     something else finds it; the shelf on /play is how somebody looking for
     something to play does. Losing either is losing half the traffic to a
     page nothing else links. */
  const nav = read("web/nav.js");
  ok("the market is in the site's own page list", /href: "\/market"/.test(nav));
  ok("and on the bar, before City",
    /\{ href: "\/market",[^}]*bar: true/.test(nav) &&
    nav.indexOf('href: "/market"') < nav.indexOf('href: "/city"'),
    "City carries the live dot; a tab after it reads as an afterthought");
  const play = read("web/play.html");
  ok("Play links it, which is where things you can play live",
    /<a class="tile" href="\/market">/.test(play));
  ok("and Play reads as a shelf rather than one game with a link bolted on",
    /class="shelf"/.test(play) && /Also to play/.test(play) &&
    (play.match(/class="tile/g) ?? []).length >= 2);
  /* The tile has to say what the page says. A card promising a market and
     landing on a disclaimer is the wrong order to learn that in. */
  ok("the tile says up front that nothing of value moves",
    /Nothing of value\s+moves/.test(play.replace(/\s+/g, " ").replace(/ /g, " ")) ||
    /nothing of value moves/i.test(play));
}

console.log("\n=== S. the second keeper");
{
  /* One keeper is a market that loses positions the afternoon a GitHub Action
     falls over — which this one has done twice this week. So the site writes
     its own copy at the moment of the call, into the SAME file the collector
     maintains, and the two converge rather than compete. */
  const keep = read("api/keep.js");
  const arc = read("scripts/archive.mjs");
  const page = read("web/market.html");

  ok("there is a second keeper at all", keep.length > 2000);
  ok("it writes the file the collector writes and the endpoint reads",
    keep.includes(`web/data/${ROOM}/all.ndjson`) || /PATH = `web\/data\/\$\{ROOM\}\/all\.ndjson`/.test(keep));
  ok("and the page nudges it after a call lands",
    /function keep\(\)/.test(page) && (page.match(/^\s*keep\(\);$/gm) ?? []).length === 2,
    "after the tap and after the call, and nowhere else");
  ok("without waiting on it or reporting it",
    /\.catch\(\(\) => \{\}\)/.test(page) && !/await keep\(\)/.test(page),
    "the call is signed and posted either way; this copy is best-effort");

  /* ── THE THING THAT MAKES IT SAFE TO EXPOSE ────────────────────────────
     It reads the ROOM and stores what it finds there. It never reads the
     request body, so a public endpoint that writes to a repository cannot be
     asked to write anything a stranger made up: whatever is in that room got
     there by being signed, because that is the only way in. */
  ok("it never reads the request body", !/request\.json\(\)|await request\.text\(\)/.test(keep),
    "a public write endpoint that trusts its caller is a public write endpoint");
  ok("it takes its records from the room instead",
    /technocore\.chat|TECHNOCORE/.test(keep) && /\/r\/\$\{ROOM\}/.test(keep));
  ok("and keeps only frames that are ours",
    /text\.startsWith\(PREFIX\)/.test(keep));
  ok("with the server's own sequence number, not one the caller chose",
    /\^\[0-9\]\{1,19\}\$/.test(keep));

  /* ── AND THE ONE THAT KEEPS THE BILL DOWN ──────────────────────────────
     A personal token DOES trigger workflows, unlike GITHUB_TOKEN. Without
     [skip ci] every call would fire deploy.yml and buy a deployment. */
  ok("its commits carry [skip ci], so a call cannot buy a deployment",
    /\[skip ci\]/.test(keep),
    "a personal token triggers workflows where GITHUB_TOKEN does not");
  ok("it is guarded against writing over somebody else's line",
    /sha/.test(keep) && /409/.test(keep));
  ok("and it is inert, not broken, with no token configured",
    /if \(!TOKEN\)/.test(keep) && /kept: 0/.test(keep),
    "the call is still on the network; the site is one keeper down");

  /* ── AND THE COLLECTOR MUST NOT ERASE IT ───────────────────────────────
     This process seeds its ledger once, at the start of a five-hour window.
     Writing its own copy over the top would delete every frame the endpoint
     added since, and the two keepers would spend the market taking turns to
     lose each other's work. */
  const w = arc.slice(arc.indexOf("async function writeCalls"), arc.indexOf("async function writeTail"));
  ok("the collector reads the file before it writes it",
    /readFile\(file/.test(w), "otherwise it overwrites the other keeper");
  ok("and unions by the sequence number rather than replacing",
    /rows\.has\(k\)/.test(w) && /L\.rows = out/.test(w));
}

console.log("\n=== R. the state almost everybody arrives in");
{
  /* SIGNED OUT is the default, not an edge case: most people reaching this
     page have never had a key. The first version met them with two disabled
     buttons and a grey line pointing at the top bar — a page saying "you
     cannot do this" and leaving them to work out why and what to do. */
  const page = read("web/market.html");
  ok("the signed-out buttons are live, not disabled",
    /tapBtn\.disabled = shut;/.test(page) && /dataset\.signin = "1"/.test(page),
    "a way in that cannot be pressed is a locked door with the key on the far side");
  ok("and they open the sign-in themselves",
    /function openSignIn\(\)/.test(page) &&
    /dataset\.signin\) return void openSignIn\(\)/.test(page));
  ok("with a fallback when the bar is not there to reach into",
    /location\.href = "\/create"/.test(page),
    "/create is the honest next step for somebody with no key at all");
  ok("a side can be picked before signing in, and survives it",
    /Sign in to put paper on \$\{side === "yes"/.test(page));
  ok("the panel says the one thing a stranger needs to hear about a key",
    /made in this browser and never leaves it/.test(page));
  ok("and offers a way to get one", /id="nokey"/.test(page) && /href="\/create"/.test(page));
  /* A disabled button still has to be READ — its label is the instruction. */
  const dim = (page.match(/\.go\[disabled\]\{opacity:([\d.]+)/) ?? [])[1];
  ok("a disabled button is dimmed but still legible", Number(dim) >= 0.55, `opacity ${dim}`);
  /* And the token that does not exist, which cost this page a white background
     and then grey text on a bright button. */
  ok("nothing on the page reaches for var(--bg)", !/var\(--bg\)/.test(page),
    "deal.css declares it inside .btn and nowhere else");
}

console.log("\n=== M. words for the reader, not the protocol");
{
  ok("months, while it is months away", /months left/.test(leftUntil(CLOSES_MS, CLOSES_MS - 200 * 86400000)));
  ok("days, when it is days", leftUntil(CLOSES_MS, CLOSES_MS - 5 * 86400000) === "5 days left");
  ok("one day is not 1 days", leftUntil(CLOSES_MS, CLOSES_MS - 86400000 - 1) === "1 day left");
  ok("hours, at the end", leftUntil(CLOSES_MS, CLOSES_MS - 3600000) === "hours left");
  ok("and closed, after it", leftUntil(CLOSES_MS, CLOSES_MS + 1) === "closed");
}

console.log("\n=== N. what a call is worth if it is right");
{
  /* Parimutuel: the winners divide the whole board in proportion to what they
     put on it. The consequence worth testing is the one that makes the page
     interesting — agreeing with everybody pays almost nothing, and calling it
     alone pays several times over. */
  const f = foldMarket([tap(A), tap(B), call(A, "yes", 800), call(B, "no", 200)]);
  ok("the pool is everything on the board", f.volume === 1000 && f.total === 1000, String(f.volume));
  const a = f.standings.find((r) => r.did === A);
  const b = f.standings.find((r) => r.did === B);
  ok("the only caller on a side takes the whole pool if it is right",
    Math.round(a.ifYes) === 1000 && Math.round(b.ifNo) === 1000);
  ok("agreeing with the room pays 1.25×", a.multiple.toFixed(2) === "1.25", String(a.multiple));
  ok("and calling it alone against the room pays 5×", b.multiple.toFixed(2) === "5.00", String(b.multiple));
  ok("a losing call is worth nothing at all", a.ifNo === 0 && b.ifYes === 0);

  /* Two on one side split their side's share of the pool between them, in
     proportion — not equally. */
  const g = foldMarket([tap(A), tap(B), call(A, "yes", 750), call(B, "yes", 250)]);
  const ga = g.standings.find((r) => r.did === A);
  ok("two on the same side split it by what each put down",
    Math.round(ga.ifYes) === 750 && ga.multiple.toFixed(2) === "1.00",
    "with nobody on the other side there is nothing to win");
  ok("and the payouts add up to the pool, not to more than it",
    Math.abs(g.standings.reduce((s2, r) => s2 + r.ifYes, 0) - g.volume) < 1e-9);

  ok("somebody on both sides has no single multiple",
    foldMarket([tap(A), call(A, "yes", 100), call(A, "no", 100)]).standings[0].multiple === null);
}

console.log("\n=== O. profit, once it is settled");
{
  const shopSays = (o) => msg(SHOP, settleFrame(SHOP, o));
  const f = foldMarket([tap(A), tap(B), call(A, "yes", 800), call(B, "no", 200), shopSays("no")]);
  const a = f.standings.find((r) => r.did === A);
  const b = f.standings.find((r) => r.did === B);
  ok("the winner's profit is the pool less their own stake",
    Math.round(b.pnl) === 800, String(Math.round(b.pnl)));
  ok("and the loser is down everything they put in",
    Math.round(a.pnl) === -800, String(Math.round(a.pnl)));
  ok("the profits sum to zero, because nothing was created",
    Math.abs(f.standings.reduce((s2, r) => s2 + r.pnl, 0)) < 1e-9);
  /* THE ORDER OF THE LIST CHANGES WITH THE QUESTION IT ANSWERS. Before it
     settles the list is who is most committed; after, it is who was right.
     Sorting a finished market by stake puts the biggest loser at the top. */
  ok("and the leaderboard is led by whoever was right, not by whoever put most in",
    f.standings[0].did === B, f.standings[0].did.slice(-4));
}

console.log("\n=== P. the FAQ, and the one thing it must say");
{
  const page = read("web/market.html");
  const faq = page.slice(page.indexOf('class="card faq"'), page.indexOf("</section>", page.indexOf('class="card faq"')));
  ok("there is an FAQ at all", faq.length > 1500);
  const qs = [...faq.matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1]);
  ok("with a good handful of questions in it", qs.length >= 8, `${qs.length} questions`);
  /* IT OPENS ON THE DISCLAIMER. A disclaimer nobody clicks is a disclaimer
     nobody read, and this is the one thing on the page that could actually
     mislead somebody about money. */
  ok("the first one is open on arrival",
    /<details class="loud" open>/.test(faq) &&
    faq.indexOf('<details class="loud" open>') < faq.indexOf("<details>"),
    qs[0]);
  ok("and it is the one about whether any of this is worth anything",
    /worth anything/i.test(qs[0]), qs[0]);
  ok("which answers no, in the first word", /class="a">\s*No\./.test(faq));
  ok("says the paper converts into nothing", /converts into nothing/i.test(faq));
  ok("that there is no prize", /no prize/i.test(faq));
  ok("and that it cannot be cashed out in any direction",
    /cannot be bought,\s+sold,\s+sent,\s+swapped or\s+withdrawn/i.test(faq.replace(/\s+/g, " ")));
  /* The two claims that would be dishonest to leave out. */
  ok("it admits one person with ten keys gets ten thousand paper",
    /ten keys get ten thousand/i.test(faq));
  ok("and it promises nothing about the airdrop",
    /makes no claim that any of this earns anything/i.test(faq),
    "the one promise this page must never make");
  ok("it says who is not involved", /he has nothing to do\s+with it/i.test(faq) || /nothing to do with it/i.test(faq));

  /* <details>, not a scripted accordion: it opens with a keyboard, survives
     the script failing, and Ctrl+F finds the text inside a closed one. */
  ok("the accordion is native rather than scripted",
    faq.includes("<details") && !/faq[\s\S]{0,400}addEventListener/.test(page.slice(page.indexOf("<script type=\"module\">"))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

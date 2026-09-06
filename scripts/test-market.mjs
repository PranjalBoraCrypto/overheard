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
  ROOM, MARKET, PREFIX, TAP, CLOSES_MS, SHOP, SIDES,
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
  /* On a phone it stops being a column and becomes a surface docked to the
     bottom edge: always under the thumb, never scrolled past. */
  ok("and on a narrow one it docks to the bottom edge instead",
    /@media \(max-width:900px\)\{[\s\S]*?\.aside\{position:fixed;left:0;right:0;bottom:0/.test(page));
  ok("the dock clears the home indicator",
    /@media \(max-width:900px\)\{[\s\S]*?env\(safe-area-inset-bottom/.test(page));
  /* A surface fixed over the page hides what is under it unless the page is
     told how tall it is, so the height is measured and reserved. */
  /* On the BODY, not on the page column: the footer breaks out of that column
     to span the window, so a reserve inside it would have left the dock
     sitting on top of the footer. */
  ok("the page reserves the dock's height so nothing ends up behind it",
    /--dock-h:\s*0px/.test(page) &&
    /body\{padding-bottom:var\(--dock-h\)\}/.test(page) &&
    /setProperty\("--dock-h"/.test(page));
  /* A different running order, not the desktop one narrowed: question, then
     the ring, then the two figures. .ask dissolves into the hero's own grid
     so its children can be ordered one by one. */
  ok("the phone puts the ring between the question and the figures",
    /@media \(max-width:900px\)\{[\s\S]*?\.ask\{display:contents/.test(page) &&
    /\.corewrap\{order:4[\s\S]{0,120}?\.sides2\{order:5/.test(page));
  /* overflow-x:hidden on the body turns it into a scroll container, and a
     scroll container is where position:sticky quietly stops working. This
     page lost its sticky rail to exactly that once. */
  ok("the body clips sideways overflow without becoming a scroller",
    /overflow-x:hidden;overflow-x:clip/.test(page));
  /* Both of these are read inside calc(). An undefined custom property makes
     the whole declaration invalid at computed-value time, which drops the
     sticky offset and the reserved bottom padding together and in silence. */
  /* A var WITH a fallback — var(--wake,0) — cannot make a declaration
     invalid, so it is not the failure mode this guards against. Only the
     bare ones matter. */
  const calcVars = [...page.matchAll(/calc\([^;}]*?var\((--[a-z0-9-]+)\s*\)/g)]
    .map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i);
  const undeclared = calcVars.filter((v) => !new RegExp(`${v}\\s*:`).test(page)
    && !/^--(s\d|gutter|line|void|edge)$/.test(v));
  ok("every variable this page does arithmetic with is declared on this page",
    undeclared.length === 0, undeclared.join(", ") || calcVars.join(" "));
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
  /* ── WHAT THE MACHINE GETS ────────────────────────────────────────────
     The page decides how much motion the machine in front of it can afford
     before it paints anything, and says so in data-fx. Ambient motion is
     gated on that; state changes are not, because a ring that moves when the
     numbers move is information rather than decoration. */
  ok("the page grades the machine before it paints",
    /data-fx/.test(page) && /prefers-reduced-motion/.test(page) &&
    /hardwareConcurrency/.test(page) && /deviceMemory/.test(page));
  ok("and demotes itself if the frames do not keep up",
    /data-fx="lean"/.test(page) && /requestAnimationFrame/.test(page));
  ok("the ambient loop is off on a lean machine",
    /\[data-fx="lean"\][^{]*\.beltrun\{animation:none!important/.test(page));
  ok("and the ambient loop only runs where it was earned",
    /\[data-fx="standard"\] \.beltrun\.loop,\[data-fx="full"\] \.beltrun\.loop\{/.test(page));
  /* Every rAF loop on this page has to be able to end. One that re-queues
     unconditionally is a phone battery running down behind a page nobody is
     looking at any more. */
  const rafs = [...page.matchAll(/requestAnimationFrame\(([A-Za-z_$][\w$]*)\)/g)]
    .map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i);
  ok("every animation loop can stop itself", rafs.length > 0 && rafs.every((fn) => {
    const body = page.slice(page.indexOf(`const ${fn} =`) >= 0
      ? page.indexOf(`const ${fn} =`) : page.indexOf(`function ${fn}`));
    const end = body.indexOf("\n};") >= 0 ? body.indexOf("\n};") : body.indexOf("\n}");
    const src = body.slice(0, end + 3);
    return /\bif\s*\(/.test(src) && /requestAnimationFrame/.test(src);
  }), rafs.join(", "));
  ok("nothing on the page polls on a timer", !/setInterval/.test(page));
}

console.log("\n=== Q2. what one person actually did, and when");
{
  /* A RUNNING TOTAL IS NOT A HISTORY, and the two cannot be recovered from
     each other: 750 on Yes is one call or three, and only the fold knows
     which. The share card is made from one call, so one call has to survive
     the fold intact. */
  const f = foldMarket([tap(A), call(A, "yes", 600), call(A, "no", 100),
                        tap(B), call(B, "no", 250), call(A, "yes", 150)]);
  ok("every accepted call is kept, not just the totals", f.ledger.length === 4,
    `${f.ledger.length} of 4`);
  ok("in the order the room took them",
    f.ledger.map((e) => e.put).join(",") === "600,100,250,150",
    f.ledger.map((e) => e.put).join(","));
  const mine = seatOf(f, A).mine;
  ok("one person's own calls are theirs alone", mine.length === 3 &&
    mine.every((e) => e.did === A), String(mine.length));
  ok("newest first, because that is the one they came back to look at",
    mine[0].put === 150 && mine[2].put === 600,
    mine.map((e) => e.put).join(","));
  ok("each one carries its side, its stake and its moment",
    mine.every((e) => SIDES.includes(e.side) && e.put > 0 && e.at > 0 && e.ts));
  /* The purse AFTER the call, recorded at the time. A card made from an old
     call has to say what was true when it was made; deriving it later from
     today's total would quietly rewrite history. */
  ok("and what was left once it landed, as it was then",
    mine[2].after === TAP - 600 && mine[1].after === TAP - 700 && mine[0].after === TAP - 850,
    mine.map((e) => e.after).join(","));
  /* A refused frame is not history. It never counted, and a card made from
     one would be a person sharing something that did not happen. */
  const g = foldMarket([tap(A), call(A, "yes", 5000), call(A, "yes", 200)]);
  ok("a refused call is not in anybody's history",
    g.ledger.length === 1 && g.ledger[0].put === 200, String(g.ledger.length));
  ok("and somebody who never called has an empty one, not a missing one",
    Array.isArray(seatOf(foldMarket([tap(B)]), B).mine) &&
    seatOf(foldMarket([tap(B)]), B).mine.length === 0);
  ok("as does a stranger the market has never seen",
    Array.isArray(seatOf(f, "did:key:zNobody").mine));
  /* Forged and late frames are refused above; neither may reach a card. */
  ok("nor is a frame signed by somebody else in the history of the person it names",
    seatOf(foldMarket([tap(A), tap(B), msg(B, callFrame(A, "yes", 500, "f9"))]), A).mine.length === 0);
}

console.log("\n=== U. the card somebody puts their name to");
{
  const card = read("web/card.js");
  ok("there is a card renderer at all", card.length > 500);
  /* ONE DRAWING, ONE FILE. The usual way to build these is to lay the card
     out in HTML and rasterise it at export time with a second renderer, and
     that second renderer is where the feature rots: the export drifts from
     the preview a property at a time and the thing people post is the wrong
     one. Here the canvas on screen is the canvas that leaves. */
  /* Prose stripped first: this file EXPLAINS why it does not use html2canvas,
     and a test that reads the explanation as the thing it warns against is a
     test that fails for being told the truth. */
  const code = card.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok("the card is drawn once, not laid out and then re-rendered",
    /getContext\("2d"\)/.test(code) && !/html2canvas|dom-to-image|foreignObject/i.test(code));
  ok("and nothing is fetched from off this origin to draw it",
    !/https?:\/\//.test(code),
    "a cross-origin image would taint the canvas and break every export");
  /* The card travels furthest from the page that could be used to check it,
     so it must not be the only place a number exists. */
  ok("the renderer does no arithmetic of its own on the money",
    !/\*\s*pool|pool\s*\/|ifYes|ifNo/.test(card));
  ok("it says in UTC when the call was made", /getUTCDate|getUTCFullYear/.test(card));
  ok("and it carries the subject's mark as well as ours",
    /flop\.png/.test(card) && /Overheard/.test(card));

  const page = read("web/market.html");
  /* A CLASS NAME IS A GLOBAL. deal.css already owns `.sheet` — a bottom sheet
     with max-height:82vh and translateY(101%) — and reusing the name gave the
     share dialog those properties silently: it sized to 82% of the viewport
     and sat off the bottom of the screen. Nothing errored. */
  const shared = read("web/deal.css");
  const mine = [...page.matchAll(/^\.([a-z][a-z0-9-]{2,})\s*[{,]/gm)].map((m) => m[1]);
  const theirs = new Set([...shared.matchAll(/^\.([a-z][a-z0-9-]{2,})\s*[{,]/gm)].map((m) => m[1]));
  const clash = [...new Set(mine.filter((c) => theirs.has(c)))]
    .filter((c) => !["card", "go", "side", "amt", "say", "foot", "blank", "feed", "row"].includes(c));
  ok("no class on this page silently inherits a shared component's rules",
    clash.length === 0, clash.join(", ") || `${mine.length} checked against deal.css`);

  /* The key rides on the card by default: it is already public in the room
     and on this page's own leaderboard, so a card without it is a card that
     cannot be matched to the record it came from. What matters is that it
     stays a CHOICE — posting to a timeline is louder than signing in a room,
     and it has to be possible to take off before anything is copied. */
  ok("the key is on the card by default", /id="showkey" checked/.test(page));
  ok("but it is a switch, not a fact of life",
    /id="showkey"/.test(page) && /class="keytog"/.test(page) &&
    /\$\("showkey"\)\.addEventListener\("change"/.test(page));
  ok("and the card reads the switch rather than assuming",
    /\$\("showkey"\)\.checked \? shortDid/.test(page));

  ok("the post it writes tags the project", /@flop_labs/.test(page));
  /* The post says "paper" and nothing else. It is the one piece of this page
     that travels to an audience who never saw the disclaimer. */
  {
    const from = page.indexOf("function postText");
    /* Prose stripped: this function EXPLAINS what it refuses to do, and twice
       now a test has failed for reading the explanation as the thing. */
    const draft = page.slice(from, page.indexOf("$(\"shx2\")", from))
      .replace(/\/\*[\s\S]*?\*\//g, "");
    ok("the post calls the stake paper, and calls it that every time",
      (draft.match(/paper on/g) ?? []).length >= 2 && /paper/.test(draft));
    ok("and never says money changed hands",
      !/\b(USD|dollars?|\$\d|profit|earn(ed|ings)?|payout|cash|invest)\b/i.test(draft));
    ok("nor uses the word this page has never used",
      !/\b(bet|bets|betting|wager|odds|gamble|gambling)\b/i.test(draft));
    ok("somebody on both sides is not given a claim they never made",
      /both sides/.test(draft) && !/netting|net position/i.test(draft));
    /* X shows the link twice if it is in the text AND the url parameter. */
    ok("the link is written once", /intent\/tweet\?text=/.test(page) &&
      !/intent\/tweet\?text=[^`]*&url=/.test(page));
  }
  /* X takes text, not files. A button that pretends otherwise posts a bare
     link, so the image goes to the clipboard at the same moment and the
     sheet says so. */
  ok("sharing to X also puts the picture somewhere it can be pasted",
    /intent\/tweet/.test(page) && /ClipboardItem/.test(page));
  ok("a browser that refuses the clipboard is told about, not lied to",
    /will not let a page copy an image/.test(page));

  ok("your own calls are their own section, before the room's board",
    page.indexOf('id="hist"') > 0 && page.indexOf('id="hist"') < page.indexOf('class="card board"'));
  ok("and it is not there at all until you have made one",
    /<section class="card hist" id="hist" hidden/.test(page));
  ok("five to a page, and a pager only when there are more",
    /const PER = 5/.test(page) && /pg\.hidden = pages < 2/.test(page));
  /* The room refreshes underneath this list every few seconds. A page number
     reset on every repaint would make it unusable for the one person it is
     for. */
  ok("the page you are on survives the room refreshing under you",
    /let histPage = 0/.test(page) && !/histPage = 0;\s*\n\s*paintHistory/.test(page));
  ok("the arrival is marked by nonce, not by position",
    /e\.nonce === freshNonce/.test(page));
  ok("and the mark is consumed so it does not replay on every repaint",
    /justLanded = null/.test(page));

  /* The slab is a mass on a spring. Not an ease: an ease cannot overshoot,
     and a card that stops dead the instant the pointer does has no weight. */
  ok("the card is sprung rather than eased",
    /const k = 190, c = 21/.test(page) && /vel \+= a \* dt/.test(page));
  ok("and there is no hinge on a touchscreen",
    /@media \(max-width:900px\)\{[\s\S]*?\.slab\{transform:none!important/.test(page));
}

console.log("\n=== V. the walk from arriving to sharing");
{
  const page = read("web/market.html");
  const nav = read("web/nav.js");

  /* THE TAP AND THE CALL ARE TWO SIGNATURES, and between them the panel used
     to go quiet — the amber button vanished and nothing said the next thing
     was a side. */
  ok("claiming the paper points at the next step",
    /pointAtSides\(\)/.test(page) && /sides\.classList\.add\("next"\)/.test(page));
  ok("and picking a side takes the pointer down",
    /unpoint\(\);\s*\n\s*paintPanel\(\)/.test(page));
  /* A control that pulses forever is one the eye learns to ignore, and it
     would still be flashing an hour later while somebody read the FAQ. */
  ok("the cue stops on its own", /animation:nextUp [^;}]*\b3\b/.test(page) &&
    /setTimeout\(unpoint/.test(page));
  ok("and says it in words as well as light, for a machine with no animation",
    /id="nextsay"/.test(page) && /Now pick a side/.test(page) &&
    /\.stepk\.point\{color:var\(--blue\)\}/.test(page));

  /* Making a call is the moment somebody is proudest of it. Asking them to go
     find a Share button afterwards is asking at the wrong time. */
  ok("the card opens itself once a call has landed",
    /const landed = seatOf\(fold, ID\.did\)\.mine\?\.find\(\(e\) => e\.nonce === ref\)/.test(page) &&
    /openSheet\("call", landed\)/.test(page));
  ok("found by nonce rather than by taking the top row",
    !/openSheet\("call", *(seat|mine)\.mine?\[0\]/.test(page));

  /* ── AND THE READ AFTER A WRITE HAS TO BE A REAL READ ────────────────────
     The room read is answered out of an edge cache a few seconds deep. The
     read fired the instant after a signature is posted was getting that
     cache — an answer from a moment BEFORE the person signed — so the frame
     was not there, and the card that looks for it by nonce correctly opened
     nothing. The room API already carries `t=` for exactly this. */
  ok("the read straight after a write bypasses every cache in the path",
    /async function readLive\(fresh\)/.test(page) &&
    /fresh \? `&t=\$\{Date\.now\(\)\}`/.test(page) &&
    /async function load\(fresh\)/.test(page));
  ok("both writes use it — the call and the tap",
    (page.match(/await load\(true\)/g) ?? []).length >= 2);
  /* But ONLY after a write. Spending a bypass on every poll is a thousand
     tabs each opening their own connection upstream. */
  ok("and an ordinary poll still shares one read between every tab",
    /await load\(fresh\)|readLive\(fresh\), readArchive\(fresh\)/.test(page) &&
    !/readLive\(true\)/.test(page));
  /* A signature still has to travel and be written before it can be read, so
     one look was a coin toss whatever the cache did. */
  ok("and it asks more than once before giving up",
    /const waits = \[620, 1300, 2000, 2600\]/.test(page) &&
    /if \(i > 0\) await load\(true\)/.test(page));
  ok("it does not interrupt somebody who opened a card themselves",
    /if \(!\$\("shshare"\)\.hidden \|\| !ID\) return/.test(page));

  /* HALF A READ IS NOT A READ. The archive and the room can fail separately,
     and a page with one of them still has numbers. That is fine for a total
     and not fine for "have you taken your paper" — somebody who tapped an
     hour ago would be shown the button again, and pressing it spends a
     signature on a frame the fold will refuse. */
  ok("a half-read record does not assert that you have not claimed",
    /partial = !unread && \(l === null \|\| a === null\)/.test(page) &&
    /Only part of the record loaded/.test(page));
  ok("but the button still works, so a real first-timer is never locked out",
    /tapBtn\.hidden = false; tapBtn\.disabled = shut;[\s\S]{0,400}?partial \? "say bad"/.test(page));

  /* An SVG <title> is also a browser tooltip, so hovering the object — the
     whole point of the object — put a grey box over it. */
  ok("the ring has no tooltip sitting on top of itself",
    !/<title id="coretitle">/.test(page) && /class="core"[^>]*aria-hidden="true"/.test(page));
  ok("and its numbers are still real text underneath", /class="coreface"/.test(page));
  /* The ring scaled with the screen and the words over it did not, so under
     390px the ring caught up and the losing line ran out over the arc. The
     answer was to let the ring take the width the phone already had, not to
     shrink the words past reading. */
  ok("the ring takes the room a small phone actually has",
    /\.corewrap\{order:4;max-width:min\(78vw,290px\)/.test(page));
  ok("and nothing over it is shrunk under 11.5px to fit",
    [...page.matchAll(/\.coreface \.p[ckn]\{[^}]*font-size:(\d+(?:\.\d+)?)px/g)]
      .every((m) => Number(m[1]) >= 11.5));

  ok("no tab on the bar is lit any more", !/hot: true/.test(nav));

  /* ── THE DOCK GETS OUT OF THE WAY ────────────────────────────────────
     It covers a fifth to a third of a phone screen, and somebody who has
     made their call wants the page back. */
  ok("the phone dock can be shut", /id="dockpull"/.test(page) &&
    /\.aside\[data-shut="1"\]\{transform:translateY\(var\(--shut/.test(page));
  ok("and it slides rather than snapping shut",
    /\.aside\{\s*\n?\s*transition:transform/.test(page) ||
    /\] \.aside,\[data-fx="full"\] \.aside\{\s*\n?\s*transition:transform/.test(page));
  /* A transform does not change a measured height, so the reserved space has
     to be computed for each state — otherwise the page keeps a third of the
     screen clear for a strip that is 46px tall. */
  ok("the page reserves only what is left on screen",
    /dockShut \? pull : whole/.test(page));
  /* The pull bar grows once it is the only thing left, so measuring before
     the state lands reserves the wrong height. */
  ok("and measures after the state lands, not before",
    page.indexOf('aside.setAttribute("data-shut"') <
    page.indexOf('const pull = $("dockpull").getBoundingClientRect()'));
  /* toggleAttribute writes an EMPTY value; the rule asks for "1". The
     attribute was present, hasAttribute agreed, and no CSS matched. */
  ok("the attribute carries the value the stylesheet asks for",
    !/toggleAttribute\("data-shut"/.test(page));
  ok("shutting it is remembered in this browser and nowhere else",
    /localStorage\.setItem\(SHUT_KEY/.test(page) && !/SHUT_KEY[^\n]*fetch/.test(page));
  ok("a wide screen never hides the panel this way",
    /if \(!fixed\) \{[\s\S]{0,220}?removeAttribute\("data-shut"\)/.test(page) &&
    /\.dockpull\{display:none\}/.test(page));
  /* A cue pointing at a control behind a shut dock is a cue nobody can take. */
  ok("and anything that needs the panel opens it first",
    /function pointAtSides\(\) \{[\s\S]{0,80}?openDock\(\)/.test(page));
  ok("what you hold is on the strip that is left",
    /\.aside\[data-shut="1"\] \.dpk\{display:inline\}/.test(page));
  /* THE STRIP ASKS, IT DOES NOT REPORT. There is one line of room, and a bare
     balance spends it on a fact nobody can act on. It has to cover every rung
     of the same ladder the panel itself walks, including the end of it. */
  {
    const lab = /function dockLabel\(\) \{([\s\S]*?)\n\}/.exec(page)?.[1] ?? "";
    ok("the strip names the next move rather than the balance",
      /return "Enter now"/.test(lab));
    ok("it asks for a key when there is none",
      /!ID\) return "Sign in to call"/.test(lab));
    ok("it sends you to the tap when no paper has been claimed",
      /!seat\.tapped\) return `Claim your/.test(lab));
    ok("it invites a second call once one is down",
      /seat\.put > 0\) return[^\n]*call again/.test(lab));
    /* Nothing left to put down means no next step exists, so asking for one
       would be asking for something impossible. */
    ok("and when every sheet is called it reports instead of asking",
      /seat\.left <= 0\) return/.test(lab) &&
      lab.indexOf("seat.left <= 0") < lab.indexOf("seat.put > 0"));
    ok("a closed question outranks all of it",
      lab.indexOf("has closed") >= 0 &&
      lab.indexOf("has closed") < lab.indexOf("Sign in to call"));
  }
  ok("and the control says which way it goes, for a screen reader too",
    /aria-expanded/.test(page) && /Show the call panel/.test(page));
}

console.log("\n=== Q. how anybody finds it");
{
  /* TWO WAYS IN, and both have to hold. The bar is how somebody who came for
     something else finds it; the shelf on /play is how somebody looking for
     something to play does. Losing either is losing half the traffic to a
     page nothing else links. */
  const nav = read("web/nav.js");
  ok("the market is in the site's own page list", /href: "\/market"/.test(nav));
  /* ON THE BAR, and before City — which carries the live dot and would make
     any tab after it read as an afterthought. */
  ok("and on the bar, ahead of City",
    /\{ href: "\/market",[^}]*bar: true/.test(nav) &&
    nav.indexOf('href: "/market"') < nav.indexOf('href: "/city"'));
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

console.log("\n=== T. the nonce on a signed write, which has to go up");
{
  /* THE REFUSAL THAT EXPLAINED IT, quoted from the network on the very first
     real call anybody made here:
       400 nonce 178872218369713 is not greater than 1788722176337723,
       the last one this key used in /r/overheard-calls
     Fifteen digits against sixteen. Every page built its nonce as
     `Date.now()` concatenated with `Math.floor(Math.random()*1000)`, and that
     tail is ONE TO THREE digits — so the value jumped between three orders of
     magnitude at random and did not track the clock at all. Any write that
     drew a short one after a long one went backwards and was refused.
     It looked like a flaky network, because a retry usually drew a longer
     number and worked. */
  const sess = read("web/session.js");
  ok("there is one nonce maker for the whole site", /export function postNonce\(/.test(sess));
  ok("and it is microseconds, so it rises with the clock",
    /Date\.now\(\) \* 1000/.test(sess), "sixteen digits, always the same width");
  ok("with a counter for two writes in one millisecond",
    /Math\.max\(Date\.now\(\) \* 1000, lastNonce \+ 1\)/.test(sess),
    "the clock cannot separate them and something must");

  /* Run it. A rule about monotonicity is worth exactly as much as a run that
     tries to break it. */
  let last = 0n, back = 0, n = 0;
  const seen = new Set();
  const make = (() => { let lastN = 0; return () => { const v = Math.max(Date.now() * 1000, lastN + 1); lastN = v; return String(v); }; })();
  for (let i = 0; i < 50000; i++) {
    const s2 = make(); const v = BigInt(s2);
    if (v <= last) back++;
    last = v; seen.add(s2); n++;
  }
  ok("fifty thousand of them, none of which goes backwards", back === 0, `${back} regressions`);
  ok("and none of which repeats", seen.size === n, `${seen.size} of ${n} distinct`);
  ok("each one short enough for /api/post to accept",
    make().length <= 19 && /^[0-9]+$/.test(make()), `${make().length} digits, cap is 19`);

  /* The old one, as the control. Without it "none of which goes backwards"
     proves only that this test cannot count. */
  let oldBack = 0; last = 0n;
  for (let i = 0; i < 3000; i++) {
    const v = BigInt(String(Date.now()) + String(Math.floor(Math.random() * 1000)));
    if (v <= last) oldBack++;
    last = v;
  }
  ok("where the old one went backwards constantly", oldBack > 0,
    `${oldBack} regressions in 3000 — the network refused every one of them`);

  /* EVERY page that signs a write, not just this one. The shop's checkout and
     the orders page had the identical line, so a real order could fail to
     post its payment lock for the same reason and read as a flaky network. */
  for (const f of ["web/market.html", "web/hire.html", "web/orders.html"]) {
    const src = read(f);
    ok(`${f.split("/").pop()} uses it`,
      /postNonce\(\)/.test(src) && !/Math\.random\(\) \* 1000/.test(src),
      /Math\.random\(\) \* 1000/.test(src) ? "still rolling a die for its nonce" : "");
  }
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
  /* A GET says whether it is wired up, which is not a secret — the value of
     the variable is, and nothing reads it into a response. Without this the
     only way to find out is to make a real call and look for a commit. */
  ok("a GET answers whether the keeper is wired up",
    /request\.method === "GET"/.test(keep) && /keeper: TOKEN \?/.test(keep));
  ok("without ever putting the token in a response",
    !/TOKEN\b(?![\s\S]{0,40}\?)/.test(keep.slice(keep.indexOf('keeper: TOKEN'), keep.indexOf('keeper: TOKEN') + 200)) ||
    !new RegExp("(token|TOKEN)\\s*[,}]").test(keep.slice(keep.indexOf("return json({\n      ok: true,"), keep.indexOf("writes:"))),
    "whether it is set is public; what it is never leaves the process");

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

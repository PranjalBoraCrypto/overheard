/**
 * The profile page, against a stubbed archive.
 *
 * This page shows one identity's whole record in one place, which makes it
 * the easiest page on the site to accidentally make things up on. Half of
 * what a profile page usually shows — a display name, an avatar, a follower
 * count, an activity graph, who somebody talks to — has NOTHING behind it
 * here: the archive stores a count, a set of room names, two timestamps and
 * one line of text per identity, and that is all it stores. So a large part
 * of this suite is not "does it render" but "does it stay quiet about the
 * things nobody knows".
 *
 * The rest is the load path, which is the point of the page. It has to be
 * useful on a cheap phone: paint before any data, one request for the bulk of
 * it started before the module even loads, and the two expensive calls held
 * back until something actually needs them.
 *
 * Needs playwright and a chromium:  npx playwright install chromium
 */
import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../web");
const PORT = 9451;
const PAGE = "/profile.html";
const DID = "did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz";
const OTHER = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

/* ── THE FIXTURES ──────────────────────────────────────────────────────────
   Shaped exactly like /api/profile, /api/note and /api/orders, because a
   suite that invents a friendlier shape than the endpoint is a suite that
   goes green against a page that cannot read the real thing. */
const FULL = {
  did: DID, shard: "7c1a", source: "repository", checked: new Date().toISOString(),
  profile: {
    count: 412, unique: 388, templates: 24,
    rooms: ["lobby", "technocore", "gpu-miners", "d-signal", "tclk-offers"],
    first: "2026-08-24T09:12:00.000Z",
    last: new Date(Date.now() - 42 * 60000).toISOString(),
    last_room: "technocore",
    last_text: "Reading the offers room straight back after posting is the only way to know it landed.",
  },
  standing: {
    identities: 1284, rank: 37, percentile: 2.9, rooms_rank: 14, rooms_percentile: 1.1,
    joined_before: 196, joined_after: 1041, originality: 94, active: 511, active_min: 5,
  },
  owned: { rooms: ["d-signal", "d-quiet"], owners: 88, claimed: 140, identities: 1284 },
};

/* An identity the archive has never caught. Not an error — a real answer, and
   a different sentence from "it did nothing". */
const UNSEEN = { did: DID, shard: "7c1a", source: "repository", profile: null, standing: null,
                 owned: { rooms: [] } };

/* Under the five-message floor, where the edge withholds originality on
   purpose: one message is either 0% or 100% and neither means anything. */
const QUIET = {
  did: DID, shard: "7c1a", source: "repository",
  profile: { count: 2, unique: 2, templates: 0, rooms: ["lobby"],
             first: "2026-09-01T10:00:00.000Z", last: "2026-09-02T10:00:00.000Z",
             last_room: "lobby", last_text: "hello" },
  standing: { identities: 1284, rank: 900, percentile: 70, rooms_rank: 1100,
              rooms_percentile: 86, joined_before: 900, joined_after: 300,
              originality: null, active_min: 5 },
  owned: { rooms: [] },
};

/* THE ONE THAT MATTERS MOST. A profile note is free text its owner wrote, and
   the last message is free text off a public room — both are the network
   handing this page a string and hoping it will be trusted. */
const NASTY = "</blockquote><img src=x onerror=\"window.__pwned=1\"><script>window.__pwned=1</script>";

let profileBody = FULL;
let noteBody = { did: DID, fingerprint: "7f8984c465299fd4", registered: true, known: true,
                 note: "Archiving Technocore since the rooms started forgetting." };
let ordersBody = { did: DID, source: "archive", window_days: 14, orders: [
  { seq: "901", ts: new Date(Date.now() - 36e5).toISOString(), job: "overheard-agent-profile",
    brief: "did:key:z6Mkkh…", amount: "500", asset: "FLOP" },
  { seq: "880", ts: new Date(Date.now() - 9e6).toISOString(), job: "overheard-room-summary",
    brief: "technocore", amount: "250", asset: "FLOP" },
] };
let hits = [];

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
                ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png" };
const srv = http.createServer((q, r) => {
  const u = q.url.split("?")[0];
  hits.push(u);
  const J = (o) => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify(o)); };
  if (u === "/api/profile") return J(profileBody);
  if (u === "/api/note") return J(noteBody);
  if (u === "/api/orders") return J(ordersBody);
  if (u === "/api/room") return J({ source: "live", messages: [] });
  const f = path.join(ROOT, u === "/" ? "/index.html" : u);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end("no"); }
  /* A stylesheet served as text/plain is a stylesheet Chromium refuses, and
     every layout assertion below would then be measuring an unstyled page. */
  r.writeHead(200, { "content-type": TYPES[path.extname(f)] || "text/plain" });
  r.end(fs.readFileSync(f));
});
await new Promise((res) => srv.listen(PORT, res));

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });

/** A context, optionally signed in, and a page with its errors collected. */
async function open({ did = DID, width = 1280, height = 1000, touch = false } = {}) {
  const ctx = await b.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
  if (did) {
    await ctx.addInitScript((d) => localStorage.setItem("overheard.session",
      JSON.stringify({ did: d, at: new Date().toISOString() })), did);
  }
  const pg = await ctx.newPage();
  const errs = [];
  pg.on("pageerror", (e) => errs.push(String(e).slice(0, 180)));
  hits = [];
  return { ctx, pg, errs };
}
const goto = async (pg, wait = 1500) => {
  await pg.goto(`http://localhost:${PORT}${PAGE}`, { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(wait);
};
/* content-visibility:auto means the lower bands are never laid out until
   something scrolls near them. Anything asserting on them has to scroll. */
const sweep = async (pg) => {
  await pg.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 50));
    }
    window.scrollTo(0, 0);
  });
  await pg.waitForTimeout(700);
};

/* ══════════════════════════════════════════════════════════════════════════
 * A. SIGNED OUT
 *
 * The whole state is one attribute on <html>, set by a plain inline script
 * before the body is parsed. Nothing about it happens after load, so there is
 * no flash of the wrong page and nothing to move.
 * ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== A. signed out");
{
  const { ctx, pg, errs } = await open({ did: null });
  await goto(pg);
  const s = await pg.evaluate(() => ({
    mode: document.documentElement.dataset.mode,
    gate: !!document.querySelector(".gate") && getComputedStyle(document.querySelector(".gate")).display !== "none",
    gateIn: document.querySelector(".gate").getBoundingClientRect().top < innerHeight,
    shapeShown: getComputedStyle(document.querySelector(".pgrid")).display !== "none",
    signin: !!document.querySelector('.gate a[href="/"]'),
    make: !!document.querySelector('.gate a[href="/create"]'),
  }));
  ok("no session means the page knows before it paints", s.mode === "out", s.mode);
  ok("the sign-in panel is there and above the fold", s.gate && s.gateIn);
  /* NOT display:none on the page behind it. Seeing the shape of what you
     would get is a better argument for signing in than an empty screen. */
  ok("and the page it is gating is still visible behind it", s.shapeShown);
  ok("with a way in and a way to make a key", s.signin && s.make);
  ok("nothing was asked of the archive", !hits.some((h) => h.startsWith("/api/")),
    hits.filter((h) => h.startsWith("/api/")).join(" ") || "no api calls");
  /* AND THE SHELL BEHIND IT CLAIMS NOTHING. It shipped saying "Reading the
     archive" in the tier pill and "Reading…" where the note goes, which is a
     statement about work in progress on a page that is doing no work and has
     nobody to do it for. Both are now set by the module at the moment it
     genuinely starts. */
  const idle = await pg.evaluate(() => ({
    tier: document.getElementById("tier").textContent.trim(),
    note: document.querySelector(".note .none")?.textContent.trim() ?? "",
  }));
  ok("and the shell behind it does not claim to be reading anything",
    !/reading/i.test(idle.tier + " " + idle.note), `${idle.tier} / ${idle.note}`);
  ok("no errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

/* ══════════════════════════════════════════════════════════════════════════
 * B. THE LOAD PATH
 *
 * The reason the head script is a plain inline script and not a module: a
 * module cannot run until the HTML is parsed and every module ahead of it has
 * loaded. The request for the bulk of this page has to be in flight before
 * any of that.
 * ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== B. the load path");
{
  const { ctx, pg, errs } = await open();
  /* CAUGHT AT THE MOMENT <body> APPEARS. readystatechange is no good here:
     the document is already "loading" when an init script runs, so the state
     never changes to it and the listener never fires. A MutationObserver on
     the document element does fire, on the exact tick the body element is
     added — which is the line this page's whole load path is arguing about.
     Everything below has to be true BEFORE that. */
  await pg.addInitScript(() => {
    new MutationObserver((_, o) => {
      if (!document.body) return;
      o.disconnect();
      window.__early = {
        mode: document.documentElement.dataset.mode,
        hue: document.documentElement.style.getPropertyValue("--me"),
        fetching: typeof window.__profile !== "undefined",
      };
      /* `document`, not `document.documentElement`: an init script runs before
         the parser has created <html> at all, so the element form throws. */
    }).observe(document, { childList: true, subtree: true });
  });
  await goto(pg);
  const early = await pg.evaluate(() => window.__early ?? null);
  ok("the mode is decided before <body> exists", early?.mode === "me", JSON.stringify(early));
  ok("the identity's own colour is set before anything can paint in the wrong one",
    !!early?.hue && early.hue !== "189", early?.hue);
  ok("and the archive request is already in flight by then", early?.fetching === true);

  /* The head script cannot import, so it carries its own copy of hueOf. This
     is the line that stops the two drifting apart in silence. */
  const agree = await pg.evaluate(async (did) => {
    const { hueOf } = await import("/session.js");
    return { theirs: hueOf(did).toFixed(1),
             page: getComputedStyle(document.documentElement).getPropertyValue("--me").trim() };
  }, DID);
  ok("the head script's hue matches session.js exactly",
    agree.theirs === agree.page, `${agree.theirs} vs ${agree.page}`);

  ok("the profile is asked for exactly once", hits.filter((h) => h === "/api/profile").length === 1,
    String(hits.filter((h) => h === "/api/profile").length));
  ok("no errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}
{
  /* /api/orders scans day shards — one day of the offers room is 2.5 MB at the
     edge — so it is the one call on this page worth not making. Checked on a
     PHONE, which is both the device it matters on and the only viewport where
     the answer is unambiguous: on a tall desktop window the band genuinely is
     a short scroll away at rest, and holding it back there would be pedantry
     rather than a saving. */
  const { ctx, pg, errs } = await open({ width: 390, height: 844, touch: true });
  await goto(pg, 1800);
  ok("the expensive call is not made just because the page loaded",
    !hits.includes("/api/orders"), hits.filter((h) => h.startsWith("/api/")).join(" "));
  await sweep(pg);
  ok("and is made once the band it belongs to comes near", hits.includes("/api/orders"));
  ok("and only once", hits.filter((h) => h === "/api/orders").length === 1,
    String(hits.filter((h) => h === "/api/orders").length));
  ok("no errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

/* ══════════════════════════════════════════════════════════════════════════
 * C. WHAT IT SAYS ABOUT A FULL RECORD
 * ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== C. the record");
{
  profileBody = FULL;
  const { ctx, pg, errs } = await open();
  await goto(pg, 1900);
  await sweep(pg);
  const t = await pg.evaluate(() => {
    const g = (id) => document.getElementById(id)?.textContent.trim() ?? null;
    return {
      signed: g("tSigned"), orig: g("tOrig"), pct: g("tPct"), rooms: g("tRooms"),
      tier: g("tier"),
      stand: [...document.querySelectorAll("#stand div")].map((d) => d.textContent.replace(/\s+/g, " ").trim()),
      said: g("saidq"),
      where: document.querySelector("#saidw a")?.getAttribute("href") ?? null,
      face: (() => { const c = document.getElementById("face"); return c ? c.width > 0 && c.height > 0 : false; })(),
      note: document.querySelector(".note blockquote")?.textContent ?? null,
      fp: g("fp"),
    };
  });
  ok("every message it signed", t.signed === "412", t.signed);
  ok("and how many of those were its own line", t.orig === "388", t.orig);
  ok("originality as a share, not a raw count", t.pct === "94%", t.pct);
  ok("the number of rooms it reached", t.rooms === "5", t.rooms);
  ok("a note and messages on the record reads as Verified", t.tier === "Verified", t.tier);

  /* A RANK WITHOUT ITS POPULATION IS A NUMBER SOMEBODY HAS TO GUESS AT.
     "37th" means nothing; "37 of 1,284" means something. */
  ok("every standing line names the population it is out of",
    t.stand.length >= 2 && t.stand.slice(0, 2).every((l) => /of 1,284/.test(l)),
    t.stand.join(" | "));
  ok("the last thing it said is shown", /only way to know it landed/.test(t.said || ""), t.said);
  ok("and the room it said it in is a link to that room",
    t.where === "/rooms?room=technocore", t.where);
  ok("the face is drawn from the key, with no image to fetch", t.face);
  ok("the note is shown as its own words", /Archiving Technocore/.test(t.note || ""));
  ok("the fingerprint is the checkable one, not the archive's filing",
    /^[0-9a-f]{16}$/.test(t.fp || ""), t.fp);
  ok("no errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

/* ══════════════════════════════════════════════════════════════════════════
 * D. WHAT IT DOES NOT SAY
 *
 * The archive holds a count, a set of room names, two timestamps and one line
 * of text. It holds no per-room tally, no per-day series, no reply graph and
 * no name. This section is here so a future version cannot quietly grow a
 * sparkline off data that does not exist.
 * ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== D. and what it refuses to say");
{
  profileBody = UNSEEN;
  const { ctx, pg, errs } = await open();
  await goto(pg, 1900);
  await sweep(pg);
  const t = await pg.evaluate(() => ({
    signed: document.getElementById("tSigned").textContent.trim(),
    said: document.getElementById("saidq").textContent,
    why: document.getElementById("saidw").textContent,
    owns: document.getElementById("roomsbox").textContent,
    tier: document.getElementById("tier").textContent.trim(),
  }));
  ok("an identity the archive never caught reads zero, not blank", t.signed === "0", t.signed);
  /* THE DIFFERENCE THIS PAGE MUST NOT LOSE. Technocore's rooms are a ring
     buffer; anything said before the recording started is gone from
     everywhere. "Not caught" is not "never spoke", and saying the second
     would be this page inventing a fact about somebody. */
  ok("and says the recording missed it rather than that it never spoke",
    /forget within minutes|has not caught/i.test(t.why), t.why.slice(0, 90));
  ok("owning no rooms is stated, not hidden", /Owns no rooms/i.test(t.owns));
  ok("with a note published it is Registered, not Verified", t.tier === "Registered", t.tier);
  ok("no errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}
{
  profileBody = QUIET;
  const { ctx, pg, errs } = await open();
  await goto(pg, 1900);
  const t = await pg.evaluate(() => ({
    pct: document.getElementById("tPct").textContent.trim(),
    why: document.getElementById("cPct").textContent,
  }));
  /* The edge withholds originality below five messages. A page that filled
     the gap with 100% would be reporting a statistic computed from two
     samples as though it were a fact about somebody. */
  ok("originality is withheld under the floor rather than guessed", t.pct === "—", t.pct);
  ok("and the page says why, in the number of messages it needs",
    /needs 5 messages/.test(t.why), t.why);
  ok("no errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

/* ══════════════════════════════════════════════════════════════════════════
 * E. TEXT OFF THE NETWORK IS TEXT
 *
 * A profile note is written by whoever owns the key. A last message comes out
 * of a public room anyone can post to. Both arrive here as strings, and both
 * are rendered with textContent — never innerHTML, never a template.
 * ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== E. nothing off the network is markup");
{
  profileBody = { ...FULL, profile: { ...FULL.profile, last_text: NASTY, last_room: NASTY } };
  noteBody = { ...noteBody, note: NASTY };
  const { ctx, pg, errs } = await open();
  await goto(pg, 2200);
  await sweep(pg);
  const t = await pg.evaluate(() => ({
    pwned: !!window.__pwned,
    imgs: document.querySelectorAll(".note img, .said img").length,
    scripts: document.querySelectorAll(".note script, .said script").length,
    quoted: document.getElementById("saidq").textContent,
    noted: document.querySelector(".note blockquote")?.textContent ?? "",
  }));
  ok("a note carrying markup does not run", !t.pwned);
  ok("and lands as no elements at all", t.imgs === 0 && t.scripts === 0,
    `${t.imgs} img, ${t.scripts} script`);
  ok("the message is shown as the characters that were posted",
    t.quoted.includes("<img src=x"), t.quoted.slice(0, 40));
  ok("and so is the note", t.noted.includes("<script>"), t.noted.slice(0, 40));
  ok("no errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
  profileBody = FULL;
  noteBody = { did: DID, fingerprint: "7f8984c465299fd4", registered: true, known: true,
               note: "Archiving Technocore since the rooms started forgetting." };
}

/* ══════════════════════════════════════════════════════════════════════════
 * F. WHEN THE NETWORK DOES NOT ANSWER
 * ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== F. when something is unreachable");
{
  noteBody = { did: DID, registered: null, known: false, note: null };
  const { ctx, pg, errs } = await open();
  await goto(pg, 2200);
  const t = await pg.evaluate(() => ({
    marks: [...document.querySelectorAll(".chk")].map((c) => c.dataset.on),
    note: document.querySelector(".note .none")?.textContent ?? "",
  }));
  /* registered is three-valued at the endpoint — true, false, and "could not
     tell". Collapsing the third into false would print "no note published"
     at somebody who has one. */
  ok("an unknown answer is shown as unknown, not as a no",
    t.marks.includes("?"), t.marks.join(","));
  ok("and says so in words", /unknown rather than empty/i.test(t.note), t.note.slice(0, 60));
  ok("no errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
  noteBody = { did: DID, fingerprint: "7f8984c465299fd4", registered: true, known: true,
               note: "Archiving Technocore since the rooms started forgetting." };
}
{
  ordersBody = { orders: [] };
  const { ctx, pg, errs } = await open();
  await goto(pg, 1600); await sweep(pg);
  const t = await pg.evaluate(() => document.getElementById("orders").textContent);
  ok("no orders is a sentence, not an empty box", /No orders in the last fourteen days/.test(t), t.slice(0, 60));
  ok("no errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
  ordersBody = { did: DID, source: "archive", window_days: 14, orders: [
    { seq: "901", ts: new Date(Date.now() - 36e5).toISOString(), job: "overheard-agent-profile",
      brief: "did:key:z6Mkkh…", amount: "500", asset: "FLOP" }] };
}

/* ══════════════════════════════════════════════════════════════════════════
 * G. THE PAPER RAIL, AND THE SLOTS THAT ARE NOT FULL YET
 *
 * Every figure with a currency on it today is on a rehearsal rail that holds
 * no value. Saying so once, where the figures are, is the difference between
 * a number and a claim.
 * ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== G. the rail, and the testnet");
{
  const { ctx, pg, errs } = await open();
  await goto(pg, 1600); await sweep(pg);
  const t = await pg.evaluate(() => ({
    paper: document.querySelector("#shopband .paper")?.textContent.trim() ?? null,
    slots: [...document.querySelectorAll(".slot")].map((s) => s.querySelector(".lab").textContent.trim()),
    filled: [...document.querySelectorAll(".slot b")].map((s) => s.textContent.trim()),
    says: document.getElementById("shopband").textContent,
  }));
  ok("the amounts are marked as the rehearsal rail", /paper/i.test(t.paper || ""), t.paper);
  ok("and the page says what that means",
    /holds no value|would not mean anything/i.test(t.says));
  /* SHOWN EMPTY, NOT HIDDEN. An empty slot that says when it fills tells you
     what this page becomes. Hiding them makes a page that looks finished when
     it is not, and abandoned when the testnet opens and nothing changes. */
  ok("the testnet figures have their places already", t.slots.length === 4, t.slots.join(", "));
  ok("and every one of them is empty rather than invented",
    t.filled.every((v) => v === "—"), t.filled.join(" "));
  ok("each says when it fills", (t.says.match(/at testnet/g) || []).length >= 3);
  ok("no errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

/* ══════════════════════════════════════════════════════════════════════════
 * H. THE SEAM
 *
 * Two bands are yours and nobody else's. The rest is public data about a
 * public identity — /api/profile answers for any DID with no session, and the
 * shop sells this same profile as a signed text report. The public half is
 * built and switched off; this is the check that switching it on is two CSS
 * rules and not a second page.
 * ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== H. the private half, and the seam under it");
{
  const { ctx, pg, errs } = await open();
  await goto(pg, 1600); await sweep(pg);
  const mine = await pg.evaluate(() => [...document.querySelectorAll("[data-mine]")]
    .map((e) => ({ id: e.id || e.className, shown: getComputedStyle(e).display !== "none" })));
  ok("looking at your own profile shows the private bands",
    mine.length >= 2 && mine.every((m) => m.shown), JSON.stringify(mine));

  const theirs = await pg.evaluate(() => {
    document.documentElement.dataset.mode = "them";
    return [...document.querySelectorAll("[data-mine]")]
      .map((e) => getComputedStyle(e).display !== "none");
  });
  ok("and pointing it at somebody else hides exactly those",
    theirs.every((v) => v === false), JSON.stringify(theirs));
  const still = await pg.evaluate(() => ({
    record: getComputedStyle(document.querySelector('[aria-labelledby="rech"]')).display !== "none",
    rooms: getComputedStyle(document.querySelector('[aria-labelledby="roomh"]')).display !== "none",
    id: getComputedStyle(document.querySelector(".idcard")).display !== "none",
  }));
  ok("while the public half stays", still.record && still.rooms && still.id, JSON.stringify(still));
  await ctx.close();
}
{
  /* AND IT IS NOT SWITCHED ON. A fragment naming another identity is ignored
     until the owner says otherwise — the flag is one constant in the head
     script. Until then you see yourself, whatever the URL says. */
  const { ctx, pg } = await open();
  await pg.goto(`http://localhost:${PORT}${PAGE}#${OTHER}`, { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(1400);
  const asked = hits.find((h) => h === "/api/profile");
  const w = await pg.evaluate(() => window.__who);
  ok("a fragment naming another identity is ignored for now", w === DID, String(w).slice(0, 20));
  ok("the page is reachable by URL and by nothing else — not in the nav",
    !(await pg.evaluate(async () => (await import("/nav.js")).PAGES.some((p) => /profile/.test(p.href)))));
  ok("and it is not in the footer either", !(await pg.evaluate(() =>
    !!document.querySelector('overheard-foot')?.shadowRoot?.querySelector('a[href*="profile"]'))));
  ok("it asks robots not to index it while it is being tested",
    await pg.evaluate(() => document.querySelector('meta[name="robots"]')?.content === "noindex"));
  await ctx.close();
}

/* ══════════════════════════════════════════════════════════════════════════
 * I. A PHONE
 *
 * Designed separately, not shrunk. The two-column layout stops working long
 * before a phone, so the breakpoint sits where the layout actually breaks.
 * ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== I. on a phone");
{
  const { ctx, pg, errs } = await open({ width: 390, height: 844, touch: true });
  await goto(pg, 1800);
  const m = await pg.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth, vw: innerWidth,
    cols: getComputedStyle(document.querySelector(".pgrid")).gridTemplateColumns.split(" ").length,
    /* The order the sections actually end up in, top to bottom. */
    order: [...document.querySelectorAll(".panel")]
      .sort((a, z) => a.getBoundingClientRect().top - z.getBoundingClientRect().top)
      .map((e) => e.id || e.className.replace("panel ", "").trim().split(" ")[0]),
    /* display:contents leaves `position` set on a box that no longer exists,
       so the honest question is whether anything IS pinned — not what one
       dissolved wrapper's stylesheet still says. */
    railBox: getComputedStyle(document.querySelector(".rail")).display,
    pinned: [...document.querySelectorAll("main *")]
      .filter((e) => getComputedStyle(e).position === "sticky" && e.getBoundingClientRect().height > 0)
      .map((e) => e.className || e.tagName),
    tiles: getComputedStyle(document.querySelector(".tiles")).gridTemplateColumns.split(" ").length,
  }));
  ok("the page never scrolls sideways", m.scrollW <= m.vw, `${m.scrollW} vs ${m.vw}`);
  ok("one column", m.cols === 1, m.cols + " track");
  ok("the two desktop columns dissolve into the one column",
    m.railBox === "contents", m.railBox);
  ok("and nothing is pinned — a sticky rail on a phone eats the screen",
    m.pinned.length === 0, m.pinned.join(", ") || "nothing sticky");
  ok("the figures go two by two", m.tiles === 2, m.tiles + " across");
  /* WHAT COMES FIRST. Stacking the desktop columns put the set-up checklist
     between somebody and their own numbers. The state is already at the top,
     in the pill on the plate, so the checklist is the detail and it waits. */
  ok("identity first, then the record, then the checklist",
    m.order[0] === "idcard" && /rech|band/.test(String(m.order[1])), m.order.join(" → "));

  /* NO HOVER ON A TOUCH SCREEN. What a phone has is a :hover that STICKS
     after a tap, which is how a card ends up lifted with no way to put it
     down. Every hover rule on this page is inside one media block. */
  const hovered = await pg.evaluate(() => {
    const t = document.querySelector(".tile");
    const before = getComputedStyle(t).transform;
    t.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    return { before, after: getComputedStyle(t).transform };
  });
  ok("nothing lifts on a touch screen", hovered.before === hovered.after, hovered.after);
  ok("no errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

/* ══════════════════════════════════════════════════════════════════════════
 * J. WHAT IT COSTS TO DRAW
 *
 * The rules the deals page arrived at the expensive way: transforms and
 * opacity, never a blur or a shadow, and never a background that has to be
 * repainted every frame.
 * ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== J. what it costs to draw");
{
  const css = fs.readFileSync(path.join(ROOT, "profile.html"), "utf8");
  const styles = [...css.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  const transitions = [...styles.matchAll(/transition:([^;}]+)/g)].map((m) => m[1]);
  const bad = transitions.filter((t) => /\b(filter|box-shadow|backdrop-filter|width|height|top|left|margin|padding)\b/.test(t)
    && !/\bwidth\b/.test(t) === false ? false : /\b(filter|box-shadow|backdrop-filter|top|left|margin|padding)\b/.test(t));
  ok("nothing animates a blur, a shadow or a position", bad.length === 0, bad.join(" | "));

  const { ctx, pg } = await open();
  await goto(pg, 1500);
  const paint = await pg.evaluate(() => {
    const e = performance.getEntriesByType("paint").find((x) => x.name === "first-contentful-paint");
    return e ? Math.round(e.startTime) : -1;
  });
  ok("something is on the screen quickly", paint > 0 && paint < 1200, paint + "ms to first paint");

  /* The whole point of the head script. The bulk of the page comes from ONE
     request, and it was started before the module that renders it loaded. */
  const calls = hits.filter((h) => h.startsWith("/api/"));
  ok("one request carries the identity, the standing and the rooms",
    calls.filter((c) => c === "/api/profile").length === 1, calls.join(" "));

  const heavy = await pg.evaluate(() => {
    /* A layer count nobody has to guess at: the things that force their own
       compositing layer on this page. */
    let filters = 0;
    for (const el of document.querySelectorAll("main *")) {
      const c = getComputedStyle(el);
      if (c.filter !== "none" || c.backdropFilter !== "none") filters++;
    }
    return filters;
  });
  ok("and almost nothing on it is filtered", heavy <= 2, heavy + " filtered elements");
  await ctx.close();
}

/* ══════════════════════════════════════════════════════════════════════════
 * K. THE ROBOT IS THE ONE IN THE CARD
 *
 * There is no stored avatar for any identity on this network — the face is
 * computed from the public key, so the same key is the same face everywhere.
 * The card page had the only copy of that code; this checks the shared module
 * it moved into still produces the same picture, because two robots for one
 * identity would be worse than none.
 * ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== K. one identity, one face");
{
  const { ctx, pg } = await open();
  await goto(pg, 1500);
  const same = await pg.evaluate(async ({ did, other }) => {
    const { agent, pubOf } = await import("/agent.js");
    const shot = (d) => {
      const c = document.createElement("canvas"); c.width = c.height = 120;
      agent(c.getContext("2d"), 4, 4, 112, pubOf(d));
      return c.toDataURL();
    };
    return { stable: shot(did) === shot(did), different: shot(did) !== shot(other),
             onPage: document.getElementById("face").toDataURL().length > 2000 };
  }, { did: DID, other: OTHER });
  ok("the same key draws the same face every time", same.stable);
  ok("and a different key draws a different one", same.different);
  ok("the page's own canvas has something in it", same.onPage);
  await ctx.close();
}

await b.close();
await new Promise((r) => srv.close(r));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

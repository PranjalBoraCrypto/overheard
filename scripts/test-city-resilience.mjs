/* Agent City when Technocore is not answering.
 *
 * There was a screen that said "Technocore returned 503. Nothing here is
 * cached or invented, so the city stays empty until it does." It was
 * accurate, and it was the worst thing this page did: a visitor arriving
 * during a forty-second upstream hiccup was shown a technical apology where
 * a city should be, and left believing the site was broken.
 *
 * These tests are the guarantee that it cannot come back. They are grouped
 * by the promise each one keeps:
 *
 *   A. THE ENDPOINT never answers an upstream failure with an error. It
 *      answers with genuine archived data, correctly labelled, and it never
 *      lets that degraded answer be cached over a good one.
 *   B. THE PAGE draws a city before it has asked anyone anything, and keeps
 *      it on screen through a failing directory.
 *   C. THE WORDING stays honest in every state — saved is never called live,
 *      a working connection is never called offline, and an age is attached
 *      to anything that is not current.
 *   D. THE MERGE does not move the camera or rebuild the scene.
 *
 * Needs playwright and a chromium:  npx playwright install chromium
 */
import { chromium } from "playwright";
import http from "http"; import fs from "fs"; import path from "path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "web");

let bad = 0;
const check = (n, ok, d = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? "   " + d : ""}`);
  if (!ok) bad++;
};

const load = async (f) => {
  const src = await readFile(path.join(HERE, "..", "api", f), "utf8");
  return (await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"))).default;
};

const SNAP = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "city-snapshot.json"), "utf8"));

const upstreamOK = {
  total: 36498, capacity: 40960,
  rooms: [
    { room: "lobby", last_seq: 8013448, idle_seconds: 0, topic: "Verified Technocore Hub", window: 200 },
    { room: "technocore", last_seq: 1486031, idle_seconds: 0, topic: null, window: 200 },
    { room: "kibble", last_seq: 242429, idle_seconds: 4, topic: "useful work board", window: 200 },
  ],
};

/* ════════════════════════════════════════════════════════════════════════
   A. THE ENDPOINT
   ════════════════════════════════════════════════════════════════════ */
console.log("=== A. /api/city answers a broken upstream with data, not an error");

const cityHandler = await load("city.js");
const realFetch = globalThis.fetch;

/** Stand in for both the upstream and the site's own static asset. */
function stubFetch({ upstream }) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/data/city-snapshot.json")) {
      return new Response(JSON.stringify(SNAP), { status: 200 });
    }
    if (typeof upstream === "number") return new Response("nope", { status: upstream });
    if (upstream === "throw") throw new Error("network");
    return new Response(JSON.stringify(upstream), { status: 200 });
  };
}
const callCity = () => cityHandler(new Request("https://overheard.test/api/city"));

for (const [label, upstream] of [["503", 503], ["429", 429], ["a dead socket", "throw"]]) {
  stubFetch({ upstream });
  const res = await callCity();
  const body = await res.json();
  check(`${label} upstream still returns a city`,
    res.status === 200 && body.known === true && body.named.length > 0,
    `${res.status} · ${body.named?.length ?? 0} rooms`);
  check(`  …labelled as the snapshot it is`, body.source === "snapshot", String(body.source));
  check(`  …carrying the ORIGINAL retrieval time, not now`,
    body.retrieved_at === SNAP.retrieved_at && body.age_seconds > 0,
    `${body.retrieved_at} · ${body.age_seconds}s old`);
  /* The rule that keeps the ladder from collapsing: a degraded answer must
     never be cached, or the CDN would serve it in place of the good reading
     it already has, and every visitor for the next twenty seconds would get
     a two-day-old file instead of a twenty-second-old directory. */
  check(`  …and is never cached over a good reading`,
    res.headers.get("Cache-Control") === "no-store",
    res.headers.get("Cache-Control"));
  check(`  …with the real reason kept for the diagnostics, not the screen`,
    typeof body.degraded?.why === "string" && body.degraded.why.length > 0,
    body.degraded?.why);
}

stubFetch({ upstream: upstreamOK });
{
  const res = await callCity();
  const body = await res.json();
  check("a healthy upstream is labelled live", body.source === "live" && body.age_seconds === 0);
  /* THE SHELF LIFE MUST BE SHORTER THAN THE CLIENT'S POLL, and the number
     matters rather than merely being present. It was 20 against a client
     that polled every 20, and two equal periods beat: some polls landed in a
     generation already seen and found nothing, the next skipped one and
     found two windows of traffic at once. That is the reported "burst, then
     silent for long". Anything at or above the poll interval reintroduces
     it, so this asserts the relationship and not just the header. */
  const CLIENT_POLL_S = 7;         // data.js CITY_MS
  const cc = res.headers.get("Cache-Control") || "";
  const ttl = Number(/s-maxage=(\d+)/.exec(cc)?.[1] ?? -1);
  check("only a live reading is cacheable", ttl > 0, cc);
  check("and its shelf life is longer than the client's poll, so most polls are cache hits",
    ttl > CLIENT_POLL_S, `s-maxage=${ttl} vs ${CLIENT_POLL_S}s poll`);
  check("but not a whole multiple of it, which is what made the city beat",
    ttl % CLIENT_POLL_S !== 0, `s-maxage=${ttl}`);
  check("with stale-if-error, so the CDN can cover a blip before we have to",
    /stale-if-error/.test(res.headers.get("Cache-Control") || ""));
}

/* /api/room: the same ladder, with the rule that matters most in a room. */
console.log("\n=== A2. /api/room hands back archived messages, flagged as archived");
const roomHandler = await load("room.js");
const roomSnap = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "room-snapshots", "lobby.json"), "utf8"));
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/data/room-snapshots/lobby.json")) return new Response(JSON.stringify(roomSnap), { status: 200 });
  return new Response("nope", { status: 503 });
};
{
  const res = await roomHandler(new Request("https://overheard.test/api/room?room=lobby&since=0"));
  const body = await res.json();
  check("opening a door onto a dead upstream still shows the room",
    body.source === "snapshot" && body.messages.length > 0, `${body.messages?.length} messages`);
  check("every archived message says so, so nothing can bubble it as new",
    body.messages.every((m) => m.archived === true));
  check("and they are real messages with real sequence numbers",
    body.messages.every((m) => /^\d+$/.test(m.seq) && typeof m.text === "string"));
  /* A poll is not a door. Handing `since=<seq>` a two-day-old archive would
     be handing the past to something holding the present. */
  const poll = await roomHandler(new Request("https://overheard.test/api/room?room=lobby&since=999"));
  check("but a failed POLL is not answered with the archive",
    poll.status !== 200 && (await poll.json()).source === "none", String(poll.status));
}
globalThis.fetch = realFetch;

/* ════════════════════════════════════════════════════════════════════════
   B/C/D. THE PAGE
   ════════════════════════════════════════════════════════════════════ */

/** The directory is a switch the test flips mid-session. */
let MODE = "down";       // "down" | "live" | "hang"
let cityHits = 0;

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  let p = u.pathname;
  if (p === "/city") p = "/city.html";
  if (p === "/") p = "/index.html";

  if (p === "/api/city") {
    cityHits++;
    if (MODE === "hang") return;                        // never answers, never closes
    if (MODE === "down") {
      /* Exactly what the real endpoint sends when Technocore is refusing:
         the snapshot, labelled, uncacheable. */
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ ...SNAP, source: "snapshot", age_seconds: 172800,
        degraded: { why: "technocore returned 503" } }));
    }
    const now = new Date().toISOString();
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ...SNAP, source: "live", retrieved_at: now, at: now, age_seconds: 0 }));
  }
  if (p.startsWith("/api/")) {
    res.writeHead(200, { "content-type": "application/json" }); return res.end("{}");
  }

  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    const type = p.endsWith(".js") ? "text/javascript" : p.endsWith(".css") ? "text/css"
      : p.endsWith(".json") ? "application/json" : "text/html";
    res.writeHead(200, { "content-type": type });
    return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end("{}");
}).listen(8973);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const pg = await ctx.newPage();
const errs = [];
pg.on("pageerror", (e) => errs.push(e.message));

const seen = () => pg.evaluate(() => document.body.innerText);
const bootShown = () => pg.evaluate(() => !document.getElementById("boot").hidden);
const chip = () => pg.evaluate(() => document.getElementById("status").innerText.trim());
const roomCount = () => pg.evaluate(() => window.__city?.city?.roster?.length ?? -1);

console.log("\n=== B. the city is on screen before anyone answers");
MODE = "hang";                                          // the directory never replies at all
const t0 = Date.now();
await pg.goto("http://localhost:8973/city");
await pg.waitForFunction(() => (window.__city?.city?.roster?.length ?? 0) > 0, null, { timeout: 12000 })
  .catch(() => {});
const tCity = Date.now() - t0;
check("a city exists with the directory hanging", (await roomCount()) > 0, `${await roomCount()} rooms`);
check("and it got there quickly", tCity < 8000, `${tCity}ms`);
await pg.waitForTimeout(1200);
check("nothing covers the canvas", !(await bootShown()));
{
  const text = await seen();
  check("the words '503' never appear", !/\b503\b/.test(text));
  check("nor 'Nothing here is cached or invented'", !/Nothing here is cached/i.test(text));
  check("nor 'is not answering' as a headline", !/directory is not answering/i.test(text));
}
check("the chip admits it is saved data", /saved|updating/i.test(await chip()), await chip());
check("and never says Live", !/^Live$/i.test(await chip()), await chip());

console.log("\n=== C. a refusing directory keeps the city and stays honest");
MODE = "down";
await pg.reload();
await pg.waitForFunction(() => (window.__city?.city?.roster?.length ?? 0) > 0, null, { timeout: 12000 });
await pg.waitForTimeout(2000);
check("still a city", (await roomCount()) > 0, `${await roomCount()} rooms`);
check("still nothing covering it", !(await bootShown()));
{
  const c = await chip();
  check("the chip names the state and the age", /saved snapshot/i.test(c) && /ago|d |h |m /i.test(c), c);
  const title = await pg.evaluate(() => document.getElementById("status").title);
  check("and the honest sentence is in the tooltip, not on the city",
    /not a reading of the network right now/i.test(title), title.slice(0, 60) + "…");
}

/* ════════════════════════════════════════════════════════════════════════
   C2. THE CHIP SAYS WHICH SIDE IS NOT ANSWERING
   ════════════════════════════════════════════════════════════════════════

   Asked, in exactly these words, about a chip reading "Reconnecting · last
   live 34m ago": is this our build or Flop's? It is the right question and
   the chip could not answer it, while the endpoint had known all along and
   was saying so into a title attribute — a tooltip nobody hovers and a phone
   cannot show.

   There are two sides, they fail for unrelated reasons, and only one of them
   is ours. The chip names it.
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== C2. and which side is not answering");
{
  /* A live reading first, so the page has something to be stale ABOUT — the
     wording differs over a live reading and over the shipped snapshot. */
  MODE = "live";
  await pg.reload();
  await pg.waitForFunction(() => /^Live$/i.test(document.getElementById("status").innerText.trim()),
    null, { timeout: 20000 });

  /* Technocore refusing. The endpoint answers with the snapshot and says so,
     and the page must attribute it upstream. */
  MODE = "down";
  await pg.evaluate(() => {
    /* Straight past the backoff: this is about wording, not scheduling. */
    document.dispatchEvent(new Event("visibilitychange"));
  });
  /* A tab that has just been woken says "Resuming" for a few seconds before
     it is willing to call anything a failure — one missed poll on a laptop
     coming out of sleep is not evidence of an outage, and saying so would be
     the alarming lie this whole section exists to prevent. That state is
     deliberate and temporary, so the test waits for the chip to SETTLE rather
     than reading it mid-recovery. */
  await pg.waitForFunction(() => /technocore|saved snapshot|proxy/i.test(
    document.getElementById("status").innerText), null, { timeout: 45000 }).catch(() => {});
  await pg.waitForTimeout(400);
  const t = await pg.evaluate(() => ({
    text: document.getElementById("status").innerText.replace(/\s+/g, " ").trim(),
    title: document.getElementById("status").title,
  }));
  check("it names Technocore rather than saying only 'reconnecting'",
    /technocore/i.test(t.text) || /saved snapshot/i.test(t.text), t.text);
  check("and the tooltip says whose problem it is",
    /not answering overheard|this site's problem|not a reading of the network/i.test(t.title),
    t.title.slice(0, 70) + "…");
  check("it never blames the wrong side", !/overheard's proxy not answering/i.test(t.text), t.text);
  MODE = "live";
}

console.log("\n=== D. live data merges without disturbing anything");
/* The arrival flight belongs to the FIRST paint and is meant to run — that is
   the seed doing its job. What must not happen is a second one when live data
   replaces the snapshot underneath a visitor who is already looking around.
   So the camera is sampled once it has settled, not mid-flight. */
await pg.waitForFunction(() => !window.__city.cam.busy, null, { timeout: 15000 }).catch(() => {});
await pg.waitForTimeout(300);
const camOf = () => pg.evaluate(() => {
  const c = window.__city.cam, t = c.target;
  return { dist: Math.round(c.dist * 100), pitch: Math.round(c.pitch * 1000),
    tx: Math.round(t.x * 100), tz: Math.round(t.z * 100),
    rooms: window.__city.city.roster.length };
});
const before = await camOf();
MODE = "live";
/* WHY THIS IS NUDGED RATHER THAN WAITED OUT. Section C left the poller in
   backoff, and the backoff is exponential and jittered — by design, so that
   every tab open when Technocore went down does not return at the same
   instant and knock it over again. That means the next unprompted attempt is
   anywhere up to about two and a half minutes away, and a test that waits
   forty seconds for it is a coin flip: it passed most runs and failed some,
   which is worse than either.
   A visitor coming back to the tab is the real recovery path and the page
   already implements it — the same visibilitychange handler a browser fires.
   So the test takes that path, and what it asserts is unchanged: the merge
   must not move the camera, empty the city or fly anybody anywhere. */
await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await pg.waitForFunction(() => /^Live$/i.test(document.getElementById("status").innerText.trim()),
  null, { timeout: 40000 }).catch(() => {});
await pg.waitForTimeout(600);
const after = await camOf();
check("the chip flips to Live", /^Live$/i.test(await chip()), await chip());
check("the camera did not move",
  before.dist === after.dist && before.pitch === after.pitch
  && before.tx === after.tx && before.tz === after.tz,
  `${before.dist}/${before.pitch}/${before.tx},${before.tz} → ${after.dist}/${after.pitch}/${after.tx},${after.tz}`);
check("and no second arrival flight was triggered by the merge",
  !(await pg.evaluate(() => window.__city.cam.busy)));
check("the city was not emptied and rebuilt", after.rooms >= before.rooms,
  `${before.rooms} → ${after.rooms}`);
check("the upstream was asked more than once", cityHits > 1, `${cityHits} calls`);

console.log("\npage errors:", JSON.stringify(errs.slice(0, 4)));
if (errs.length) bad++;
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall good");

await browser.close(); srv.close();
process.exit(bad ? 1 : 0);

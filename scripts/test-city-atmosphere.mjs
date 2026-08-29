/* Agent City: the page, the soundtrack, and the pulse of the data.
 *
 * Four things were asked for, and each one is easy to *appear* to have done:
 *
 *   A. THE PAGE'S OWN BACKGROUND IS GONE. The city used to paint its own
 *      dark plate, which meant the site's sky stopped at the nav bar and
 *      resumed under it. Checking that a CSS rule was deleted proves
 *      nothing; what matters is that the sky layer is behind the canvas and
 *      the canvas is genuinely transparent, so this reads the computed
 *      background and the renderer's clear alpha.
 *   B. THE ROOM HEADER SITS LEFT, UNDER ITS OWN SPACE. Measured in real
 *      geometry: the way out is above the name, everything shares one left
 *      edge, and that edge is inset from the frame.
 *   C. MUSIC PLAYS OUT HERE AND NOT IN THERE. Five loops on the city, and
 *      silence inside a room — a room has its own bed and the tick of a
 *      message arriving, and a soundtrack over that drowns out the only
 *      part of the sound that is information.
 *   D. THE CITY PULSES WITH THE DATA, AND ONLY WITH THE DATA. A roof
 *      flaring is a claim that a message arrived in that room. It must be
 *      spendable only by real movement, it must fade, and — the part worth
 *      testing hardest — a poll's worth of activity must be spread across
 *      the window rather than fired in one lump, because twenty seconds of
 *      stillness broken by one simultaneous flash is what "dead" looks like.
 *
 * Needs playwright and a chromium:  npx playwright install chromium
 */
import { chromium } from "playwright";
import http from "http"; import fs from "fs"; import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "web");
const SNAP = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "city-snapshot.json"), "utf8"));

let bad = 0;
const check = (n, ok, d = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? "   " + d : ""}`);
  if (!ok) bad++;
};

/* The directory under the test's control: `bump` walks every sequence
   number forward, so one poll looks like a burst of real activity. */
let bump = 0;
const directory = () => {
  const now = new Date().toISOString();
  const step = (r) => ({ ...r, last_seq: r.last_seq == null ? null : String(Number(r.last_seq) + bump) });
  return { ...SNAP, source: "live", retrieved_at: now, at: now, age_seconds: 0,
    landmarks: SNAP.landmarks.map(step), named: SNAP.named.map(step) };
};

const room = (name) => ({
  ok: true, room: name, source: "live", retrieved_at: new Date().toISOString(),
  age_seconds: 0, messages: [], next: "0",
});

const srv = http.createServer((req, res) => {
  let p = new URL(req.url, "http://x").pathname;
  if (p === "/city") p = "/city.html";
  if (p === "/api/city") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(directory()));
  }
  if (p === "/api/room") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(room(new URL(req.url, "http://x").searchParams.get("room") || "lobby")));
  }
  if (p.startsWith("/api/")) { res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    const t = p.endsWith(".js") ? "text/javascript" : p.endsWith(".json") ? "application/json"
      : p.endsWith(".css") ? "text/css" : "text/html";
    res.writeHead(200, { "content-type": t });
    return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end("{}");
}).listen(8977);

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  /* --autoplay-policy: WebAudio in headless chromium will not leave the
     "suspended" state without a user gesture, and a suspended context books
     no oscillators. Without this the music section measures the browser's
     autoplay rule rather than the page. */
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader",
         "--autoplay-policy=no-user-gesture-required"],
});

/* Every section takes a fresh context and gives it back — software WebGL
   contexts do not garbage-collect fast enough to leave lying around. */
async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1240, height: 820 } });
  await ctx.addInitScript(() => {
    try { localStorage.setItem("overheard.city.quality", "balanced"); } catch {}
    try { localStorage.setItem("overheard.city.seen", "1"); } catch {}
  });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on("pageerror", (e) => errs.push(e.message));
  await pg.goto("http://localhost:8977/city");
  await pg.waitForFunction(
    () => window.__city?.world?.life != null && (window.__city?.city?.roster?.length ?? 0) > 0,
    null, { timeout: 25000 });
  await pg.waitForFunction(() => !window.__city.cam.busy, null, { timeout: 20000 }).catch(() => {});
  return { pg, ctx, errs };
}

/* ════════════════════════════════════════════════════════════════════════
   A. THE SITE'S BACKGROUND, NOT THE PAGE'S OWN
   ════════════════════════════════════════════════════════════════════ */
console.log("=== A. the city sits on the same background as every other page");
{
  const { pg, ctx, errs } = await open();

  const bg = await pg.evaluate(() => {
    const st = document.querySelector(".stage");
    const sky = document.querySelector(".sky");
    const cv = document.querySelector("canvas");
    const r = window.__city.world.renderer;
    const gl = r.getContext();
    return {
      stage: getComputedStyle(st).backgroundColor,
      stageImage: getComputedStyle(st).backgroundImage,
      sky: !!sky,
      canvas: getComputedStyle(cv).backgroundColor,
      alpha: !!gl.getContextAttributes().alpha,
      clearAlpha: r.getClearAlpha(),
    };
  });

  const transparent = (v) => v === "rgba(0, 0, 0, 0)" || v === "transparent";
  check("the stage paints nothing of its own", transparent(bg.stage), bg.stage);
  check("and has no gradient hiding under it", bg.stageImage === "none", bg.stageImage.slice(0, 48));
  check("the site's sky layer is present on the page", bg.sky);
  check("the canvas itself is transparent", transparent(bg.canvas), bg.canvas);
  check("the drawing buffer has an alpha channel at all", bg.alpha);
  check("and the renderer clears to nothing, so the sky shows through",
    bg.clearAlpha === 0, String(bg.clearAlpha));

  /* "The same background as every other page" is a claim about two pages,
     so it takes two pages to check. Pixels would be the ideal comparison and
     are the wrong one here — the sky's two blobs are on 26 and 31 second
     animations, so two screenshots taken seconds apart legitimately differ.
     The ground itself does not move: the body colour and the sky's own
     gradients are what must match. */
  const ground = (p) => p.evaluate(() => {
    const sky = [...document.querySelectorAll(".sky i")]
      .map((i) => getComputedStyle(i).backgroundImage).join(" | ");
    return { body: getComputedStyle(document.body).backgroundColor, sky };
  });
  const here = await ground(pg);
  const other = await ctx.newPage();
  await other.goto("http://localhost:8977/play.html");
  await other.waitForTimeout(400);
  const there = await ground(other);
  await other.close();

  check("the city's ground is the site's ground", here.body === there.body,
    `${here.body} vs ${there.body}`);
  check("and it is the very same sky, blob for blob", here.sky === there.sky && here.sky.length > 0);
  check("no page errors", errs.length === 0, errs[0] || "");
  await ctx.close();
}

/* ════════════════════════════════════════════════════════════════════════
   B. THE ROOM HEADER
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== B. inside a room, the header reads left and has room above it");
{
  const { pg, ctx, errs } = await open();
  await pg.evaluate(() => window.__city.enterRoom("lobby"));
  await pg.waitForFunction(() => document.body.classList.contains("inroom"), null, { timeout: 20000 });
  await pg.waitForTimeout(700);

  const geo = await pg.evaluate(() => {
    const b = document.getElementById("backCity").getBoundingClientRect();
    const h = document.getElementById("roomName").getBoundingClientRect();
    const t = document.getElementById("roomTopic").getBoundingClientRect();
    const head = document.querySelector(".roomhead").getBoundingClientRect();
    return { b: [b.left, b.top, b.bottom], h: [h.left, h.top], t: [t.left, t.top],
             head: [head.left, head.top], w: innerWidth,
             align: getComputedStyle(document.querySelector(".roomhead")).textAlign };
  });

  check("the way out sits above the room's name", geo.b[2] <= geo.h[1] + 1,
    `back ends ${Math.round(geo.b[2])}, name starts ${Math.round(geo.h[1])}`);
  check("there is real space between them", geo.h[1] - geo.b[2] >= 8,
    `${Math.round(geo.h[1] - geo.b[2])}px`);
  check("the block is left-aligned, not centred", geo.align === "left" || geo.align === "start", geo.align);
  check("the button, the name and the topic share one left edge",
    Math.abs(geo.b[0] - geo.h[0]) <= 3 && Math.abs(geo.h[0] - geo.t[0]) <= 3,
    [geo.b[0], geo.h[0], geo.t[0]].map(Math.round).join(" / "));
  check("and that edge is inset from the frame, not against it",
    geo.head[0] >= 48 && geo.head[0] <= 140, `${Math.round(geo.head[0])}px`);
  check("the header is not pinned to the very top", geo.head[1] >= 20, `${Math.round(geo.head[1])}px`);
  check("the city headline is not showing behind it",
    await pg.evaluate(() => {
      const el = document.querySelector(".cityonly");
      return !el || getComputedStyle(el).display === "none";
    }));
  check("no page errors", errs.length === 0, errs[0] || "");
  await ctx.close();
}

/* ════════════════════════════════════════════════════════════════════════
   C. THE SOUNDTRACK
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== C. music on the city, silence in a room");
{
  const { pg, ctx, errs } = await open();

  /* Count oscillators for real. `musicPlaying()` is the page's own opinion;
     an OscillatorNode actually being constructed is the fact. */
  await pg.evaluate(() => {
    window.__osc = 0;
    const O = OscillatorNode;
    const orig = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () { window.__osc++; return orig.call(this); };
    void O;
  });

  await pg.click("#mute");                                   // a real gesture
  await pg.waitForTimeout(1600);

  const city = await pg.evaluate(() => ({
    playing: window.__city.sound.musicPlaying(),
    track: window.__city.sound.musicTrack(),
    osc: window.__osc,
  }));
  check("switching sound on starts a loop", city.playing);
  check("and it is one of the named tracks", typeof city.track === "string" && city.track.length > 0, city.track);
  check("notes are really being booked, not just a flag set", city.osc > 10, `${city.osc} oscillators`);

  await pg.evaluate(() => window.__city.enterRoom("lobby"));
  await pg.waitForFunction(() => document.body.classList.contains("inroom"), null, { timeout: 20000 });
  /* Settle FIRST, then count. Arriving in a room legitimately makes sound —
     the arrival chime and the room's bed are both oscillators, and counting
     from the moment of entry measures those rather than the soundtrack.
     What must be true a second later is that nothing is still being booked
     on a schedule, which is the difference between stopping the music and
     turning its volume down. */
  await pg.waitForTimeout(1200);
  await pg.evaluate(() => { window.__osc = 0; });
  await pg.waitForTimeout(1600);
  const inroom = await pg.evaluate(() => ({
    playing: window.__city.sound.musicPlaying(), osc: window.__osc,
  }));
  check("entering a room stops the music", !inroom.playing);
  check("and stops booking notes, rather than muting them", inroom.osc === 0, `${inroom.osc} oscillators`);

  await pg.evaluate(() => window.__city.leaveRoom?.() ?? document.getElementById("backCity").click());
  await pg.waitForFunction(() => !document.body.classList.contains("inroom"), null, { timeout: 20000 });
  await pg.waitForTimeout(1200);
  check("leaving brings it back",
    await pg.evaluate(() => window.__city.sound.musicPlaying()));

  /* Muting must silence the soundtrack too, not only the effects. */
  await pg.click("#mute");
  await pg.waitForTimeout(400);
  check("and muting silences it",
    !(await pg.evaluate(() => window.__city.sound.musicPlaying())));
  check("no page errors", errs.length === 0, errs[0] || "");
  await ctx.close();
}

/* ════════════════════════════════════════════════════════════════════════
   D. THE PULSE
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== D. the city pulses with the data it is reading");
{
  const { pg, ctx, errs } = await open();

  /* Wait for the city to go quiet before testing the pulse in isolation.
     The page is already flashing rooms of its own accord at this point —
     which is the whole point of the feature and exactly what makes an
     "is it still lit?" assertion unreliable if it is asked mid-trickle. */
  const quiet = await pg.waitForFunction(
    () => (window.__city.world.flashes?.size ?? 1) === 0, null, { timeout: 30000 },
  ).then(() => true).catch(() => false);
  check("the city does eventually settle, rather than staying lit", quiet);

  check("a room that exists can be flashed",
    await pg.evaluate(() => window.__city.world.flash("lobby", 0.8)));
  check("and a room that does not exist cannot",
    (await pg.evaluate(() => window.__city.world.flash("not-a-real-room-4f2c", 0.8))) === false);

  const lit = await pg.evaluate(() => window.__city.world.flashes?.get("lobby") ?? -1);
  check("the flash is being tracked", lit > 0.5, lit.toFixed(2));

  /* It must FADE. A pulse that stays on is a highlight, and a city of
     permanent highlights says nothing. */
  await pg.waitForTimeout(2400);
  const after = await pg.evaluate(() => window.__city.world.flashes?.get("lobby") ?? 0);
  check("and it fades out on its own", after === 0 || after < 0.5, String(after));

  /* The staggered release. One poll's worth of activity arrives as a lump;
     what the city must do is spend it across the window. Sampled per second,
     a lump is one bucket with everything in it. */
  bump = 12;                                   // every room moved
  const spread = await pg.evaluate(async () => {
    const counts = [];
    let n = 0;
    const l = window.__city.world.life;
    const orig = l.signal.bind(l);
    l.signal = (...a) => { n++; return orig(...a); };
    /* No "poll now" export exists, and adding one for a test would be
       adding an API to the page for the test's convenience. The page
       already re-polls when a hidden tab comes back, which is the same
       code path a scheduled poll takes. */
    document.dispatchEvent(new Event("visibilitychange"));
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      counts.push(n); n = 0;
    }
    l.signal = orig;
    return counts;
  });
  const total = spread.reduce((a, b) => a + b, 0);
  const buckets = spread.filter((c) => c > 0).length;
  const biggest = Math.max(...spread);
  check("a directory that moved everywhere does produce signals", total > 0, spread.join(","));
  check("and they are spread over seconds, not fired in one lump",
    buckets >= 3, `${buckets} of 8 seconds had activity`);
  check("no single second carries most of the burst",
    total === 0 || biggest <= Math.ceil(total * 0.7), `biggest ${biggest} of ${total}`);
  check("no page errors", errs.length === 0, errs[0] || "");
  await ctx.close();
}

console.log(bad ? `\n${bad} FAILURE(S)` : "\nall good");
await browser.close(); srv.close();
process.exit(bad ? 1 : 0);

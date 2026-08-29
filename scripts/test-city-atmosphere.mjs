/* Agent City: the page, the readouts, and the sound of the data.
 *
 * Each section is a claim that is easy to *appear* to have satisfied:
 *
 *   A. THE PAGE HAS NO BACKGROUND OF ITS OWN. Checking that a CSS rule was
 *      deleted proves nothing. What matters is that the canvas is genuinely
 *      transparent, the renderer clears with no alpha, and the ground is the
 *      SAME ground another page on this site is standing on.
 *   B. THE ROOM HEADER SITS LEFT, UNDER ITS OWN SPACE, and the room is on
 *      that same ground rather than under a plate of its own.
 *   C. THE CITY IS READABLE FROM OUTSIDE. A count over a building and a rail
 *      of the busiest rooms. The number must be the delta the directory
 *      actually reported, the rail must rank on a measured rate, and the
 *      lines in it must be real messages rendered as text.
 *   D. THE CITY PULSES WITH THE DATA, AND ONLY WITH THE DATA. A flash is a
 *      claim that a message arrived. It must be spendable only by real
 *      movement, it must fade, and a poll's worth of activity must be spread
 *      across the window rather than fired in one lump.
 *   E. NOTHING PLAYS THAT IS NOT A READING. The music is gone. What is left
 *      is caused by data — a tick per arrival, a tone that tracks the city's
 *      rate and goes silent when the city is idle — and by your own actions.
 *      The test that matters most here is the negative one: an idle city
 *      makes no sound at all.
 *   F. THE THINGS THAT WERE BROKEN. The feed's close button, the room
 *      panel's actions being pushed below the fold by a long list, and a
 *      pasted did:key that answered into a box its own click was about to
 *      hide.
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
let bump = 0, MODE = "live";
const directory = () => {
  const now = new Date().toISOString();
  const step = (r) => ({ ...r, last_seq: r.last_seq == null ? null : String(Number(r.last_seq) + bump) });
  const live = MODE === "live";
  return { ...SNAP, source: MODE,
    retrieved_at: live ? now : SNAP.retrieved_at, at: live ? now : SNAP.retrieved_at,
    age_seconds: live ? 0 : 172800,
    landmarks: SNAP.landmarks.map(step), named: SNAP.named.map(step) };
};

/* Two deliberately awkward messages, because the rail renders somebody
   else's words and the only interesting question about that is whether it
   can be made to render them as anything but text. */
const HOSTILE = '<script>window.__pwned=1</script> and <b>bold</b>';
/* HOSTILE goes LAST, because the rail shows a room's NEWEST line and a
   dangerous string parked behind a harmless one is never actually rendered —
   which is a test that passes without testing anything. */
const LINES = ["ATTEST v1|j-8801|useful|rh:9fa31c", HOSTILE];

const room = (name, since) => {
  const from = Math.max(0, Number(since) || 0);
  return {
    ok: true, room: name, source: "live", retrieved_at: new Date().toISOString(),
    age_seconds: 0,
    messages: from > 0 ? LINES.map((text, i) => ({
      seq: String(from + i + 1), ts: new Date().toISOString(),
      from: "did:key:z6MkTest" + i, nick: null, text, sig: "sig", nonce: null,
    })) : [],
    first_seq: "1", last_seq: String(from + LINES.length), next: String(from + LINES.length),
  };
};

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let p = u.pathname;
  if (p === "/city") p = "/city.html";
  if (p === "/api/city") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(directory()));
  }
  if (p === "/api/room") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(
      room(u.searchParams.get("room") || "lobby", u.searchParams.get("since"))));
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
   C. THE CITY IS READABLE FROM OUTSIDE
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== C. what is happening in there, read from out here");
{
  const { pg, ctx, errs } = await open();
  bump = 14;                                   // every room moved
  await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await pg.waitForTimeout(2200);
  bump = 31;
  await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  /* Long enough for the staggered release to put several counts up and for
     the peek budget to fetch at least one line. */
  await pg.waitForTimeout(9000);

  /* ── the counts over the buildings ── */
  const t = await pg.evaluate(() => {
    const ns = [...document.querySelectorAll(".tally")];
    return {
      n: ns.length,
      /* The count and its noun are separate nodes now — the noun is there so
         a bare "+4" is not a number with no unit. Read the figure only. */
      labels: ns.map((e) => e.querySelector("b").firstChild.textContent),
      nouns: ns.map((e) => e.querySelector("b i")?.textContent ?? null),
      titles: ns.map((e) => e.querySelector(".box")?.title ?? ""),
      rooms: ns.map((e) => e.querySelector("span").textContent),
      positioned: ns.every((e) => /translate/.test(e.style.transform)),
    };
  });
  check("counts appear over the buildings that moved", t.n > 0, `${t.n} on screen`);
  check("every one of them is a real number", t.labels.every((l) => /^\+[\d,]+$/.test(l)), t.labels.join(" "));
  check("and names the room it belongs to",
    t.rooms.every((r) => typeof r === "string" && r.length > 0), t.rooms.slice(0, 3).join(","));
  check("each is placed on the building, not parked at the origin", t.positioned);
  check("and they are capped rather than unbounded", t.n <= 8, `${t.n}`);
  /* "+4" over a building is a number with no noun, and the question it
     earned was exactly that: what? */
  check("each one says what it is counting",
    t.nouns.every((n) => n === "messages" || n === "message"), t.nouns.slice(0, 3).join(","));
  check("and spells it out in full on hover, room and all",
    t.titles.every((x) => /message/.test(x) && /since the last reading/.test(x)),
    t.titles[0]?.slice(0, 54) || "");

  /* THE NUMBER MUST BE THE DELTA, NOT A DECORATION. The directory moved every
     room by 17 between the two readings above, so a count that says anything
     else is inventing. */
  const named = await pg.evaluate(() => window.__city.city.roster.map((r) => r.room));
  void named;
  check("the number is the delta the directory reported",
    t.labels.every((l) => Number(l.replace(/[+,]/g, "")) === 17), t.labels.join(" "));

  /* ── the busiest-now rail ── */
  const rail = await pg.evaluate(() => {
    const box = document.getElementById("rail");
    const rows = [...box.querySelectorAll(".railrow")];
    return {
      hidden: box.hidden,
      n: rows.length,
      names: rows.map((r) => r.querySelector(".nm").textContent),
      rates: rows.map((r) => r.querySelector(".rt").textContent),
      fills: rows.map((r) => r.querySelector(".rt").style.getPropertyValue("--fill")),
      glyphs: rows.map((r) => r.querySelector(".g")?.dataset.kind ?? null),
      sparks: rows.filter((r) => r.querySelector(".sp .spark")).length,
      lines: rows.map((r) => r.querySelector(".ln")?.textContent || null).filter(Boolean),
      live: box.querySelector(".railtop .live").textContent,
      unit: box.querySelector(".railtop .u")?.textContent ?? "",
      unitsInRows: rows.filter((r) => /msg|min/i.test(r.textContent)).length,
      note: box.querySelector(".railtop").title,
      html: box.innerHTML,
    };
  });
  check("the rail is up", !rail.hidden);
  check("and holds a few rooms, not a directory", rail.n > 0 && rail.n <= 4, `${rail.n} rows`);
  check("every row names a room the city actually has",
    rail.names.every((n) => named.includes(n)), rail.names.join(","));
  /* THE RATE IS A BARE NUMBER, and the unit is written once above the column
     rather than four times down it. Four rows each carrying "msg/min" is the
     same fact four times, in the place with the least room for it. */
  check("every row carries a rate as a bare number",
    rail.rates.every((r) => /^[\d.,]+$/.test(r.trim())), rail.rates.join(" "));
  check("the unit is stated once, over the column", /msg\/min/i.test(rail.unit), rail.unit);
  check("and not repeated in any row", rail.unitsInRows === 0, `${rail.unitsInRows} rows repeat it`);
  check("the rate is drawn as a shape as well as a number",
    rail.fills.every((f) => /%$/.test(f)), rail.fills.join(" "));
  /* WHAT THE ROOM IS DOING, AS A GLYPH. Every one must be a verb the kibble
     spec actually defines, or plain message — never a category invented here. */
  const VERBS = ["job", "claim", "result", "attest", "witness", "hello", "message"];
  check("each row carries a glyph for what the room is doing",
    rail.glyphs.every((g) => VERBS.includes(g)), rail.glyphs.join(","));
  check("and a sparkline once there is history to draw",
    rail.sparks > 0, `${rail.sparks} of ${rail.n}`);
  check("the rail says whether it is live", /live|saved/i.test(rail.live), rail.live);
  /* The provenance moved off the face of the panel and into its tooltip. It
     still has to be there — a measured figure that does not say it was
     measured here is the overclaim this whole page exists to avoid. */
  check("and still says where its numbers come from",
    /measured in this browser/i.test(rail.note), rail.note.slice(0, 46));

  /* THE LINES ARE REAL MESSAGES AND ARE TEXT. The fixture serves a message
     containing a script tag; if any of this were ever set as HTML rather than
     as a text node, the tag would be in the DOM. */
  check("at least one room's newest line was read", rail.lines.length > 0, `${rail.lines.length} lines`);
  check("the hostile line is the one on screen, so this is really being tested",
    rail.lines.some((l) => l.includes("<script>")), rail.lines[0]?.slice(0, 46) || "");
  check("it is rendered as characters, not parsed as markup",
    !/<script/i.test(rail.html) && !/<b>bold<\/b>/i.test(rail.html));
  check("and nothing in it executed",
    (await pg.evaluate(() => window.__pwned)) === undefined);

  /* Clicking a row goes to that room rather than doing nothing. */
  const target = rail.names[0];
  const camBefore = await pg.evaluate(() => Math.round(window.__city.cam.target.x * 10));
  await pg.click("#rail .railrow");
  await pg.waitForTimeout(1400);
  const camAfter = await pg.evaluate(() => Math.round(window.__city.cam.target.x * 10));
  check("clicking a row takes you there", camBefore !== camAfter, `${target}: ${camBefore} → ${camAfter}`);

  check("no page errors", errs.length === 0, errs[0] || "");
  bump = 0;
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

/* ════════════════════════════════════════════════════════════════════════
   E. NOTHING PLAYS THAT IS NOT A READING
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== E. the sound is data, and an idle city is silent");
{
  const { pg, ctx, errs } = await open();

  /* Count oscillators for real. What a module says about itself is an
     opinion; an OscillatorNode being constructed is a fact. */
  await pg.evaluate(() => {
    window.__osc = 0;
    const orig = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () { window.__osc++; return orig.call(this); };
  });

  check("the music engine is gone, not merely switched off",
    await pg.evaluate(() => window.__city.sound.musicOn === undefined
      && window.__city.sound.musicPlaying === undefined));

  await pg.click("#mute");                                   // a real gesture
  await pg.waitForTimeout(400);
  check("sound switches on", await pg.evaluate(() => window.__city.sound.enabled()));

  /* THE NEGATIVE TEST, AND THE IMPORTANT ONE. Nothing has moved: bump is 0,
     every room reads the same sequence number it did last time. A page with
     a soundtrack would be playing. This one must not be making a sound at
     all — not a quiet one, none. */
  await pg.evaluate(() => { window.__osc = 0; });
  await pg.waitForTimeout(3000);
  const idle = await pg.evaluate(() => ({ osc: window.__osc, tone: window.__city.sound.toneRunning() }));
  check("an idle city plays nothing at all", idle.osc === 0, `${idle.osc} oscillators`);
  check("and runs no tone, rather than an inaudible one", !idle.tone);

  /* Now the network moves, and the same silence must break — caused by the
     data and by nothing else. */
  bump = 26;
  await pg.evaluate(() => { window.__osc = 0; });
  await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await pg.waitForTimeout(6000);
  const busy = await pg.evaluate(() => ({ osc: window.__osc, tone: window.__city.sound.toneRunning() }));
  check("a city that moved does make a sound", busy.osc > 0, `${busy.osc} oscillators`);
  check("and the tone comes up with it", busy.tone);

  /* The cap. A burst must not become a machine gun. */
  await pg.evaluate(() => { window.__osc = 0; });
  await pg.evaluate(() => {
    for (let i = 0; i < 300; i++) window.__city.sound.tick(i, "message", "lobby");
  });
  await pg.waitForTimeout(200);
  const burst = await pg.evaluate(() => window.__osc);
  check("three hundred messages in one instant do not make three hundred sounds",
    burst <= 8, `${burst} oscillators`);

  /* Entering a room stops the CITY's tone: it is a number about somewhere you
     are not, and in here it would play over the ticks of the room you are
     actually in. */
  await pg.evaluate(() => window.__city.enterRoom("lobby"));
  await pg.waitForFunction(() => document.body.classList.contains("inroom"), null, { timeout: 20000 });
  await pg.waitForTimeout(900);
  check("the city tone stops at the door",
    !(await pg.evaluate(() => window.__city.sound.toneRunning())));

  /* Muting must tear the tone down rather than turn it down — a tone left
     running behind a zeroed master is battery spent on being inaudible. */
  await pg.evaluate(() => window.__city.leaveRoom());
  await pg.waitForFunction(() => !document.body.classList.contains("inroom"), null, { timeout: 20000 });
  await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await pg.waitForTimeout(2500);
  await pg.click("#mute");
  await pg.waitForTimeout(500);
  check("muting tears the tone down, it does not just turn it down",
    !(await pg.evaluate(() => window.__city.sound.toneRunning())));
  check("no page errors", errs.length === 0, errs[0] || "");
  bump = 0;
  await ctx.close();
}

/* ════════════════════════════════════════════════════════════════════════
   E2. THE AIR DOES NOT BEAT
   ════════════════════════════════════════════════════════════════════════

   Reported as "womp type background sound, unbearable", and it was exactly
   that: two sines detuned by 0.8%, which at 146Hz is a 1.2Hz amplitude beat.
   Two oscillators only beat when their frequencies differ slightly, so the
   property to assert is not "it sounds nicer" — it is that the tone's
   partials are EXACT ratios of its root. That is checkable, and it is the
   thing that was wrong.
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== E2. the air is a chord, not a beat");
{
  const { pg, ctx, errs } = await open();
  await pg.click("#mute");
  bump = 40;
  await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await pg.waitForFunction(() => window.__city.sound.toneRunning(), null, { timeout: 20000 })
    .catch(() => {});

  /* Two oscillators beat when their frequencies differ slightly, so the
     property to read is what the air ASKS FOR.

     THE CONTINUOUS VOICES ONLY. The first version of this shim caught every
     oscillator built during the window, which in a live city includes the
     ticks — and a tick is a struck note that glides slightly flat as it
     decays, so two of them landing on the same room's note are momentarily a
     few tenths of a Hz apart. That is not a drone and cannot womp: it is over
     in under a second. The air's voices are the ones that are never given a
     stop time, which is exactly the distinction that matters here. */
  const pairs = await pg.evaluate(async () => {
    const seen = [];
    const origMake = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      const o = origMake.call(this);
      const rec = { o, hz: 0, stops: false };
      const origStop = o.stop.bind(o);
      o.stop = (...a) => { rec.stops = true; return origStop(...a); };
      seen.push(rec);
      return o;
    };
    window.__city.sound.cityToneOff();
    window.__city.sound.cityTone(9000);
    /* Read the frequency immediately: a struck note glides, and what is being
       asked here is what each voice was BUILT at. */
    for (const r of seen) r.hz = Math.round(r.o.frequency.value * 100) / 100;
    await new Promise((res) => setTimeout(res, 250));
    AudioContext.prototype.createOscillator = origMake;
    return seen.filter((r) => !r.stops).map((r) => r.hz);
  });

  check("the air is built from more than one voice", pairs.length >= 2, pairs.join(","));
  /* Every pair must be either identical or far enough apart that the
     difference is a musical interval rather than a beat. Under ~12Hz apart
     and the ear hears amplitude wobble instead of a chord. */
  const beats = [];
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const d = Math.abs(pairs[i] - pairs[j]);
      if (d > 0.01 && d < 12) beats.push(`${pairs[i]}/${pairs[j]}`);
    }
  }
  check("and no two of them beat against each other", beats.length === 0,
    beats.length ? beats.join(" ") : pairs.join(","));
  /* Exact ratios, which is what makes the above true by construction rather
     than by luck: a fifth is 1.5 and an octave is 2, to the cent. */
  const root = Math.min(...pairs);
  const ratios = pairs.map((f) => Math.round((f / root) * 1000) / 1000).sort();
  check("they are exact intervals of one root", ratios.every((r) => {
    const near = [1, 1.5, 2, 3, 4];
    return near.some((n) => Math.abs(r - n) < 0.005);
  }), ratios.join(","));

  check("no page errors", errs.length === 0, errs[0] || "");
  bump = 0;
  await ctx.close();
}

/* ════════════════════════════════════════════════════════════════════════
   E3. THE FIRST LIVE READING IS A BASELINE, NOT A FLOOD
   ════════════════════════════════════════════════════════════════════════

   Reported as "starts very quiet, then once data loads it becomes ultra
   noisy". The cause was not the sound. The page seeds itself from an
   archived snapshot so a city is on screen instantly, and that snapshot's
   sequence numbers can be days old — so the first live reading was diffed
   against them and the delta was the whole weekend's traffic. Every room at
   once, counts in the tens of thousands, the signal pool saturated.

   We did not watch those messages arrive, so they are not arrivals. This is
   the honesty rule and the fix for the noise, and they are the same rule.
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== E3. arriving from the archive is not a burst of activity");
{
  MODE = "snapshot";
  const { pg, ctx, errs } = await open();
  check("the city is up from saved data", await pg.evaluate(() => window.__city.city.roster.length > 0));
  check("and nothing is animating off it",
    (await pg.evaluate(() => window.__city.world.life.liveSignals)) === 0);

  /* Now the live directory answers, and it is a long way ahead of the file —
     which is exactly what a real first reading looks like. */
  MODE = "live";
  bump = 9000;
  let count = 0;
  await pg.exposeFunction("__sig", () => { count++; });
  await pg.evaluate(() => {
    const l = window.__city.world.life;
    const orig = l.signal.bind(l);
    l.signal = (...a) => { window.__sig(); return orig(...a); };
  });
  await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await pg.waitForFunction(() => window.__city.data.state.status.source === "live",
    null, { timeout: 20000 }).catch(() => {});
  await pg.waitForTimeout(5000);

  check("the first live reading produces no arrivals at all", count === 0, `${count} signals`);
  check("and no counts over the buildings",
    (await pg.evaluate(() => document.querySelectorAll(".tally").length)) === 0);
  check("the chip says live, so this is not just a failed poll",
    /^Live$/i.test((await pg.evaluate(() => document.getElementById("status").innerText)).trim()));

  /* The SECOND live reading is a genuine observation and must behave
     normally — the baseline rule must not have switched the city off. */
  bump = 9014;
  await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await pg.waitForTimeout(5000);
  check("the next reading does move the city", count > 0, `${count} signals`);
  const labels = await pg.evaluate(() =>
    [...document.querySelectorAll(".tally b")].map((b) => b.firstChild.textContent));
  check("and its counts are the real delta, not the gap to the archive",
    labels.every((l) => Number(l.replace(/[+,]/g, "")) === 14), labels.join(" ") || "(none yet)");

  check("no page errors", errs.length === 0, errs[0] || "");
  bump = 0;
  await ctx.close();
}

/* ════════════════════════════════════════════════════════════════════════
   F. THE THINGS THAT WERE BROKEN
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== F. the three that did not work");
{
  const { pg, ctx, errs } = await open();

  /* 1. THE FEED IS THE ROOM PANEL, NOT A SECOND WINDOW.
        It used to be a full-height drawer pinned to the opposite side of the
        screen, so pressing "Room feed" opened a large new panel across the
        city while the one holding the button stayed put — two panels to read
        at once. It takes over the same card now: same place, same width,
        with a back arrow to the room. */
  await pg.evaluate(() => window.__city.enterRoom("lobby"));
  await pg.waitForFunction(() => document.body.classList.contains("inroom"), null, { timeout: 20000 });
  await pg.waitForTimeout(1200);
  const boxOf = () => pg.evaluate(() => {
    const r = document.getElementById("side").getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.width)].join("x");
  });
  const before = await boxOf();
  await pg.evaluate(() => document.querySelector("#side .prow .go").click());
  await pg.waitForTimeout(700);
  check("the room feed opens", await pg.evaluate(() => !!document.querySelector("#side #flist")));
  check("in the same panel, same size and place", (await boxOf()) === before, `${before} → ${await boxOf()}`);
  check("and there is no second window anywhere",
    await pg.evaluate(() => !document.getElementById("feedpane")));
  check("with a way BACK rather than a way to shut everything",
    await pg.evaluate(() => !!document.querySelector("#side .pback")));

  /* IT MUST SURVIVE THE NEXT POLL. The room repaints its own summary into
     this element every few seconds; before the feed shared the element that
     was fine, and after it, it wiped the feed a moment after it opened. */
  await pg.waitForTimeout(5000);
  check("and it is still there after the room polls again",
    await pg.evaluate(() => !!document.querySelector("#side #flist")));

  await pg.evaluate(() => document.querySelector("#side .pback").click());
  await pg.waitForTimeout(500);
  check("back returns to the room, not to nothing",
    await pg.evaluate(() => !!document.querySelector("#side .rowlist")
      && !document.querySelector("#side #flist")));
  check("without shutting the panel", !(await pg.evaluate(() => document.getElementById("side").hidden)));

  /* 2. THE ACTIONS STAY ABOVE THE LIST. With forty identities the panel used
        to push "Room feed" and "Back to the city" below the fold — the more
        there was to look at, the harder it was to leave. */
  const panel = await pg.evaluate(() => {
    const side = document.getElementById("side").getBoundingClientRect();
    const btns = [...document.querySelectorAll("#side .prow.pinned .go")].map((b) => b.getBoundingClientRect());
    const list = document.querySelector("#side .rowlist");
    const lr = list?.getBoundingClientRect();
    return {
      n: btns.length,
      tops: btns.map((b) => Math.round(b.top)),
      bottoms: btns.map((b) => Math.round(b.bottom)),
      listTop: lr ? Math.round(lr.top) : null,
      sideBottom: Math.round(side.bottom),
      listScrolls: list ? getComputedStyle(list).overflowY : null,
    };
  });
  check("both actions are present", panel.n === 2, `${panel.n}`);
  check("they sit on one row, not stacked", panel.tops[0] === panel.tops[1], panel.tops.join(","));
  check("above the identity list", Math.max(...panel.bottoms) <= panel.listTop + 1,
    `${Math.max(...panel.bottoms)} vs ${panel.listTop}`);
  check("inside the panel, not below its bottom edge",
    Math.max(...panel.bottoms) < panel.sideBottom, `${Math.max(...panel.bottoms)} < ${panel.sideBottom}`);
  check("and the list is what scrolls", panel.listScrolls === "auto" || panel.listScrolls === "scroll",
    panel.listScrolls);

  /* 3. THE AUTO-TOUR IS GONE, AND LEFT NOTHING BEHIND — including the second
        entry point on the legend card, which outlived the first removal and
        sat there calling a handler that no longer existed. */
  check("no auto-play control", await pg.evaluate(() => !document.getElementById("tour")));
  check("and no dead state where it used to be",
    await pg.evaluate(() => window.__city.state.tour === undefined));
  await pg.evaluate(() => document.getElementById("legend").click());
  await pg.waitForTimeout(400);
  check("and the legend does not offer it either",
    !/take the tour/i.test(await pg.evaluate(() => document.getElementById("side").innerText)));

  /* 4. THE TWO CONTROLS THAT DID NOTHING USEFUL. */
  check("no speech-bubble toggle", await pg.evaluate(() => !document.getElementById("bubbles")));
  check("no Hide button on the activity strip",
    await pg.evaluate(() => !document.getElementById("hideStrip")));

  check("no page errors", errs.length === 0, errs[0] || "");
  await ctx.close();
}

/* ════════════════════════════════════════════════════════════════════════
   G. TRANSMISSIONS, AND WHERE EACH ONE BELONGS
   ════════════════════════════════════════════════════════════════════════

   Two contexts, deliberately separated:

     IN A ROOM the messages are attached to the agents that sent them —
     world-anchored cards on tethers, which is only meaningful where the
     bodies are. No global feed here: it would be the same activity written
     twice beside the plaza it is already happening on.

     IN THE CITY there are no bodies, so there is a compact global feed
     instead — and there the room NAME is the useful part.

   The interesting assertions are the negative ones: the feed must not be in
   a room, the cards must not be in the city, and neither may ever show a
   message the page did not actually read.
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== G. transmissions in the room, a feed in the city");
{
  const { pg, ctx, errs } = await open();
  bump = 18;
  await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await pg.waitForTimeout(2500);
  bump = 37;
  await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  /* Long enough for the peek rotation to have read a couple of rooms. */
  await pg.waitForTimeout(11000);

  /* ── the city: a global feed ── */
  check("the city offers a live feed", !(await pg.evaluate(() => document.getElementById("live").hidden)));
  check("collapsed to a pill until asked",
    await pg.evaluate(() => document.getElementById("liveBody").hidden));
  await pg.click("#livePill");
  await pg.waitForTimeout(400);

  const feed = await pg.evaluate(() => {
    const rows = [...document.querySelectorAll("#liveBody .liverow")];
    return {
      n: rows.length,
      rooms: rows.map((r) => r.querySelector(".rm")?.textContent ?? ""),
      note: document.querySelector("#liveBody .livenote")?.textContent ?? "",
      html: document.getElementById("liveBody").innerHTML,
    };
  });
  check("it lists what has been read", feed.n > 0 && feed.n <= 3, `${feed.n} rows`);
  /* THE ROOM NAME IS THE POINT OF THIS PANEL. In the city there are no
     bodies to attach a message to, so "which room" is the only spatial fact
     a line can carry. */
  check("and every line names its room",
    feed.rooms.every((r) => /^in \S+/.test(r.trim())), feed.rooms.join(" | "));
  /* AND IT DOES NOT OVERCLAIM. This is the newest line from the handful of
     rooms the city peeks, not every message on Technocore, and the panel has
     to say which it is. */
  check("it says what it is and is not",
    /each room the city is watching/i.test(feed.note), feed.note.slice(0, 48));
  check("a stranger's words are still text, never markup",
    !/<script/i.test(feed.html) && (await pg.evaluate(() => window.__pwned)) === undefined);

  /* Clicking a line goes to the room it came from. */
  const target = (feed.rooms[0] || "").replace(/^in\s+/, "").trim();
  await pg.click("#liveBody .liverow");
  await pg.waitForFunction(() => document.body.classList.contains("inroom"), null, { timeout: 20000 });
  check("clicking a line walks into that room",
    (await pg.evaluate(() => window.__city.state.room)) === target,
    `${await pg.evaluate(() => window.__city.state.room)} vs ${target}`);

  /* ── in the room: cards, not a feed ── */
  check("and the global feed is not shown in there",
    await pg.evaluate(() => document.getElementById("live").hidden));

  await pg.waitForTimeout(6500);
  const tx = await pg.evaluate(() => {
    const cards = [...document.querySelectorAll(".tx")];
    const shown = cards.filter((c) => c.style.display !== "none");
    const paths = [...document.querySelectorAll(".tether")]
      .filter((p) => (p.getAttribute("d") || "").length > 3);
    return {
      pool: cards.length,
      live: window.__city.tx?.shown ?? -1,
      tethers: paths.length,
      anchored: shown.every((c) => /translate3d/.test(c.style.transform)),
      svgs: document.querySelectorAll("svg.tethers").length,
      xy: shown.map((c) => c.style.transform),
    };
  });
  check("messages arrive as cards attached to their agent", tx.live > 0, `${tx.live} live`);
  /* THREE, POOLED. Not three created and destroyed — three elements, reused
     forever. A fourth message takes the oldest slot. */
  check("out of a pool of exactly three elements", tx.pool === 3, `${tx.pool}`);
  check("never more than three at once", tx.live <= 3, `${tx.live}`);
  check("each one tethered to a body", tx.tethers >= tx.live, `${tx.tethers} tethers`);
  /* ONE SVG FOR ALL OF THEM, not one per card. */
  check("through a single shared overlay", tx.svgs === 1, `${tx.svgs} svg roots`);
  check("positioned by transform, so nothing reflows", tx.anchored);

  /* WORLD-ANCHORED IS THE WHOLE CLAIM: move the camera, and the cards move
     with the agents they belong to. */
  const before = await pg.evaluate(() =>
    [...document.querySelectorAll(".tx")].map((c) => c.style.transform).join("|"));
  await pg.evaluate(() => window.__city.roomCam.flyTo({ dist: 58, yaw: 1.5 }, 500));
  await pg.waitForTimeout(1500);
  const after = await pg.evaluate(() =>
    [...document.querySelectorAll(".tx")].map((c) => c.style.transform).join("|"));
  check("and they follow the camera, because they are anchored in the world",
    before !== after, `${before.slice(0, 30)} → ${after.slice(0, 30)}`);

  check("no page errors", errs.length === 0, errs[0] || "");
  bump = 0;
  await ctx.close();
}

console.log(bad ? `\n${bad} FAILURE(S)` : "\nall good");
await browser.close(); srv.close();
process.exit(bad ? 1 : 0);

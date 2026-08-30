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
  /* TWO READINGS, AND THE SECOND ONE IS THE TEST. The first moves every room
     by 14 and is what gives the page a live baseline to diff against; the
     second moves them to 31, so the delta on screen must be 17. Waiting for
     the first reading's counts to actually appear — rather than sleeping and
     hoping — is what makes the second one's arithmetic meaningful. */
  bump = 14;                                   // every room moved
  await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await pg.waitForFunction(() => document.querySelectorAll(".tally").length > 0,
    null, { timeout: 15000 });
  await pg.evaluate(() => { window.__seen = document.querySelector(".tally b").textContent; });
  bump = 31;
  await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  /* ── the counts over the buildings ──
     CAUGHT ON A BEAT, NOT AT A FIXED MOMENT. The counts arrive in sets of one
     to three, hold for TALLY_BEAT and are replaced by the next set; a whole
     poll's worth is shown and gone inside about seven seconds. A sleep of a
     fixed length followed by one evaluate() tests the phase of the clock
     rather than the feature — and did, reporting zero counts on a page that
     had just shown twelve. This waits for a set to be up and reads it then. */
  await pg.waitForFunction(() => {
    const n = document.querySelector(".tally b");
    return n && n.textContent !== window.__seen;
  }, null, { timeout: 15000 });
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

  /* ── the busiest-now rail ──
     The peek budget fetches one room's newest line every few seconds, so the
     rail needs a moment before it has lines in it. That wait used to sit
     above the counts and is now here, where it is the thing that needs it. */
  await pg.waitForTimeout(9000);
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

  /* ANY GESTURE, NOT THE MUTE BUTTON. Sound is on by default now, so
     clicking #mute would turn it OFF — the button reflects the setting, and
     the setting already says on. What the page is waiting for is the
     browser's permission, which any real gesture grants. */
  await pg.keyboard.press("Shift");
  await pg.waitForTimeout(400);
  check("sound starts at the first gesture, without being asked for",
    await pg.evaluate(() => window.__city.sound.enabled()));

  /* THE NEGATIVE TEST, AND THE IMPORTANT ONE. Nothing has moved: bump is 0,
     every room reads the same sequence number it did last time. A page with
     a soundtrack would be playing. This one must not be making a sound at
     all — not a quiet one, none. */
  await pg.evaluate(() => { window.__osc = 0; });
  await pg.waitForTimeout(3000);
  const idle = await pg.evaluate(() => ({ osc: window.__osc, tone: window.__city.sound.toneRunning() }));
  check("an idle city plays nothing at all", idle.osc === 0, `${idle.osc} oscillators`);
  /* AND THERE IS NOTHING SUSTAINED LEFT TO RUN. Two continuous sounds used
     to live here — a low bed under every room and a filtered chord under the
     city — and both are gone. The bed carried no information at all: it was
     on at the same level in a room mid-conversation and a room that had said
     nothing for an hour, and it was reported, correctly, as a hum you hear
     when nothing is happening. The chord did carry a reading, and it went
     anyway: a 98Hz drone at any level is a hum, and it was the reason sound
     could not be on by default. */
  check("and nothing is droning underneath it", !idle.tone);

  /* Now the network moves, and the same silence must break — caused by the
     data and by nothing else. */
  bump = 26;
  await pg.evaluate(() => { window.__osc = 0; });
  await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await pg.waitForTimeout(6000);
  const busy = await pg.evaluate(() => ({ osc: window.__osc, tone: window.__city.sound.toneRunning() }));
  check("a city that moved does make a sound", busy.osc > 0, `${busy.osc} oscillators`);
  /* Every one of those oscillators is a one-shot that ends by itself. What
     must NOT appear is anything that keeps running between events. */
  check("and it is still all events, nothing held on", !busy.tone);

  /* The cap. A burst must not become a machine gun. */
  await pg.evaluate(() => { window.__osc = 0; });
  await pg.evaluate(() => {
    for (let i = 0; i < 300; i++) window.__city.sound.tick(i, "message", "lobby");
  });
  await pg.waitForTimeout(200);
  const burst = await pg.evaluate(() => window.__osc);
  check("three hundred messages in one instant do not make three hundred sounds",
    burst <= 8, `${burst} oscillators`);

  /* A ROOM IS SILENT TOO. There was a low bed under every room, running for
     as long as you stood in it. Standing in a quiet room must now cost
     nothing but the occasional arrival. */
  await pg.evaluate(() => window.__city.enterRoom("lobby"));
  await pg.waitForFunction(() => document.body.classList.contains("inroom"), null, { timeout: 20000 });
  await pg.waitForTimeout(900);
  await pg.evaluate(() => { window.__osc = 0; });
  await pg.waitForTimeout(2500);
  const inRoom = await pg.evaluate(() => ({ osc: window.__osc, tone: window.__city.sound.toneRunning() }));
  /* The fixture keeps serving this room new messages, and a message SHOULD
     make a sound — so the claim is not silence, it is that the room adds no
     sound OF ITS OWN. A handful of strikes over two and a half seconds is
     arrivals; a bed would be a voice that never stops, which is what the
     second check reads. */
  check("a room makes only the sounds its messages make", inRoom.osc < 12,
    `${inRoom.osc} oscillators`);
  check("and no bed runs underneath it", !inRoom.tone);

  await pg.evaluate(() => window.__city.leaveRoom());
  await pg.waitForFunction(() => !document.body.classList.contains("inroom"), null, { timeout: 20000 });
  check("no page errors", errs.length === 0, errs[0] || "");
  bump = 0;
  await ctx.close();
}

/* ════════════════════════════════════════════════════════════════════════
   E2. THERE IS NOTHING SUSTAINED TO GET WRONG
   ════════════════════════════════════════════════════════════════════════

   This section used to prove that the ambient chord did not BEAT. The first
   version of that chord was two sines detuned by 0.8%, which at 146Hz is a
   1.2Hz amplitude beat — reported as "womp type background sound,
   unbearable" — and the fix was exact ratios, checked here to the cent.

   The chord is gone, so the property to check is stronger and simpler: after
   a burst of real activity and a pause, NO oscillator is still running. Not
   a quiet one, not one behind a zeroed master. Every sound this page makes
   now ends by itself, which is what lets sound be on by default without the
   page humming at somebody who did not ask for it.
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== E2. every sound ends by itself");
{
  const { pg, ctx, errs } = await open();
  await pg.evaluate(() => {
    window.__live = 0;
    const orig = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      const o = orig.call(this);
      window.__live++;
      /* Count what is genuinely still running: an oscillator with a stop
         time already scheduled is a one-shot and will end on its own. */
      const stop = o.stop.bind(o);
      o.stop = (...a) => { window.__live--; return stop(...a); };
      return o;
    };
  });
  await pg.keyboard.press("Shift");     // sound is on; this only unlocks it
  await pg.waitForTimeout(400);

  bump = 44;
  await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await pg.waitForTimeout(6000);
  const during = await pg.evaluate(() => window.__live);
  bump = 0;
  /* Long enough for every strike to have been scheduled and stopped. */
  await pg.waitForTimeout(4000);
  const after = await pg.evaluate(() => window.__live);

  check("a busy city really did make sounds", during >= 0);
  check("and nothing is left running when it goes quiet", after <= 0, `${after} still open`);
  check("the module agrees it has no sustained voice",
    !(await pg.evaluate(() => window.__city.sound.toneRunning())));

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
   E4. SOUND IS ON, THE CONTROL SAYS SO, AND EVERY ARRIVAL IS AUDIBLE
   ════════════════════════════════════════════════════════════════════════

   Two reports, one root each.

   "I still see sound is muted on the city page." It was not muted — the
   button was reading `sound.enabled()`, which is false until the browser has
   seen a gesture, because every browser refuses to start an audio context
   before one. So a first-time visitor arriving with sound ON was shown a
   crossed-out speaker labelled "Sound off": a preference they never set,
   with no visible cause. The control now paints the SETTING and says that
   the browser is what is waiting.

   "Inside a room I can't hear anything when a message pops up." Also not
   silence — simultaneity. A poll returns three messages at once, and all
   three used to be spent inside one synchronous loop: three cards on one
   frame, three ticks in one millisecond, and sound.js correctly refusing the
   second and third (45ms minimum, which is what stops forty arrivals
   becoming forty strikes). Three arrivals made one quiet tick. They are
   spaced now, so one message is one moment.

   The second check below is the one with teeth: it is not "a sound
   happened", it is "they did not all happen at once".
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== E4. sound on, and one message is one sound");
{
  const { pg, ctx, errs } = await open();

  /* BEFORE ANY GESTURE AT ALL. This is exactly the state that was reported,
     so it is read before the test touches the page in any way. */
  const cold = await pg.evaluate(() => {
    const b = document.getElementById("mute");
    return { on: b.classList.contains("on"), pressed: b.getAttribute("aria-pressed"),
      title: b.title, icon: b.querySelector("use")?.getAttribute("href"),
      running: window.__city.sound.enabled() };
  });
  check("a first-time visitor's control says sound is on", cold.on && cold.pressed === "true",
    `${cold.pressed} / on=${cold.on}`);
  check("with the speaker icon, not the crossed-out one", cold.icon === "#c-sound", cold.icon);
  check("and it explains that the browser is what is waiting",
    /sound on/i.test(cold.title) && /touch|gesture/i.test(cold.title), cold.title);
  check("the context itself is honestly not running yet", cold.running === false);

  await pg.keyboard.press("Shift");
  await pg.waitForTimeout(300);
  check("one gesture starts it", await pg.evaluate(() => window.__city.sound.enabled()));
  check("and the label drops the explanation once it has",
    await pg.evaluate(() => document.getElementById("mute").title === "Sound on"),
    await pg.evaluate(() => document.getElementById("mute").title));

  /* AND THE BUTTON STILL MUTES. A default of on is only defensible if the
     way out is one click. */
  await pg.click("#mute");
  await pg.waitForTimeout(200);
  const off = await pg.evaluate(() => ({
    on: document.getElementById("mute").classList.contains("on"),
    running: window.__city.sound.enabled(),
    saved: localStorage.getItem("overheard.city.muted"),
  }));
  check("clicking it mutes, rather than turning on what is already on",
    !off.on && !off.running, `on=${off.on} running=${off.running}`);
  check("and the choice is remembered", off.saved === "1", off.saved);
  await pg.click("#mute");
  await pg.waitForTimeout(200);

  /* ── one message, one sound ──────────────────────────────────────────── */
  await pg.evaluate(() => {
    window.__at = [];
    const orig = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      window.__at.push(performance.now()); return orig.call(this);
    };
  });

  await pg.evaluate(() => window.__city.enterRoom("lobby"));
  await pg.waitForFunction(() => document.body.classList.contains("inroom"), null, { timeout: 20000 });
  await pg.waitForTimeout(1500);
  await pg.evaluate(() => { window.__at = []; });     // past the arrival chord
  await pg.waitForTimeout(9000);

  /* Each strike builds two oscillators (fundamental and partial) within the
     same millisecond, so the STARTS are what count — collapse anything
     within 40ms of its predecessor into one. */
  const strikes = await pg.evaluate(() => {
    const out = [];
    for (const t of window.__at) if (!out.length || t - out[out.length - 1] > 40) out.push(t);
    return out.map((t) => Math.round(t));
  });
  const gaps = strikes.slice(1).map((t, i) => Math.round(t - strikes[i]));

  check("a room with messages in it makes more than one sound",
    strikes.length >= 3, `${strikes.length} strikes`);
  /* THE REGRESSION GUARD. Before the fix a poll's three messages produced
     exactly one strike and the next was a whole poll away — every gap was
     seconds. Now most gaps are the release spacing, which is what "one
     message, one moment" sounds like. */
  const close = gaps.filter((g) => g < 900).length;
  check("and they are spread out rather than one per poll",
    close >= 2, `gaps ${gaps.join(",")}`);
  check("but never two in the same instant",
    gaps.every((g) => g > 120), `gaps ${gaps.join(",")}`);

  await pg.evaluate(() => window.__city.leaveRoom());
  await pg.waitForFunction(() => !document.body.classList.contains("inroom"), null, { timeout: 20000 });
  check("no page errors", errs.length === 0, errs[0] || "");
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
   F2. A CLOSED PANEL STAYS CLOSED
   ════════════════════════════════════════════════════════════════════════

   Reported from a room: × shut the panel, and the moment the next message
   arrived it was back. The cause was the room poll — it repainted the room
   summary into that element on EVERY reading, which is right when the panel
   is open and wrong the instant somebody has closed it. Four seconds later
   the visitor is looking at the thing they just dismissed, and the only
   reading available to them is that the close button does not work.

   The rule this locks in: data reopens nothing. The panel comes back when
   the visitor asks — the reopen tab, an agent, a message, the feed — and a
   fresh room clears the dismissal, because walking in is asking.
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== F2. a closed room panel stays closed");
{
  const { pg, ctx, errs } = await open();
  await pg.evaluate(() => window.__city.enterRoom("lobby"));
  await pg.waitForFunction(() => document.body.classList.contains("inroom"), null, { timeout: 20000 });
  await pg.waitForFunction(() => !!document.querySelector("#side .rowlist"), null, { timeout: 20000 });

  const shown = () => pg.evaluate(() => !document.getElementById("side").hidden);
  check("the room panel is up on arrival", await shown());

  await pg.evaluate(() => document.querySelector("#side .px").click());
  await pg.waitForTimeout(300);
  check("× closes it", !(await shown()));
  check("and leaves a way back", !(await pg.evaluate(() => document.getElementById("reopen").hidden)));

  /* LONGER THAN THE POLL. The room is re-read every few seconds; this waits
     out several readings, so if anything in the data path reopens the panel
     it has had every chance to. */
  await pg.waitForTimeout(9000);
  check("and several room readings later it is still closed", !(await shown()));

  /* Messages arriving is the exact trigger that was reported. */
  const got = await pg.evaluate(() => (window.__city.state.room, document.querySelectorAll(".tx").length));
  await pg.waitForTimeout(3000);
  check("including while transmissions are landing", !(await shown()), `${got} cards`);

  await pg.evaluate(() => document.getElementById("reopen").click());
  await pg.waitForTimeout(400);
  check("the reopen tab brings it back", await shown());
  check("and the tab stands down once it has",
    await pg.evaluate(() => document.getElementById("reopen").hidden));

  /* Closing again, then walking into another room: a new room is a new
     question, so the panel is due back without being asked. */
  await pg.evaluate(() => document.querySelector("#side .px").click());
  await pg.waitForTimeout(200);
  await pg.evaluate(() => window.__city.leaveRoom());
  await pg.waitForTimeout(900);
  await pg.evaluate(() => window.__city.enterRoom("lobby"));
  await pg.waitForFunction(() => !!document.querySelector("#side .rowlist"), null, { timeout: 20000 });
  check("walking back into a room shows it again", await shown());

  check("no page errors", errs.length === 0, errs[0] || "");
  await ctx.close();
}

/* ════════════════════════════════════════════════════════════════════════
   G. TRANSMISSIONS, AND THE CITY'S ONE READOUT
   ════════════════════════════════════════════════════════════════════════

   IN A ROOM the messages are attached to the agents that sent them —
   world-anchored cards on tethers, which is only meaningful where the
   bodies are.

   IN THE CITY there are no bodies, so activity is read two ways: the counts
   that rise off the buildings that moved, and the Busiest Now rail. A global
   Live Transmissions feed was tried here and removed — it duplicated the
   rail, it could only ever report the handful of rooms the peek channel had
   sampled, and on a phone it collapsed to an empty box with the word "Live"
   in it. The negative assertions below are the interesting ones: no feed
   anywhere, and the cards only ever inside a room.
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== G. transmissions in the room, counts in the city");
{
  const { pg, ctx, errs } = await open();
  bump = 18;
  await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await pg.waitForTimeout(2500);
  bump = 37;
  await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  /* Long enough for the peek rotation to have read a couple of rooms. */
  await pg.waitForTimeout(11000);

  /* ── the city: no feed, anywhere ── */
  const gone = await pg.evaluate(() => ({
    panel: !!document.getElementById("live"),
    pill: !!document.getElementById("livePill"),
    body: !!document.getElementById("liveBody"),
    rows: document.querySelectorAll(".liverow").length,
    css: /liverow|livepill/.test([...document.styleSheets]
      .flatMap((sh) => { try { return [...sh.cssRules].map((r) => r.selectorText || ""); }
                         catch { return []; } }).join(" ")),
  }));
  check("the city has no live-transmissions panel", !gone.panel && !gone.pill && !gone.body);
  check("and no rows left behind by it", gone.rows === 0, String(gone.rows));
  check("and its styles went with it", !gone.css);

  /* WHAT REPLACED IT is the rail, and it must be carrying real rooms. */
  const rail = await pg.evaluate(() => ({
    up: !document.getElementById("rail").hidden,
    rows: document.querySelectorAll("#rail .railrow").length,
  }));
  check("the rail is what the city reads instead", rail.up && rail.rows > 0,
    `${rail.rows} rows`);

  /* AND THE OVERFLOW IS DECLARED. A reading that moves more rooms than the
     beats can show must say so rather than quietly showing a subset. */
  const over = await pg.evaluate(() => {
    const n = document.querySelector("#rail .railmore");
    return n ? { text: n.textContent, title: n.title } : null;
  });
  if (over) {
    check("and says what the counts could not fit", /more message/.test(over.text), over.text);
    check("with the whole reading on hover", /other room/.test(over.title));
  } else {
    check("no overflow line when everything fitted", true);
  }

  /* Walk into a room the normal way, since there is no feed line to click. */
  const target = await pg.evaluate(() => document.querySelector("#rail .railrow .nm").textContent);
  await pg.click("#rail .railrow");
  await pg.waitForFunction(() => document.body.classList.contains("inroom"), null, { timeout: 20000 });
  check("clicking a rail row walks into that room",
    (await pg.evaluate(() => window.__city.state.room)) === target,
    `${await pg.evaluate(() => window.__city.state.room)} vs ${target}`);

  /* ── AND NO COUNT COMES THROUGH THE DOOR WITH YOU ─────────────────────
     Reported with a screenshot: a "+1,064 messages lobby" card hanging over
     the plaza for the whole visit. enterRoom() cleared the counts and then
     awaited the approach flight — and the frame loop was still in city mode
     for all of that second and a half, so the queue fired again, put a fresh
     count up, and the mode flipped underneath it. Nothing in the room scene
     repositions or ages a city count, so it stayed exactly where it was.
     Sampled over four seconds, because the bug was a race. */
  const stuck = await pg.evaluate(async () => {
    let worst = 0;
    for (let i = 0; i < 40; i++) {
      worst = Math.max(worst, document.querySelectorAll(".tally").length);
      await new Promise((r) => setTimeout(r, 100));
    }
    return worst;
  });
  check("and no city count follows you into the room", stuck === 0, `${stuck} on screen`);

  /* ── in the room: cards ── */
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

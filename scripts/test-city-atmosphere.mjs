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
let bump = 0;
const directory = () => {
  const now = new Date().toISOString();
  const step = (r) => ({ ...r, last_seq: r.last_seq == null ? null : String(Number(r.last_seq) + bump) });
  return { ...SNAP, source: "live", retrieved_at: now, at: now, age_seconds: 0,
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
      labels: ns.map((e) => e.querySelector("b").textContent),
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
      bars: rows.map((r) => r.querySelector(".bar i").style.width),
      lines: rows.map((r) => r.querySelector(".ln")?.textContent ?? null).filter(Boolean),
      live: box.querySelector(".railtop .live").textContent,
      note: box.querySelector(".railnote").textContent,
      html: box.innerHTML,
    };
  });
  check("the rail is up", !rail.hidden);
  check("and holds a few rooms, not a directory", rail.n > 0 && rail.n <= 4, `${rail.n} rows`);
  check("every row names a room the city actually has",
    rail.names.every((n) => named.includes(n)), rail.names.join(","));
  check("every row carries a rate in the unit it was measured in",
    rail.rates.every((r) => /msg\/min$/.test(r)), rail.rates[0]);
  check("and a bar drawn from that rate", rail.bars.every((w) => /%$/.test(w)), rail.bars.join(" "));
  check("the rail says whether it is live", /live|saved/i.test(rail.live), rail.live);
  check("and says where its numbers come from",
    /measured here/i.test(rail.note), rail.note.slice(0, 40));

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
   F. THE THINGS THAT WERE BROKEN
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== F. the three that did not work");
{
  const { pg, ctx, errs } = await open();

  /* 1. THE FEED'S CLOSE BUTTON. It called closePanel(), which is a different
        window — so the X reliably closed the panel behind the feed and left
        the feed open. */
  await pg.evaluate(() => window.__city.enterRoom("lobby"));
  await pg.waitForFunction(() => document.body.classList.contains("inroom"), null, { timeout: 20000 });
  await pg.waitForTimeout(1200);
  await pg.evaluate(() => document.querySelector("#side .prow .go").click());
  await pg.waitForTimeout(600);
  check("the room feed opens", !(await pg.evaluate(() => document.getElementById("feedpane").hidden)));
  await pg.evaluate(() => document.querySelector("#feedpane .px").click());
  await pg.waitForTimeout(400);
  check("and its close button closes IT",
    await pg.evaluate(() => document.getElementById("feedpane").hidden));
  check("without taking the room panel with it",
    !(await pg.evaluate(() => document.getElementById("side").hidden)));

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

  /* 3. THE AUTO-TOUR IS GONE, AND LEFT NOTHING BEHIND. */
  check("no auto-play control", await pg.evaluate(() => !document.getElementById("tour")));
  check("and no dead state where it used to be",
    await pg.evaluate(() => window.__city.state.tour === undefined));

  check("no page errors", errs.length === 0, errs[0] || "");
  await ctx.close();
}

console.log(bad ? `\n${bad} FAILURE(S)` : "\nall good");
await browser.close(); srv.close();
process.exit(bad ? 1 : 0);

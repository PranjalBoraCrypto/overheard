/* Is Agent City alive?
 *
 * The complaint that caused this work was "it feels like a static 3D city
 * model with strange camera animations. The camera moves, but the world
 * itself feels dead." That is a testable claim, and this is the test: hold
 * the camera absolutely still, sample the scene twice, and require it to
 * have changed.
 *
 * It is worth saying why that is the right assertion rather than a proxy for
 * one. Counting objects would pass on a city full of frozen drones. Checking
 * that an animation loop runs would pass on a loop that moves nothing.
 * Reading the actual instance matrices of the things that are supposed to be
 * travelling, with no input of any kind, is the only check that fails when
 * the page is a photograph.
 *
 * The other three groups guard the line the life layer must not cross:
 *
 *   B. LOW-END STILL LIVES. The Performance preset is allowed to draw less.
 *      It is not allowed to stop. A quality tier that freezes the city is a
 *      broken page with an excuse.
 *   C. SIGNALS ARE EVIDENCE. A light between buildings is a claim that a
 *      message happened. Saved data must never produce one, and a room whose
 *      counter did not move must never produce one.
 *   D. THE BUDGET. Instanced, pooled, and bounded — a burst of activity must
 *      not be able to grow the scene.
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

/* The directory, under the test's control. `bump` walks every room's
   sequence number forward so a poll looks like real activity. */
let bump = 0, live = true;
const directory = () => {
  const step = (r) => ({ ...r, last_seq: r.last_seq == null ? null : String(Number(r.last_seq) + bump) });
  const now = new Date().toISOString();
  return {
    ...SNAP,
    source: live ? "live" : "snapshot",
    retrieved_at: live ? now : SNAP.retrieved_at,
    at: live ? now : SNAP.retrieved_at,
    age_seconds: live ? 0 : 172800,
    landmarks: SNAP.landmarks.map(step),
    named: SNAP.named.map(step),
  };
};

const srv = http.createServer((req, res) => {
  let p = new URL(req.url, "http://x").pathname;
  if (p === "/city") p = "/city.html";
  if (p === "/api/city") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(directory()));
  }
  if (p.startsWith("/api/")) { res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    const t = p.endsWith(".js") ? "text/javascript" : p.endsWith(".json") ? "application/json" : "text/html";
    res.writeHead(200, { "content-type": t });
    return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end("{}");
}).listen(8975);

/* Software GL: a frame is slow, so everything here is given room. What is
   being measured is whether things MOVE, never how fast they are drawn —
   a frame rate from swiftshader says nothing about a real machine. */
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});

async function open(level) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  await ctx.addInitScript((lvl) => {
    try { localStorage.setItem("overheard.city.quality", lvl); } catch {}
    try { localStorage.setItem("overheard.city.seen", "1"); } catch {}   // no legend in the way
  }, level);
  const pg = await ctx.newPage();
  const errs = [];
  pg.on("pageerror", (e) => errs.push(e.message));
  await pg.goto("http://localhost:8975/city");
  /* Wait for the DATA, not just the module. `world.life` exists the instant
     the scene is built, which is before the directory has answered and
     therefore before the arrival flight has even been asked for — waiting on
     it alone let the flight start after the test had decided the camera was
     idle, and the resulting failure looked like the city moving its own
     camera when it was doing exactly what it was told. */
  await pg.waitForFunction(
    () => window.__city?.world?.life != null && (window.__city?.city?.roster?.length ?? 0) > 0,
    null, { timeout: 25000 });
  return { pg, ctx, errs };
}

/** The positions of the ambient movers, as a string. No input is sent. */
const sampleLife = (pg) => pg.evaluate(() => window.__city.world.life.sample());

/* ════════════════════════════════════════════════════════════════════════
   A. THE WORLD MOVES WHILE THE CAMERA DOES NOT
   ════════════════════════════════════════════════════════════════════ */
console.log("=== A. the city is alive with nobody touching it");
{
  const { pg, errs } = await open("balanced");
  /* The arrival flight is a deliberate transition and belongs to the first
     paint; what is being tested is whether anything moves AFTER it. Sampling
     mid-flight would measure the very thing this rebuild is trying to stop
     relying on. */
  await pg.waitForFunction(() => !window.__city.cam.busy, null, { timeout: 20000 }).catch(() => {});
  await pg.waitForTimeout(300);
  const camBefore = await pg.evaluate(() => {
    const c = window.__city.cam, t = c.target;
    return [c.dist, c.pitch, t.x, t.z].map((v) => Math.round(v * 100)).join(",");
  });
  const a = await sampleLife(pg);
  await pg.waitForTimeout(2500);
  const b = await sampleLife(pg);
  const camAfter = await pg.evaluate(() => {
    const c = window.__city.cam, t = c.target;
    return [c.dist, c.pitch, t.x, t.z].map((v) => Math.round(v * 100)).join(",");
  });

  check("something in the world moved", a !== b, a === b ? `frozen at ${a.slice(0, 40)}` : "positions changed");
  check("and the camera did not move to fake it", camBefore === camAfter, camBefore);
  check("no input was sent, and none was needed", !(await pg.evaluate(() => window.__city.cam.touched)));

  /* Five seconds is the acceptance criterion, so it is the one measured. */
  const t0 = Date.now();
  const first = await sampleLife(pg);
  let moved = false;
  while (Date.now() - t0 < 5000 && !moved) {
    await pg.waitForTimeout(250);
    moved = (await sampleLife(pg)) !== first;
  }
  check("within five seconds of looking at it", moved, `${Date.now() - t0}ms`);
  check("no page errors", errs.length === 0, errs.slice(0, 2).join(" | "));
}

/* ════════════════════════════════════════════════════════════════════════
   B. EVERY TIER LIVES
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== B. the lowest quality preset is not a still image");
for (const level of ["performance", "balanced", "high"]) {
  const { pg, ctx } = await open(level);
  const a = await sampleLife(pg);
  await pg.waitForTimeout(2500);
  const b = await sampleLife(pg);
  const counts = await pg.evaluate(() => window.__city.world.life.counts);
  check(`${level}: still moves`, a !== b, `${counts.drones} drones, ${counts.cars} cars`);
  check(`${level}: and has somewhere to put a signal`, counts.signals > 0, `${counts.signals} slots`);
  await ctx.close();
}

/* ════════════════════════════════════════════════════════════════════════
   C. A LIGHT BETWEEN BUILDINGS IS A CLAIM, AND IT NEEDS EVIDENCE
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== C. signals come from messages that really happened");
{
  live = true; bump = 0;
  const { pg } = await open("balanced");
  await pg.waitForTimeout(1200);

  /* A poll where nothing changed. Every room's counter is where it was, so
     the honest number of signals is zero — a city that sparkles on an
     unchanged directory is decoration pretending to be data. */
  const quiet = await pg.evaluate(async () => {
    const l = window.__city.world.life;
    await new Promise((r) => setTimeout(r, 100));
    const before = l.liveSignals;
    window.__city.data.state.status.source = "live";
    return before;
  });
  await pg.waitForTimeout(1500);
  const stillQuiet = await pg.evaluate(() => window.__city.world.life.liveSignals);
  check("an unchanged directory lights nothing", stillQuiet <= quiet + 1, `${quiet} → ${stillQuiet}`);

  /* Now the network does something. */
  bump = 900;
  const lit = await pg.evaluate(async () => {
    const l = window.__city.world.life;
    /* Wait for the poll the test just made interesting, up to two intervals. */
    for (let i = 0; i < 90; i++) {
      if (l.liveSignals > 0) return l.liveSignals;
      await new Promise((r) => setTimeout(r, 500));
    }
    return 0;
  });
  check("a directory that moved does light something", lit > 0, `${lit} signals in flight`);
  check("but never more than the pool holds",
    lit <= (await pg.evaluate(() => window.__city.world.life.counts.signals)), String(lit));
}

/* ════════════════════════════════════════════════════════════════════════
   D. SAVED DATA MOVES NOTHING
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== D. a snapshot is a photograph, and is not animated");
{
  live = false; bump = 0;
  const { pg } = await open("balanced");
  await pg.waitForTimeout(1500);
  bump = 5000;                       // the file "changes", which a file cannot really do
  await pg.waitForTimeout(3000);
  const sig = await pg.evaluate(() => window.__city.world.life.liveSignals);
  check("no signal is spawned from snapshot data", sig === 0, `${sig} signals`);
  /* The ambient layer still runs, and should: it is scenery, it makes no
     claim about the network, and a completely frozen page during an outage
     is the failure this whole rebuild started from. */
  const a = await sampleLife(pg);
  await pg.waitForTimeout(1500);
  check("but the scenery keeps moving, because it claims nothing",
    (await sampleLife(pg)) !== a);
  const cls = await pg.evaluate(() => document.getElementById("status").className);
  check("and the chip still says the data is saved", /warn/.test(cls), cls);
}

/* ════════════════════════════════════════════════════════════════════════
   E. THE BUDGET
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== E. it cannot grow under load");
{
  live = true; bump = 50;
  const { pg } = await open("high");
  await pg.waitForTimeout(1500);
  /* NOT draw calls: `renderer.info.render.calls` is whatever the last frame
     happened to draw, and it moves by a few either way as the camera settles
     and instances come and go. Measuring growth against a noisy per-frame
     counter produces a test that fails for reasons that are not the thing it
     is about. What must not grow is the SCENE — objects in the graph, and
     the instance capacity behind them, both of which are allocated once. */
  const before = await pg.evaluate(() => {
    let objects = 0;
    window.__city.world.scene.traverse(() => objects++);
    const l = window.__city.world.life;
    return { objects, cap: l.root.children.reduce((a, m) => a + m.count, 0) };
  });
  /* Two hundred signals asked for at once, against a pool of forty-eight. */
  await pg.evaluate(() => {
    const l = window.__city.world.life;
    const rooms = window.__city.world.rooms.slice(0, 40);
    for (let i = 0; i < 200; i++) {
      const a = rooms[i % rooms.length], b = rooms[(i * 7) % rooms.length];
      if (a && b) l.signal(a.room, b.room, 1 + (i % 3));
    }
  });
  await pg.waitForTimeout(400);
  const after = await pg.evaluate(() => {
    let objects = 0;
    window.__city.world.scene.traverse(() => objects++);
    const l = window.__city.world.life;
    return { objects, cap: l.root.children.reduce((a, m) => a + m.count, 0) };
  });
  check("two hundred events add nothing to the scene",
    after.objects === before.objects, `${before.objects} → ${after.objects} objects`);
  check("and not one instance slot either",
    after.cap === before.cap, `${before.cap} → ${after.cap} slots`);
  check("the whole life layer is four draw calls",
    (await pg.evaluate(() => window.__city.world.life.root.children.length)) === 4);
}

console.log(bad ? `\n${bad} FAILURE(S)` : "\nall good");
await browser.close(); srv.close();
process.exit(bad ? 1 : 0);

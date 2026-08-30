/* Walking into a room.
 *
 * Until now "entering a room" meant this, in full: record the name, look up
 * the building's x/z, move the camera 118 units closer. No interior existed.
 * And it took two clicks to get even that — one to open a summary, one to
 * press "Enter the room".
 *
 * These tests are the definition of the thing that replaced it:
 *
 *   A. ONE CLICK, AND IT IS SOMEWHERE ELSE. Not a summary, not a closer
 *      camera — a different scene, with its own geometry and its own camera.
 *   B. THE ARCHIVE FILLS THE ROOM AND ANIMATES NOTHING. A saved conversation
 *      gives a room its history and its population. It must never light a
 *      figure or raise a bubble, because a message drawn as if it had just
 *      been spoken is a lie with somebody's identity attached to it.
 *   C. A GENUINELY NEW MESSAGE DOES BOTH.
 *   D. LEAVING RESTORES THE VIEW, exactly. The visitor arranged it; going
 *      through a door must not cost them it.
 *
 * Needs playwright and a chromium:  npx playwright install chromium
 */
import { chromium } from "playwright";
import http from "http"; import fs from "fs"; import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "web");
const SNAP = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "city-snapshot.json"), "utf8"));
const TAIL = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "room-snapshots", "lobby.json"), "utf8"));

let bad = 0;
const check = (n, ok, d = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? "   " + d : ""}`);
  if (!ok) bad++;
};

/* The room reads: the first one hands over the ARCHIVE, flagged as such,
   which is what the real endpoint does when Technocore is refusing. Polls
   after that return whatever the test has decided just happened. */
let fresh = [];
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let p = u.pathname;
  if (p === "/city") p = "/city.html";
  const J = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (p === "/api/city") {
    const now = new Date().toISOString();
    return J({ ...SNAP, source: "live", retrieved_at: now, at: now, age_seconds: 0 });
  }
  if (p === "/api/room") {
    const since = u.searchParams.get("since") || "0";
    if (since === "0") return J({ ...TAIL, source: "snapshot", age_seconds: 172800 });
    return J({ room: u.searchParams.get("room"), source: "live",
      retrieved_at: new Date().toISOString(), age_seconds: 0,
      first_seq: null, last_seq: fresh.length ? fresh[fresh.length - 1].seq : since,
      count: fresh.length, messages: fresh });
  }
  if (p.startsWith("/api/")) return J({});
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    const t = p.endsWith(".js") ? "text/javascript" : p.endsWith(".json") ? "application/json" : "text/html";
    res.writeHead(200, { "content-type": t });
    return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end("{}");
}).listen(8976);

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const ctx = await browser.newContext({ viewport: { width: 1300, height: 820 } });
await ctx.addInitScript(() => {
  try { localStorage.setItem("overheard.city.quality", "balanced"); } catch {}
  try { localStorage.setItem("overheard.city.seen", "1"); } catch {}
});
const pg = await ctx.newPage();
const errs = [];
pg.on("pageerror", (e) => errs.push(e.message));

await pg.goto("http://localhost:8976/city");
await pg.waitForFunction(() => (window.__city?.city?.roster?.length ?? 0) > 0, null, { timeout: 25000 });
await pg.waitForFunction(() => !window.__city.cam.busy, null, { timeout: 25000 }).catch(() => {});

/* ══ A. ONE CLICK ══════════════════════════════════════════════════════ */
console.log("=== A. one click, and it is somewhere else");
const camCity = await pg.evaluate(() => {
  const c = window.__city.cam, t = c.target;
  return [c.dist, c.pitch, t.x, t.z].map((v) => Math.round(v * 100)).join(",");
});
check("the room scene is not built until it is needed", await pg.evaluate(() => !window.__city.room3d));

/* Exactly one call, standing in for exactly one click. */
await pg.evaluate(() => window.__city.enterRoom("lobby"));
await pg.waitForFunction(() => document.body.classList.contains("inroom"), null, { timeout: 25000 });
await pg.waitForTimeout(2200);

check("it is a different scene, not a closer camera", await pg.evaluate(() =>
  window.__city.mode === "room" && window.__city.room3d.scene !== window.__city.world.scene));
check("with its own camera and its own limits", await pg.evaluate(() =>
  window.__city.room3d.camera !== window.__city.world.camera
  && window.__city.room3d.limits.maxDist < 200));
check("the header stops talking about the city", await pg.evaluate(() =>
  document.getElementById("roomName").textContent === "lobby"));
check("and there is an obvious way out", await pg.evaluate(() =>
  !!document.getElementById("backCity").offsetParent));
/* The city's floating labels naming other districts, over a room they have
   nothing to do with, is the clearest way to say "you did not really go
   anywhere". */
check("the city's labels do not follow you in", await pg.evaluate(() =>
  [...document.querySelectorAll(".lab")].every((n) => !n.offsetParent)));
check("the city is left standing, not torn down", await pg.evaluate(() =>
  (window.__city.world.rooms?.length ?? 0) > 0));

/* ══ B. THE ARCHIVE POPULATES AND ANIMATES NOTHING ═════════════════════ */
console.log("\n=== B. saved history fills the room without pretending to be new");
const onEntry = await pg.evaluate(() => ({
  figures: window.__city.room3d.figures.length,
  lit: window.__city.room3d.lit,
  /* THE POOL IS ALWAYS IN THE DOM — three card elements, built once and
     reused — so counting `.tx` counts the pool and always says three. What
     is being asked is how many are LIVE. */
  bubbles: window.__city.tx?.shown ?? 0,
}));
check("the identities that really spoke are standing there",
  onEntry.figures > 5, `${onEntry.figures} figures`);
check("not one of them is lit", onEntry.lit === 0, `${onEntry.lit} lit`);
check("and not one archived message became a transmission",
  onEntry.bubbles === 0, `${onEntry.bubbles} cards`);

/* ══ C. A REAL MESSAGE DOES BOTH ═══════════════════════════════════════ */
console.log("\n=== C. a genuinely new message lights the speaker and speaks");
const [speaker, addressee] = await pg.evaluate(() =>
  window.__city.room3d.figures.slice(0, 2).map((f) => f.id));
fresh = [{
  seq: "9999999", ts: new Date().toISOString(), from: speaker, nick: null,
  text: `@${String(addressee).slice(8, 20)} picking this up now — routing through the hub.`,
  sig: null, nonce: "1",
}];
let peak = 0, bubbles = 0;
for (let i = 0; i < 26; i++) {
  await pg.waitForTimeout(400);
  const s = await pg.evaluate(() => ({
    lit: window.__city.room3d.lit, b: window.__city.tx?.shown ?? 0 }));
  peak = Math.max(peak, s.lit); bubbles = Math.max(bubbles, s.b);
  if (peak > 0 && bubbles > 0) break;
}
check("the speaker lights up", peak > 0, `${peak} lit`);
check("and transmits it", bubbles > 0, `${bubbles} card(s)`);
/* The light has to outlast nothing, and under-last nothing either: a
   speaker who has gone dark while their own card is still up is a tether
   pointing at nobody. */
check("the light is still on while the card is",
  await pg.evaluate(() => (window.__city.tx?.shown ?? 0) === 0
    || window.__city.room3d.lit > 0));
await pg.screenshot({ path: "/tmp/room-scene.png" });

/* ══ D. LEAVING ════════════════════════════════════════════════════════ */
console.log("\n=== D. leaving gives back the view you arranged");
await pg.evaluate(() => window.__city.leaveRoom());
await pg.waitForTimeout(1400);
const camBack = await pg.evaluate(() => {
  const c = window.__city.cam, t = c.target;
  return [c.dist, c.pitch, t.x, t.z].map((v) => Math.round(v * 100)).join(",");
});
check("the camera is exactly where it was", camCity === camBack, `${camCity} → ${camBack}`);
check("and the city is back", await pg.evaluate(() =>
  window.__city.mode === "city" && !document.body.classList.contains("inroom")));
check("no page errors anywhere in that", errs.length === 0, errs.slice(0, 2).join(" | "));
if (errs.length) bad++;

/* ════════════════════════════════════════════════════════════════════════
   E. THE POPULATION
   ════════════════════════════════════════════════════════════════════════

   The agents are hexagonal pods now — a low-poly shell, an inset black face
   panel, two cyan eyes, side tabs, a light bar underneath and a hover wash
   under that. Four things about the rebuild are claims, and all four are
   easy to appear to have satisfied:

     · A ROOM IS A POPULATION. Two hundred pods, none of them costing a draw
       call of their own.
     · NOTHING MOVES EXCEPT THE TWO THINGS THAT MAY. Blinking, and the light
       bar of whoever just sent a message. No hover, no drift, no lean, no
       turning — which is what lets every matrix be written once.
     · THEY DO NOT ALL FACE THE SAME WAY. The angle is drawn from the
       identity's own hash, so the room reads as a room rather than as a
       parade, and an agent is turned the same way on every visit.
     · THE PALETTE IS LOCKED. One shell colour, one eye colour, for
       everybody. No hue that varies by identity, status or activity.
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== E. two hundred pods, and not one of them a draw call");
{
  /* A room with two hundred distinct speakers, which is the number the whole
     design was sized for. */
  fresh = Array.from({ length: 200 }, (_, i) => ({
    seq: String(9000 + i), ts: new Date().toISOString(),
    from: "did:key:z6Mk" + String(i).padStart(4, "0") + "PopulationTest",
    nick: null, text: "hello", sig: null, nonce: null,
  }));
  /* Section D walked back out to the city, so this walks back in — the
     population only exists while somebody is standing in a room. */
  await pg.evaluate(() => window.__city.enterRoom("lobby"));
  await pg.waitForFunction(() => document.body.classList.contains("inroom"),
    null, { timeout: 20000 });
  await pg.waitForFunction(() => (window.__city.room3d?.figures.length ?? 0) > 100,
    null, { timeout: 25000 }).catch(() => {});
  await pg.waitForTimeout(2500);

  const shape = await pg.evaluate(() => {
    const r = window.__city.room3d;
    const inst = [];
    r.scene.traverse((o) => { if (o.isInstancedMesh) inst.push(o); });
    return { agents: r.figures.length, meshes: inst.length,
             counts: inst.map((m) => m.count) };
  });
  check("the room draws the whole population individually", shape.agents >= 100,
    `${shape.agents} agents`);
  /* THE COST IS FIXED. Seven instanced meshes for the pods plus the pooled
     reply sparks — a room with two hundred speakers costs what a room with
     three costs, which is the property that makes two hundred possible. */
  check("out of a handful of instanced meshes, not one per agent",
    shape.meshes <= 10, `${shape.meshes} meshes`);
  check("and every agent is an instance in them",
    shape.counts.filter((c) => c === shape.agents).length >= 5, shape.counts.join(","));

  /* ── SOME MOVE, MOST DO NOT ─────────────────────────────────────────────
     About a third of the room drifts on a slow closed loop around its own
     station; the rest are genuinely still, and THAT is what keeps two
     hundred affordable — a still pod's matrices are written once and never
     touched again.

     So the claim is a split, and both halves matter. If nothing moved the
     room would be a photograph; if everything moved, every frame would write
     fourteen hundred matrices and the budget argument would be gone. */
  const motion = await pg.evaluate(async () => {
    const r = window.__city.room3d;
    const n = Math.min(60, r.figures.length);
    const read = () => r.figures.slice(0, n).map((f) => `${f.px.toFixed(4)},${f.pz.toFixed(4)}`);
    const before = read();
    await new Promise((z) => setTimeout(z, 900));
    const after = read();
    let moved = 0;
    for (let i = 0; i < n; i++) if (before[i] !== after[i]) moved++;
    return { n, moved, declared: r.figures.filter((f) => f.drift > 0).length };
  });
  check("some of the room is moving", motion.moved > 0, `${motion.moved} of ${motion.n}`);
  check("and most of it is not", motion.moved < motion.n * 0.6, `${motion.moved} of ${motion.n}`);
  /* A DRIFTER STAYS ITS OWN. The position is a hash of the identity and the
     one true thing about it is that you can find it again — so a pod is
     allowed to move around its station and not away from it. */
  const bounded = await pg.evaluate(async () => {
    const r = window.__city.room3d;
    let worst = 0;
    for (let k = 0; k < 40; k++) {
      for (const f of r.figures) {
        const d = Math.hypot(f.px - f.x, f.pz - f.z);
        if (d > worst) worst = d;
      }
      await new Promise((z) => requestAnimationFrame(z));
    }
    return worst;
  });
  check("and no pod wanders away from its own station", bounded < 2.8, `${bounded.toFixed(2)} units`);
  /* A poll landing marks the whole roster for a re-place, so this waits for
     the next frame rather than racing it. */
  check("and every one of them has been placed",
    await pg.evaluate(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return window.__city.room3d.figures.every((f) => f.placed);
    }));

  /* ── THEY DO NOT ALL FACE THE SAME WAY ──────────────────────────────────
     Facing was, briefly, "every pod turns to the centre of the plaza". That
     is tidy and it is a claim the data does not support, and it put whole
     arcs of the room into identical rotations. The angle is arbitrary and
     hash-derived now, so what matters is that the values are spread right
     round the circle rather than clustered. */
  const yaws = await pg.evaluate(() => {
    const f = window.__city.room3d.figures;
    /* Twelve buckets of thirty degrees. A hash spread over two hundred
       agents should touch every one of them. */
    const b = new Array(12).fill(0);
    for (const x of f) {
      const a = ((x.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      b[Math.floor(a / (Math.PI * 2) * 12) % 12]++;
    }
    return b;
  });
  check("pods face every direction, not one", yaws.filter((n) => n > 0).length >= 10,
    yaws.join(","));
  check("and no single direction swallows the room",
    Math.max(...yaws) < yaws.reduce((a, b) => a + b, 0) * 0.3, yaws.join(","));

  /* ── ONE PALETTE ────────────────────────────────────────────────────────
     No per-identity hue, no per-identity size. Checked on the figures rather
     than on pixels, because the claim is about what the code assigns. */
  const palette = await pg.evaluate(() => {
    const f = window.__city.room3d.figures;
    const keys = new Set();
    for (const x of f) for (const k of Object.keys(x)) keys.add(k);
    return { keys: [...keys], sizes: new Set(f.map((x) => x.size)).size };
  });
  check("no agent carries a colour of its own",
    !palette.keys.includes("hue") && !palette.keys.includes("tint"),
    palette.keys.join(" "));
  check("and none carries a size of its own", palette.sizes <= 1,
    `${palette.sizes} distinct`);

  /* LEVEL OF DETAIL. Distance decides whether a pod's blink is drawn at all;
     past the mid band an eye is a fraction of a pixel. */
  const lods = await pg.evaluate(() => {
    const c = [0, 0, 0];
    for (const f of window.__city.room3d.figures) c[f.lod]++;
    return c;
  });
  check("the near ones are getting the full treatment", lods[0] > 0, lods.join("/"));
  check("and distance thins the work rather than everything being near",
    lods[1] + lods[2] > 0, lods.join("/"));

  /* BLINKING IS REAL, and it is randomised. Sampled over a couple of seconds:
     some agents must be mid-blink and they must not all be mid-blink. */
  const blinks = await pg.evaluate(async () => {
    const f = window.__city.room3d.figures;
    let any = 0, all = 0, frames = 0;
    for (let i = 0; i < 140; i++) {
      const n = f.filter((x) => x.blinkT >= 0).length;
      if (n > 0) any++;
      if (n === f.length) all++;
      frames++;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { any, all, frames };
  });
  check("somebody is always blinking in a room this size", blinks.any > 0,
    `${blinks.any}/${blinks.frames} frames`);
  check("and never everybody at once", blinks.all === 0, `${blinks.all} frames had all of them`);

  /* ── THE MESSAGE PULSE BELONGS TO ONE POD ───────────────────────────────
     The bar under a pod means "this identity just sent something". If it
     lights on anybody else it is a lie, and the neighbours-glance version of
     this feature was removed for exactly that reason. */
  /* Stop the fixture feeding the room first. Otherwise the next poll speaks
     for the very agent this is watching, re-arms its pulse, and the test
     reads correct behaviour as a stuck light. */
  fresh = [];
  await pg.waitForTimeout(2600);
  const pulse = await pg.evaluate(async () => {
    const r = window.__city.room3d;
    const id = r.figures[7].id;
    r.speak(id);
    await new Promise((s) => setTimeout(s, 200));
    const litNow = r.figures.filter((f) => f.pulseT >= 0).map((f) => f.id);
    const mine = r.figures[7].lit;
    /* DID IT EVER END, rather than is it dark right now. The room is live:
       another message can legitimately arrive for this same agent inside the
       window and re-arm the pulse, and a snapshot at the end would read that
       as a light that never went out. Sampling for the moment it returns to
       rest is the claim that actually matters. */
    let ended = false;
    for (let k = 0; k < 30; k++) {
      await new Promise((s) => setTimeout(s, 50));
      const self = r.figures.find((f) => f.id === id);
      if (self && self.pulseT < 0) { ended = true; break; }
    }
    return { litNow, mine, after: ended ? 0 : 1, target: id };
  });
  check("a new message lights exactly one pod",
    pulse.litNow.length === 1 && pulse.litNow[0] === pulse.target,
    `${pulse.litNow.length} lit`);
  check("and it is genuinely bright while it is lit", pulse.mine > 0.3,
    pulse.mine.toFixed(2));
  check("and it is over inside a second and a half", pulse.after === 0,
    `${pulse.after} still lit`);

  check("no page errors from any of it", errs.length === 0, errs.slice(0, 2).join(" | "));
  if (errs.length) bad++;
}

console.log(bad ? `\n${bad} FAILURE(S)` : "\nall good");
await browser.close(); srv.close();
process.exit(bad ? 1 : 0);

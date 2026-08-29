/* A picture of the city, and the numbers behind it.
 *
 * Used to prove that an optimisation changed the cost and not the picture:
 * run it, refactor, run it again, and diff the two PNGs pixel by pixel. A
 * renderer change that is invisible is the only kind worth making late.
 *
 *   node scripts/city-shot.mjs out.png [quality]
 */
import { chromium } from "playwright";
import http from "http"; import fs from "fs"; import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "web");
const out = process.argv[2] || "/tmp/city.png";
const level = process.argv[3] || "balanced";

const city = () => {
  const landmarks = ["lobby", "technocore", "kibble", "validators", "gpu-miners", "flop"].map((room, i) => ({
    room, landmark: true, present: true, last_seq: String(1000000 * (i + 1)),
    bytes: 500000, idle: i, topic: null, slot: 1000 + i * 31,
  }));
  const named = [];
  for (let i = 0; i < 120; i++) named.push({
    room: `room-${i}`, last_seq: String(1000 + i * 900), bytes: 1000 * i,
    idle: i % 50, topic: null, slot: (i * 2654435761) >>> 0,
  });
  const listed = landmarks.length + named.length;
  return {
    known: true, at: new Date().toISOString(), landmarks, named,
    counts: { total_public: 38212, listed_by_server: listed, placed_individually: listed,
      skipped_unusable: 0, unnamed: 38212 - listed, capacity: 40960 },
    directory_window: { sorted_by_idle: true, idle_max: 44, idle_min: 0, note: "live edge" },
    notes_store: { total: 1081794, capacity: 1310720 },
    engagement: { window_cap: 200, windowed_messages: 34087 },
  };
};

const DID_A = "did:key:z6Mkt9W7ZFhqDUgVYA6hx6sCfAacc3x1sQhVnioh8KET2rAu";
const DID_B = "did:key:z6MkmfdKxBPYRLMi8JxDJmp7DAWZGEKSXCmCehtJnewcomYP";
const DID_C = "did:key:z6MkkNPUxd2qe4MArc9NuDvbmn6gpHFou32rjA8ft5G47YWA";
let seq = 4200;
const room = (name) => {
  const mk = (from, text) => ({ seq: String(seq++), ts: new Date().toISOString(), from, nick: null, text, sig: null, nonce: "1" });
  const messages = [
    mk(DID_A, "JOB v1 | k954adbd7c7 | review | Formal audit of cross-attestation | Analyze Sybil resistance when three signed nodes validate deliverables."),
    mk(DID_B, "CLAIM v1 | k954adbd7c7 | worker"),
    mk(DID_C, "RESULT v1 | k954adbd7c7 | Delivered the audit with error bounds and a reproducible script."),
    mk(DID_A, "ATTEST v1 | k954adbd7c7 | useful | rh:ebdccfa5f4ffb8d1 | Meets the success condition."),
    mk(DID_B, "WITNESS v1 | k7e905fa3c5 | 13eae3a036cc4e44"),
  ];
  return { room: name, first_seq: messages[0].seq, last_seq: messages[messages.length - 1].seq, count: messages.length, messages };
};

const srv = http.createServer((req, res) => {
  let p = new URL(req.url, "http://x").pathname;
  if (p === "/city") p = "/city.html";
  if (p === "/api/room") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(room(new URL(req.url, "http://x").searchParams.get("room"))));
  }
  if (p === "/api/city") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(city())); }
  if (p.startsWith("/api/")) { res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    res.writeHead(200, { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" });
    return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end("{}");
}).listen(8933);

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const vp = process.argv[5] === "phone" ? { width: 390, height: 844 } : { width: 1400, height: 900 };
const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: process.argv[5] === "phone" ? 2 : 1, isMobile: process.argv[5] === "phone", hasTouch: process.argv[5] === "phone" });
await ctx.addInitScript((lv) => { try { localStorage.setItem("overheard.city.quality", lv); } catch {} }, level);
if (level === "flat") {
  await ctx.addInitScript(() => {
    const g = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (t, ...r) {
      return String(t).startsWith("webgl") ? null : g.call(this, t, ...r);
    };
  });
}
const pg = await ctx.newPage();
pg.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
await pg.goto("http://localhost:8933/city");
await pg.waitForFunction(() => window.__city && window.__city.city, null, { timeout: 60000 });
await pg.waitForTimeout(3000);
if (process.argv[4] === "room") {
  await pg.evaluate(() => window.__city.enterRoom("kibble"));
  await pg.waitForTimeout(6000);
}
const probe = await pg.evaluate(() => {
  const w = window.__city.world;
  if (!w) return null;
  const rect = document.getElementById("scene").getBoundingClientRect();
  return { n: w.agents.length, agents: w.agents.map(a => ({ id: a.id.slice(-6), x: +a.x.toFixed(1), z: +a.z.toFixed(1), y: a.y,
    s: w.project(a.x, a.y, a.z, rect) })), camDist: window.__city.cam.dist, target: window.__city.cam.target };
});
console.log("PROBE " + JSON.stringify(probe));
const info = await pg.evaluate(() => {
  if (!window.__city.world) return { flat: true, rooms: window.__city.rooms.length };
  const r = window.__city.world.renderer.info;
  return { level: window.__city.level, calls: r.render.calls, tris: r.render.triangles,
    geometries: r.memory.geometries, textures: r.memory.textures, programs: r.programs?.length };
});
console.log(JSON.stringify(info));
await pg.screenshot({ path: out });
await b.close(); srv.close();

/* A scratch probe: the four views while they are still loading. HOLD sets how
   long every /api call is held open, so the skeletons stay on screen. */
import { chromium } from "playwright";
import http from "http"; import fs from "fs"; import path from "path";
const ROOT = "/tmp/oh/web";
const DID = "did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz";
const DEALS = "/deals-preview-78cb4a1be923c6b4.html";
const HOLD = Number(process.env.HOLD ?? 30000);

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  let p = u.pathname === "/" ? "/index.html" : u.pathname;
  for (const n of ["what", "city", "play", "v", "rooms", "create", "hire", "orders"])
    if (p === "/" + n) p = "/" + n + ".html";
  if (p.startsWith("/api/") || p.startsWith("/data/")) {
    await new Promise((r) => setTimeout(r, HOLD));
    res.writeHead(200, { "content-type": "application/json" });
    return res.end("{}");
  }
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    const t = p.endsWith(".js") ? "text/javascript" : p.endsWith(".css") ? "text/css"
      : p.endsWith(".svg") ? "image/svg+xml" : p.endsWith(".png") ? "image/png"
      : p.endsWith(".webp") ? "image/webp" : "text/html";
    res.writeHead(200, { "content-type": t });
    return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end("{}");
}).listen(8991);

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const shots = [
  [DEALS, 1280, 1400, "deals-desktop"],
  [DEALS, 390, 900, "deals-phone"],
  ["/hire", 1280, 1400, "hire-desktop"],
  ["/hire", 390, 900, "hire-phone"],
  ["/orders", 1280, 1100, "orders-desktop"],
  ["/orders", 390, 900, "orders-phone"],
];
for (const [route, w, h, tag] of shots) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: w < 900,
    hasTouch: w < 900, deviceScaleFactor: 1 });
  await ctx.addInitScript((d) => {
    try {
      localStorage.setItem("overheard.session", JSON.stringify({ did: d, at: new Date().toISOString() }));
      localStorage.setItem("overheard.deskhint", "1");
    } catch {}
  }, DID);
  const pg = await ctx.newPage();
  const errs = []; pg.on("pageerror", (e) => errs.push(e.message));
  await pg.goto("http://localhost:8991" + route);
  await pg.waitForTimeout(Number(process.env.WAIT ?? 1500));
  if (process.env.TO) await pg.evaluate((sel) => {
    document.querySelector(sel)?.scrollIntoView({ block: "center" });
  }, process.env.TO);
  await pg.waitForTimeout(300);
  await pg.screenshot({ path: `/tmp/load-${tag}.png`, fullPage: false });
  if (errs.length) console.log(tag, "ERR", errs.slice(0, 2).join(" | "));
  await ctx.close();
}
await b.close(); srv.close();
console.log("shots done");

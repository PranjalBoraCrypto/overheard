/* A scratch probe, not a suite: renders the bar at a spread of widths, signed
   in and signed out, and reports what fits. */
import { chromium } from "playwright";
import http from "http"; import fs from "fs"; import path from "path";
import { fileURLToPath } from "url";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const DID = "did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz";

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let p = u.pathname === "/" ? "/index.html" : u.pathname;
  for (const n of ["what", "city", "play", "v", "rooms", "create"]) if (p === "/" + n) p = "/" + n + ".html";
  if (p.startsWith("/api/") || p.startsWith("/data/")) {
    res.writeHead(200, { "content-type": "application/json" }); return res.end("{}");
  }
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    const t = p.endsWith(".js") ? "text/javascript" : p.endsWith(".css") ? "text/css"
      : p.endsWith(".svg") ? "image/svg+xml" : p.endsWith(".png") ? "image/png" : "text/html";
    res.writeHead(200, { "content-type": t }); return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end("{}");
}).listen(8993);

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const WIDTHS = [360, 390, 430, 520, 560, 600, 700, 768, 900, 1024, 1280, 1440];

for (const signed of [false, true]) {
  console.log(`\n=== ${signed ? "SIGNED IN" : "signed out"}`);
  for (const w of WIDTHS) {
    const ctx = await b.newContext({ viewport: { width: w, height: 860 }, isMobile: w < 900, hasTouch: w < 900 });
    if (signed) await ctx.addInitScript((d) => {
      try { localStorage.setItem("overheard.session", JSON.stringify({ did: d, at: new Date().toISOString() })); } catch {}
    }, DID);
    await ctx.addInitScript(() => { try { localStorage.setItem("overheard.tabpeek", "1"); } catch {} });
    const pg = await ctx.newPage();
    const errs = []; pg.on("pageerror", (e) => errs.push(e.message));
    await pg.goto("http://localhost:8993/rooms");
    await pg.waitForTimeout(900);
    const r = await pg.evaluate(() => {
      const root = document.querySelector("overheard-bar").shadowRoot;
      const bar = root.querySelector(".bar");
      const bb = bar.getBoundingClientRect();
      const kid = (s) => { const n = root.querySelector(s); if (!n) return null;
        const c = getComputedStyle(n); if (c.display === "none") return "none";
        const r = n.getBoundingClientRect(); return `${Math.round(r.left)}..${Math.round(r.right)} (${Math.round(r.width)}w)`; };
      /* how many visual rows the bar took */
      const tops = new Set();
      for (const n of bar.children) { const c = getComputedStyle(n);
        if (c.display === "none") continue; tops.add(Math.round(n.getBoundingClientRect().top)); }
      return { h: Math.round(bb.height), rows: tops.size,
        brand: kid(".brand"), tabs: kid(".tabs"), soon: kid(".soon"),
        nb: kid(".nb"), me: kid(".me"), chip: kid(".chip"), inb: kid(".in"),
        over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    console.log(`${String(w).padStart(4)}  h${String(r.h).padStart(3)} rows:${r.rows} over:${r.over}  brand ${r.brand}  tabs ${r.tabs}  soon ${r.soon}  nb ${r.nb}  me ${r.me}${errs.length ? "  ERR " + errs[0] : ""}`);
    await ctx.close();
  }
}

/* the sheet itself */
console.log("\n=== the sheet, at 360 and 390");
for (const [w, h] of [[360, 640], [390, 844]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
  const pg = await ctx.newPage();
  await pg.goto("http://localhost:8993/play");
  await pg.waitForTimeout(900);
  await pg.evaluate(() => document.querySelector("overheard-bar").shadowRoot.querySelector(".burger").click());
  await pg.waitForTimeout(500);
  const r = await pg.evaluate(() => {
    const root = document.querySelector("overheard-bar").shadowRoot;
    const s = root.querySelector(".menu.nav");
    const sb = s.getBoundingClientRect();
    return { box: `${Math.round(sb.left)}..${Math.round(sb.right)} top ${Math.round(sb.top)} h${Math.round(sb.height)}`,
      scrolls: s.scrollHeight > s.clientHeight + 1,
      rows: [...s.querySelectorAll(".prow")].map((a) => {
        const r = a.getBoundingClientRect();
        return `${a.querySelector("b").textContent}@${Math.round(r.top)}h${Math.round(r.height)}${a.getAttribute("aria-current") ? "*" : ""}`;
      }) };
  });
  console.log(`${w}x${h}  ${r.box}  scrolls:${r.scrolls}\n      ${r.rows.join("  ")}`);
  await pg.screenshot({ path: `/tmp/bar-sheet-${w}.png` });
  await ctx.close();
}
await b.close(); srv.close();

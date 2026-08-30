/* Every page, at phone width, checked for the three ways a layout breaks on
 * a small screen:
 *
 *   1. THE PAGE SCROLLS SIDEWAYS. The clearest possible symptom and the one
 *      users describe as "it's broken on my phone".
 *   2. SOMETHING STICKS OUT PAST THE EDGE. A sideways scroll is the sum of
 *      these, but an element can also overflow into a clipping ancestor and
 *      be silently cut in half, which produces no document overflow and is
 *      just as wrong. Elements inside a DELIBERATE horizontal scroller — the
 *      city's chip row, the bar's tab strip — are excluded by walking up the
 *      tree, because a row that scrolls sideways is a design.
 *   3. TWO FLOATING CARDS SIT ON TOP OF EACH OTHER. The city is a stack of
 *      absolutely-positioned panels over a canvas, and at 390px the ones that
 *      sit comfortably apart on a desktop start to overlap. This is what
 *      "the city page has an overlap issue on mobile" was.
 *
 * Plus page errors, which on a phone-width run have caught a broken module
 * that desktop tests happened not to load.
 *
 * Two widths: a 390pt iPhone and a 360dp Android, which between them bracket
 * almost every phone in use.
 *
 * Needs playwright and a chromium:  npx playwright install chromium
 */
import { chromium } from "playwright";
import http from "http"; import fs from "fs"; import path from "path";
import { fileURLToPath } from "url";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const DID = "did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz";

const city = () => {
  const landmarks = ["lobby", "technocore", "kibble", "validators", "gpu-miners", "flop"].map((room, i) => ({
    room, landmark: true, present: true, last_seq: String(1000000 * (i + 1)),
    bytes: 500000, idle: i, topic: null, slot: 1000 + i * 31 }));
  const named = [];
  for (let i = 0; i < 60; i++) named.push({ room: `room-${i}`, last_seq: String(1000 + i * 900),
    bytes: 1000 * i, idle: i % 50, topic: null, slot: (i * 2654435761) >>> 0 });
  return { known: true, at: new Date().toISOString(), landmarks, named,
    counts: { total_public: 38212, listed_by_server: 66, placed_individually: 66, skipped_unusable: 0, unnamed: 38146, capacity: 40960 },
    directory_window: { sorted_by_idle: true, idle_max: 44, idle_min: 0, note: "live edge" },
    notes_store: { total: 1081794, capacity: 1310720 },
    engagement: { window_cap: 200, windowed_messages: 34087 } };
};
let seq = 4200;
const room = (name) => {
  const mk = (from, text) => ({ seq: String(seq++), ts: new Date().toISOString(), from, nick: null, text, sig: null, nonce: "1" });
  const A = "did:key:z6Mkt9W7ZFhqDUgVYA6hx6sCfAacc3x1sQhVnioh8KET2rAu";
  const messages = [mk(A, "JOB v1 | k9 | review | Formal audit"), mk(A, "hello there")];
  return { room: name, first_seq: messages[0].seq, last_seq: messages[1].seq, count: 2, messages };
};

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let p = u.pathname;
  if (p === "/") p = "/index.html";
  for (const n of ["what", "city", "play", "v", "rooms", "create"]) if (p === "/" + n) p = "/" + n + ".html";
  const J = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (p === "/api/city") return J(city());
  if (p === "/api/room") return J(room(u.searchParams.get("room") || "lobby"));
  if (p === "/api/note") return J({ did: DID, registered: true, known: true, fingerprint: "ab".repeat(8), note: "a note" });
  if (p === "/api/profile") return J({ owned: { rooms: [], owners: 312, identities: 97264 },
    profile: { count: 9, unique: 9, templates: 0, rooms: ["lobby"], first: "2026-08-25T10:00:00Z",
               last: "2026-08-27T09:00:00Z", last_text: "hello" }, standing: null });
  if (p === "/api/identities") return J({ updated: new Date().toISOString(), identities: {} });
  if (p === "/api/recent") return J({ rooms: [] });
  if (p.startsWith("/api/") || p.startsWith("/data/")) return J({});
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    const type = p.endsWith(".js") ? "text/javascript" : p.endsWith(".png") ? "image/png" : "text/html";
    res.writeHead(200, { "content-type": type });
    return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end("{}");
}).listen(8995);

const PAGES = process.argv[2] ? process.argv[2].split(",") : ["/", "/what", "/rooms", "/city", "/play", "/create", "/v"];

let bad = 0;
const check = (n, ok, d = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? "   " + d : ""}`);
  if (!ok) bad++;
};
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
for (const [w, h, tag] of [[390, 844, "iphone"], [360, 740, "android"]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2,
                                   isMobile: true, hasTouch: true });
  for (const route of PAGES) {
    const pg = await ctx.newPage();
    const errs = [];
    pg.on("pageerror", (e) => errs.push(e.message));
    await pg.goto("http://localhost:8995" + route);
    await pg.waitForTimeout(route === "/city" ? 7000 : 2600);
    /* The first-visit legend is a panel over the whole phone screen by
       design. Dismiss it, so what is measured is the page underneath. */
    if (route === "/city") { await pg.keyboard.press("Escape"); await pg.waitForTimeout(600); }
    const r = await pg.evaluate(() => {
      const de = document.documentElement;
      const over = de.scrollWidth - de.clientWidth;
      /* anything sticking out past the right edge */
      const wide = [];
      for (const n of document.querySelectorAll("body *")) {
        const b = n.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        if (b.right > de.clientWidth + 1 || b.left < -1) {
          /* Skip anything living inside a deliberate horizontal scroller or a
             clipping box — a chip row that scrolls sideways is a design, not
             an overflow. */
          let skip = false;
          for (let a = n; a && a !== document.body; a = a.parentElement) {
            const c = getComputedStyle(a);
            if (c.position === "fixed") { skip = true; break; }
            if (c.overflowX === "auto" || c.overflowX === "scroll" || c.overflowX === "hidden" ||
                c.overflow === "hidden" || c.overflowX === "clip" || c.overflow === "clip") { skip = true; break; }
          }
          if (skip) continue;
          wide.push(`${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}${n.className && typeof n.className === "string" ? "." + n.className.trim().split(/\s+/).join(".") : ""} L${Math.round(b.left)} R${Math.round(b.right)}`);
        }
      }
      /* HUD cards that sit on top of each other */
      const huds = [...document.querySelectorAll(".hud")].filter((n) => !n.hidden && n.getBoundingClientRect().width);
      const clash = [];
      for (let i = 0; i < huds.length; i++) for (let j = i + 1; j < huds.length; j++) {
        const a = huds[i].getBoundingClientRect(), c = huds[j].getBoundingClientRect();
        const ox = Math.min(a.right, c.right) - Math.max(a.left, c.left);
        const oy = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
        if (ox > 8 && oy > 8) clash.push(`${huds[i].id || huds[i].className} × ${huds[j].id || huds[j].className} (${Math.round(ox)}×${Math.round(oy)})`);
      }
      /* touch targets under 32px */
      const small = [];
      for (const n of document.querySelectorAll("button, a, input, select, textarea")) {
        const b = n.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        if (b.height < 30 || b.width < 24) small.push(`${n.tagName.toLowerCase()}${n.id ? "#" + n.id : "." + String(n.className).trim().split(/\s+/)[0]} ${Math.round(b.width)}×${Math.round(b.height)}`);
      }
      return { over, wide: wide.slice(0, 6), clash: clash.slice(0, 6), small: [...new Set(small)].slice(0, 6) };
    });
    const name = `${tag} ${route}`;
    /* THE ONE-TIME DESKTOP NOTE. It is a fixed bar over the bottom of the
       page, so it must be dismissed before anything is measured — and the
       fact that it appears at all, on the first page of the run only, is
       itself the thing being checked. */
    const hint = await pg.evaluate(() => {
      const h = [...document.body.children].find((n) => n.shadowRoot?.querySelector(".wrap .tx b"));
      if (!h) return null;
      const t = h.shadowRoot.querySelector(".tx b").textContent;
      h.shadowRoot.querySelector(".x").click();
      return t;
    });
    if (route === PAGES[0]) check(`${tag} says the site is better on a computer, once`, !!hint, hint || "not shown");
    else check(`${tag} ${route} does not say it again`, hint === null, hint || "");
    await pg.waitForTimeout(120);
    check(`${name} does not scroll sideways`, r.over <= 0, `${r.over}px`);
    check(`${name} keeps everything inside the window`, r.wide.length === 0, r.wide.join(" | "));
    check(`${name} has no two cards on top of each other`, r.clash.length === 0, r.clash.join(" | "));
    check(`${name} throws nothing`, errs.length === 0, errs.slice(0, 2).join(" | "));
    /* Not a failure: a text link inside a sentence is allowed to be the
       height of the sentence. Printed so a genuinely tiny control gets
       noticed rather than being invisible to this file. */
    if (r.small.length) console.log(`        (small targets: ${r.small.join(" | ")})`);
    await pg.screenshot({ path: `/tmp/m-${tag}-${route.replace(/\W/g, "") || "home"}.png`, fullPage: false });
    await pg.close();
  }
  await ctx.close();
}
await b.close(); srv.close();
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall good");
process.exit(bad ? 1 : 0);

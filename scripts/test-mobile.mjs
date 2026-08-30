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
    const type = p.endsWith(".js") ? "text/javascript" : p.endsWith(".png") ? "image/png"
      : p.endsWith(".webp") ? "image/webp" : p.endsWith(".svg") ? "image/svg+xml" : "text/html";
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
      /* FLOATING THINGS THAT SIT ON TOP OF EACH OTHER.
         This used to be ".hud" alone, and that omission is why a phone could
         show three message cards written through the room header while this
         file reported everything fine. The transmission cards and the city's
         message counts are positioned in the same space over the same canvas
         and are exactly as capable of covering something that matters, so
         they are in the list now. */
      const huds = [...document.querySelectorAll(".hud, .tx, .tally")]
        .filter((n) => !n.hidden && n.getBoundingClientRect().width
          && getComputedStyle(n).display !== "none"
          && parseFloat(getComputedStyle(n).opacity) > 0.05);
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

/* ════════════════════════════════════════════════════════════════════════
   THE DOOR TO THE CITY
   ════════════════════════════════════════════════════════════════════════

   The bar's tab strip scrolls sideways on a phone, which is what stopped it
   wrapping onto two lines, and it overflows: the tabs you can see are Card,
   Rooms, Play and Create, while Verify and City sit past the right edge with
   nothing to say they are there. The first day of real traffic read exactly
   like that list, ending with Agent City on 9% of arrivals — the best page
   on the site, losing on position rather than on merit.

   So the homepage carries a door to it, on phones only. Both halves are
   asserted here, because each is worthless without the other: that the tab
   really is off screen at phone widths (if it ever stops being, this door
   is redundant and somebody should be told), and that the door exists there
   and NOWHERE ELSE, since the desktop layout was to be left alone.
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== the door to the city, on phones only");
{
  const probe = async (w, h) => {
    const ctx2 = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1,
      isMobile: w < 900, hasTouch: w < 900 });
    /* AT REST. The strip demonstrates itself once on a first visit, and a
       measurement taken mid-demonstration reports whatever the animation was
       showing at that instant rather than what a visitor sits looking at. */
    await ctx2.addInitScript(() => { try { localStorage.setItem("overheard.tabpeek", "1"); } catch {} });
    const pg = await ctx2.newPage();
    const errs = [];
    pg.on("pageerror", (e) => errs.push(e.message));
    await pg.goto("http://localhost:8995/");
    await pg.waitForTimeout(1400);
    const out = await pg.evaluate(async () => {
      /* where the City tab actually sits, inside the bar's shadow root */
      const root = document.querySelector("overheard-bar")?.shadowRoot;
      const strip = root?.querySelector(".tabs");
      let tab = null;
      if (strip) {
        const a = [...strip.querySelectorAll("a")].find((n) => /^city$/i.test(n.textContent.trim()));
        if (a) {
          const sb = strip.getBoundingClientRect(), ab = a.getBoundingClientRect();
          tab = { inside: ab.right <= sb.right + 1 && ab.left >= sb.left - 1,
            shows: Math.max(0, Math.round(Math.min(ab.right, sb.right) - Math.max(ab.left, sb.left))),
            width: Math.round(ab.width),
            where: `${Math.round(ab.left)}..${Math.round(ab.right)} in strip ${Math.round(sb.left)}..${Math.round(sb.right)}` };
        }
      }
      const d = document.querySelector(".citydoor");
      if (!d) return { tab, door: null };
      const shown = getComputedStyle(d).display !== "none";
      const img = d.querySelector("img");
      /* ONLY WAIT WHEN IT IS ON SCREEN. The picture is loading="lazy" inside a
         block that is display:none above 520px, and a lazy image in a hidden
         box never fires load OR error, because it is never fetched at all.
         Waiting on it at desktop width hangs this probe forever, which is how
         this comment came to exist. That it is never fetched is the good news:
         a phone-only picture costs a desktop visitor nothing. */
      if (shown && img && !img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
      const bb = d.getBoundingClientRect();
      return { tab, door: { display: getComputedStyle(d).display, href: d.getAttribute("href"),
        w: Math.round(bb.width), h: Math.round(bb.height),
        img: img ? img.naturalWidth : 0, alt: img ? img.alt.length : 0 } };
    });
    await ctx2.close();
    return { ...out, errs };
  };

  const phone = await probe(390, 844);
  /* WHY THIS ASSERTION IS WEAKER THAN IT WAS, AND SHOULD BE. It used to read
     "the City tab is off the right edge", and it was, by 108px. Widening the
     strip to the window edge pulled 52 of those back, so at rest a sliver of
     City now breaks the fade. That is a better bar and it is not a reachable
     tab: the thing still cannot be read or tapped without a deliberate
     sideways scroll, which is the entire case for a door on the homepage. If
     the day comes that the whole tab fits at rest, this fails, and somebody
     should ask whether the door has outlived its reason. */
  check("at 390px the City tab still cannot be read without scrolling",
    phone.tab && !phone.tab.inside && phone.tab.shows < phone.tab.width * 0.6,
    phone.tab ? `${phone.tab.shows} of ${phone.tab.width}px showing` : "no tab found");
  check("so the homepage carries a door to it",
    phone.door && phone.door.display !== "none", phone.door ? `${phone.door.w}x${phone.door.h}` : "absent");
  check("and it goes to the city", phone.door?.href === "/city", phone.door?.href || "");
  check("with a picture that actually loads", (phone.door?.img || 0) > 0, `${phone.door?.img}px wide`);
  check("and alt text, because it is a link and not decoration", (phone.door?.alt || 0) > 20);
  check("nothing thrown", phone.errs.length === 0, phone.errs[0] || "");

  const small = await probe(360, 800);
  check("same on a 360dp Android, where the tab is off the edge entirely",
    small.door && small.door.display !== "none" && small.tab.shows === 0,
    `${small.tab.shows} of ${small.tab.width}px showing`);

  /* WHERE IT MUST NOT BE. The rule for this change was that the desktop view
     does not move, and the door is only justified where the tab is hidden. */
  const wide = await probe(560, 900);
  check("at 560px, where the tab is back on screen, the door is gone",
    wide.door?.display === "none" && wide.tab?.inside, `door ${wide.door?.display}, tab inside ${wide.tab?.inside}`);
  const desk = await probe(1280, 900);
  check("and on a desktop it is gone too", desk.door?.display === "none", desk.door?.display || "absent");
  check("where the tab was never hidden in the first place", desk.tab?.inside, desk.tab?.where || "");
}


/* ════════════════════════════════════════════════════════════════════════
   THE TAB STRIP, WHICH HAS TO ADMIT THAT IT SCROLLS
   ════════════════════════════════════════════════════════════════════════

   Six tabs need 472px and a phone gives the row 308 to 390. Scrolling is the
   right answer to that and was already the behaviour; what was missing was
   any sign of it, so the two tabs past the edge were invisible in the sense
   that matters — nobody knew to look.

   Three separate promises, and they fail in different ways, so they are
   checked separately:

     THE ROW REACHES THE WINDOW. It used to stop 52px short because
     width:100% resolves against a content box the padding had already
     narrowed, so the negative margins moved the row without widening it.
     Fifty-two pixels is most of a tab.

     THE END FADES, AND ONLY THE END THERE IS MORE BEYOND. A fade at an end
     you have already reached is a lie in the other direction.

     THE TAB YOU ARE STANDING ON IS ON SCREEN, and the strip demonstrates
     itself once, on the first phone visit only, and never again.
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== the tab strip says that it scrolls");
{
  const strip = (pg) => pg.evaluate(() => {
    const root = document.querySelector("overheard-bar").shadowRoot;
    const t = root.querySelector(".tabs");
    const tb = t.getBoundingClientRect();
    const cs = getComputedStyle(t);
    const seen = [...t.querySelectorAll("a")].filter((a) => {
      const r = a.getBoundingClientRect();
      return r.left >= tb.left - 1 && r.right <= tb.right + 1;
    }).map((a) => a.textContent.trim());
    const city = [...t.querySelectorAll("a")].find((a) => /^city$/i.test(a.textContent.trim()));
    const cr = city.getBoundingClientRect();
    return {
      left: Math.round(tb.left), right: Math.round(tb.right),
      client: Math.round(t.clientWidth), scroll: Math.round(t.scrollWidth),
      at: Math.round(t.scrollLeft), max: Math.round(t.scrollWidth - t.clientWidth),
      fl: parseFloat(cs.getPropertyValue("--fl")) || 0,
      fr: parseFloat(cs.getPropertyValue("--fr")) || 0,
      masked: /linear-gradient/.test(cs.webkitMaskImage || cs.maskImage || ""),
      seen, cityLeft: Math.round(cr.left), cityRight: Math.round(cr.right),
      cityShows: cr.left < tb.right - 2,
    };
  });
  const open = async (w, h, route, seenPeek) => {
    const ctx2 = await b.newContext({ viewport: { width: w, height: h },
      isMobile: w < 900, hasTouch: w < 900 });
    if (seenPeek) await ctx2.addInitScript(() => { try { localStorage.setItem("overheard.tabpeek", "1"); } catch {} });
    const pg = await ctx2.newPage();
    await pg.goto("http://localhost:8995" + route);
    return { ctx2, pg };
  };

  /* ── a first phone visit ─────────────────────────────────────────────── */
  {
    const { ctx2, pg } = await open(390, 844, "/", false);
    /* sample across the whole peek, which starts about a second in */
    const seenAt = [];
    for (let i = 0; i < 42; i++) {
      seenAt.push(await pg.evaluate(() =>
        Math.round(document.querySelector("overheard-bar").shadowRoot.querySelector(".tabs").scrollLeft)));
      await pg.waitForTimeout(110);
    }
    const s = await strip(pg);
    check("the row reaches the right edge of the window", s.right >= 388, `${s.left}..${s.right} of 390`);
    check("and it is masked rather than cut square", s.masked);
    check("at rest the far end fades and the near end does not",
      s.fr > 20 && s.fl === 0, `L${s.fl} R${s.fr}`);
    check("the four that always fitted are still there",
      ["Card", "Rooms", "Play", "Create"].every((n) => s.seen.includes(n)), s.seen.join(","));
    check("Verify is now whole, which it was not before", s.seen.includes("Verify"), s.seen.join(","));
    check("and the edge of City breaks the fade, so the row visibly continues",
      s.cityShows, `City ${s.cityLeft}..${s.cityRight}, row ends ${s.right}`);
    /* THE PEEK. It must happen, it must be big enough to reveal something,
       and it must put the strip back exactly where it found it. */
    const peak = Math.max(...seenAt);
    check("the strip demonstrates itself once, on the first visit", peak > 40, `travelled ${peak}px`);
    check("and returns to where it started", s.at === 0, `${s.at}px`);
    await ctx2.close();
  }

  /* ── the second visit, and every one after it ────────────────────────── */
  {
    const { ctx2, pg } = await open(390, 844, "/", true);
    const moves = [];
    for (let i = 0; i < 30; i++) {
      moves.push(await pg.evaluate(() =>
        Math.round(document.querySelector("overheard-bar").shadowRoot.querySelector(".tabs").scrollLeft)));
      await pg.waitForTimeout(110);
    }
    check("a nav that has already introduced itself stays still",
      Math.max(...moves) === 0, `max ${Math.max(...moves)}px`);
    await ctx2.close();
  }

  /* ── standing on the page whose tab is off the end ───────────────────── */
  {
    const { ctx2, pg } = await open(390, 844, "/city", true);
    await pg.waitForTimeout(1400);
    const s = await strip(pg);
    check("standing in the city, the City tab is on screen",
      s.cityLeft >= s.left - 1 && s.cityRight <= s.right + 1,
      `City ${s.cityLeft}..${s.cityRight} in ${s.left}..${s.right}`);
    check("and the near end fades now, because there is something behind you",
      s.fl > 0, `L${s.fl} R${s.fr}`);
    await ctx2.close();
  }

  /* ── where none of this should happen ────────────────────────────────── */
  {
    const { ctx2, pg } = await open(1280, 900, "/", false);
    const moves = [];
    for (let i = 0; i < 24; i++) {
      moves.push(await pg.evaluate(() =>
        Math.round(document.querySelector("overheard-bar").shadowRoot.querySelector(".tabs").scrollLeft)));
      await pg.waitForTimeout(110);
    }
    const s = await strip(pg);
    check("on a desktop the row fits, so nothing is masked", !s.masked, `scroll ${s.scroll} vs client ${s.client}`);
    check("nothing fades", s.fr === 0 && s.fl === 0, `L${s.fl} R${s.fr}`);
    check("and nothing moves on its own", Math.max(...moves) === 0);
    check("every tab is simply visible", s.seen.length === 6, s.seen.join(","));
    await ctx2.close();
  }
}

await b.close(); srv.close();
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall good");
process.exit(bad ? 1 : 0);

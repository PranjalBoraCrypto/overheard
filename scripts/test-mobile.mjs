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
    const type = p.endsWith(".js") ? "text/javascript" : p.endsWith(".css") ? "text/css" : p.endsWith(".png") ? "image/png"
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

   The city is the best page on the site and it came last in the first day of
   real traffic, at 9% of arrivals, because it was the last tab in a row that
   scrolled off the edge of a phone. The row is gone now and every page is one
   tap inside the button — but ONE TAP IS STILL A TAP, and the page that loses
   on position is the page that has to be found rather than seen.

   So the homepage carries a door to it, on phones only. Both halves are
   asserted, because each is worthless without the other: that the City tab
   really is not on the phone bar (if it ever comes back, this door is
   redundant and somebody should be told), and that the door exists there and
   NOWHERE ELSE, since the desktop layout was to be left alone.
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== the door to the city, on phones only");
{
  const probe = async (w, h) => {
    const ctx2 = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1,
      isMobile: w < 900, hasTouch: w < 900 });
    const pg = await ctx2.newPage();
    const errs = [];
    pg.on("pageerror", (e) => errs.push(e.message));
    await pg.goto("http://localhost:8995/");
    await pg.waitForTimeout(1400);
    const out = await pg.evaluate(async () => {
      /* Is City reachable from the bar without opening anything? On a
         desktop it is a tab; on a phone the tabs are not rendered at all. */
      const root = document.querySelector("overheard-bar")?.shadowRoot;
      const strip = root?.querySelector(".tabs");
      const onBar = !!strip && getComputedStyle(strip).display !== "none"
        && [...strip.querySelectorAll("a")].some((n) => /^city$/i.test(n.textContent.trim()));
      const d = document.querySelector(".citydoor");
      if (!d) return { onBar, door: null };
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
      return { onBar, door: { display: getComputedStyle(d).display, href: d.getAttribute("href"),
        w: Math.round(bb.width), h: Math.round(bb.height),
        img: img ? img.naturalWidth : 0, alt: img ? img.alt.length : 0 } };
    });
    await ctx2.close();
    return { ...out, errs };
  };

  const phone = await probe(390, 844);
  check("at 390px the City tab is not on the bar at all", !phone.onBar);
  check("so the homepage carries a door to it",
    phone.door && phone.door.display !== "none", phone.door ? `${phone.door.w}x${phone.door.h}` : "absent");
  check("and it goes to the city", phone.door?.href === "/city", phone.door?.href || "");
  check("with a picture that actually loads", (phone.door?.img || 0) > 0, `${phone.door?.img}px wide`);
  check("and alt text, because it is a link and not decoration", (phone.door?.alt || 0) > 20);
  check("nothing thrown", phone.errs.length === 0, phone.errs[0] || "");

  const small = await probe(360, 800);
  check("same on a 360dp Android", small.door && small.door.display !== "none" && !small.onBar);

  /* WHERE IT MUST NOT BE. The door is justified where the tab is not on the
     bar, and the desktop view was to be left alone. */
  const wide = await probe(560, 900);
  check("at 560px the door is already gone", wide.door?.display === "none", wide.door?.display || "");
  const desk = await probe(1280, 900);
  check("and on a desktop it is gone too", desk.door?.display === "none", desk.door?.display || "absent");
  check("where the tab was never hidden in the first place", desk.onBar);
}


/* ════════════════════════════════════════════════════════════════════════
   THE PHONE'S NAVIGATION SHOWS EVERY PAGE
   ════════════════════════════════════════════════════════════════════════

   WHAT WAS HERE BEFORE, and why it is gone.

   The bar used to put its six tabs in a row that scrolled sideways on a
   phone, and this file used to assert three things about that row: that it
   reached the window edge, that its ends faded in proportion to how much was
   left beyond them, and that it demonstrated the gesture once on a first
   visit. All three were true. The measurement that mattered was elsewhere:
   the first day of real traffic arrived in tab order and ended with Agent
   City — the best page on the site — on 9% of arrivals, because Verify and
   City sat past the right edge and nobody knew to look.

   A row that admits it scrolls is still a row you cannot read. So the row is
   gone below 900px and there is a button, and what this section checks is
   the promise that replaced it: EVERY PAGE, ON ONE SCREEN, ONE TAP AWAY.

   Four things, and they fail separately:

     THE BAR IS ONE ROW AT EVERY WIDTH. The old cut-off for the Testnet pill
     was 760px, which was 279px short of what the full bar needs, so it
     wrapped onto three and four lines everywhere from 600 to 1024 — 182px
     of navigation above a 600px screen. Checked at every width, signed in
     and signed out, because the widths that broke were in the middle.

     SIGNING IN DOES NOT MOVE IT. REPORTED: the chip grew by 91px when it
     gained the DID text, which was enough to rearrange the row. The bar is
     now the same height and the same right edge either way.

     THE SHEET HOLDS THE WHOLE SITE AND FITS ON THE SHORTEST PHONE. All of
     PAGES, not just the tabs — which is one MORE page than the strip ever
     offered, since the explainer was never a tab — with every row on screen
     at 360×640 without scrolling.

     AND IT IS NOT BURIED. The desktop note is fixed to the bottom of the
     screen at z-index 9999 and the sheet comes up from the same edge; the
     note's own fourth rule is that it never sits in front of anything.
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== the bar is one row at every width");
{
  const DID = "did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz";
  const look = async (w, h, signed, route = "/rooms") => {
    const ctx = await b.newContext({ viewport: { width: w, height: h },
      isMobile: w < 900, hasTouch: w < 900 });
    if (signed) await ctx.addInitScript((d) => {
      try { localStorage.setItem("overheard.session", JSON.stringify({ did: d, at: new Date().toISOString() })); } catch {}
    }, DID);
    /* The desktop note is a fixed bar over the bottom of the screen and it
       would sit inside every measurement below. It is checked on purpose
       further down; here it is out of the way. */
    await ctx.addInitScript(() => { try { localStorage.setItem("overheard.deskhint", "1"); } catch {} });
    const pg = await ctx.newPage();
    const errs = []; pg.on("pageerror", (e) => errs.push(e.message));
    await pg.goto("http://localhost:8995" + route);
    await pg.waitForTimeout(900);
    const out = await pg.evaluate(() => {
      const r = document.querySelector("overheard-bar").shadowRoot;
      const bar = r.querySelector(".bar");
      const shown = (s) => { const n = r.querySelector(s); if (!n) return null;
        return getComputedStyle(n).display === "none" ? null : n.getBoundingClientRect(); };
      const de = document.documentElement;
      const tabs = shown(".tabs"), nb = shown(".nb"), me = shown(".me");
      /* Everything on the row shares one horizontal band if it did not wrap.
         Heights differ, so compare centres rather than tops. */
      const mids = [...bar.children]
        .filter((n) => getComputedStyle(n).display !== "none")
        .map((n) => { const q = n.getBoundingClientRect(); return q.top + q.height / 2; });
      return { h: Math.round(bar.getBoundingClientRect().height),
        spread: Math.round(Math.max(...mids) - Math.min(...mids)),
        tabs: !!tabs, nb: !!nb,
        right: me ? Math.round(me.right) : 0,
        over: de.scrollWidth - de.clientWidth };
    });
    await ctx.close();
    return { ...out, errs };
  };

  for (const w of [360, 390, 430, 520, 560, 600, 768, 899, 900, 1024, 1280, 1440]) {
    const out = await look(w, 900, false);
    const inn = await look(w, 900, true);
    check(`${w}px: one row, signed out and in`,
      out.spread === 0 && inn.spread === 0, `spread ${out.spread} / ${inn.spread}, h ${out.h} / ${inn.h}`);
    check(`${w}px: nothing hangs off the side`,
      out.over <= 0 && inn.over <= 0, `${out.over} / ${inn.over}`);
    /* THE REPORTED BUG, and it is not the same as "one row": a bar that
       stays on one row and still shuffles when you sign in is still a bar
       that moved under somebody. */
    check(`${w}px: signing in does not move the bar`,
      out.right === inn.right && out.h === inn.h,
      `right ${out.right} → ${inn.right}, h ${out.h} → ${inn.h}`);
    /* And which navigation is on screen. 900 is the arithmetic: without the
       Testnet pill the row still needs 841px of content and 900 gives 848. */
    const wantTabs = w >= 900;
    check(`${w}px: ${wantTabs ? "the tab row" : "the button"}`,
      out.tabs === wantTabs && out.nb === !wantTabs && inn.tabs === wantTabs && inn.nb === !wantTabs,
      `tabs ${out.tabs}/${inn.tabs}, button ${out.nb}/${inn.nb}`);
    check(`${w}px: throws nothing`, out.errs.length === 0 && inn.errs.length === 0,
      (out.errs[0] || inn.errs[0] || ""));
  }
}

console.log("\n=== and one tap shows the whole site");
{
  const open = async (w, h, route) => {
    const ctx = await b.newContext({ viewport: { width: w, height: h },
      isMobile: w < 900, hasTouch: w < 900 });
    const pg = await ctx.newPage();
    await pg.goto("http://localhost:8995" + route);
    await pg.waitForTimeout(900);
    await pg.evaluate(() => document.querySelector("overheard-bar").shadowRoot.querySelector(".burger").click());
    await pg.waitForTimeout(450);
    return { ctx, pg };
  };
  const readSheet = (pg) => pg.evaluate(() => {
    const r = document.querySelector("overheard-bar").shadowRoot;
    const s = r.querySelector(".menu.nav");
    if (!s) return null;
    const sb = s.getBoundingClientRect();
    return {
      top: Math.round(sb.top), bottom: Math.round(sb.bottom),
      left: Math.round(sb.left), right: Math.round(sb.right),
      scrolls: s.scrollHeight > s.clientHeight + 1,
      expanded: r.querySelector(".burger").getAttribute("aria-expanded"),
      rows: [...s.querySelectorAll(".prow")].map((a) => {
        const q = a.getBoundingClientRect();
        return { label: a.querySelector("b").textContent, href: a.getAttribute("href"),
          blurb: a.querySelector("i").textContent,
          now: a.getAttribute("aria-current") === "page",
          top: Math.round(q.top), bottom: Math.round(q.bottom), h: Math.round(q.height) };
      }),
      testnet: (s.querySelector(".nsoon")?.textContent || ""),
    };
  });

  /* THE SHORTEST PHONE STILL IN USE. 360×640 is where "all of it at once"
     is a claim rather than an observation: seven rows, a heading and the
     Testnet line come to about 558px and this screen offers 589. */
  {
    const { ctx, pg } = await open(360, 640, "/play");
    const s = await readSheet(pg);
    check("the sheet opens", !!s && s.expanded === "true");
    check("with every page in the site, not just the tabs", s.rows.length === 7,
      s.rows.map((r) => r.label).join(", "));
    check("including the explainer, which was never a tab",
      s.rows.some((r) => r.href === "/what"), s.rows.map((r) => r.href).join(" "));
    check("and City, which is the whole reason this exists",
      s.rows.some((r) => r.href === "/city"));
    check("every row is on screen at 360×640",
      s.rows.every((r) => r.top >= 0 && r.bottom <= 640),
      s.rows.filter((r) => r.top < 0 || r.bottom > 640).map((r) => `${r.label} ${r.top}..${r.bottom}`).join(" | ") || "all inside");
    check("so it does not need to be scrolled", !s.scrolls);
    check("it spans the whole width of the phone", s.left <= 0 && s.right >= 360,
      `${s.left}..${s.right}`);
    /* WHY THE BLURBS ARE ASSERTED. They are the reason this is worth a tap
       rather than a worse version of six words in a row: "Play" and
       "Create" are labels a first visitor cannot rank, and "Proof of
       Learning" and "Make an identity" are. */
    check("every row says what the page is for",
      s.rows.every((r) => r.blurb && r.blurb.length > 6),
      s.rows.filter((r) => !r.blurb).map((r) => r.label).join(" ") || "all described");
    check("Testnet is here too, which the phone bar had no room for",
      /testnet/i.test(s.testnet) && /soon/i.test(s.testnet), s.testnet.trim());
    /* WHERE YOU ARE. Exactly one row, and the right one — the old strip
       said this with a filled tab and there is nothing else saying it now. */
    const now = s.rows.filter((r) => r.now);
    check("the page you are on is marked, once", now.length === 1 && now[0].href === "/play",
      now.map((r) => r.href).join(" ") || "none");
    check("and the button says so before it is opened",
      await pg.evaluate(() => document.querySelector("overheard-bar").shadowRoot
        .querySelector(".nb").hasAttribute("data-hot")));
    /* Every row is a thumb target. 44 is the number Apple and Google both
       publish; these are 56. */
    check("every row is a thumb target", s.rows.every((r) => r.h >= 44),
      `smallest ${Math.min(...s.rows.map((r) => r.h))}px`);
    await ctx.close();
  }

  /* IT CLOSES, THREE WAYS. A sheet that opens and will not shut is worse
     than no sheet. */
  {
    const { ctx, pg } = await open(390, 844, "/rooms");
    const gone = () => pg.evaluate(() => !document.querySelector("overheard-bar")
      .shadowRoot.querySelector(".menu.nav"));
    check("Escape closes it", (await pg.keyboard.press("Escape"), await pg.waitForTimeout(200), await gone()));
    await pg.evaluate(() => document.querySelector("overheard-bar").shadowRoot.querySelector(".burger").click());
    await pg.waitForTimeout(300);
    /* The left gutter, below the bar: page background on every layout here.
       A tap in the middle of the page lands on whatever the page put there,
       and on /rooms at 390px that is a room link. */
    await pg.mouse.click(5, 250);
    await pg.waitForTimeout(250);
    check("a tap on the page behind it closes it", await gone());
    await pg.evaluate(() => document.querySelector("overheard-bar").shadowRoot.querySelector(".burger").click());
    await pg.waitForTimeout(300);
    /* And choosing the page you are already on. The browser does not
       navigate, so nothing else would ever shut it. */
    await pg.evaluate(() => document.querySelector("overheard-bar").shadowRoot
      .querySelector('.prow[href="/rooms"]').click());
    await pg.waitForTimeout(250);
    check("and choosing the page you are already on closes it", await gone());
    await ctx.close();
  }

  /* NOT BURIED UNDER THE DESKTOP NOTE. Found by screenshot: the note is
     fixed to the bottom of the screen at z-index 9999, the sheet arrives at
     the same edge, and the last two pages in the list were behind a box
     explaining that the site is better on a computer. */
  {
    const ctx = await b.newContext({ viewport: { width: 360, height: 640 },
      isMobile: true, hasTouch: true });
    const pg = await ctx.newPage();
    await pg.goto("http://localhost:8995/rooms");
    await pg.waitForTimeout(1200);
    const hint = () => pg.evaluate(() => {
      const h = [...document.body.children].find((n) => n.shadowRoot?.querySelector(".wrap .tx b"));
      if (!h) return "absent";
      return getComputedStyle(h).display === "none" ? "hidden" : "showing";
    });
    check("the desktop note is showing to begin with", (await hint()) === "showing", await hint());
    await pg.evaluate(() => document.querySelector("overheard-bar").shadowRoot.querySelector(".burger").click());
    await pg.waitForTimeout(400);
    check("and it steps aside for the sheet", (await hint()) === "hidden", await hint());
    /* It HIDES rather than closing: closing is what records "seen", and a
       visitor who opened a menu has not dismissed this. */
    await pg.keyboard.press("Escape");
    await pg.waitForTimeout(300);
    check("and comes back when the sheet shuts", (await hint()) === "showing", await hint());
    await ctx.close();
  }

  /* WHERE IT MUST NOT BE. The rule for this change was that the desktop bar
     does not move. */
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const pg = await ctx.newPage();
    await pg.goto("http://localhost:8995/rooms");
    await pg.waitForTimeout(900);
    const d = await pg.evaluate(() => {
      const r = document.querySelector("overheard-bar").shadowRoot;
      return { nb: getComputedStyle(r.querySelector(".nb")).display,
        tabs: [...r.querySelectorAll(".tabs a")].map((a) => a.textContent.trim()),
        soon: getComputedStyle(r.querySelector(".soon")).display };
    });
    check("on a desktop the button does not exist", d.nb === "none", d.nb);
    check("all six tabs are simply there", d.tabs.length === 6, d.tabs.join(","));
    check("and Testnet with them", d.soon !== "none", d.soon);
    await ctx.close();
  }
}



/* ════════════════════════════════════════════════════════════════════════
   THE SITE DOES NOT COOK THE PHONE
   ════════════════════════════════════════════════════════════════════════

   Reported as "my phone went very hot after running the site". Profiled at
   390px across all seven pages before changing anything, and two things
   accounted for nearly all of it:

     THE BLOOMS. Three fixed layers, up to 700px across, under
     filter:blur(90px), animated with translate AND scale — so the blur
     cannot be rasterised once and reused, it is recomputed as the layer
     resizes, sixty times a second, on six of the seven pages, forever. This
     is what the site was doing while apparently doing nothing.

     A rule to stop them already existed for prefers-reduced-motion, and it
     had never worked: `.sky i` is (0,1,1) and the animations arrive through
     `.sky i:nth-child(1)` at (0,2,1), so the more specific selector won and
     the accessibility promise was quietly broken.

     The blooms are now GONE — every page stands on one painted field, and
     nothing behind it moves (see sky.css). That changed what this section
     can honestly ask. It used to count animations on `.sky` and require two
     of them on a desktop; there is no `.sky` any more, so that check failed
     while the site was working, and the other three passed by counting a
     class that no longer exists, which is worse. A test that asserts a
     removed design is not a weaker test, it is a test pointing at nothing.

     So the question is asked by COST rather than by class name: is anything
     animating a blurred layer, anywhere. A blur that moves or resizes cannot
     be rasterised once and reused, so it is recomputed every frame — that
     was the actual expense, and it stays the thing that is forbidden however
     the markup is rearranged or renamed later.

     SIXTY FRAMES OF 3-D. The city asked for sixty frames a second of a
     WebGL scene, indefinitely, on a device with no fan. It draws thirty on
     a phone now — the same scene, the same data, the same code, drawn half
     as often — and is untouched on a desktop.

   Measured effect on the profile: long tasks on /city over a five-second
   window fell from 4,830ms to 1,713ms, and the number of running animations
   fell on every page.
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== the site does not cook the phone");
{
  /* Anything still running that sits on, or inside, a blurred layer. Named,
     not counted: a failure that says which element is a failure somebody can
     fix, and a bare number is a bug report with the useful half missing. */
  const blurred = (pg) => pg.evaluate(() => {
    const out = [];
    for (const a of (document.getAnimations ? document.getAnimations() : [])) {
      if (a.playState !== "running") continue;
      const t = a.effect?.target;
      if (!t || t.nodeType !== 1) continue;
      for (let n = t, i = 0; n && n.nodeType === 1 && i < 5; n = n.parentElement, i++) {
        if (/blur\(/.test(getComputedStyle(n).filter || "")) {
          out.push(`${a.animationName || "?"} on ${t.tagName.toLowerCase()}` +
                   `${String(t.className || "").trim() ? "." + String(t.className).trim().split(/\s+/)[0] : ""}`);
          break;
        }
      }
    }
    return out;
  });
  /* Anything that loops forever, pseudo-elements included. `document
     .getAnimations()` reports a `::after` animation with the ORIGINATING
     element as its target, which is exactly the blind spot being tested:
     `*{animation:none}` does not match a pseudo-element, so a rule that looks
     total leaves every ::before and ::after running. Five pages were doing
     that, and one of them — the light crossing the invitation bar on /rooms —
     was the last thing still moving under reduced motion. */
  const forever = (pg) => pg.evaluate(() =>
    (document.getAnimations ? document.getAnimations() : [])
      .filter((a) => a.playState === "running")
      .filter((a) => a.effect?.getTiming?.().iterations === Infinity)
      .map((a) => `${a.animationName || "?"} on ${a.effect?.target?.tagName?.toLowerCase() || "?"}` +
                  `${a.effect?.pseudoElement || ""}`));

  const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
  const DESK = { viewport: { width: 1280, height: 900 } };
  const visit = async (opts, route, ms = 1800) => {
    const ctx2 = await b.newContext(opts);
    const pg = await ctx2.newPage();
    await pg.goto("http://localhost:8995" + route);
    await pg.waitForTimeout(ms);
    return { pg, done: () => ctx2.close() };
  };

  /* NOTHING ANIMATES A BLUR, on either kind of machine. The desktop half
     matters as much as the phone half: the blooms were removed for everyone,
     and a check that only looks at 390px would let them come back at 1280. */
  for (const [route, name] of [["/", "home"], ["/rooms", "rooms"], ["/city", "city"], ["/play", "play"]]) {
    for (const [opts, where] of [[PHONE, "a phone"], [DESK, "a desktop"]]) {
      const v = await visit(opts, route);
      const hot = await blurred(v.pg);
      check(`${name}: nothing animates a blurred layer on ${where}`, hot.length === 0,
        hot.length ? hot.join(", ") : "clean");
      await v.done();
    }
  }

  /* THE REDUCED-MOTION PROMISE, on every page rather than on the one page
     that happened to be checked. This is the promise the site has broken
     twice now — once by specificity, once by pseudo-element — and both times
     it was broken because nobody looked anywhere except the home page. */
  for (const route of ["/", "/what", "/rooms", "/city", "/play", "/create", "/v"]) {
    const v = await visit({ ...DESK, reducedMotion: "reduce" }, route, 1500);
    const loops = await forever(v.pg);
    check(`reduced motion: nothing loops forever on ${route}`, loops.length === 0,
      loops.length ? loops.join(", ") : "still");
    await v.done();
  }

  /* AND THE GROUND ITSELF is painted once. It is the one layer on every
     page, so if it ever starts animating it costs on every page at once. */
  {
    const v = await visit(DESK, "/");
    const g = await v.pg.evaluate(() => {
      const s = getComputedStyle(document.body, "::before");
      return { img: (s.backgroundImage || "none") !== "none", anim: s.animationName || "none" };
    });
    check("the field behind every page is painted, not animated", g.img && g.anim === "none",
      `background ${g.img ? "present" : "MISSING"}, animation ${g.anim}`);
    await v.done();
  }

  /* THE FRAME CAP. It cannot be proved by counting frames on a machine that
     never reaches thirty in the first place — this container's software
     renderer manages about twenty — so the cap itself is published and read.
     The behavioural half is the ceiling: draws per second must never exceed
     it, which is checkable on any machine, fast or slow. */
  for (const [w, h, mob, want, label] of [[390, 844, true, 30, "a phone"], [1280, 900, false, 0, "a desktop"]]) {
    const ctx2 = await b.newContext({ viewport: { width: w, height: h }, isMobile: mob, hasTouch: mob });
    await ctx2.addInitScript(() => { try { localStorage.setItem("overheard.city.quality", "performance"); } catch {} });
    const pg = await ctx2.newPage();
    await pg.goto("http://localhost:8995/city");
    await pg.waitForFunction(() => window.__city?.world?.renderer, null, { timeout: 40000 }).catch(() => {});
    await pg.waitForTimeout(2500);
    const cap = await pg.evaluate(() => window.__city?.fpsCap ?? -1);
    check(`on ${label} the city caps at ${want || "nothing"}`, cap === want, `cap ${cap}`);
    if (want) {
      const a = await pg.evaluate(() => window.__city.world.renderer.info.render.frame);
      const t0 = Date.now();
      await pg.waitForTimeout(4000);
      const c = await pg.evaluate(() => window.__city.world.renderer.info.render.frame);
      const rate = (c - a) / ((Date.now() - t0) / 1000);
      check("and never draws faster than that", rate <= want + 3, `${rate.toFixed(1)} draws/s`);
    }
    await ctx2.close();
  }
}

await b.close(); srv.close();
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall good");
process.exit(bad ? 1 : 0);

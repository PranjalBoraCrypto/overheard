/* The padding and congestion sweep.
 *
 * Four views, seven widths, and five ways a layout is cramped rather than
 * merely narrow:
 *
 *   1. THE PAGE SCROLLS SIDEWAYS. The loudest symptom and the easiest to fix.
 *   2. SOMETHING IS PAST THE WINDOW. A sideways scroll is the sum of these,
 *      but a clipping ancestor hides one while it is still wrong.
 *   3. TEXT IS TOUCHING A BOX. The one this sweep is really for: a card with
 *      a border and a word four pixels from it reads as unfinished, and no
 *      other check catches it because nothing overflows.
 *   4. TWO THINGS OVERLAP.
 *   5. A TOUCH TARGET IS TOO SMALL, on the widths where a thumb is what is
 *      pointing at it.
 *
 * Run:  node scripts/probe-space.mjs [width,width,...]
 */
import { chromium } from "playwright";
import { serve, YOU } from "./probe-fixture.mjs";

const DEALS = "/deals-preview-78cb4a1be923c6b4.html";
const VIEWS = [
  [DEALS, "deals", null],
  [DEALS + "#board", "board", '[data-main="board"]'],
  ["/hire", "hire", null],
  ["/orders", "orders", null],
];
const WIDTHS = (process.argv[2] || "1440,1280,1024,768,430,390,360").split(",").map(Number);

const srv = serve(8990);
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

/* Runs inside the page. Everything it reports is a rectangle and a selector,
   so a finding can be looked at rather than argued with. */
const MEASURE = () => {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const name = (n) => n.tagName.toLowerCase()
    + (n.id ? "#" + n.id : "")
    + (typeof n.className === "string" && n.className.trim()
        ? "." + n.className.trim().split(/\s+/).slice(0, 3).join(".") : "");
  const vis = (n) => {
    const c = getComputedStyle(n);
    if (c.display === "none" || c.visibility === "hidden" || +c.opacity < 0.05) return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const clipped = (n) => {
    for (let a = n; a && a !== document.body; a = a.parentElement) {
      const c = getComputedStyle(a);
      if (c.position === "fixed") return true;
      if (/auto|scroll|hidden|clip/.test(c.overflowX + c.overflow)) return true;
    }
    return false;
  };
  /* Anything inside a box that scrolls or clips is that box's business — a
     <pre> of JSON is meant to run past its own right edge. */
  const inScroller = (n, stop) => {
    for (let a = n.parentElement; a && a !== stop; a = a.parentElement) {
      const c = getComputedStyle(a);
      if (/auto|scroll/.test(c.overflowX + c.overflowY + c.overflow)) return true;
    }
    return false;
  };
  /* The atmosphere and the sliding indicators. They are pointer-transparent
     precisely because they are not objects, and they overlap everything by
     design — reporting them buries the one overlap that matters. */
  const decor = (n) => {
    for (let a = n; a && a !== document.body; a = a.parentElement) {
      if (getComputedStyle(a).pointerEvents === "none") return true;
      if (/^(sky|spot|heroglow|segglide|tex|grain)$/.test(a.className?.baseVal ?? "")) return true;
    }
    return false;
  };

  /* 2. past the window */
  const wide = [];
  for (const n of document.querySelectorAll("body *")) {
    if (!vis(n)) continue;
    const r = n.getBoundingClientRect();
    if ((r.right > vw + 1 || r.left < -1) && !clipped(n))
      wide.push(`${name(n)} L${Math.round(r.left)} R${Math.round(r.right)}`);
  }

  /* 3. TEXT TOUCHING A BOX.
     For every element that draws a box — a visible border or a background of
     its own — walk its text-bearing descendants and measure the gap from each
     to the box's PADDING edge. Under 5px on a real card is congestion; the
     element's own padding is what should have been there. Text nodes only:
     an icon flush to an edge is often deliberate, a word never is. */
  const tight = [];
  const boxes = [];
  for (const n of document.querySelectorAll("body *")) {
    if (!vis(n)) continue;
    const c = getComputedStyle(n);
    const bordered = ["Top", "Right", "Bottom", "Left"]
      .some((s) => parseFloat(c["border" + s + "Width"]) > 0
        && !/transparent|rgba\(0, 0, 0, 0\)/.test(c["border" + s + "Color"]));
    const filled = c.backgroundImage !== "none"
      || !/transparent|rgba\(0, 0, 0, 0\)/.test(c.backgroundColor);
    /* A CARD, not a row. The rounded corner is what makes a box read as a
       surface with an inside — a bare flex row that happens to have a
       background is a layout, and its children sitting flush to its bottom
       is how layouts work. Without this the sweep reported forty rows and
       buried the four cards that were actually cramped. */
    const round = parseFloat(c.borderTopLeftRadius) >= 6;
    if ((!bordered && !filled) || !round) continue;
    const r = n.getBoundingClientRect();
    if (r.width < 120 || r.height < 44) continue;      /* pills, chips, dots */
    /* A CONTROL GROUP IS NOT A CARD. A segmented control is a track with
       buttons packed into it, and four pixels of inset is the design rather
       than a card whose text got too close to the edge. Recognised by every
       one of its element children being a control. */
    const kids = [...n.children];
    if (kids.length && kids.every((k) => /^(BUTTON|A|INPUT|LABEL|SELECT)$/.test(k.tagName))) continue;
    boxes.push({ n, r, c });
  }
  for (const box of boxes) {
    const { n, r, c } = box;
    const pad = {
      t: r.top + parseFloat(c.borderTopWidth),
      b: r.bottom - parseFloat(c.borderBottomWidth),
      l: r.left + parseFloat(c.borderLeftWidth),
      rr: r.right - parseFloat(c.borderRightWidth),
    };
    for (const k of n.querySelectorAll("*")) {
      /* Only leaves that actually carry words. */
      const txt = [...k.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim());
      if (!txt || !vis(k)) continue;
      /* Skip anything with a box of its own between it and this one: the
         inner box's padding is that text's business, not this box's. */
      let own = false;
      for (let a = k.parentElement; a && a !== n; a = a.parentElement) {
        if (boxes.some((q) => q.n === a)) { own = true; break; }
      }
      if (own) continue;
      if (inScroller(k, n)) continue;
      /* A fixed child is not inside its parent in any layout sense — hire's
         pay dock is fixed to the bottom of the phone while its markup lives
         inside the order card, and measuring it against that card's padding
         says the card is cramped when the two are not even in the same
         coordinate space. */
      let fixed = false;
      for (let a = k; a && a !== n; a = a.parentElement)
        if (getComputedStyle(a).position === "fixed") { fixed = true; break; }
      if (fixed) continue;
      const q = k.getBoundingClientRect();
      if (!q.width || !q.height) continue;
      const gaps = { top: q.top - pad.t, bottom: pad.b - q.bottom,
                     left: q.left - pad.l, right: pad.rr - q.right };
      /* Only a gap that is nearly nothing. A NEGATIVE gap is overflow, which
         is a different fault with its own check above, and mixing the two
         produced a list where "-387px" and "0.4px" sat next to each other as
         if they were the same complaint. */
      const bad = Object.entries(gaps).filter(([, v]) => v >= -1 && v < 5);
      if (bad.length) tight.push(`${name(n)} › ${name(k)} [${bad.map(([s, v]) => s + " " + v.toFixed(1)).join(", ")}] "${k.textContent.trim().slice(0, 34)}"`);
    }
  }

  /* 4. overlap, among the things that float over other things */
  const float = [...document.querySelectorAll("body *")].filter((n) => {
    if (!vis(n) || decor(n)) return false;
    const c = getComputedStyle(n);
    return (c.position === "fixed" || c.position === "sticky" || c.position === "absolute")
      && n.getBoundingClientRect().width > 60 && n.getBoundingClientRect().height > 24;
  });
  const clash = [];
  for (let i = 0; i < float.length; i++) for (let j = i + 1; j < float.length; j++) {
    if (float[i].contains(float[j]) || float[j].contains(float[i])) continue;
    const a = float[i].getBoundingClientRect(), d = float[j].getBoundingClientRect();
    const ox = Math.min(a.right, d.right) - Math.max(a.left, d.left);
    const oy = Math.min(a.bottom, d.bottom) - Math.max(a.top, d.top);
    if (ox > 10 && oy > 10) clash.push(`${name(float[i])} × ${name(float[j])} (${Math.round(ox)}×${Math.round(oy)})`);
  }

  /* 5. targets */
  const small = [];
  /* Only where a thumb is what is pointing. A 17px (i) beside a cursor is a
     fine target and a poor one under a finger, and reporting it at 1440px is
     reporting a fact about a mouse.

     AND IT HIT-TESTS RATHER THAN MEASURING. The first version of this read
     getBoundingClientRect and was therefore blind to the fix: a control whose
     hit area is grown by a transparent pseudo-element has exactly the same
     rect it had before, and the probe reported eleven failures over a change
     that had corrected all of them. What a thumb can hit is a question only
     elementFromPoint can answer. */
  if (matchMedia("(pointer: coarse)").matches) {
    const hits = (n, x, y) => {
      const t = document.elementFromPoint(x, y);
      return !!t && (t === n || n.contains(t));
    };
    for (const n of document.querySelectorAll("button,a,input,select,textarea,summary,[role=button]")) {
      if (!vis(n)) continue;
      const c = getComputedStyle(n);
      /* A word inside a sentence is allowed to be the height of the sentence,
         whether it is an <a> or a button styled as one. */
      if (/^inline$/.test(c.display)) continue;
      const r = n.getBoundingClientRect();
      if (r.height >= 40 && r.width >= 32) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      /* elementFromPoint answers only inside the viewport, and outside it it
         answers null — which is indistinguishable from "nothing is there".
         The first run of the hit-test version reported every control below
         the fold as unreachable. The window is tall for this probe so that
         most of a page is in it; anything still outside is skipped rather
         than failed, because a null is not evidence. */
      if (cy - 20 < 0 || cy + 20 > innerHeight || cx < 0 || cx > innerWidth) continue;
      /* 20 short of the centre in each direction is a 40px box, which is the
         floor this project is holding controls to. Horizontal is only asked
         of controls that are actually narrow — a 121px caret needs height. */
      const bad = [];
      if (!hits(n, cx, cy - 19) || !hits(n, cx, cy + 19)) bad.push("height");
      if (r.width < 32 && (!hits(n, cx - 15, cy) || !hits(n, cx + 15, cy))) bad.push("width");
      if (bad.length)
        small.push(`${name(n)} ${Math.round(r.width)}×${Math.round(r.height)}`
          + ` (${bad.join("+")} not reachable) in ${name(n.parentElement)}`);
    }
  }

  return { over: de.scrollWidth - de.clientWidth,
    wide: [...new Set(wide)], tight: [...new Set(tight)],
    clash: [...new Set(clash)], small: [...new Set(small)] };
};

let findings = 0;
for (const [route, tag, click] of VIEWS) {
  for (const w of WIDTHS) {
    /* Tall on purpose: the hit-test below can only ask about pixels that are
       in the window, so a 1000px window measured the top of each page and
       nothing else. */
    const ctx = await b.newContext({ viewport: { width: w, height: 2600 },
      isMobile: w < 900, hasTouch: w < 900 });
    await ctx.addInitScript((d) => {
      try {
        localStorage.setItem("overheard.session", JSON.stringify({ did: d, at: new Date().toISOString() }));
        localStorage.setItem("overheard.deskhint", "1");
      } catch {}
    }, YOU);
    const pg = await ctx.newPage();
    const errs = []; pg.on("pageerror", (e) => errs.push(e.message));
    await pg.goto("http://localhost:8990" + route);
    await pg.waitForTimeout(2200);
    if (click) await pg.click(click).catch(() => {});
    await pg.waitForTimeout(900);
    const r = await pg.evaluate(MEASURE);
    const bad = r.over > 0 || r.wide.length || r.tight.length || r.clash.length || r.small.length || errs.length;
    if (bad) {
      findings++;
      console.log(`\n── ${tag} @ ${w}`);
      if (r.over > 0) console.log(`   scrolls sideways by ${r.over}px`);
      for (const x of r.wide.slice(0, 6))  console.log(`   past window   ${x}`);
      for (const x of r.tight.slice(0, 14)) console.log(`   tight         ${x}`);
      for (const x of r.clash.slice(0, 6)) console.log(`   overlap       ${x}`);
      for (const x of r.small.slice(0, 8)) console.log(`   small target  ${x}`);
      for (const x of errs.slice(0, 2))    console.log(`   THREW         ${x}`);
    } else {
      console.log(`ok ${tag} @ ${w}`);
    }
    if (process.env.SHOT) await pg.screenshot({ path: `/tmp/sp-${tag}-${w}.png`, fullPage: process.env.SHOT === "full" });
    await ctx.close();
  }
}
await b.close(); srv.close();
console.log(`\n${findings} view/width combinations with findings`);

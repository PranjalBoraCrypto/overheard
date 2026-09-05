/**
 * The desktop pointer response, in one place.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS NOT
 *
 * It is not the site's cursor glow. That is `.spot` — a fixed radial behind
 * the whole page, moved by a small loop at the bottom of every page, copied
 * byte-for-byte from rooms.html and pinned there by tests. It is part of the
 * site's atmosphere and nothing here touches it.
 *
 * This is a LOCAL effect: a surface catching light where the pointer is over
 * it, and a card leaning very slightly toward the pointer. It is built to sit
 * under the site glow rather than compete with it — no colour of its own, no
 * blur, low opacity, and a tilt measured in fractions of a degree.
 *
 * ── WHY A SHARED MODULE AND NOT A LINE IN EACH PAGE ───────────────────────
 *
 * Because getting it wrong is expensive in a way that does not show up until
 * somebody is on a laptop with forty cards on screen:
 *
 *   · ONE listener on the document, not one per card. Forty `mousemove`
 *     handlers is forty closures firing at pointer rate.
 *   · Writes happen in a rAF, once per frame, never in the event. A handler
 *     that writes a style synchronously on every mousemove is a handler that
 *     forces layout at whatever rate the mouse reports.
 *   · Only transform and opacity, so the compositor does the work.
 *   · Elements OFF SCREEN are not tracked at all, via IntersectionObserver.
 *   · The effect is removed the instant the pointer leaves, rather than left
 *     frozen at its last position — a card lit from a corner the cursor left
 *     ten seconds ago reads as a rendering bug.
 *
 * And the guard that matters most: `(hover:hover) and (pointer:fine)`. On a
 * touch screen none of this is attached, no listeners exist, and the CSS
 * that would use the variables is itself inside the same media query. Touch
 * gets its own model — press states and scroll reveals — and not a desktop
 * effect that never fires.
 */

const FINE = typeof matchMedia === "function"
  && matchMedia("(hover:hover) and (pointer:fine)").matches;
const STILL = typeof matchMedia === "function"
  && matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Half a degree. The brief asked for "very subtle card perspective", and the
   failure mode of tilt is not subtlety — it is a page where text shears
   whenever the mouse moves. At this angle a card reads as reacting; at three
   degrees it reads as a novelty. */
const TILT = 0.5;

let live = null;          // the element under the pointer right now
let frame = 0;
let mx = 0, my = 0;

function apply() {
  frame = 0;
  const el = live;
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const x = (mx - r.left) / r.width;
  const y = (my - r.top) / r.height;
  el.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
  el.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
  if (el.dataset.tilt === "1" && !STILL) {
    el.style.transform =
      `perspective(900px) rotateX(${((0.5 - y) * TILT * 2).toFixed(3)}deg)` +
      ` rotateY(${((x - 0.5) * TILT * 2).toFixed(3)}deg) translateZ(0)`;
  }
}

function clear(el) {
  if (!el) return;
  el.dataset.lit = "0";
  el.style.removeProperty("--mx");
  el.style.removeProperty("--my");
  if (el.dataset.tilt === "1") el.style.transform = "";
}

/**
 * Track every `.lit` inside `root`. Safe to call more than once — later calls
 * pick up elements added since, which is what a list that repaints needs.
 */
export function litten(root = document) {
  if (!FINE) return () => {};

  /* Off-screen elements are not tracked. A board with two hundred listings
     should cost the same as one with eight, and the difference is entirely
     whether the ones nobody can see are still in the loop. */
  const seen = new WeakSet();
  const io = "IntersectionObserver" in window
    ? new IntersectionObserver((rows) => {
        for (const r of rows) r.target.dataset.near = r.isIntersecting ? "1" : "0";
      }, { rootMargin: "120px" })
    : null;

  const watch = () => {
    for (const el of root.querySelectorAll(".lit")) {
      if (seen.has(el)) continue;
      seen.add(el);
      el.dataset.near = "1";
      io?.observe(el);
    }
  };
  watch();

  const move = (e) => {
    mx = e.clientX; my = e.clientY;
    const el = e.target instanceof Element ? e.target.closest(".lit") : null;
    if (el !== live) { clear(live); live = el; if (el) el.dataset.lit = "1"; }
    if (live && live.dataset.near !== "0" && !frame) frame = requestAnimationFrame(apply);
  };
  /* pointerleave on the document catches the cursor leaving the window
     entirely, which mouseout does not reliably do. */
  const leave = () => { clear(live); live = null; };

  document.addEventListener("pointermove", move, { passive: true });
  document.addEventListener("pointerleave", leave, { passive: true });
  window.addEventListener("blur", leave);

  return watch;                    // call after a repaint to pick up new cards
}

/* ── MAGNETIC PRIMARY ACTIONS ──────────────────────────────────────────────
 * A few pixels, on the one button that matters on a page, and nothing else.
 * The brief said "limited to a few pixels" and it is right: a button that
 * chases the cursor across a card is a button people miss.
 */
export function magnetic(el, strength = 4) {
  if (!FINE || STILL || !el) return;
  let f = 0, x = 0, y = 0;
  const set = () => { f = 0; el.style.transform = `translate(${x}px,${y}px)`; };
  el.addEventListener("pointermove", (e) => {
    const r = el.getBoundingClientRect();
    x = ((e.clientX - (r.left + r.width / 2)) / (r.width / 2)) * strength;
    y = ((e.clientY - (r.top + r.height / 2)) / (r.height / 2)) * strength;
    if (!f) f = requestAnimationFrame(set);
  }, { passive: true });
  el.addEventListener("pointerleave", () => { x = y = 0; if (!f) f = requestAnimationFrame(set); },
    { passive: true });
}

/* ── AND THE TOUCH HALF ────────────────────────────────────────────────────
 * Not a fallback — a different model for a different device. Scroll-triggered
 * reveals, once each, never re-firing, and never on a viewport that has
 * already scrolled past them: an element that animates in every time it
 * crosses the fold is the thing that makes a phone page feel busy rather than
 * alive.
 */
export function reveal(root = document) {
  if (STILL || !("IntersectionObserver" in window)) {
    for (const el of root.querySelectorAll("[data-rise]")) el.dataset.rise = "in";
    return;
  }
  const io = new IntersectionObserver((rows) => {
    for (const r of rows) {
      if (!r.isIntersecting) continue;
      r.target.dataset.rise = "in";
      io.unobserve(r.target);
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
  for (const el of root.querySelectorAll("[data-rise='out']")) io.observe(el);
}

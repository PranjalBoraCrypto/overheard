/**
 * city/declutter.js — deciding which labels get to exist this frame.
 *
 * A label that lands underneath the headline card, or on top of another
 * label, is worse than no label: it is a thing that looks broken. Both views
 * of the city — the 3D scene and the flat map — put HTML labels over a
 * moving picture, so both need the same three rules, and they need them in
 * the same order:
 *
 *   1. Anything sitting under a HUD card is hidden. The cards are opaque and
 *      they win; a district name half-visible behind the search box reads as
 *      a bug, not as information.
 *   2. Labels are placed in priority order and a later one that would overlap
 *      an earlier one is dropped. Districts outrank the ring label, which
 *      outranks room names.
 *   3. Sizes are measured once per label and cached, because reading
 *      offsetWidth after writing a transform forces the browser to lay the
 *      page out again — thirty times a second, for twenty labels, that is the
 *      single most expensive thing an overlay can do.
 */

const PAD = 6;

export function makeDeclutter(els) {
  let hud = [];
  let hudAt = 0;
  let placed = [];
  let stage = { left: 0, top: 0, width: 1, height: 1 };

  /** The cards the visitor is actually reading. Re-measured twice a second:
   *  they move when the window resizes or a panel opens, and neither of those
   *  happens at frame rate. */
  function collectHud(now) {
    if (now - hudAt < 500 && hud.length) return;
    hudAt = now;
    hud = [];
    stage = els.stage.getBoundingClientRect();
    const nodes = [
      els.chips?.closest(".hud"), els.side, els.feed,
      document.querySelector(".hud.br"), document.getElementById("strip"),
      document.getElementById("hits"),
    ];
    for (const n of nodes) {
      if (!n || n.hidden || n.offsetParent === null) continue;
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      hud.push({
        l: r.left - stage.left - PAD, t: r.top - stage.top - PAD,
        r: r.right - stage.left + PAD, b: r.bottom - stage.top + PAD,
      });
    }
  }

  const hits = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

  return {
    /** Call once per overlay tick, before placing anything. */
    begin(now) { collectHud(now); placed = []; },

    /**
     * Ask for a spot. `entry` is any object the caller owns; its measured size
     * is cached on it. Returns true if the label may show at (x, y), where y
     * is the bottom of the label and x its centre.
     */
    place(entry, x, y) {
      const n = entry.node;
      if (!entry.w || !entry.h) {
        /* Measured while visible, once. A hidden element measures zero, so a
           label that has never been shown is measured optimistically and
           corrected on the frame it first appears. */
        entry.w = n.offsetWidth || 120;
        entry.h = n.offsetHeight || 26;
      }
      const box = { l: x - entry.w / 2, t: y - entry.h, r: x + entry.w / 2, b: y };
      if (box.r < 0 || box.l > stage.width || box.b < 0 || box.t > stage.height) return false;
      for (const h of hud) if (hits(box, h)) return false;
      for (const p of placed) if (hits(box, p)) return false;
      placed.push(box);
      return true;
    },

    /**
     * Try a few places before giving up. A district label that vanishes
     * because the search box happens to be under it has cost the visitor a
     * landmark; a district label thirty pixels lower has cost nothing. Order
     * matters: the first candidate is where the label belongs, the rest are
     * compromises in decreasing order of honesty about what it points at.
     */
    placeAny(entry, x, y, alts = [[0, 0], [0, 34], [0, -30], [-70, 0], [70, 0], [0, 66]]) {
      for (const [dx, dy] of alts) {
        if (this.place(entry, x + dx, y + dy)) return { x: x + dx, y: y + dy };
      }
      return null;
    },
  };
}

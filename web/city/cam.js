/**
 * city/cam.js — the camera, and the promise that it is yours.
 *
 * ONE RULE ABOVE ALL THE OTHERS: any input from the visitor cancels whatever
 * the camera was doing on its own, on the same frame, without argument. A
 * cinematic flight that cannot be interrupted is not cinematic, it is a
 * cutscene, and a page that takes the controls away for two seconds while
 * somebody is trying to look at something is the single most irritating thing
 * a 3D interface can do. Auto-tour, fly-to-district, fly-to-room: all of them
 * die the instant a mouse button goes down or a finger lands.
 *
 * The motion is integrated, not tweened. Orbit, pan and zoom each hold a
 * target and the current value chases it with an exponential ease whose rate
 * comes from the real frame delta — so the feel is identical at 30fps and
 * 144fps, which a per-frame lerp with a fixed factor is not. This is the same
 * argument the card tilt on /play settles, for the same reason.
 *
 * Reduced motion is honoured by replacing flights with a cut. Not a shorter
 * flight — a cut. Somebody who has asked for less movement has asked for less
 * movement, and "we made it quicker" is not the same answer.
 */

/* The distances are not taste, they are arithmetic. The lens is 38° vertical,
   so the height the camera can see at distance d is 2·d·tan(19°) ≈ 0.69·d.
   The plate is 148 units in radius, so framing the whole city takes something
   near 370 at this pitch — and the first framing of this page used 210, which
   put the visitor inside the skyline looking at four towers with the rest of
   the city off screen. The opening shot has to be the city, whole. */
const TAU = 0.13;                    // seconds; the ease time constant

/* THE LIMITS ARE ARGUMENTS NOW, NOT CONSTANTS.
   ──────────────────────────────────────────────────────────────────────────
   This controller was written for one scene and had the city's dimensions
   baked into it: a floor of 30 units, a ceiling of 820, a target leashed to
   the 132-unit plate, and an opening distance of 356 that frames a skyline.
   Every one of those is wrong inside a room, where the whole environment is
   sixty units across and 356 would put the visitor in orbit above it.

   The alternative was a second controller for the room scene, and that is
   how two pieces of software that are supposed to feel identical stop
   feeling identical: the drag inertia diverges, the pinch behaves
   differently on one of them, and a fix lands in one file and not the other.
   One controller, two sets of limits. */
export const CITY_LIMITS = {
  minDist: 30, maxDist: 820, minPitch: 0.16, maxPitch: 1.35,
  radius: 132, minY: -4, maxY: 40,
  home: { yaw: -0.72, pitch: 0.54, dist: 356, tx: 0, ty: 8, tz: 0 },
  fit: (a, clamp) => clamp((552 / a) * (a < 1 ? 0.6 : 1), 330, 820),
};

export function makeCamera(THREE, camera, dom, { reduced = false, limits = CITY_LIMITS } = {}) {
  const L = limits;
  const MIN_DIST = L.minDist, MAX_DIST = L.maxDist;
  const MIN_PITCH = L.minPitch, MAX_PITCH = L.maxPitch;
  const home = { ...L.home };
  // dist is replaced by setAspect() as soon as the canvas has a size

  const cur = { ...home };
  const want = { ...home };
  let flight = null;                 // { from, to, t, ms, done }
  let dragging = null;               // 'orbit' | 'pan'
  let px = 0, py = 0;
  const pointers = new Map();
  let pinch = 0;
  let onChange = null;
  let enabled = true;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const CITY_R = L.radius;
  let touched = false;              // has the visitor moved the camera themselves?

  /* The opening distance depends on the shape of the window, not just its
     size. A portrait phone sees a third of the width a laptop does at the
     same distance, so a fixed 356 put the visitor inside the skyline again —
     this time only on phones, which is the worst place to find out. The
     constant is (opening distance × aspect) measured on the desktop framing
     that was tuned by eye. */
  function fitFor(aspect) {
    const a = Math.max(0.4, aspect || 1.5);
    /* Portrait cannot show the whole plate and a legible city at once at the
       desktop's three-quarter angle, so it does two things instead of one:
       looks down more steeply, which turns a wide ellipse into a rounder one
       that fits a tall screen, and gives up a little of the outer plate. The
       room scene supplies its own version of the same trade. */
    return L.fit(a, clamp);
  }

  function normalise() {
    want.pitch = clamp(want.pitch, MIN_PITCH, MAX_PITCH);
    want.dist = clamp(want.dist, MIN_DIST, MAX_DIST);
    const r = Math.hypot(want.tx, want.tz);
    if (r > CITY_R) { want.tx *= CITY_R / r; want.tz *= CITY_R / r; }
    want.ty = clamp(want.ty, L.minY, L.maxY);
  }

  /** Anything the visitor does stops the camera doing its own thing. */
  function seize() {
    touched = true;
    if (flight) { flight = null; onChange?.("seized"); }
  }

  function apply() {
    const cp = Math.cos(cur.pitch), sp = Math.sin(cur.pitch);
    camera.position.set(
      cur.tx + Math.cos(cur.yaw) * cp * cur.dist,
      cur.ty + sp * cur.dist,
      cur.tz + Math.sin(cur.yaw) * cp * cur.dist
    );
    camera.lookAt(cur.tx, cur.ty, cur.tz);
  }

  /* ── input ────────────────────────────────────────────────────────────── */

  const onDown = (e) => {
    if (!enabled) return;
    dom.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    seize();
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
      dragging = "pan";
    } else {
      dragging = e.button === 2 || e.shiftKey ? "pan" : "orbit";
      px = e.clientX; py = e.clientY;
    }
  };

  const onMove = (e) => {
    if (!enabled || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      /* Two fingers: the distance between them is zoom, their midpoint is
         pan. Doing both from one gesture is what a map does, and a map is
         what people already know how to hold. */
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) { want.dist *= pinch / Math.max(1, d); }
      pinch = d;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (px || py) panBy(mx - px, my - py);
      px = mx; py = my;
      normalise();
      return;
    }

    const dx = e.clientX - px, dy = e.clientY - py;
    px = e.clientX; py = e.clientY;
    if (dragging === "orbit") {
      want.yaw += dx * 0.0055;
      want.pitch -= dy * 0.0042;
    } else if (dragging === "pan") {
      panBy(dx, dy);
    }
    normalise();
  };

  /** Pan in the ground plane, in the direction the camera is facing, scaled
   *  by how far away it is — so a drag moves the same amount of *city* at
   *  every zoom rather than the same number of pixels. */
  function panBy(dx, dy) {
    const k = cur.dist * 0.0016;
    const fx = Math.cos(want.yaw), fz = Math.sin(want.yaw);
    want.tx += (-dx * -fz - dy * fx) * k;
    want.tz += (-dx * fx - dy * fz) * k;
  }

  const onUp = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (!pointers.size) { dragging = null; px = py = 0; }
  };

  const onWheel = (e) => {
    if (!enabled) return;
    e.preventDefault();
    seize();
    /* Multiplicative, so a notch is the same *proportion* of the distance
       whether you are above the city or inside a plaza. Additive zoom crawls
       when far and slams when near. */
    want.dist *= Math.exp(clamp(e.deltaY, -240, 240) * 0.0011);
    normalise();
  };

  const noMenu = (e) => e.preventDefault();

  dom.addEventListener("pointerdown", onDown);
  dom.addEventListener("pointermove", onMove);
  dom.addEventListener("pointerup", onUp);
  dom.addEventListener("pointercancel", onUp);
  dom.addEventListener("wheel", onWheel, { passive: false });
  dom.addEventListener("contextmenu", noMenu);

  /* ── the public surface ───────────────────────────────────────────────── */

  const api = {
    get busy() { return !!flight; },
    /** Has the visitor moved the camera themselves? Nothing may reframe a
     *  view somebody has taken hold of. */
    get touched() { return touched; },
    get dragging() { return !!dragging; },
    get dist() { return cur.dist; },
    get pitch() { return cur.pitch; },
    get target() { return { x: cur.tx, y: cur.ty, z: cur.tz }; },
    set enabled(v) { enabled = v; if (!v) { dragging = null; pointers.clear(); } },
    onChange(fn) { onChange = fn; },

    /** Move somewhere, over time — unless the visitor has asked for less
     *  motion, in which case arrive. */
    flyTo(to, ms = 1100) {
      const dest = { ...cur, ...to };
      Object.assign(want, dest);
      normalise();
      if (reduced || ms <= 0) { Object.assign(cur, want); flight = null; apply(); onChange?.("arrived"); return; }
      flight = { from: { ...cur }, to: { ...want }, t: 0, ms };
    },

    home(ms = 1100) { api.flyTo({ ...home }, ms); },

    /* ── LEAVING AND COMING BACK ──────────────────────────────────────────
       Walking into a room and out again must not cost the visitor the view
       they arranged. `snapshot` takes the whole camera state — including
       whether they had taken hold of it, which decides whether anything is
       later allowed to reframe on their behalf — and `restore` puts it back
       with no flight at all, because a journey home from a place you were
       never taken from is just the page moving on its own again. */
    snapshot() { return { ...cur, touched }; },
    restore(s) {
      if (!s) return;
      flight = null;
      Object.assign(cur, { yaw: s.yaw, pitch: s.pitch, dist: s.dist, tx: s.tx, ty: s.ty, tz: s.tz });
      Object.assign(want, cur);
      touched = !!s.touched;
      normalise();
      apply();
    },

    /** Frame a point: look at it from a sensible height and distance without
     *  changing which way round the city the visitor had it. */
    focus(x, z, dist, ms = 1100, pitch) {
      api.flyTo({ tx: x, tz: z, ty: 0, dist, pitch: pitch ?? Math.max(0.42, Math.min(0.9, cur.pitch)) }, ms);
    },

    nudge(dyaw) { seize(); want.yaw += dyaw; },

    /** The window changed shape. Reframe only if the visitor has not taken
     *  the camera themselves — moving somebody's view because they rotated
     *  their phone is the same rudeness as an uninterruptible flight. */
    setAspect(aspect) {
      home.dist = fitFor(aspect);
      home.pitch = aspect < 1 ? 0.86 : 0.54;
      if (touched) return;
      want.dist = cur.dist = home.dist;
      want.pitch = cur.pitch = home.pitch;
      apply();
    },

    step(dt) {
      if (flight) {
        flight.t += dt * 1000;
        const k = Math.min(1, flight.t / flight.ms);
        /* Ease in and out, but weighted so the deceleration is longer than
           the acceleration: arriving gently reads as control, leaving gently
           reads as hesitation. */
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 2.6) / 2;
        for (const key of ["yaw", "pitch", "dist", "tx", "ty", "tz"]) {
          cur[key] = flight.from[key] + (flight.to[key] - flight.from[key]) * e;
        }
        if (k >= 1) { flight = null; onChange?.("arrived"); }
        apply();
        return;
      }
      const a = 1 - Math.exp(-dt / TAU);
      for (const key of ["yaw", "pitch", "dist", "tx", "ty", "tz"]) {
        cur[key] += (want[key] - cur[key]) * a;
      }
      apply();
    },

    dispose() {
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerup", onUp);
      dom.removeEventListener("pointercancel", onUp);
      dom.removeEventListener("wheel", onWheel);
      dom.removeEventListener("contextmenu", noMenu);
    },
  };

  apply();
  return api;
}

/**
 * city/quality.js — how much to draw, decided by the machine rather than by
 * hope.
 *
 * THE DEFAULT IS NOT "HIGH", AND THAT IS THE WHOLE DESIGN.
 *
 * A 3D page that opens at full detail and degrades later has already failed
 * the person on integrated graphics: the first ten seconds — the ones that
 * decide whether they stay — are the worst ten seconds they will see. So this
 * opens at Balanced on anything that looks capable and Performance on
 * anything that does not, then watches the real frame time and moves.
 *
 * It moves DOWN fast and UP slowly, deliberately. A stutter is felt
 * immediately and must be answered immediately; the reward for guessing
 * upward too eagerly is an oscillation between two settings, which is worse
 * than either. Up needs eight seconds of comfortable frames, down needs two
 * of bad ones.
 *
 * An explicit choice from the visitor is final. Auto-adjust switches itself
 * off the moment somebody picks a level, because a control that overrides
 * the person using it is not a control.
 */

const KEY = "overheard.city.quality";
const MUTE = "overheard.city.muted";

export const LEVELS = ["performance", "balanced", "high"];

/** What each level actually changes. Everything here is decoration: the city
 *  structure, the rooms, the agents, the messages and the analytics are the
 *  same at every level, and the 2D fallback has them too. */
export const PRESETS = {
  performance: {
    label: "Performance",
    dpr: 1,           shadows: false, ground: 24,  blocks: 6,
    agents: 14,       particles: 0,   beams: 2,    fog: false,
    windows: false,   detail: 0,      bubbles: 3,  antialias: false,
    pulseLife: 900,   idleSpin: false,
  },
  balanced: {
    label: "Balanced",
    dpr: 1.5,         shadows: false, ground: 40,  blocks: 10,
    agents: 22,       particles: 40,  beams: 4,    fog: true,
    windows: true,    detail: 1,      bubbles: 4,  antialias: true,
    pulseLife: 1200,  idleSpin: true,
  },
  high: {
    label: "High",
    dpr: 2,           shadows: true,  ground: 56,  blocks: 14,
    agents: 34,       particles: 90,  beams: 6,    fog: true,
    windows: true,    detail: 2,      bubbles: 5,  antialias: true,
    pulseLife: 1500,  idleSpin: true,
  },
};

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

/**
 * A first guess, made before a single frame has been drawn — so it is made
 * from the few things a browser will admit to up front, and it guesses low.
 * Every one of these signals is weak on its own; together they are enough to
 * tell a phone from a workstation, which is all the opening frame needs.
 */
export function guessLevel() {
  const saved = read(KEY);
  if (LEVELS.includes(saved)) return { level: saved, auto: false, why: "your choice" };

  const mem = navigator.deviceMemory || 0;            // GB, coarse, often absent
  const cores = navigator.hardwareConcurrency || 0;
  const coarse = matchMedia("(pointer: coarse)").matches;
  const small = Math.min(innerWidth, innerHeight) < 700;
  const saveData = navigator.connection?.saveData === true;

  if (saveData) return { level: "performance", auto: true, why: "data saver is on" };
  if (coarse && small) return { level: "performance", auto: true, why: "phone-sized touch screen" };
  if (mem && mem <= 4) return { level: "performance", auto: true, why: `${mem}GB of memory reported` };
  if (cores && cores <= 4) return { level: "performance", auto: true, why: `${cores} cores reported` };
  return { level: "balanced", auto: true, why: "starting conservatively" };
}

export function saveLevel(level) { if (LEVELS.includes(level)) write(KEY, level); }
export const muted = () => read(MUTE) !== "0";       // muted unless explicitly unmuted
export const setMuted = (v) => write(MUTE, v ? "1" : "0");

/**
 * The frame watcher.
 *
 * It measures the median of a rolling window rather than the mean, because
 * the thing that ruins a mean is exactly the thing this must not react to: a
 * single 400ms frame when the browser decided to garbage-collect. A median
 * over sixty frames answers "is this generally bad", which is the question.
 */
export function makeWatcher({ onDown, onUp, target = 34 }) {
  const frames = new Array(60).fill(16);
  let i = 0, filled = 0, badFor = 0, goodFor = 0, enabled = true, last = performance.now();

  const median = () => {
    const s = frames.slice(0, Math.max(1, filled)).sort((a, b) => a - b);
    return s[s.length >> 1];
  };

  return {
    get enabled() { return enabled; },
    set enabled(v) { enabled = v; badFor = goodFor = 0; },
    /** Called once per rendered frame. Cheap on purpose. */
    tick(now) {
      const dt = now - last; last = now;
      if (dt > 0 && dt < 2000) { frames[i] = dt; i = (i + 1) % frames.length; filled = Math.min(60, filled + 1); }
      if (!enabled || filled < 45) return;
      const fps = 1000 / median();
      if (fps < target) { badFor += dt; goodFor = 0; }
      else if (fps > target + 18) { goodFor += dt; badFor = 0; }
      else { badFor = goodFor = 0; }
      if (badFor > 2000) { badFor = 0; filled = 0; onDown?.(Math.round(fps)); }
      else if (goodFor > 8000) { goodFor = 0; filled = 0; onUp?.(Math.round(fps)); }
    },
    fps: () => Math.round(1000 / median()),
  };
}

/** WebGL at all? Asked once, cheaply, and the answer decides between the
 *  scene and the flat map — not a broken canvas and an apology. */
export function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return false;
    const lose = gl.getExtension("WEBGL_lose_context");
    lose?.loseContext?.();
    return true;
  } catch { return false; }
}

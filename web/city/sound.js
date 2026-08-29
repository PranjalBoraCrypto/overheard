/**
 * city/sound.js — the city, quietly.
 *
 * MUTED UNTIL ASKED. Sound that starts on its own is a page somebody closes,
 * and a browser will refuse to start an audio context before a gesture
 * anyway. Nothing here runs until the visitor unmutes.
 *
 * SYNTHESISED, NOT LOADED. Every sound is two oscillators and an envelope, so
 * the whole soundtrack costs no bytes, no decode, no cache entry and no
 * request. It also means the palette is small on purpose: a soft wooden tick
 * when a message lands, a fifth when a district opens, a short rising pair on
 * a selection, and a low sine bed that only exists inside a room.
 *
 * It is also rate-limited, hard. A busy room can deliver forty messages in a
 * second and forty ticks in a second is a fault condition, not a soundtrack —
 * so ticks are capped, detuned slightly by sequence so a burst reads as
 * texture rather than a machine gun, and skipped entirely while the tab is
 * hidden.
 */

let ctx = null, master = null, bed = null, bedGain = null;
let on = false;
let lastTick = 0, ticksThisSecond = 0, secondStart = 0;

const TICK_CAP = 6;            // per second, whatever arrives

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.0;
  master.connect(ctx.destination);
  return ctx;
}

export function setEnabled(v) {
  on = !!v;
  if (!on) {
    if (master) master.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
    return;
  }
  if (!ensure()) return;
  ctx.resume?.();
  /* 0.5 was too quiet to be heard at all on laptop speakers once the
     per-sound peaks (0.055 for a tick) were multiplied through it — the
     whole soundtrack was technically present and practically inaudible,
     which is indistinguishable from broken. */
  master.gain.setTargetAtTime(0.85, ctx.currentTime, 0.15);
}
export const enabled = () => on;

function env(node, t0, peak, attack, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  node.connect(g); g.connect(master);
  return g;
}

function blip(freq, { type = "sine", peak = 0.09, attack = 0.006, decay = 0.16, detune = 0 } = {}) {
  if (!on || !ctx || document.hidden) return;
  const t0 = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = type; o.frequency.value = freq; o.detune.value = detune;
  env(o, t0, peak, attack, decay);
  o.start(t0); o.stop(t0 + attack + decay + 0.02);
}

/** A message landed. The pitch drifts a little with the sequence number so a
 *  burst sounds like rain rather than one note repeated. */
export function tick(seq = 0, kind = "message") {
  if (!on || !ctx) return;
  const now = performance.now();
  if (now - secondStart > 1000) { secondStart = now; ticksThisSecond = 0; }
  if (ticksThisSecond >= TICK_CAP) return;
  if (now - lastTick < 45) return;
  ticksThisSecond++; lastTick = now;

  const n = Number(String(seq).slice(-3)) || 0;
  const base =
    kind === "job" ? 520 :
    kind === "claim" ? 620 :
    kind === "deliver" ? 700 :
    kind === "attest" ? 780 : 460;
  blip(base, { type: "triangle", peak: 0.13, decay: 0.15, detune: (n % 24) * 5 - 60 });
}

/** Entering a district or a room: a fifth, warm, once. */
export function arrive() {
  if (!on || !ctx) return;
  blip(294, { type: "sine", peak: 0.24, attack: 0.01, decay: 0.5 });
  setTimeout(() => blip(441, { type: "sine", peak: 0.17, attack: 0.01, decay: 0.6 }), 70);
}

/** A selection: short, rising, unmistakably a confirmation. */
export function pick() {
  blip(660, { type: "sine", peak: 0.15, decay: 0.10 });
  setTimeout(() => blip(880, { type: "sine", peak: 0.11, decay: 0.12 }), 55);
}

/** The room bed. A single low sine, barely there, so leaving a room is
 *  audible as a change of space rather than as silence being switched off. */
export function bedOn(v) {
  if (!on || !ensure()) return;
  if (v && !bed) {
    /* 58Hz was below what a laptop speaker can physically reproduce, so the
       "change of space" on entering a room was silent on exactly the
       hardware most people are using. 116Hz is the same note an octave up:
       still a low bed, and one that actually comes out of the box. */
    bed = ctx.createOscillator(); bed.type = "sine"; bed.frequency.value = 116;
    bedGain = ctx.createGain(); bedGain.gain.value = 0.0001;
    bed.connect(bedGain); bedGain.connect(master); bed.start();
    bedGain.gain.setTargetAtTime(0.055, ctx.currentTime, 1.2);
  } else if (!v && bed) {
    const b = bed, g = bedGain; bed = null; bedGain = null;
    g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.4);
    setTimeout(() => { try { b.stop(); } catch {} }, 1500);
  }
}

export function dispose() {
  bedOn(false);
  try { ctx?.close(); } catch {}
  ctx = null; master = null; on = false;
}

/**
 * city/sound.js — the city, quietly. NOTHING HERE IS MUSIC.
 *
 * There WAS music: five chiptune loops on a scheduler. It is gone, on
 * purpose, and the reason is worth keeping written down because it is the
 * same reason the rest of this page is built the way it is.
 *
 * A loop plays the same notes whatever the network is doing. It is decoration
 * over a page whose whole claim is that what you see is what is happening —
 * and worse, it competes with the sounds that ARE readings. Every sound this
 * module now makes is caused by something in the data:
 *
 *   TICK        a message genuinely arrived. Pitched by which room it landed
 *               in, so a busy district has a recognisable voice.
 *   SURGE       a room's rate jumped well past its own normal. The audio half
 *               of the flash on its roof.
 *   TONE        one low note under everything, whose pitch and loudness track
 *               how busy the whole city is. Not a drone: a dial you can hear.
 *               Silent when the city is idle, because that is a reading too.
 *   ARRIVE/PICK movement. The camera landing, walking into a room, choosing
 *               something. Feedback for your own actions, not claims about
 *               the network — and the only sounds here that are not data.
 *
 * MUTED UNTIL ASKED. Sound that starts on its own is a page somebody closes,
 * and a browser will refuse to start an audio context before a gesture
 * anyway. Nothing here runs until the visitor unmutes.
 *
 * SYNTHESISED, NOT LOADED. Every sound is one or two oscillators and an
 * envelope: no bytes, no decode, no cache entry, no request.
 *
 * RATE-LIMITED, HARD. A busy room can deliver forty messages a second, and
 * forty ticks a second is a fault condition rather than a soundtrack. Ticks
 * are capped, spaced, detuned by sequence so a burst reads as rain rather
 * than a machine gun, and skipped entirely while the tab is hidden. Above the
 * cap the city tone carries the load instead, which is the honest way to say
 * "more than you can count" without saying it forty times.
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
    /* Torn down, not just turned down. A tone left running behind a zeroed
       master is two oscillators burning battery to be inaudible, and it is
       also the bug where unmuting later brings back a reading taken minutes
       ago as if it were current. */
    toneOff();
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

/** Cheap string hash, so a room always sounds like itself. */
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

/* A pentatonic ladder. Ticks land on scale degrees rather than on arbitrary
   frequencies for one practical reason: a dozen rooms ticking at once on
   arbitrary pitches is noise, and the same dozen on five notes of one scale
   is a texture you can listen to for an hour. It is not a tune — nothing
   chooses the order but the network. */
const LADDER = [392.00, 440.00, 523.25, 587.33, 659.25, 783.99, 880.00];

/**
 * A message landed.
 *
 * `room` picks the note, so the district you are looking at has a pitch you
 * come to recognise and a message from somewhere else is audibly from
 * somewhere else. `kind` picks the timbre. `seq` detunes by a few cents so
 * two messages in the same room are not the identical sample twice.
 */
export function tick(seq = 0, kind = "message", room = "") {
  if (!on || !ctx) return;
  const now = performance.now();
  if (now - secondStart > 1000) { secondStart = now; ticksThisSecond = 0; }
  if (ticksThisSecond >= TICK_CAP) return;
  if (now - lastTick < 45) return;
  ticksThisSecond++; lastTick = now;

  const n = Number(String(seq).slice(-3)) || 0;
  const note = LADDER[Math.floor(hash(room || "·") * LADDER.length)];
  /* Signed, structured work sounds brighter and shorter than chatter. That is
     a real distinction in this network, not a decorative one. */
  const bright = kind === "job" || kind === "claim" || kind === "deliver" || kind === "attest";
  blip(note * (bright ? 1 : 0.5), {
    type: bright ? "triangle" : "sine",
    peak: bright ? 0.115 : 0.085,
    decay: bright ? 0.13 : 0.22,
    detune: (n % 24) * 3 - 36,
  });
}

/**
 * A room went hot: its rate jumped well above its own normal. Two notes a
 * fourth apart, rising, quiet enough to sit under a tick — the ear reads
 * "something changed there" without being interrupted.
 *
 * Deliberately harder to trigger than the roof flash. A flash is cheap and
 * you can look away from it; a sound you cannot, so this fires at most once
 * every few seconds however many rooms surge at once.
 */
let lastSurge = 0;
export function surge(room = "", strength = 1) {
  if (!on || !ctx) return;
  const now = performance.now();
  if (now - lastSurge < 2600) return;
  lastSurge = now;
  const note = LADDER[Math.floor(hash(room || "·") * LADDER.length)];
  const peak = 0.10 + Math.min(0.7, strength) * 0.08;
  blip(note, { type: "sine", peak, attack: 0.012, decay: 0.34 });
  setTimeout(() => blip(note * 4 / 3, { type: "sine", peak: peak * 0.8, attack: 0.012, decay: 0.5 }), 95);
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

/* ══════════════════════════════════════════════════════════════════════════
   THE CITY TONE — a dial, not a drone
   ══════════════════════════════════════════════════════════════════════════

   One low note under the whole overview, whose pitch and loudness follow the
   city's total measured rate. It is the closest thing here to ambience and it
   is still a reading: an idle city is SILENT, and a busy one is audibly
   higher and fuller than a slow one. If Technocore stops, this stops, which
   is the property a loop could never have.

   Two oscillators a hair apart rather than one. A single sine at this pitch
   is a test tone and sounds like a fault; the beating between two of them is
   what makes it read as a room full of machines instead. */
let tone = null;
export function cityTone(perMin) {
  if (!on || !ensure()) { if (!on) toneOff(); return; }
  /* Compressed hard. The difference between an idle city and a slow one
     matters and the difference between busy and very busy does not, so this
     is a log curve, not a linear one. */
  const r = Math.max(0, Number(perMin) || 0);
  const load = Math.min(1, Math.log10(1 + r) / 2.6);

  if (load < 0.02) return toneOff();
  if (!tone) {
    const g = ctx.createGain(); g.gain.value = 0.0001; g.connect(master);
    const a = ctx.createOscillator(), b = ctx.createOscillator();
    a.type = b.type = "sine";
    a.connect(g); b.connect(g); a.start(); b.start();
    tone = { g, a, b };
  }
  /* 87Hz to 146Hz: low enough to sit under everything, high enough that a
     laptop speaker actually reproduces it — the same lesson the room bed
     taught at 58Hz, where the sound existed and nobody could hear it. */
  const hz = 87 + load * 59;
  const t = ctx.currentTime;
  tone.a.frequency.setTargetAtTime(hz, t, 1.8);
  tone.b.frequency.setTargetAtTime(hz * 1.008, t, 1.8);
  tone.g.gain.setTargetAtTime(0.018 + load * 0.05, t, 2.2);
}

function toneOff() {
  if (!tone) return;
  const t = tone; tone = null;
  try { t.g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.6); } catch {}
  setTimeout(() => { try { t.a.stop(); t.b.stop(); t.g.disconnect(); } catch {} }, 2400);
}
export const toneRunning = () => !!tone;
/** Stop the tone without arguing about the rate — used on entering a room,
 *  where the city is no longer what you are listening to. */
export function cityToneOff() { toneOff(); }

export function dispose() {
  toneOff();
  bedOn(false);
  try { ctx?.close(); } catch {}
  ctx = null; master = null; on = false; tone = null; bed = null; bedGain = null;
}


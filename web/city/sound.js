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

/* ══════════════════════════════════════════════════════════════════════════
   THE CITY'S MUSIC
   ══════════════════════════════════════════════════════════════════════════

   Five short chiptune loops for the overview, and silence inside a room.

   WHY IT IS SYNTHESISED AND NOT FIVE MP3 FILES. Five loops of any listenable
   length is megabytes, on a page that already loads a 3D engine, and a
   visitor who never turns sound on pays for all of it. This is four
   oscillators and a scheduler: no bytes, no decode, no cache entries, no
   requests, and it starts the instant it is asked rather than after a
   download. The 8-bit palette is not a compromise made to fit that — square
   and triangle waves with hard envelopes are exactly what the format IS, and
   the constraint that makes chiptune sound like chiptune is the same one
   that makes it free.

   WHY LOOK-AHEAD SCHEDULING. setTimeout is accurate to tens of milliseconds
   on a good day and to whole frames when a 3D scene is drawing, which is
   audible as a stumbling beat. So a timer wakes four times a second and
   books every note due in the next quarter second onto the audio clock,
   which is sample-accurate and does not care what the renderer is doing.
   The music stays in time through a frame drop that would ruin it.

   WHY IT STOPS IN A ROOM. A room has its own sound — the low bed, the ticks
   of messages arriving — and those are information. Music over the top would
   be competing with the thing a visitor went in there to hear.

   NOTHING HERE IS A CLAIM ABOUT THE NETWORK. This is atmosphere and it says
   so by never changing with the data: the same five loops in the same order
   whatever Technocore is doing. The city's honesty is in what it DRAWS. */

/* Semitone offsets from the root, as scale degrees. Minor pentatonic and
   dorian: the two scales that sound "thoughtful machine" rather than
   "video game victory", which is the wrong register for a page about a
   network of strangers talking. */
const SCALES = {
  minPent: [0, 3, 5, 7, 10],
  dorian:  [0, 2, 3, 5, 7, 9, 10],
};

/** The five loops. Each is a bass figure, a lead phrase and a rest pattern —
 *  deliberately sparse, because this plays for as long as somebody keeps the
 *  page open and a busy loop becomes unbearable in about ninety seconds. */
const TRACKS = [
  { name: "drift",    root: 55.00, bpm: 76,  scale: "minPent",
    lead: [0, 2, 4, 2, 3, 2, 0, -1], bass: [0, 0, 3, 0], gap: 2, wave: "square", duty: 0.5 },
  { name: "ledger",   root: 61.74, bpm: 84,  scale: "dorian",
    lead: [0, 3, 5, 4, 2, 4, 3, 1], bass: [0, 5, 3, 5], gap: 3, wave: "square", duty: 0.25 },
  { name: "quorum",   root: 49.00, bpm: 68,  scale: "minPent",
    lead: [4, 3, 2, 0, 2, 3, 4, 6], bass: [0, 0, 2, 4], gap: 2, wave: "triangle", duty: 0.5 },
  { name: "relay",    root: 58.27, bpm: 92,  scale: "minPent",
    lead: [0, 4, 3, 4, 0, -2, 0, 2], bass: [0, 3, 0, 5], gap: 4, wave: "square", duty: 0.125 },
  { name: "longwave", root: 46.25, bpm: 60,  scale: "dorian",
    lead: [0, 2, 3, 2, 0, -3, 0, 1], bass: [0, 0, 4, 2], gap: 3, wave: "triangle", duty: 0.5 },
];

let music = null;      // { gain, timer, step, at, track, order, plays }

/** Degree → frequency, wrapping octaves so a phrase can walk off either end
 *  of the scale without leaving the key. */
function noteHz(root, scaleName, degree) {
  const sc = SCALES[scaleName];
  const oct = Math.floor(degree / sc.length);
  const semi = sc[((degree % sc.length) + sc.length) % sc.length] + oct * 12;
  return root * Math.pow(2, semi / 12);
}

/** One 8-bit voice: an oscillator with a hard attack and a short tail. The
 *  square's "duty" is faked by detuning a second oscillator against it,
 *  which is what gives 12.5% its thin, reedy character without needing a
 *  custom PeriodicWave. */
function voice(hz, t0, dur, { wave = "square", duty = 0.5, peak = 0.06 } = {}) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
  g.gain.setValueAtTime(peak, t0 + dur * 0.55);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  g.connect(music.gain);

  const o = ctx.createOscillator();
  o.type = wave; o.frequency.value = hz;
  o.connect(g); o.start(t0); o.stop(t0 + dur + 0.02);

  if (wave === "square" && duty !== 0.5) {
    const o2 = ctx.createOscillator();
    o2.type = "square"; o2.frequency.value = hz;
    o2.detune.value = duty < 0.2 ? 32 : 14;
    const g2 = ctx.createGain();
    g2.gain.value = 0.55;
    o2.connect(g2); g2.connect(g);
    o2.start(t0); o2.stop(t0 + dur + 0.02);
  }
}

/* Look-ahead: book everything due in the next quarter second. */
const LOOK = 0.25, TICK_MS = 90;

function schedule() {
  if (!music || !ctx) return;
  const t = TRACKS[music.order[music.track]];
  const beat = 60 / t.bpm / 2;                  // eighth notes
  while (music.at < ctx.currentTime + LOOK) {
    const i = music.step;
    const bar = Math.floor(i / 8);

    /* The lead rests every `gap` bars. Space is what stops a loop from
       becoming a nag — the pattern you remember is the one that stops. */
    if (bar % t.gap !== t.gap - 1) {
      const d = t.lead[i % t.lead.length];
      voice(noteHz(t.root * 4, t.scale, d), music.at, beat * 0.9,
        { wave: t.wave, duty: t.duty, peak: 0.038 });
    }
    /* Bass on every other eighth, an octave and a half below. */
    if (i % 2 === 0) {
      const b = t.bass[Math.floor(i / 2) % t.bass.length];
      voice(noteHz(t.root, t.scale, b), music.at, beat * 1.6,
        { wave: "triangle", peak: 0.075 });
    }
    music.at += beat;
    music.step++;

    /* Four bars each, then the next track. Five tracks and a shuffled order
       means the page does not open with the same eight notes every time. */
    if (music.step >= 32) {
      music.step = 0;
      music.track = (music.track + 1) % music.order.length;
      if (music.track === 0) shuffle(music.order);
    }
  }
  music.timer = setTimeout(schedule, TICK_MS);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Music on or off. Called with false on entering a room and true on leaving
 * it, and it is a no-op whenever sound as a whole is muted.
 */
export function musicOn(v) {
  if (v) {
    if (!on || !ensure() || music) return;
    const gain = ctx.createGain();
    /* Well under the effects. It is the floor of the room, not the thing in
       it — a soundtrack that competes with the tick of a message arriving is
       drowning out the only part of this that is information. */
    gain.gain.value = 0.0001;
    gain.connect(master);
    gain.gain.setTargetAtTime(0.34, ctx.currentTime, 1.4);
    music = { gain, timer: 0, step: 0, at: ctx.currentTime + 0.12, track: 0,
              order: shuffle(TRACKS.map((_, i) => i)) };
    schedule();
  } else if (music) {
    const m = music;
    music = null;
    clearTimeout(m.timer);
    m.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.5);
    setTimeout(() => { try { m.gain.disconnect(); } catch {} }, 2200);
  }
}
export const musicPlaying = () => !!music;
/** Which loop is playing, for the tests and for anybody curious. */
export const musicTrack = () => (music ? TRACKS[music.order[music.track]].name : null);

export function dispose() {
  musicOn(false);
  bedOn(false);
  try { ctx?.close(); } catch {}
  ctx = null; master = null; on = false;
}

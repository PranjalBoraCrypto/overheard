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
 *               in, so a busy district has a voice you come to recognise.
 *   SURGE       a room's rate jumped well past its own normal. The audio half
 *               of the flash on its roof.
 *   AIR         one soft chord under the overview, whose brightness tracks
 *               how busy the whole city is. Silent when the city is idle,
 *               because that is a reading too.
 *   ARRIVE/PICK movement. The camera landing, walking into a room, choosing
 *               something. Feedback for your own actions, not claims about
 *               the network — and the only sounds here that are not data.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHY IT SOUNDS THE WAY IT DOES
 *
 * The first version was raw oscillators straight into a gain node, and it
 * sounded like exactly that: a test tone. Three things separate a sound
 * somebody is happy to hear a hundred times from one they mute.
 *
 *   STRUCK, NOT SWITCHED ON. A real note that a person likes is a body
 *   resonating: a very fast attack, a bright inharmonic partial that dies
 *   away first, and a fundamental that rings on. Two oscillators and two
 *   envelopes with DIFFERENT decay times is the whole trick — the partial
 *   gives the strike, the fundamental gives the tone.
 *
 *   ROOM. Every sound goes through a short synthesised reverb — an impulse
 *   response generated from decaying noise, about forty milliseconds of maths
 *   and no bytes. It is the difference between a beep and an instrument.
 *
 *   NO BEATING. The old city tone was two sines detuned by 0.8%, which at
 *   146Hz is a 1.2Hz amplitude beat: an audible WOMP, once a second, forever.
 *   It read as a fault, and reported as one. Intervals here are exact ratios
 *   — a fifth, an octave — so the chord is still and the movement is in a
 *   filter instead.
 *
 * MUTED UNTIL ASKED. A browser will refuse to start an audio context before a
 * gesture anyway, and sound that starts on its own is a page somebody closes.
 *
 * RATE-LIMITED, HARD. A busy room can deliver forty messages a second, and
 * forty ticks a second is a fault condition rather than a soundtrack. Ticks
 * are capped, spaced, and skipped while the tab is hidden. Above the cap the
 * air carries the load instead, which is the honest way to say "more than you
 * can count" without saying it forty times.
 */

let ctx = null, master = null, wet = null, verb = null, comp = null;
let bed = null, bedGain = null;
let on = false;
let lastTick = 0, ticksThisSecond = 0, secondStart = 0;

const TICK_CAP = 6;            // per second, whatever arrives

/** A short, bright room. Forty milliseconds of decaying noise is enough to
 *  turn a bare oscillator into something that sounds like it happened
 *  somewhere, and it costs one buffer allocated once. */
function impulse(seconds = 1.5, decay = 3.4) {
  const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      /* Noise under a power curve. The randomness is the room's texture; the
         curve is how fast it stops being a room and starts being silence. */
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
  }
  return buf;
}

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();

  master = ctx.createGain();
  master.gain.value = 0.0;

  /* A limiter on the end, because these sounds are event-driven and events
     arrive together. Six ticks, a surge and the air all landing in the same
     200ms is a peak nothing else in the chain is protecting against, and
     clipping is the single most unpleasant thing a page can do to somebody
     wearing headphones. */
  comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 22;
  comp.ratio.value = 6;
  comp.attack.value = 0.004;
  comp.release.value = 0.18;

  verb = ctx.createConvolver();
  verb.buffer = impulse(1.6, 3.6);
  wet = ctx.createGain();
  wet.gain.value = 0.30;

  master.connect(comp);
  wet.connect(verb); verb.connect(comp);
  comp.connect(ctx.destination);
  return ctx;
}

export function setEnabled(v) {
  on = !!v;
  if (!on) {
    if (master) master.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
    /* Torn down, not just turned down. Air left running behind a zeroed
       master is oscillators burning battery to be inaudible, and it is also
       the bug where unmuting later brings back a reading taken minutes ago
       as if it were current. */
    airOff();
    return;
  }
  if (!ensure()) return;
  ctx.resume?.();
  master.gain.setTargetAtTime(0.8, ctx.currentTime, 0.15);
}
export const enabled = () => on;

/**
 * One struck note.
 *
 * Two partials with different decays is what makes this read as a physical
 * thing being hit rather than as a tone being switched on: the upper partial
 * is the strike and is gone in a moment, the fundamental is the body and
 * rings out under it. `send` is how much of it goes to the room.
 */
function strike(hz, {
  peak = 0.09, decay = 0.5, partial = 2.76, pgain = 0.4, pdecay = 0.16,
  type = "sine", send = 0.5, when = 0, glide = 0,
} = {}) {
  if (!on || !ctx || document.hidden) return;
  const t0 = ctx.currentTime + when;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  /* 4ms, not instant. A true step is a click; four milliseconds is still
     percussive and has no edge on it. */
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.004 + decay);
  g.connect(master);
  const s = ctx.createGain();
  s.gain.value = send;
  g.connect(s); s.connect(wet);

  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(hz, t0);
  /* A small downward glide on the fundamental. Struck bodies go slightly flat
     as they lose energy, and the ear reads the absence of it as synthetic. */
  if (glide) o.frequency.exponentialRampToValueAtTime(hz * (1 - glide), t0 + decay);
  o.connect(g); o.start(t0); o.stop(t0 + decay + 0.1);

  /* 2.76 is roughly the first inharmonic partial of a struck bar — the
     interval that makes a marimba sound like wood rather than like a sine. */
  if (pgain > 0) {
    const pg = ctx.createGain();
    pg.gain.setValueAtTime(0.0001, t0);
    pg.gain.exponentialRampToValueAtTime(peak * pgain, t0 + 0.003);
    pg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.003 + pdecay);
    pg.connect(master);
    const ps = ctx.createGain(); ps.gain.value = send * 0.7;
    pg.connect(ps); ps.connect(wet);

    const po = ctx.createOscillator();
    po.type = "sine"; po.frequency.value = hz * partial;
    po.connect(pg); po.start(t0); po.stop(t0 + pdecay + 0.1);
  }
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
const noteFor = (room) => LADDER[Math.floor(hash(room || "·") * LADDER.length)];

/**
 * A message landed.
 *
 * `room` picks the note, so the district you are watching has a pitch you
 * learn and a message from somewhere else is audibly from somewhere else.
 * `kind` picks the body: signed, structured work is a brighter, shorter
 * strike than chatter, which is a real distinction in this network rather
 * than a decorative one.
 */
export function tick(seq = 0, kind = "message", room = "") {
  if (!on || !ctx) return;
  const now = performance.now();
  if (now - secondStart > 1000) { secondStart = now; ticksThisSecond = 0; }
  if (ticksThisSecond >= TICK_CAP) return;
  if (now - lastTick < 45) return;
  ticksThisSecond++; lastTick = now;

  const structured = kind === "job" || kind === "claim" || kind === "result" || kind === "attest";
  const note = noteFor(room);
  /* Chatter an octave down and rounder; structured work up where the
     ear notices it. Neither is loud. */
  strike(structured ? note : note * 0.5, {
    peak: structured ? 0.085 : 0.065,
    decay: structured ? 0.42 : 0.85,
    partial: structured ? 2.76 : 2.0,
    pgain: structured ? 0.42 : 0.16,
    pdecay: structured ? 0.13 : 0.2,
    send: structured ? 0.55 : 0.4,
    glide: 0.004,
  });
}

/**
 * A room went hot: its rate jumped well past its own normal. A rising fifth,
 * struck twice, with more room on it — the ear reads "something changed over
 * there" without being interrupted.
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
  const note = noteFor(room) * 0.5;
  const peak = 0.075 + Math.min(1, strength) * 0.035;
  strike(note, { peak, decay: 0.8, partial: 2.0, pgain: 0.3, send: 0.7, glide: 0.003 });
  strike(note * 1.5, { peak: peak * 0.85, decay: 1.1, partial: 2.0, pgain: 0.24,
    send: 0.8, when: 0.11, glide: 0.003 });
}

/** Entering a district or a room: a fifth, warm, once, with the room open. */
export function arrive() {
  if (!on || !ctx) return;
  strike(196, { peak: 0.11, decay: 1.0, partial: 2.0, pgain: 0.2, send: 0.75, glide: 0.005 });
  strike(294, { peak: 0.09, decay: 1.3, partial: 2.0, pgain: 0.18, send: 0.85, when: 0.09 });
}

/** A selection: short, rising, unmistakably a confirmation. */
export function pick() {
  strike(659.25, { peak: 0.055, decay: 0.18, partial: 3.0, pgain: 0.3, pdecay: 0.06, send: 0.35 });
  strike(987.77, { peak: 0.04, decay: 0.22, partial: 3.0, pgain: 0.2, pdecay: 0.05,
    send: 0.45, when: 0.055 });
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
    bedGain.gain.setTargetAtTime(0.05, ctx.currentTime, 1.2);
  } else if (!v && bed) {
    const b = bed, g = bedGain; bed = null; bedGain = null;
    g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.4);
    setTimeout(() => { try { b.stop(); } catch {} }, 1500);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   THE AIR — a dial you can hear, not a drone
   ══════════════════════════════════════════════════════════════════════════

   One soft chord under the overview whose BRIGHTNESS follows the city's total
   measured rate. It is the closest thing here to ambience and it is still a
   reading: an idle city is silent, and a busy one is audibly more open than a
   slow one. If Technocore stops, this stops, which is a property no loop
   could have.

   WHAT WENT WRONG THE FIRST TIME, because it is a good lesson. It was two
   sines detuned by 0.8% and it moved by getting LOUDER and HIGHER. Detuning
   two sines makes them beat at the difference frequency: at 146Hz, 0.8% is a
   1.2Hz amplitude modulation — a womp, once a second, indefinitely. Reported,
   correctly, as unbearable.

   So: exact ratios, which do not beat at all. Root, fifth, octave — one still
   chord. And the movement is a lowpass filter opening and closing instead of
   the amplitude changing, which the ear reads as a room getting busier rather
   than as something being turned up. The gain barely moves and never gets
   near the level of a tick, because the events are the information and this
   is the floor they stand on. */
let air = null;

/**
 * @param perMin the city's total measured rate. Real values run from zero to
 *        tens of thousands, which is why the curve below is logarithmic and
 *        anchored at 20,000 rather than at the 400 the first version assumed
 *        — that mistake pinned the filter wide open on every real reading and
 *        made the tone a constant, maximally bright drone.
 */
export function cityTone(perMin) {
  if (!on || !ensure()) { if (!on) airOff(); return; }
  const r = Math.max(0, Number(perMin) || 0);
  const load = Math.min(1, Math.log10(1 + r) / Math.log10(20001));

  if (load < 0.02) return airOff();
  if (!air) {
    const g = ctx.createGain(); g.gain.value = 0.0001;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = 200; f.Q.value = 0.7;
    g.connect(f); f.connect(master);
    /* A little of it in the room, so it sits behind the strikes rather than
       in front of them. */
    const s = ctx.createGain(); s.gain.value = 0.5;
    f.connect(s); s.connect(wet);

    /* Root, fifth, octave — exact ratios. No beating by construction. */
    const os = [1, 1.5, 2].map((mul, i) => {
      const o = ctx.createOscillator();
      o.type = i === 2 ? "triangle" : "sine";
      o.frequency.value = 98 * mul;
      const og = ctx.createGain();
      og.gain.value = i === 0 ? 1 : i === 1 ? 0.42 : 0.16;
      o.connect(og); og.connect(g); o.start();
      return o;
    });
    air = { g, f, os, s };
  }
  const t = ctx.currentTime;
  /* Slow, on purpose. Twelve seconds to cross the range means the air answers
     the network's shape over minutes and never twitches at one poll. */
  air.f.frequency.setTargetAtTime(200 + load * 1500, t, 12);
  air.g.gain.setTargetAtTime(0.016 + load * 0.014, t, 12);
}

function airOff() {
  if (!air) return;
  const a = air; air = null;
  try { a.g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.7); } catch {}
  setTimeout(() => {
    try { a.os.forEach((o) => o.stop()); a.g.disconnect(); a.f.disconnect(); a.s.disconnect(); } catch {}
  }, 3000);
}
export const toneRunning = () => !!air;
/** Stop the air without arguing about the rate — used on entering a room,
 *  where the city is no longer what you are listening to. */
export function cityToneOff() { airOff(); }

export function dispose() {
  airOff();
  bedOn(false);
  try { ctx?.close(); } catch {}
  ctx = null; master = null; wet = null; verb = null; comp = null;
  on = false; air = null; bed = null; bedGain = null;
}

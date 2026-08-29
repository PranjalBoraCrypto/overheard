/**
 * city/place.js — where everything stands, and why it never moves.
 *
 * This is the layout, on its own, with no renderer attached to it. Both views
 * of the city import it: the 3D scene in world.js and the flat map in
 * flat.js. That matters more than it looks. If each view worked out its own
 * positions, a visitor whose machine dropped them into the 2D map would land
 * in a *different city* — same rooms, different places — and everything they
 * had learned about where things are would be wrong. One layout, two ways of
 * drawing it.
 *
 * PLACEMENT IS A PURE FUNCTION OF THE NAME. A room's position comes from a
 * hash of its name and from nothing else: not its traffic, not the order the
 * directory returned it, not the time of day. Reload the page tomorrow and
 * every building is where you left it.
 */

/* Six districts, hand-placed. Angles chosen so the skyline reads from the
   default camera: the two tallest are not adjacent, and nothing occludes the
   plaza in the middle. */
export const DISTRICTS = [
  { room: "lobby",      title: "Lobby",      sub: "arrival plaza",       x: 0,   z: 0,   r: 30, kind: "plaza" },
  { room: "technocore", title: "Technocore", sub: "communication core",  x: 8,   z: -86, r: 26, kind: "core" },
  { room: "kibble",     title: "Kibble",     sub: "work and delivery",   x: 86,  z: -30, r: 26, kind: "works" },
  { room: "validators", title: "Validators", sub: "signal verification", x: -84, z: -34, r: 24, kind: "dome" },
  { room: "gpu-miners", title: "GPU Miners", sub: "compute and energy",  x: -70, z: 62,  r: 26, kind: "racks" },
  { room: "flop",       title: "Flop",       sub: "coordination",        x: 76,  z: 66,  r: 24, kind: "tower" },
];

export const TAU = Math.PI * 2;

/** How far the camera may wander from the middle. The city is deliberately
 *  compact: a plate much wider than the buildings on it reads as an empty
 *  car park with a village in the middle, which is what the first framing of
 *  this page looked like. */
export const CITY_R = 132;

/**
 * Where a room stands. Hash in, position out, and nothing else in the
 * expression. Rooms ring the plaza in three bands; the band comes from the
 * hash too, so a busy room and a quiet one are equally likely to be near the
 * middle. Prominence is light's job, not geography's.
 */
export function placeRoom(name, slot) {
  const a = ((slot % 4096) / 4096) * TAU;
  const band = (slot >>> 12) % 3;
  const base = [42, 70, 100][band];
  const jit = (((slot >>> 20) % 1000) / 1000 - 0.5) * 18;
  let x = Math.cos(a) * (base + jit);
  let z = Math.sin(a) * (base + jit);
  /* Nudged clear of every district's footprint — and by a wide margin, not a
     token one. The six landmarks are the reason the skyline is recognisable,
     and an ordinary room standing shoulder to shoulder with the observatory
     hides it. Each district keeps a ring of open ground around it. */
  for (const d of DISTRICTS) {
    const dx = x - d.x, dz = z - d.z, dist = Math.hypot(dx, dz);
    const keep = d.r + 21;
    if (dist < keep && dist > 0.001) { x = d.x + (dx / dist) * keep; z = d.z + (dz / dist) * keep; }
  }
  return { x, z };
}

/**
 * Where an identity stands inside the room it is speaking in. Same argument
 * as placeRoom: from the identity, so the same agent keeps the same spot for
 * as long as it is here, and nobody wanders about to make the scene look
 * busy.
 *
 * The ring sits OUTSIDE the structures at the middle of a district. Standing
 * the agents at the centre put them inside the buildings, where the only
 * thing visible was their speech bubbles floating over a roof.
 */
export function placeAgent(slot, cx = 0, cz = 0, r0 = 16, r1 = 28) {
  const ang = ((slot % 4096) / 4096) * TAU;
  const rad = r0 + (((slot >>> 12) % 100) / 100) * (r1 - r0);
  return { x: cx + Math.cos(ang) * rad, z: cz + Math.sin(ang) * rad };
}

/** The outer blocks: one per share of the rooms the directory would not name.
 *  Identical arithmetic in both views, so the counts line up. */
export function placeBlocks(n, unnamed) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + 0.2;
    const rad = 121 + (i % 2) * 11;
    out.push({
      i, a,
      x: Math.cos(a) * rad,
      z: Math.sin(a) * rad,
      w: 8 + (i % 3) * 1.6,
      count: Math.round((unnamed || 0) / n),
    });
  }
  return out;
}

/** A building's height, and in the flat map its dot size: total traffic on a
 *  log scale. It does not change while you watch — the skyline is history,
 *  and live activity is the light.
 *
 *  The range is deliberately wide. A city seen from four hundred units away
 *  is only legible if the difference between a room with a thousand messages
 *  and one with eight million is a difference you can see from there. */
export const heightOf = (seq) => 7 + Math.min(30, Math.log10(Math.max(10, Number(seq) || 0)) * 6.0);

/**
 * city/life.js — the things that move.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS, AND WHAT WAS WRONG BEFORE IT
 *
 * The complaint was that Agent City felt like "a static 3D model with strange
 * camera animations". That was an exact diagnosis of an exact bug, and the
 * bug was not the camera. `world.update()` animated four things: a halo's
 * opacity, a pulse, a beam, and an agent's glow decay. Nothing travelled,
 * nothing turned, nothing arrived anywhere. place.js says it out loud —
 * "nobody wanders". So the only motion the page could offer was the camera's,
 * and a camera moving over a frozen model is the thing that makes a model
 * look frozen. Take the camera away and you are looking at a photograph.
 *
 * This module is the other half. It owns everything in the city that moves on
 * its own, and it is built so the answer to "is this place alive?" is yes
 * within a second of the first frame, with nobody touching anything.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THE LINE BETWEEN ATMOSPHERE AND EVIDENCE, WHICH IS NEVER CROSSED
 *
 * Two kinds of motion live here and they are not allowed to look like each
 * other, because one of them is a claim about Technocore and the other is
 * scenery.
 *
 *   AMBIENT — drones on fixed routes, traffic on the ring roads, scanners
 *   turning on the district roofs. These loop. They are not driven by data
 *   and they never pretend to be: they are always the same shapes moving at
 *   the same speed whatever the network is doing, they carry no room name,
 *   and nothing about them is reported in the feed. They exist so the city
 *   reads as a place rather than a diagram, and so a visitor who arrives
 *   during a quiet minute is not looking at a still.
 *
 *   SIGNALS — the travelling lights between buildings, and the energy a
 *   building carries. Every one of these is caused by a message that
 *   genuinely arrived. They are brighter, faster and coloured differently
 *   from the ambient layer, they always have a room behind them, and a
 *   message that came out of the archive can never spawn one. If Technocore
 *   goes quiet, this layer goes quiet, and the city visibly settles.
 *
 * A visitor who cannot tell those apart has been misled, so they are drawn
 * differently on purpose: ambient is dim, cool and slow on fixed paths;
 * signals are bright, fast, and always go from somewhere to somewhere.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * MAGNITUDE IS THE MESSAGE
 *
 * One message and forty messages must not look the same, or the city stops
 * being readable the moment anything happens. Reactions are tiered by size:
 *
 *   a single message      one light leaves the building
 *   a handful together    the building's energy lifts and holds
 *   a burst               the roof beacon flares and the district responds
 *
 * The tiers are ratios of a room's own measured rate, not absolute counts,
 * because forty messages a minute is a quiet day in the lobby and a riot
 * anywhere else.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * HOW IT STAYS CHEAP
 *
 * Everything is instanced — four InstancedMeshes for the whole layer,
 * whatever is happening — and every moving thing comes out of a fixed pool
 * that is allocated once at build and never grows. There is no physics: a
 * drone is a position on a closed curve evaluated from a clock, and a signal
 * is a parameter from 0 to 1 along an arc. Nothing collides, nothing is
 * simulated, and a frame's work is a fixed number of matrix writes that does
 * not depend on how busy Technocore is. A burst of two hundred messages
 * spawns as many signals as there are free slots and drops the rest, because
 * the alternative — a pool that grows under load — is a page that dies
 * exactly when the network gets interesting.
 */

export const TAU = Math.PI * 2;

/* Pool sizes per quality level. The PERFORMANCE row is the important one:
   it is smaller, not empty. A "performance" preset that freezes the city is
   not a performance preset, it is a broken page with an excuse — the whole
   point of this module is that the lowest tier still reads as alive. */
export const LIFE = {
  performance: { drones: 5,  cars: 10, signals: 14, beacons: 4, step: 2 },
  balanced:    { drones: 10, cars: 22, signals: 30, beacons: 7, step: 1 },
  high:        { drones: 16, cars: 38, signals: 48, beacons: 10, step: 1 },
};

/** Deterministic noise, so a route is the same route on every visit. */
function hash01(i, salt = 0) {
  let h = (i * 374761393 + salt * 668265263) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function makeLife(THREE, opts) {
  const { scene, preset, level = "balanced", reduced = false, cityR = 132 } = opts;
  const cfg = LIFE[level] || LIFE.balanced;

  /* Reduced motion is not "no life". Somebody who asked for less motion
     still deserves to see that this is a live network — what they are
     spared is the constant travel. Ambient movement stops; a signal still
     appears, and it fades in place instead of flying. */
  const travel = !reduced;

  const root = new THREE.Group();
  root.name = "life";
  scene.add(root);

  const dummy = new THREE.Object3D();
  const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

  /* ── the shared look ───────────────────────────────────────────────────
     Two materials for the whole layer. Ambient is dim and cool; signals are
     the site's cyan at full strength. Both additive and depth-write-off, so
     they read as light rather than as objects and never punch a hole in the
     fog. */
  const ambientMat = new THREE.MeshBasicMaterial({
    color: 0x2f7f96, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const signalMat = new THREE.MeshBasicMaterial({
    color: 0x8af4ff, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });

  /* The roof sweeps get their own material, much quieter than the signals.
     The first pass reused the signal material and the skyline came out
     spiked with bright white cones — which is the generic neon city this is
     supposed to avoid, and worse, it made a slow room look as loud as a
     burst. A sweep is meant to be noticed on a second look, not a first. */
  const sweepMat = new THREE.MeshBasicMaterial({
    color: 0x39c4dd, transparent: true, opacity: 0.28,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });

  const G = {
    drone: new THREE.OctahedronGeometry(1.05, 0),
    car:   new THREE.BoxGeometry(1.9, 0.5, 0.9),
    spark: new THREE.SphereGeometry(0.75, 6, 5),
    beacon: new THREE.ConeGeometry(0.5, 5.2, 4, 1, true),
  };

  const mk = (geo, mat, n) => {
    const m = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    /* CULLING OFF, AND FOR A REASON RATHER THAN BY HABIT.
       An InstancedMesh sits at the origin and puts its instances wherever
       their matrices say — so the object's own bounds describe a point in
       the middle of the plate, not the ring of drones two hundred units out.
       Left culled, this batch disappears the moment the camera looks away
       from the centre, taking every drone with it: a bug that looks exactly
       like the city dying when you turn your head. Four batches for the
       whole layer is a rounding error in the frame; the correct trade is to
       draw them always. (Culling is worth turning back ON for the buildings,
       which is a separate job — see the LOD work.) */
    m.frustumCulled = false;
    for (let i = 0; i < m.count; i++) m.setMatrixAt(i, HIDDEN);
    root.add(m);
    return m;
  };

  const drones  = mk(G.drone,  ambientMat, cfg.drones);
  const cars    = mk(G.car,    ambientMat, cfg.cars);
  const sparks  = mk(G.spark,  signalMat,  cfg.signals);
  const beacons = mk(G.beacon, sweepMat,   cfg.beacons);

  /* ── ambient: drones ───────────────────────────────────────────────────
     A closed Lissajous over the plate, evaluated from the clock. No state,
     no integration, no drift — the same drone is in the same place at the
     same second on every machine, which also means a screenshot taken for a
     test is reproducible. */
  const droneRoutes = [];
  for (let i = 0; i < cfg.drones; i++) {
    droneRoutes.push({
      rx: cityR * (0.34 + hash01(i, 1) * 0.5),
      rz: cityR * (0.34 + hash01(i, 2) * 0.5),
      a: 1 + Math.floor(hash01(i, 3) * 2),          // 1..2
      b: 2 + Math.floor(hash01(i, 4) * 2),          // 2..3
      phase: hash01(i, 5) * TAU,
      speed: 0.055 + hash01(i, 6) * 0.045,
      y: 26 + hash01(i, 7) * 30,
      bob: 1.4 + hash01(i, 8) * 2.2,
    });
  }

  /* ── ambient: ground traffic ───────────────────────────────────────────
     The ring roads already exist in the scene; these run along them. Two
     lanes, both directions, at a walking-pace-looking speed — fast traffic
     on a city this size reads as a toy. */
  const carLanes = [];
  for (let i = 0; i < cfg.cars; i++) {
    const ring = i % 3;
    carLanes.push({
      r: [46, 74, 104][ring] + (i % 2 ? 2.2 : -2.2),
      dir: i % 2 ? 1 : -1,
      t: hash01(i, 11) * TAU,
      speed: (0.055 + hash01(i, 12) * 0.03) / (1 + ring * 0.35),
    });
  }

  /* ── signals: the pool ─────────────────────────────────────────────────
     Fixed size, never grown. A slot is free when `until` has passed. */
  const pool = [];
  for (let i = 0; i < cfg.signals; i++) {
    pool.push({ live: false, x0: 0, z0: 0, y0: 0, x1: 0, z1: 0, y1: 0, born: 0, life: 1, arc: 10, size: 1 });
  }
  let cursor = 0;

  /* ── beacons: one per hot building ─────────────────────────────────────
     Not decoration: a beacon exists only where a room is actually carrying
     traffic, and its spin rate and height are that room's measured energy.
     A quiet city has no beacons at all, which is the honest picture. */
  const beaconOf = [];              // { x, z, y, energy, spin }

  /* Building positions, learned from the city. */
  let sites = new Map();            // room -> {x,z,y}
  let hot = [];                     // rooms sorted by energy, capped

  function setSites(list) {
    sites = new Map();
    for (const s of list) sites.set(s.room, s);
  }

  /** Energy per room, 0..1, from the same heat the skyline uses. */
  function setEnergy(heat) {
    hot = [];
    for (const [room, h] of heat) {
      /* A HIGH BAR, DELIBERATELY. At 0.06 almost every room in the window
         qualified and the skyline grew a sweep on nearly every roof, which
         says "everything is busy" — the one thing a heat display must never
         say. Above a third of full energy the mark means something, and a
         quiet network correctly shows almost none. */
      if (h <= 0.34) continue;
      const s = sites.get(room);
      if (!s) continue;
      hot.push({ room, x: s.x, z: s.z, y: s.y, energy: h });
    }
    hot.sort((a, b) => b.energy - a.energy);
    hot.length = Math.min(hot.length, cfg.beacons);
    beaconOf.length = 0;
    for (const h of hot) beaconOf.push({ ...h, spin: 0.6 + h.energy * 2.4 });
  }

  /**
   * A message happened, and it happened HERE.
   *
   * `weight` is the magnitude tier: 1 for a single message, up to ~3 for a
   * burst. It buys size and speed, never extra objects — a burst that spawned
   * forty sparks would cost forty matrix writes and read as noise. One
   * brighter, larger, faster light says "a lot just happened" more clearly
   * and costs the same as one.
   *
   * `to` is optional and is the honest part: a light travels between two
   * buildings only when the data says the two rooms are related — the same
   * identity speaking in both. Without that it rises from the roof and
   * fades, which claims nothing more than "something was said here".
   */
  function signal(room, to = null, weight = 1) {
    const a = sites.get(room);
    if (!a) return false;
    const b = to ? sites.get(to) : null;

    const s = pool[cursor];
    cursor = (cursor + 1) % pool.length;

    s.live = true;
    s.born = clock;
    s.size = 0.7 + Math.min(2.2, weight) * 0.55;
    s.x0 = a.x; s.z0 = a.z; s.y0 = a.y + 1.5;

    if (b && travel) {
      s.x1 = b.x; s.z1 = b.z; s.y1 = b.y + 1.5;
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      s.arc = 12 + d * 0.22;
      s.life = Math.max(0.55, Math.min(2.2, d / 90)) / Math.min(2, weight);
    } else {
      /* Straight up and out. Short, so a busy room reads as a shower of
         sparks rather than a column of light. */
      s.x1 = a.x; s.z1 = a.z; s.y1 = a.y + 16 + weight * 5;
      s.arc = 0;
      s.life = travel ? 1.1 : 0.7;
    }
    return true;
  }

  /* ── the frame ─────────────────────────────────────────────────────────
     One pass, fixed cost. `step` skips the ambient layers on alternate
     frames at the lowest tier and interpolates nothing — at 5 drones nobody
     can see the difference, and it halves the matrix writes. */
  let clock = 0;
  let frame = 0;

  function update(dt) {
    clock += dt;
    frame++;
    const doAmbient = travel && frame % cfg.step === 0;

    if (doAmbient) {
      for (let i = 0; i < cfg.drones; i++) {
        const r = droneRoutes[i];
        const t = clock * r.speed + r.phase;
        dummy.position.set(
          Math.sin(t * r.a) * r.rx,
          r.y + Math.sin(t * 2.3) * r.bob,
          Math.cos(t * r.b) * r.rz
        );
        /* Facing along the tangent, so it looks like it is going somewhere
           rather than sliding sideways through the air. */
        dummy.rotation.set(0, -Math.atan2(
          Math.cos(t * r.a) * r.a * r.rx, -Math.sin(t * r.b) * r.b * r.rz), 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        drones.setMatrixAt(i, dummy.matrix);
      }
      drones.instanceMatrix.needsUpdate = true;

      for (let i = 0; i < cfg.cars; i++) {
        const c = carLanes[i];
        const a = c.t + clock * c.speed * c.dir;
        dummy.position.set(Math.cos(a) * c.r, 0.55, Math.sin(a) * c.r);
        dummy.rotation.set(0, -a + (c.dir > 0 ? 0 : Math.PI), 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        cars.setMatrixAt(i, dummy.matrix);
      }
      cars.instanceMatrix.needsUpdate = true;
    }

    /* Signals run every frame at every tier. They are the data, and dropping
       frames of the data to save a few matrix writes would be optimising the
       one thing this page is for. */
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      if (!s.live) { sparks.setMatrixAt(i, HIDDEN); continue; }
      const u = (clock - s.born) / s.life;
      if (u >= 1) { s.live = false; sparks.setMatrixAt(i, HIDDEN); continue; }
      /* Ease out, so a light leaves fast and arrives gently — the shape of
         something being sent rather than something being dragged. */
      const e = 1 - (1 - u) * (1 - u);
      dummy.position.set(
        s.x0 + (s.x1 - s.x0) * e,
        s.y0 + (s.y1 - s.y0) * e + Math.sin(u * Math.PI) * s.arc,
        s.z0 + (s.z1 - s.z0) * e
      );
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(s.size * (1 - u * 0.55));
      dummy.updateMatrix();
      sparks.setMatrixAt(i, dummy.matrix);
    }
    sparks.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < beacons.count; i++) {
      const b = beaconOf[i];
      if (!b) { beacons.setMatrixAt(i, HIDDEN); continue; }
      const spin = travel ? clock * b.spin : 0;
      dummy.position.set(b.x, b.y + 4.4, b.z);
      /* Leaning, and turning: a sweep rather than a spike. Upright it read
         as an antenna on every roof; tilted and rotating it reads as
         something looking around, which is what a busy room is doing. */
      dummy.rotation.set(0.55, spin, 0);
      /* Length is the room's energy, so a glance across the skyline reads as
         "these are the rooms that are busy" without a legend. */
      dummy.scale.set(0.9, 0.5 + b.energy * 0.9, 0.9);
      dummy.updateMatrix();
      beacons.setMatrixAt(i, dummy.matrix);
    }
    beacons.instanceMatrix.needsUpdate = true;
  }

  function dispose() {
    for (const m of [drones, cars, sparks, beacons]) {
      root.remove(m);
      m.dispose?.();
    }
    for (const g of Object.values(G)) g.dispose();
    ambientMat.dispose();
    signalMat.dispose();
    sweepMat.dispose();
    scene.remove(root);
  }

  return {
    root, setSites, setEnergy, signal, update, dispose,
    /* For the tests, which assert that this layer actually moves rather than
       trusting that it does, and that a Performance preset is not a still. */
    get counts() { return { ...cfg }; },
    get liveSignals() { return pool.filter((s) => s.live).length; },
    sample: () => {
      const m = new THREE.Matrix4();
      const out = [];
      for (const mesh of [drones, cars]) {
        for (let i = 0; i < Math.min(3, mesh.count); i++) {
          mesh.getMatrixAt(i, m);
          out.push(Math.round(m.elements[12] * 100), Math.round(m.elements[14] * 100));
        }
      }
      return out.join(",");
    },
  };
}

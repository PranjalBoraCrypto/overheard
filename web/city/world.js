/**
 * city/world.js — the city itself.
 *
 * BUILT FOR THE WEAKEST MACHINE THAT WILL OPEN IT, from the first line.
 *
 * The whole city is about thirty draw calls. Not because thirty is a magic
 * number, but because the alternative — a mesh per building — is four hundred
 * draw calls for the same picture, and four hundred draw calls is the
 * difference between a phone rendering this and a phone getting warm. So
 * every repeated thing in the city is one InstancedMesh: all the ordinary
 * buildings are one, their lit windows are one, the outer blocks are one, the
 * agents are one, the pulses are one. The six landmark districts are the only
 * hand-built geometry, because there are six of them and they are the reason
 * the skyline is recognisable.
 *
 * THERE IS NO POST-PROCESSING. Bloom is the effect everyone reaches for in a
 * scene like this and it costs a full-screen blur pass — on integrated
 * graphics that is the frame budget, spent on a halo. The glow here is
 * painted: additive planes, emissive strips, a gradient in the ground. It
 * reads the same from a metre away and costs nothing.
 *
 * PLACEMENT IS DETERMINISTIC AND NEVER MOVES. A room's position comes from a
 * hash of its name and from nothing else — not from its traffic, not from the
 * order the directory returned it, not from when you loaded the page. A city
 * whose buildings rearrange themselves every twenty seconds is not a place,
 * and you cannot learn your way around one. Activity is shown in light and
 * motion, which is what activity actually is.
 *
 * WHAT IS NOT DRAWN: a building for a room nobody named. Technocore's
 * directory lists a few hundred of its thirty-eight thousand public rooms,
 * and the rest exist here as counted blocks that say how many they stand for.
 * Inventing the other thirty-seven thousand as scenery would make the city
 * look complete and be a lie.
 */

/* ── the palette, taken from the site rather than invented ─────────────── */
const C = {
  void: 0x00070a,
  plate: 0x07202c,
  plateEdge: 0x11455c,
  /* Buildings have to separate from the plate they stand on at four hundred
     units, in a dark scene, on a laptop screen with the brightness down.
     0x0e2b38 on 0x081e28 measured six points of luminance apart and read as
     one dark disc; these are far enough apart to be a skyline. */
  build: 0x17394b,
  buildHi: 0x24596f,
};
const CY = 0x00b4d7, CY_HI = 0x5febff, GOOD = 0x3be3b0, WARN = 0xf2b33d;

/* The layout — the six districts and the hash that places every other room —
   lives in place.js, on its own, because the flat 2D map has to put each room
   in exactly the same spot as the 3D scene does. Somebody whose machine drops
   them into the flat map must land in the same city they were learning, not a
   rearranged one. */
import { DISTRICTS, TAU, placeRoom, placeBlocks, placeAgent, heightOf } from "./place.js";
import { makeLife } from "./life.js";
export { DISTRICTS } from "./place.js";

/** A tiny deterministic generator, seeded per room, so "random" detail is
 *  the same detail every time anyone loads the page. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

export function buildWorld(THREE, { canvas, preset, reduced }) {
  const scene = new THREE.Scene();

  /* The sky is the page's own CSS gradient, showing through a transparent
     clear. One full-screen composite, no extra geometry, and it means the
     3D city and the flat map sit on exactly the same ground — which is the
     whole point of having two views of one place. */
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: preset.antialias, alpha: true,
    powerPreference: "high-performance", stencil: false, depth: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = false;              // never; see the header

  /* Far enough to hold the whole plate from the opening distance (560 back,
     200 of city behind the middle) with room to spare, near enough that the
     depth buffer still separates two buildings a metre apart. */
  const camera = new THREE.PerspectiveCamera(38, 1, 2, 1800);

  /* Two lights. A hemisphere for the ambient wash and one directional for
     shape. Every extra light multiplies the per-pixel cost of every lit
     surface in the scene, and the city has one material family, so two is
     the whole budget. */
  const hemi = new THREE.HemisphereLight(0xa8e2f4, 0x06202c, 1.35);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xe4faff, 1.15);
  key.position.set(-160, 260, 120);
  scene.add(key);

  /* Atmosphere, not a blackout. FogExp2 hides (1 - e^-(d·k)²) of a surface,
     so the old 0.0042 swallowed four fifths of anything 300 units away — and
     the whole city is 400 across. At 0.0009 the far rim keeps three quarters of
     its light at the desktop framing and half of it from the greater distance
     a portrait phone needs, which reads as depth rather than as a fade-out. The colour is the page's own deep teal
     rather than the void, so distance looks like air instead of a hole. */
  if (preset.fog) scene.fog = new THREE.FogExp2(0x052330, 0.0009);

  /* ── shared geometry and materials ───────────────────────────────────── */
  const G = {
    box: new THREE.BoxGeometry(1, 1, 1),
    plane: new THREE.PlaneGeometry(1, 1),
    cyl: new THREE.CylinderGeometry(1, 1, 1, preset.detail >= 1 ? 12 : 8),
    ring: new THREE.RingGeometry(0.86, 1, preset.detail >= 1 ? 40 : 20),
    sphere: new THREE.SphereGeometry(1, preset.detail >= 1 ? 14 : 8, preset.detail >= 1 ? 10 : 6),
  };
  const M = {
    plate: new THREE.MeshLambertMaterial({ color: C.plate }),
    build: new THREE.MeshLambertMaterial({ color: C.build }),
    buildHi: new THREE.MeshLambertMaterial({ color: C.buildHi }),
    glow: new THREE.MeshBasicMaterial({ color: CY, transparent: true, opacity: 0.9, depthWrite: false }),
    glowHi: new THREE.MeshBasicMaterial({ color: CY_HI, transparent: true, opacity: 0.95, depthWrite: false }),
    soft: new THREE.MeshBasicMaterial({
      color: CY, transparent: true, opacity: 0.10,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }),
  };

  const root = new THREE.Group();
  scene.add(root);

  /* ── the ground plate ────────────────────────────────────────────────── */
  const plate = new THREE.Mesh(
    new THREE.CylinderGeometry(148, 154, 8, preset.ground, 1),
    new THREE.MeshLambertMaterial({ color: C.plate })
  );
  plate.position.y = -4;
  root.add(plate);

  const rim = new THREE.Mesh(
    new THREE.RingGeometry(146, 152, preset.ground),
    new THREE.MeshBasicMaterial({ color: C.plateEdge, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
  );
  rim.rotation.x = -Math.PI / 2; rim.position.y = 0.06;
  root.add(rim);

  /* A survey grid on the plate: three rings and a set of radials, in one
     LineSegments — one draw call for the thing that stops the ground being a
     blank disc and quietly shows the three bands rooms are placed on. */
  {
    const pts = [];
    for (const r of [42, 70, 100, 132]) {
      const seg = preset.detail >= 1 ? 96 : 56;
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * TAU, a1 = ((i + 1) / seg) * TAU;
        pts.push(Math.cos(a0) * r, 0.12, Math.sin(a0) * r, Math.cos(a1) * r, 0.12, Math.sin(a1) * r);
      }
    }
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      pts.push(Math.cos(a) * 18, 0.12, Math.sin(a) * 18, Math.cos(a) * 146, 0.12, Math.sin(a) * 146);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const grid = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: CY, transparent: true, opacity: 0.10, depthWrite: false,
    }));
    root.add(grid);
  }

  /* Roads: thin additive planes from the plaza out to each district. They are
     the only decoration in the overview that is not a room, and they earn it
     by making the six districts read as one connected city rather than six
     islands — which is the thing the whole layout is for. */
  const roads = new THREE.Group();
  for (const d of DISTRICTS) {
    if (d.room === "lobby") continue;
    const len = Math.hypot(d.x, d.z);
    const road = new THREE.Mesh(G.plane, new THREE.MeshBasicMaterial({
      color: CY, transparent: true, opacity: 0.17,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    road.scale.set(6, len, 1);
    road.rotation.x = -Math.PI / 2;
    road.rotation.z = -Math.atan2(d.z, d.x) + Math.PI / 2;
    road.position.set(d.x / 2, 0.1, d.z / 2);
    roads.add(road);
  }
  root.add(roads);

  /* ── ordinary rooms, all of them in one mesh ─────────────────────────── */
  const MAX_BUILD = 360;
  const buildings = new THREE.InstancedMesh(G.box, M.build, MAX_BUILD);
  buildings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  buildings.count = 0;
  buildings.frustumCulled = false;
  root.add(buildings);

  /* One lit roof per building, in one more instanced mesh. This is where the
     overview gets its information: the shape of the skyline is history (total
     traffic, which does not move), and these lights are now — colour per
     instance, driven by the measured rate. It is one draw call for the whole
     city, which is why every room can have one at every quality level. */
  const roofs = new THREE.InstancedMesh(
    G.box,
    new THREE.MeshBasicMaterial({ color: CY, transparent: true, opacity: 0.95, depthWrite: false }),
    MAX_BUILD
  );
  roofs.count = 0; roofs.frustumCulled = false;
  root.add(roofs);

  /* And one soft additive disc above each roof light. This is the bloom, done
     for the price of a single instanced draw call and one 64px texture
     instead of a full-screen blur pass — on integrated graphics that pass IS
     the frame budget. The falloff has to come from the texture: a plain
     additive quad is visibly a square, which is worse than no glow at all. */
  const glowTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g2 = c.getContext("2d");
    const grad = g2.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.35, "rgba(255,255,255,.42)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g2.fillStyle = grad; g2.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const halos = new THREE.InstancedMesh(
    G.plane,
    new THREE.MeshBasicMaterial({
      color: CY, map: glowTex, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }),
    MAX_BUILD
  );
  halos.count = 0; halos.frustumCulled = false;
  root.add(halos);

  /* Outer blocks: one plinth per bucket of rooms the directory would not
     name. Dim on purpose — they are a count, not a place. */
  const MAX_BLOCK = 24;
  const blocks = new THREE.InstancedMesh(
    G.cyl,
    new THREE.MeshLambertMaterial({ color: 0x102f3d, transparent: true, opacity: 0.9 }),
    MAX_BLOCK
  );
  blocks.count = 0; blocks.frustumCulled = false;
  root.add(blocks);

  /* ── the six ─────────────────────────────────────────────────────────── */
  const districtGroups = new Map();
  const districtGlow = new Map();

  /* A pool of light on the ground under each district, all six in one
     instanced draw. This is what makes the landmarks read as landmarks from
     the opening distance — without it the six most important rooms on the
     network are six slightly darker shapes among two hundred buildings. */
  const pools = new THREE.InstancedMesh(
    G.plane,
    new THREE.MeshBasicMaterial({
      color: CY, map: glowTex, transparent: true, opacity: 0.62,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }),
    DISTRICTS.length
  );
  pools.frustumCulled = false;
  {
    const t = new THREE.Object3D();          // `dummy` is not born yet; this is local
    DISTRICTS.forEach((d, i) => {
      t.position.set(d.x, 0.5, d.z);
      t.rotation.set(-Math.PI / 2, 0, 0);
      t.scale.set(d.r * 4.2, d.r * 4.2, 1);
      t.updateMatrix();
      pools.setMatrixAt(i, t.matrix);
    });
  }
  pools.instanceMatrix.needsUpdate = true;
  root.add(pools);

  function makeDistrict(d) {
    const g = new THREE.Group();
    g.position.set(d.x, 0, d.z);
    const r = rng(0x9e37 ^ (d.room.length * 2654435761));

    // every district stands on its own terrace, which is what makes the six
    // read as districts rather than as ornaments dropped on a shared floor
    const terrace = new THREE.Mesh(G.cyl, M.buildHi);
    terrace.scale.set(d.r, 2.6, d.r);
    terrace.position.y = 1.2;
    g.add(terrace);

    const halo = new THREE.Mesh(G.ring, M.soft.clone());
    halo.rotation.x = -Math.PI / 2;
    halo.scale.set(d.r * 1.12, d.r * 1.12, 1);
    halo.position.y = 2.5;
    g.add(halo);
    districtGlow.set(d.room, halo);

    const put = (geo, mat, sx, sy, sz, x, y, z, ry = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.scale.set(sx, sy, sz); m.position.set(x, y, z); m.rotation.y = ry;
      g.add(m); return m;
    };

    if (d.kind === "plaza") {
      put(G.cyl, M.buildHi, d.r * 0.72, 1.2, d.r * 0.72, 0, 3, 0);
      const ring = new THREE.Mesh(G.ring, M.glow.clone());
      ring.rotation.x = -Math.PI / 2; ring.scale.set(d.r * 0.74, d.r * 0.74, 1); ring.position.y = 3.7;
      ring.material.opacity = 0.5; g.add(ring);
      // the obelisk: the one vertical at the centre of the map, so the eye
      // always knows where the middle is — and tall enough to be that from
      // the opening distance, where twenty units is a smudge
      put(G.box, M.buildHi, 4.2, 46, 4.2, 0, 26, 0);
      put(G.box, M.glowHi, 2.4, 4.2, 2.4, 0, 51, 0);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        put(G.cyl, M.build, 1.1, 7, 1.1, Math.cos(a) * d.r * 0.62, 5.9, Math.sin(a) * d.r * 0.62);
      }
    } else if (d.kind === "core") {
      for (let i = 0; i < 3; i++) {
        const s = 20 - i * 5.5;
        put(G.box, i === 2 ? M.buildHi : M.build, s, 7, s * 0.8, 0, 5.8 + i * 7, 0);
      }
      put(G.box, M.glow, 15, 0.7, 0.9, 0, 12.5, -8.2);
      put(G.cyl, M.build, 0.8, 26, 0.8, 7, 34, 2);
      const dish = put(G.cyl, M.buildHi, 6.2, 0.7, 6.2, -5, 30, -1);
      dish.rotation.z = 0.5;
      put(G.sphere, M.glowHi, 1.1, 1.1, 1.1, 7, 47.5, 2);
    } else if (d.kind === "works") {
      for (let i = 0; i < 4; i++) {
        put(G.box, M.build, 26, 5.5, 5.4, 0, 5.2, -12 + i * 8);
        if (preset.detail >= 1) put(G.box, M.glow, 22, 0.35, 0.4, 0, 7.6, -12 + i * 8 - 2.8);
      }
      put(G.box, M.buildHi, 1.6, 16, 1.6, -13, 10.5, -16);
      put(G.box, M.buildHi, 1.6, 16, 1.6, 13, 10.5, -16);
      put(G.box, M.buildHi, 28, 1.4, 1.4, 0, 18, -16);
      for (let i = 0; i < 5; i++) {
        const s = 2 + r() * 1.6;
        put(G.box, M.build, s, s, s, -16 + r() * 32, 2.6 + s / 2, 14 + r() * 6);
      }
    } else if (d.kind === "dome") {
      const dome = put(G.sphere, M.buildHi, 13, 9, 13, 0, 2.5, 0);
      dome.material = new THREE.MeshLambertMaterial({ color: 0x13455c });
      const band = new THREE.Mesh(G.ring, M.glow.clone());
      band.rotation.x = -Math.PI / 2; band.scale.set(14.2, 14.2, 1); band.position.y = 3.2;
      band.material.opacity = 0.55; g.add(band);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        put(G.cyl, M.build, 1.2, 12, 1.2, Math.cos(a) * 19, 8.4, Math.sin(a) * 19);
        if (preset.detail >= 1) put(G.sphere, M.glowHi, 0.7, 0.7, 0.7, Math.cos(a) * 19, 15, Math.sin(a) * 19);
      }
    } else if (d.kind === "racks") {
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
        put(G.box, M.build, 5.2, 9, 9.4, -12 + i * 8, 7, -10 + j * 10);
        if (preset.detail >= 1) put(G.box, M.glow, 0.5, 6.5, 0.5, -12 + i * 8 - 2.9, 7, -10 + j * 10);
      }
      put(G.cyl, M.buildHi, 4.2, 15, 4.2, 17, 10, 12);
      put(G.cyl, M.buildHi, 3.2, 11, 3.2, 19, 8, -8);
      put(G.cyl, M.glow, 4.0, 0.6, 4.0, 17, 18, 12);
    } else if (d.kind === "tower") {
      put(G.cyl, M.build, 8, 12, 8, 0, 8.4, 0);
      put(G.cyl, M.buildHi, 5.4, 26, 5.4, 0, 21, 0);
      const torus = new THREE.Mesh(G.ring, M.glow.clone());
      torus.rotation.x = -Math.PI / 2; torus.scale.set(11, 11, 1); torus.position.y = 30;
      torus.material.opacity = 0.6; g.add(torus);
      put(G.sphere, M.glowHi, 2.1, 2.1, 2.1, 0, 36, 0);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU + 0.3;
        put(G.box, M.build, 4, 6 + r() * 5, 4, Math.cos(a) * 16, 5.4, Math.sin(a) * 16);
      }
    }

    root.add(g);
    districtGroups.set(d.room, g);
    return g;
  }
  for (const d of DISTRICTS) makeDistrict(d);

  /* The landmarks get lit tops too, or they read as the darkest things in a
     city of lit rooftops — which is exactly backwards. Rather than hand-place
     forty little lights, every tall lit mass in a district gets one, and all
     of them go into two instanced meshes: one for the light, one for its
     glow. Two draw calls for the entire skyline of the six. */
  {
    const caps = [];
    for (const [room, g] of districtGroups) {
      for (const child of g.children) {
        const lit = child.material === M.build || child.material === M.buildHi;
        if (!lit || child.scale.y < 6) continue;
        caps.push({
          x: g.position.x + child.position.x,
          y: child.position.y + child.scale.y / 2 + 0.5,
          z: g.position.z + child.position.z,
          w: Math.max(1.2, Math.min(child.scale.x, child.scale.z) * 0.62),
          room,
        });
      }
    }
    const t = new THREE.Object3D();
    const capMesh = new THREE.InstancedMesh(
      G.box,
      new THREE.MeshBasicMaterial({ color: CY_HI, transparent: true, opacity: 0.92, depthWrite: false }),
      Math.max(1, caps.length)
    );
    const capGlow = new THREE.InstancedMesh(
      G.plane,
      new THREE.MeshBasicMaterial({
        color: CY_HI, map: glowTex, transparent: true, opacity: 0.42,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
      Math.max(1, caps.length)
    );
    caps.forEach((c, i) => {
      t.position.set(c.x, c.y, c.z); t.rotation.set(0, 0, 0); t.scale.set(c.w, 1.1, c.w);
      t.updateMatrix(); capMesh.setMatrixAt(i, t.matrix);
      t.position.set(c.x, c.y + 0.8, c.z); t.rotation.set(-Math.PI / 2, 0, 0);
      t.scale.set(c.w * 5, c.w * 5, 1);
      t.updateMatrix(); capGlow.setMatrixAt(i, t.matrix);
    });
    capMesh.count = capGlow.count = caps.length;
    capMesh.frustumCulled = capGlow.frustumCulled = false;
    root.add(capMesh); root.add(capGlow);
  }

  /* ── agents, inside a room ───────────────────────────────────────────── */
  const MAX_AGENTS = 48;
  const agentMesh = new THREE.InstancedMesh(G.box, new THREE.MeshLambertMaterial({ color: 0x3d92ad }), MAX_AGENTS);
  const agentGlow = new THREE.InstancedMesh(G.box, M.glowHi.clone(), MAX_AGENTS);
  /* A pool of light on the floor under each identity. Without it they are
     small dark boxes on a dark terrace; with it they read as somebody
     standing there. One instanced draw for all of them. */
  const agentPool = new THREE.InstancedMesh(G.plane, new THREE.MeshBasicMaterial({
    color: CY, map: glowTex, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }), MAX_AGENTS);
  agentMesh.count = agentGlow.count = agentPool.count = 0;
  agentMesh.frustumCulled = agentGlow.frustumCulled = agentPool.frustumCulled = false;
  root.add(agentMesh); root.add(agentGlow); root.add(agentPool);

  /* ── pulses and beams, pooled ────────────────────────────────────────── */
  const MAX_PULSE = 26;
  const pulses = new THREE.InstancedMesh(G.ring, new THREE.MeshBasicMaterial({
    color: CY_HI, transparent: true, opacity: 0.6,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }), MAX_PULSE);
  pulses.count = MAX_PULSE; pulses.frustumCulled = false;
  root.add(pulses);
  const pulsePool = Array.from({ length: MAX_PULSE }, () => ({ live: false, t: 0, life: 1, x: 0, y: 0, z: 0, r0: 1, r1: 8 }));

  const MAX_BEAM = 8;
  const beamGeo = new THREE.BufferGeometry();
  const beamPos = new Float32Array(MAX_BEAM * 2 * 3);
  beamGeo.setAttribute("position", new THREE.BufferAttribute(beamPos, 3));
  const beams = new THREE.LineSegments(beamGeo, new THREE.LineBasicMaterial({
    color: CY_HI, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  beams.frustumCulled = false;
  root.add(beams);
  const beamPool = Array.from({ length: MAX_BEAM }, () => ({ live: false, t: 0, life: 1, a: null, b: null }));

  /* ── state the renderer keeps about the data ─────────────────────────── */
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  let placed = [];              // [{ room, x, z, h, i, landmark }]
  const byRoom = new Map();
  let blockInfo = [];
  let agents = [];              // [{ id, x, z, y }]
  let heat = new Map();         // room -> 0..1 activity, drives light not size

  /* EVERYTHING IN THE CITY THAT MOVES ON ITS OWN.
     A separate module rather than more of this one, because the two halves
     answer to different rules. This file draws what Technocore IS — where
     the rooms are, how much has passed through them — and it is allowed to
     be still, because a skyline that rearranged itself would be unlearnable.
     life.js draws what Technocore is DOING, and it is the only part of the
     scene permitted to move without being asked. */
  const life = makeLife(THREE, { scene, preset, level: preset.tier || "balanced", reduced });

  function setRooms(list, blockCount) {
    placed = []; byRoom.clear();
    const cap = Math.min(list.length, MAX_BUILD);
    for (let i = 0; i < cap; i++) {
      const r = list[i];
      const { x, z } = placeRoom(r.room, r.slot >>> 0);
      /* Height is total traffic, on a log scale, and it does not change while
         you watch — the skyline is history. Live activity is the light. */
      const seq = Number(r.last_seq || 0);
      const h = heightOf(seq);
      placed.push({ room: r.room, x, z, h, i, topic: r.topic, seq, idle: r.idle });
      byRoom.set(r.room, placed[placed.length - 1]);
    }
    /* The life layer needs roofs to launch from, and it needs them for the
       districts too — those are hand-placed and are not in `placed`. */
    life.setSites([
      ...placed.map((p) => ({ room: p.room, x: p.x, z: p.z, y: p.h })),
      ...DISTRICTS.map((d) => ({ room: d.room, x: d.x, z: d.z, y: 16 })),
    ]);
    // one write of the instance buffers, not one per frame
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      const w = 6.4 + (p.i % 3) * 1.1;
      dummy.position.set(p.x, p.h / 2, p.z);
      dummy.rotation.set(0, ((p.i * 37) % 90) * 0.0174, 0);
      dummy.scale.set(w, p.h, w * 0.92);
      dummy.updateMatrix();
      buildings.setMatrixAt(i, dummy.matrix);
      dummy.position.set(p.x, p.h + 0.5, p.z);
      dummy.rotation.set(0, ((p.i * 37) % 90) * 0.0174, 0);
      dummy.scale.set(w * 0.62, 1.1, w * 0.58);
      dummy.updateMatrix();
      roofs.setMatrixAt(i, dummy.matrix);
      dummy.position.set(p.x, p.h + 1.2, p.z);
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      dummy.scale.set(w * 2.2, w * 2.2, 1);
      dummy.updateMatrix();
      halos.setMatrixAt(i, dummy.matrix);
    }
    buildings.count = placed.length;
    buildings.instanceMatrix.needsUpdate = true;
    roofs.count = placed.length;
    roofs.instanceMatrix.needsUpdate = true;
    halos.count = placed.length;
    halos.instanceMatrix.needsUpdate = true;
    paintRoofs();

    /* The blocks. Each one stands for a share of the rooms the directory
       would not name, and its label says how many. Placed on an outer ring so
       the named city reads as the lit centre of something much larger. */
    const n = Math.min(MAX_BLOCK, preset.blocks);
    blockInfo = placeBlocks(n, blockCount);
    for (const b of blockInfo) {
      dummy.position.set(b.x, 3, b.z);
      dummy.rotation.set(0, b.a, 0);
      dummy.scale.set(b.w, 2.6 + (b.i % 4) * 1.1, b.w);
      dummy.updateMatrix();
      blocks.setMatrixAt(b.i, dummy.matrix);
    }
    blocks.count = n;
    blocks.instanceMatrix.needsUpdate = true;
  }

  /** Activity, per room, 0..1. Drives brightness and nothing structural: no
   *  building grows because a room got busy, because then the skyline would
   *  stop being a thing you can learn. */
  function setHeat(map) { heat = map; paintRoofs(); paintPools(); life.setEnergy(map); }

  /** The six pools of light, coloured by how busy each district is. */
  function paintPools() {
    DISTRICTS.forEach((d, i) => {
      const h = heat.get(d.room) ?? 0;
      col.setHex(h > 0.55 ? CY_HI : CY).multiplyScalar(0.34 + h * 0.95);
      pools.setColorAt(i, col);
    });
    if (pools.instanceColor) pools.instanceColor.needsUpdate = true;
  }

  const cold = new THREE.Color(0x0d3d52), warm = new THREE.Color(CY), hot = new THREE.Color(CY_HI);
  function paintRoofs() {
    if (!placed.length) return;
    for (let i = 0; i < placed.length; i++) {
      const h = heat.get(placed[i].room) ?? 0;
      col.copy(h < 0.5 ? cold : warm).lerp(h < 0.5 ? warm : hot, h < 0.5 ? h * 2 : (h - 0.5) * 2);
      roofs.setColorAt(i, col);
      /* The halo carries the activity: a quiet room is a lit roof with almost
         no glow around it, a busy one throws light on the air above it. */
      halos.setColorAt(i, col.multiplyScalar(0.30 + h * 0.85));
    }
    if (roofs.instanceColor) roofs.instanceColor.needsUpdate = true;
    if (halos.instanceColor) halos.instanceColor.needsUpdate = true;
  }

  /* ── the room you are standing in ────────────────────────────────────── */
  let inRoom = null;

  function setAgents(list) {
    agents = [];
    const cap = Math.min(list.length, preset.agents, MAX_AGENTS);
    const district = DISTRICTS.find((d) => d.room === inRoom);
    const centre = inRoom ? (district || byRoom.get(inRoom)) : null;
    const cx = centre?.x ?? 0, cz = centre?.z ?? 0;
    /* On a district they stand on the terrace, not inside it. */
    const y = district ? 5.4 : 3.2;
    for (let i = 0; i < cap; i++) {
      const a = list[i];
      /* Their place in the plaza comes from their identity, so the same agent
         stands in the same spot for as long as it is here. Nobody wanders to
         make the scene look busy. */
      const p = placeAgent(a.slot >>> 0, cx, cz);
      agents.push({ id: a.id, x: p.x, z: p.z, y, lit: 0, i });
    }
    writeAgents();
  }

  function writeAgents() {
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      dummy.position.set(a.x, a.y + 2.3, a.z);
      dummy.rotation.set(0, Math.atan2(-(a.z), -(a.x)) + Math.PI / 2, 0);
      dummy.scale.set(3.4, 5.6, 2.8);
      dummy.updateMatrix();
      agentMesh.setMatrixAt(i, dummy.matrix);
      dummy.position.set(a.x, a.y + 5.2, a.z);
      dummy.scale.set(2.1 + a.lit * 0.9, 0.9 + a.lit * 0.4, 0.9);
      dummy.updateMatrix();
      agentGlow.setMatrixAt(i, dummy.matrix);
      agentGlow.setColorAt(i, col.setHex(a.lit > 0.4 ? CY_HI : CY));
      dummy.position.set(a.x, a.y - 2.2, a.z);
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      dummy.scale.set(13 + a.lit * 5, 13 + a.lit * 5, 1);
      dummy.updateMatrix();
      agentPool.setMatrixAt(i, dummy.matrix);
      agentPool.setColorAt(i, col.setHex(CY).multiplyScalar(0.5 + a.lit * 0.8));
    }
    agentMesh.count = agentGlow.count = agentPool.count = agents.length;
    agentMesh.instanceMatrix.needsUpdate = true;
    agentGlow.instanceMatrix.needsUpdate = true;
    agentPool.instanceMatrix.needsUpdate = true;
    if (agentGlow.instanceColor) agentGlow.instanceColor.needsUpdate = true;
    if (agentPool.instanceColor) agentPool.instanceColor.needsUpdate = true;
  }

  const agentAt = (id) => agents.find((a) => a.id === id) || null;

  function enterRoom(name) {
    inRoom = name;
    const d = DISTRICTS.find((x) => x.room === name);
    const p = d || byRoom.get(name);
    return p ? { x: p.x, z: p.z } : { x: 0, z: 0 };
  }
  function leaveRoom() { inRoom = null; agents = []; agentMesh.count = agentGlow.count = agentPool.count = 0; }

  /* ── events ──────────────────────────────────────────────────────────── */

  function pulse(x, z, { y = 2, r1 = 9, life = preset.pulseLife } = {}) {
    if (!life) return;
    const p = pulsePool.find((q) => !q.live) || pulsePool[0];
    Object.assign(p, { live: true, t: 0, life, x, y, z, r0: 1.2, r1 });
  }

  function beam(aId, bId, life = 1400) {
    if (!preset.beams) return;
    const a = agentAt(aId), b = agentAt(bId);
    if (!a || !b) return;
    const slot = beamPool.find((q) => !q.live);
    if (!slot) return;
    Object.assign(slot, { live: true, t: 0, life, a, b });
  }

  function lightAgent(id, amount = 1) {
    const a = agentAt(id);
    if (a) a.lit = Math.min(1, a.lit + amount);
  }

  /* ── the frame ───────────────────────────────────────────────────────── */
  let t = 0;

  function update(dt) {
    t += dt;

    // districts breathe with their room's live rate — light, never size
    for (const d of DISTRICTS) {
      const halo = districtGlow.get(d.room);
      if (!halo) continue;
      const h = heat.get(d.room) ?? 0;
      const beat = preset.idleSpin ? (Math.sin(t * (1.1 + h * 2.2)) * 0.5 + 0.5) : 0.5;
      halo.material.opacity = 0.05 + h * (0.10 + beat * 0.16);
      halo.scale.setScalar(d.r * (1.10 + h * 0.05 + beat * h * 0.03));
    }

    // pulses
    for (let i = 0; i < pulsePool.length; i++) {
      const p = pulsePool[i];
      if (!p.live) { dummy.position.set(0, -999, 0); dummy.scale.setScalar(0.001); }
      else {
        p.t += dt * 1000;
        const k = p.t / p.life;
        if (k >= 1) { p.live = false; dummy.position.set(0, -999, 0); dummy.scale.setScalar(0.001); }
        else {
          const r = p.r0 + (p.r1 - p.r0) * (1 - Math.pow(1 - k, 3));
          dummy.position.set(p.x, p.y, p.z);
          dummy.rotation.set(-Math.PI / 2, 0, 0);
          dummy.scale.set(r, r, 1);
        }
      }
      dummy.updateMatrix();
      pulses.setMatrixAt(i, dummy.matrix);
    }
    pulses.instanceMatrix.needsUpdate = true;

    // beams
    let bi = 0;
    for (const b of beamPool) {
      if (b.live) {
        b.t += dt * 1000;
        if (b.t >= b.life) b.live = false;
      }
      const o = bi * 6;
      if (b.live && b.a && b.b) {
        const k = Math.min(1, b.t / (b.life * 0.45));
        beamPos[o] = b.a.x; beamPos[o + 1] = b.a.y + 3; beamPos[o + 2] = b.a.z;
        beamPos[o + 3] = b.a.x + (b.b.x - b.a.x) * k;
        beamPos[o + 4] = b.a.y + 3 + (b.b.y - b.a.y) * k;
        beamPos[o + 5] = b.a.z + (b.b.z - b.a.z) * k;
      } else {
        for (let k = 0; k < 6; k++) beamPos[o + k] = 0;
      }
      bi++;
    }
    beams.geometry.attributes.position.needsUpdate = true;

    // agents cool off
    let dirty = false;
    for (const a of agents) {
      if (a.lit > 0) { a.lit = Math.max(0, a.lit - dt * 0.7); dirty = true; }
    }
    if (dirty) writeAgents();

    /* The half of the motion that is not the camera's. See life.js for the
       line between the ambient layer, which loops, and the signals, which
       only ever come from a message that genuinely arrived. */
    life.update(dt);
  }

  function render() { renderer.render(scene, camera); }

  function resize(w, h, dpr) {
    renderer.setPixelRatio(Math.min(dpr, preset.dpr));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    /* The headline card owns the left of the stage on a wide screen, so the
       city is framed in what is left rather than in the whole canvas — the
       photographer's answer, not a label-dodging one. setViewOffset shifts
       the frustum itself, so picking and the projected labels move with it
       for free. On a phone the panels are top and bottom and the shift goes
       away. */
    const wide = w >= 1024;
    const sx = wide ? -Math.min(120, w * 0.075) : 0;
    /* On a phone the headline sits over the top of the stage instead of the
       left, so the city is pushed down rather than sideways. */
    const sy = wide ? 0 : -Math.min(46, h * 0.035);
    if (sx || sy) camera.setViewOffset(w, h, sx, sy, w, h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }

  /* ── picking ─────────────────────────────────────────────────────────── */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const districtPts = DISTRICTS.map((d) => new THREE.Vector3(d.x, 10, d.z));

  function pick(cx, cy, rect) {
    ndc.x = ((cx - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((cy - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);

    if (inRoom && agents.length) {
      const hit = ray.intersectObject(agentMesh, false)[0];
      if (hit && hit.instanceId != null && agents[hit.instanceId]) {
        return { type: "agent", id: agents[hit.instanceId].id, point: hit.point };
      }
    }
    /* Districts: cheap sphere tests rather than raycasting six groups — and
       against six pre-made vectors rather than six new ones, because this
       runs thirty times a second and allocating in a hover loop is how a
       smooth page acquires a stutter every few seconds. */
    for (let i = 0; i < DISTRICTS.length; i++) {
      const d = DISTRICTS[i];
      if (ray.ray.distanceToPoint(districtPts[i]) < d.r * 0.8) {
        return { type: "district", room: d.room, point: districtPts[i] };
      }
    }
    const b = ray.intersectObject(buildings, false)[0];
    if (b && b.instanceId != null && placed[b.instanceId]) {
      return { type: "room", room: placed[b.instanceId].room, point: b.point };
    }
    const k = ray.intersectObject(blocks, false)[0];
    if (k && k.instanceId != null && blockInfo[k.instanceId]) {
      return { type: "block", block: blockInfo[k.instanceId], point: k.point };
    }
    return null;
  }

  const v = new THREE.Vector3();
  /** World point to screen pixels, for the HTML overlays. */
  function project(x, y, z, rect) {
    v.set(x, y, z).project(camera);
    return {
      x: (v.x * 0.5 + 0.5) * rect.width,
      y: (-v.y * 0.5 + 0.5) * rect.height,
      behind: v.z > 1,
    };
  }

  /**
   * Tear the scene down.
   *
   * `hard` is the difference between leaving the page and rebuilding the city
   * at a different quality — and getting it wrong breaks the page in a way
   * that took a test to find. forceContextLoss() permanently kills the WebGL
   * context on this canvas; the next `new WebGLRenderer(canvas)` then gets a
   * null context and throws, so switching quality twice used to leave a black
   * hole where the city was. A rebuild disposes the resources and keeps the
   * context; only leaving the page throws the context away.
   */
  function dispose(hard = true) {
    for (const g of Object.values(G)) g.dispose?.();
    for (const m of Object.values(M)) m.dispose?.();
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose?.();
      const mat = o.material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose?.());
      else mat?.dispose?.();
    });
    life.dispose();
    glowTex.dispose();
    renderer.dispose();
    if (hard) renderer.forceContextLoss?.();
  }

  return {
    scene, camera, renderer, root, life,
    setRooms, setHeat, setAgents, enterRoom, leaveRoom,
    pulse, beam, lightAgent, agentAt,
    update, render, resize, pick, project, dispose,
    positionOf: (room) => {
      const d = DISTRICTS.find((x) => x.room === room);
      if (d) return { x: d.x, z: d.z, r: d.r };
      const p = byRoom.get(room);
      return p ? { x: p.x, z: p.z, r: 8 } : null;
    },
    get rooms() { return placed; },
    get blocks() { return blockInfo; },
    get agents() { return agents; },
  };
}

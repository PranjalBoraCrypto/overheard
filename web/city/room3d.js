/**
 * city/room3d.js — the inside of a room, as a place.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHAT WAS THERE BEFORE, AND WHY IT HAD TO BE REPLACED
 *
 * "Entering a room" used to mean this, in full: `world.enterRoom(name)`
 * recorded a string, returned the x/z of a building, and the camera moved
 * 118 units closer to it. That was the whole feature. There was no interior
 * — no floor, no walls, no door — so a visitor who clicked a room got the
 * same city they were already looking at, from nearer, with some HTML panels
 * over the top and the speakers drawn as static boxes on a terrace. And it
 * took two clicks to get even that: one to open a summary, another to press
 * "Enter the room".
 *
 * A room is where the conversation is. It is the reason the city exists, and
 * it was the one part of the page that was not a place.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * A SECOND SCENE, NOT A CLOSER CAMERA
 *
 * This module owns its own THREE.Scene and its own camera, and shares only
 * the renderer and the canvas with the city. That separation is what makes
 * "somewhere else" possible: different geometry, different light, different
 * scale, different camera limits — and, importantly, the city is left
 * standing exactly as it was, so coming back is a restoration rather than a
 * rebuild.
 *
 * THE PLACE. A circular plaza under a dome, which is deliberately the
 * opposite of the city's open plate seen from above: enclosed rather than
 * surveyed, at eye level rather than from a helicopter. A slow ring of light
 * turns at the centre — the room's own hub, the thing every message passes
 * through — and the floor carries concentric etched rings that the
 * conversation lights up.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THE AGENTS, AND WHAT THEIR MOVEMENT IS ALLOWED TO MEAN
 *
 * Each identity that has spoken gets a figure: a tapered body, a head, and a
 * light in the floor under it. Where it stands is a hash of its own id, so
 * it is in the same place every time you come back and a conversation can be
 * followed by watching two specific figures rather than two moving dots.
 *
 * What they do is bounded by what is actually known:
 *
 *   IDLE BOB is scenery. Everyone does it, always, at their own phase. It
 *   claims nothing.
 *
 *   FACING is evidence. A figure turns toward another only when a message
 *   genuinely addressed it — the addressee comes from the message text, and
 *   nothing else turns anybody. When nobody has been addressed, figures face
 *   the hub, which is the honest default: they are talking to the room.
 *
 *   LIGHTING UP is evidence. A figure brightens only when a sequence number
 *   the live reader has not seen before arrives from it. An archived message
 *   never lights anyone, which is the same rule the city obeys and the
 *   reason a saved room can show its history without pretending to be busy.
 *
 *   WALKING is a small, honest thing: a handful of figures drift along short
 *   arcs around their own station and come back. They never walk to another
 *   agent, because "these two are together" would be a claim about a
 *   relationship the data does not describe.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * COST
 *
 * Four instanced meshes for every figure in the room (body, head, floor
 * light, and the pooled reply sparks), plus the fixed furniture of the plaza.
 * A room with three hundred speakers costs the same number of draw calls as
 * a room with three. Figures past the cap are folded into the crowd ring —
 * a count, drawn as a band of light, never as invented people.
 */

const TAU = Math.PI * 2;

/** Camera limits for a sixty-unit plaza. See the note in cam.js about why
 *  these are arguments rather than constants. */
export const ROOM_LIMITS = {
  minDist: 26, maxDist: 190, minPitch: 0.08, maxPitch: 1.15,
  radius: 46, minY: -2, maxY: 26,
  home: { yaw: -0.55, pitch: 0.30, dist: 92, tx: 0, ty: 6, tz: 0 },
  fit: (a, clamp) => clamp((132 / a) * (a < 1 ? 0.72 : 1), 74, 190),
};

/** How many figures are drawn individually before the rest become a count. */
const CAP = { performance: 26, balanced: 44, high: 70 };

function hash01(i, salt = 0) {
  let h = ((i >>> 0) * 374761393 + salt * 668265263) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function makeRoom(THREE, { renderer, preset, level = "balanced", reduced = false }) {
  const cap = CAP[level] || CAP.balanced;
  const scene = new THREE.Scene();
  scene.background = null;
  /* Fog that starts close. The dome is a real surface a few units past the
     furthest figure, and without fog the join between floor and wall reads
     as a seam in a model rather than as distance. */
  if (preset.fog !== false) scene.fog = new THREE.Fog(0x00131b, 70, 210);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 900);

  const root = new THREE.Group();
  scene.add(root);

  scene.add(new THREE.AmbientLight(0x275f74, 1.5));
  const key = new THREE.DirectionalLight(0x8fe6ff, 0.85);
  key.position.set(24, 46, 18);
  scene.add(key);

  const R = 42;                       // the plaza's radius

  /* ── the floor ─────────────────────────────────────────────────────────
     One disc, plus etched rings drawn as thin rings rather than as a
     texture, so they stay crisp at any zoom and cost nothing to load. */
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x061a24, roughness: 0.92, metalness: 0.05,
  });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(R + 6, 72), floorMat);
  floor.rotation.x = -Math.PI / 2;
  root.add(floor);

  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x0d5f78, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
  });
  const rings = [];
  for (const r of [12, 20, 28, 36, R + 2]) {
    const m = new THREE.Mesh(new THREE.RingGeometry(r - 0.16, r + 0.16, 90), ringMat.clone());
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.04;
    root.add(m);
    rings.push(m);
  }

  /* ── the dome ──────────────────────────────────────────────────────────
     Seen from inside, so BackSide. It is what makes this an interior: the
     city's horizon is empty space, and a room's is a wall. */
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(R + 34, 36, 18, 0, TAU, 0, Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x03141d, side: THREE.BackSide, fog: false })
  );
  root.add(dome);

  /* ── the hub ───────────────────────────────────────────────────────────
     The room's own centre: a slow ring of light that everything is arranged
     around. It turns whether or not anything is happening — it is the
     room's machinery, not its conversation — and it brightens with the
     room's measured rate, which is. */
  const hubMat = new THREE.MeshBasicMaterial({
    color: 0x2ea6c4, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const hub = new THREE.Group();
  const hubRing = new THREE.Mesh(new THREE.TorusGeometry(5.6, 0.16, 8, 64), hubMat);
  hubRing.rotation.x = Math.PI / 2;
  hubRing.position.y = 5.2;
  const hubRing2 = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.11, 8, 48), hubMat);
  hubRing2.rotation.set(Math.PI / 2, 0, 0);
  hubRing2.position.y = 8.4;
  const hubCore = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.5, 11, 10, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x6fe6ff, transparent: true, opacity: 0.35,
      blending: THREE.AdditiveBlending, depthWrite: false })
  );
  hubCore.position.y = 5.6;
  hub.add(hubRing, hubRing2, hubCore);
  root.add(hub);

  /* ── the figures ───────────────────────────────────────────────────────
     Three instanced meshes and nothing per-agent in the scene graph, so the
     cost of a busy room is the same as the cost of a quiet one. */
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x123c4c, roughness: 0.6, metalness: 0.15 });
  const headMat = new THREE.MeshStandardMaterial({
    color: 0x2b7f97, roughness: 0.35, metalness: 0.2,
    emissive: 0x0b3a49, emissiveIntensity: 0.35,
  });
  const lampMat = new THREE.MeshBasicMaterial({
    color: 0x5fe4ff, transparent: true, opacity: 0.7,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });

  const mkInst = (geo, mat, n) => {
    const m = new THREE.InstancedMesh(geo, mat, n);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    /* Same reason as the city's life layer: an InstancedMesh is at the
       origin and its bounds do not describe where its instances are, so
       culling the batch throws the whole room away when you look at a wall. */
    m.frustumCulled = false;
    m.count = 0;
    root.add(m);
    return m;
  };

  const G = {
    body: new THREE.CylinderGeometry(0.62, 1.05, 3.0, 7),
    head: new THREE.SphereGeometry(0.72, 10, 8),
    lamp: new THREE.RingGeometry(1.25, 1.95, 20),
  };
  const bodies = mkInst(G.body, bodyMat, cap);
  const heads = mkInst(G.head, headMat, cap);
  const lamps = mkInst(G.lamp, lampMat, cap);
  lamps.instanceColor = null;

  /* Per-instance colour is how one figure lights up without a material per
     agent. Allocated once at full capacity. */
  const lampCol = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  lamps.instanceColor = lampCol;
  const headCol = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  heads.instanceColor = headCol;

  /* The overflow ring: a count, drawn as a band, never as people. */
  const crowd = new THREE.Mesh(
    new THREE.RingGeometry(R - 1.6, R + 0.6, 96),
    new THREE.MeshBasicMaterial({ color: 0x1f6a80, transparent: true, opacity: 0,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  crowd.rotation.x = -Math.PI / 2;
  crowd.position.y = 0.06;
  root.add(crowd);

  /* ── reply sparks ──────────────────────────────────────────────────────
     A pooled light that travels from one figure to another. Only a message
     that named an addressee ever creates one. */
  const SPARKS = level === "performance" ? 8 : level === "high" ? 24 : 16;
  const sparkMat = new THREE.MeshBasicMaterial({
    color: 0x9df6ff, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const sparks = new THREE.InstancedMesh(new THREE.SphereGeometry(0.42, 6, 5), sparkMat, SPARKS);
  sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  sparks.frustumCulled = false;
  root.add(sparks);
  const sparkPool = [];
  for (let i = 0; i < SPARKS; i++) sparkPool.push({ live: false });
  let sparkAt = 0;

  const dummy = new THREE.Object3D();
  const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);
  const tmpCol = new THREE.Color();

  /* ── state ─────────────────────────────────────────────────────────── */
  let figures = [];        // { id, x, z, a, phase, walk, face, yaw, lit, speaking }
  const byId = new Map();
  let overflow = 0;
  let clock = 0;
  let energy = 0;          // 0..1, the room's own measured rate
  let roomName = null;

  /** Where an identity stands. A hash of its id and nothing else, so it is
   *  in the same place on every visit and a conversation is followable. */
  function station(id, i) {
    const h = hash01(hashId(id), 3);
    /* Three rings, filled from the inside out, so a quiet room is a small
       huddle near the hub rather than a scatter across an empty floor. */
    const band = i < 8 ? 0 : i < 22 ? 1 : 2;
    const rad = [13.5, 23, 32.5][band] + (h - 0.5) * 4.5;
    const ang = hash01(hashId(id), 7) * TAU;
    return { x: Math.cos(ang) * rad, z: Math.sin(ang) * rad, a: ang };
  }
  function hashId(s) {
    let h = 0x811c9dc5;
    const t = String(s);
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }

  /**
   * Who is in the room. Stable: an agent that was already here keeps its
   * position, its facing and its light, so a poll landing does not shuffle
   * everybody and lose whatever the visitor was watching.
   */
  function setAgents(list) {
    const seen = new Set();
    const next = [];
    list.slice(0, cap).forEach((a, i) => {
      seen.add(a.id);
      let f = byId.get(a.id);
      if (!f) {
        const s = station(a.id, i);
        f = {
          id: a.id, x: s.x, z: s.z, a: s.a,
          phase: hash01(hashId(a.id), 11) * TAU,
          /* A quarter of them drift, and only around their own station. */
          walk: hash01(hashId(a.id), 13) < 0.25 ? 0.55 + hash01(hashId(a.id), 17) * 0.7 : 0,
          yaw: 0, face: null, lit: 0, born: clock,
        };
        byId.set(a.id, f);
      }
      f.count = a.count;
      f.signed = a.signed;
      next.push(f);
    });
    for (const id of [...byId.keys()]) if (!seen.has(id)) byId.delete(id);
    figures = next;
    overflow = Math.max(0, list.length - figures.length);
    bodies.count = heads.count = lamps.count = figures.length;
    crowd.material.opacity = overflow > 0 ? Math.min(0.32, 0.06 + Math.log10(1 + overflow) * 0.12) : 0;
  }

  /** A message genuinely arrived from this identity. Never called for an
   *  archived one — see the contract in api/room.js. */
  function speak(id, weight = 1) {
    const f = byId.get(id);
    if (!f) return false;
    f.lit = Math.min(1.6, f.lit + 0.7 + Math.min(1, weight) * 0.5);
    return true;
  }

  /** One identity addressed another, and the message said so. */
  function reply(fromId, toId) {
    const a = byId.get(fromId), b = byId.get(toId);
    if (!a || !b) return false;
    a.face = toId;                       // the sender turns to look
    b.lit = Math.max(b.lit, 0.55);       // the addressee reacts
    const s = sparkPool[sparkAt];
    sparkAt = (sparkAt + 1) % sparkPool.length;
    s.live = true; s.born = clock; s.life = reduced ? 0.35 : 0.85;
    s.x0 = a.x; s.z0 = a.z; s.x1 = b.x; s.z1 = b.z;
    return true;
  }

  function setEnergy(v) { energy = Math.max(0, Math.min(1, v || 0)); }
  function setRoom(name) { roomName = name; }

  /* ── the frame ─────────────────────────────────────────────────────── */
  function update(dt) {
    clock += dt;

    /* The hub turns always: it is the room's machinery, not its
       conversation. Its brightness is the conversation. */
    if (!reduced) { hub.rotation.y += dt * 0.22; hubRing2.rotation.z += dt * 0.5; }
    hubMat.opacity = 0.32 + energy * 0.45 + (reduced ? 0 : Math.sin(clock * 1.4) * 0.04);
    for (let i = 0; i < rings.length; i++) {
      rings[i].material.opacity = 0.28 + energy * 0.4 * (1 - i / rings.length)
        + (reduced ? 0 : Math.sin(clock * 0.9 - i * 0.6) * 0.05);
    }

    for (let i = 0; i < figures.length; i++) {
      const f = figures[i];
      /* THE LIGHT OUTLASTS NOTHING, AND UNDER-LASTS NOTHING EITHER.
         At 0.75/s a speaker went dark in about a second and a half while
         their speech bubble was still up for six — so the figure the bubble
         belonged to was unlit by the time anybody looked for it, which
         defeats the entire point of lighting it. 0.26/s puts the light at
         roughly four seconds, inside the bubble's life, so following a
         conversation is a matter of looking where the light is. */
      if (f.lit > 0) f.lit = Math.max(0, f.lit - dt * 0.26);

      /* Drift, and come back. A closed path around its own station, so a
         figure is always findable where it was. */
      let x = f.x, z = f.z;
      if (f.walk && !reduced) {
        const t = clock * 0.28 + f.phase;
        x += Math.sin(t) * f.walk * 2.4;
        z += Math.cos(t * 0.8) * f.walk * 2.0;
      }

      /* Facing: at whoever was addressed, otherwise at the hub. Eased, so a
         head does not snap round — a snap reads as a glitch, a turn reads as
         attention. */
      const target = f.face ? byId.get(f.face) : null;
      const wantYaw = target ? Math.atan2(target.x - x, target.z - z) : Math.atan2(-x, -z);
      let d = wantYaw - f.yaw;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      f.yaw += d * Math.min(1, dt * 3.2);

      const bob = reduced ? 0 : Math.sin(clock * 1.1 + f.phase) * 0.13;

      dummy.position.set(x, 1.5 + bob, z);
      dummy.rotation.set(0, f.yaw, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      bodies.setMatrixAt(i, dummy.matrix);

      dummy.position.set(x, 3.55 + bob, z);
      dummy.scale.setScalar(1 + f.lit * 0.08);
      dummy.updateMatrix();
      heads.setMatrixAt(i, dummy.matrix);

      dummy.position.set(x, 0.09, z);
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      dummy.scale.setScalar(1 + f.lit * 0.25);
      dummy.updateMatrix();
      lamps.setMatrixAt(i, dummy.matrix);

      /* Lit is a claim, so the colour ramp is steep enough to be unmistakable
         and the floor is dark enough that an unlit figure is plainly unlit. */
      const g = 0.12 + f.lit * 0.7;
      tmpCol.setRGB(g * 0.35, g, g * 1.15);
      tmpCol.toArray(lampCol.array, i * 3);
      tmpCol.setRGB(0.06 + f.lit * 0.5, 0.16 + f.lit * 0.75, 0.22 + f.lit * 0.8);
      tmpCol.toArray(headCol.array, i * 3);
    }
    bodies.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    lamps.instanceMatrix.needsUpdate = true;
    lampCol.needsUpdate = true;
    headCol.needsUpdate = true;

    for (let i = 0; i < sparkPool.length; i++) {
      const s = sparkPool[i];
      if (!s.live) { sparks.setMatrixAt(i, HIDE); continue; }
      const u = (clock - s.born) / s.life;
      if (u >= 1) { s.live = false; sparks.setMatrixAt(i, HIDE); continue; }
      dummy.position.set(
        s.x0 + (s.x1 - s.x0) * u,
        3.4 + Math.sin(u * Math.PI) * 2.6,
        s.z0 + (s.z1 - s.z0) * u
      );
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(1 - u * 0.4);
      dummy.updateMatrix();
      sparks.setMatrixAt(i, dummy.matrix);
    }
    sparks.instanceMatrix.needsUpdate = true;
  }

  function render() { renderer.render(scene, camera); }

  function resize(w, h) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  /** Screen position of a figure's head, for anchoring a speech bubble. */
  const v = new THREE.Vector3();
  function project(id, w, h) {
    const f = byId.get(id);
    if (!f) return null;
    v.set(f.x, 5.2, f.z).project(camera);
    if (v.z > 1) return null;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h };
  }

  /** Which figure is under the pointer, if any. */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pick(nx, ny) {
    ndc.set(nx, ny);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(bodies, false)[0] || ray.intersectObject(heads, false)[0];
    if (!hit || hit.instanceId == null) return null;
    return figures[hit.instanceId]?.id ?? null;
  }

  function agentAt(id) {
    const f = byId.get(id);
    return f ? { x: f.x, z: f.z } : null;
  }

  function dispose() {
    scene.traverse((o) => {
      o.geometry?.dispose?.();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
      else m?.dispose?.();
    });
  }

  return {
    scene, camera, root, limits: ROOM_LIMITS,
    setRoom, setAgents, speak, reply, setEnergy,
    update, render, resize, project, pick, agentAt, dispose,
    get figures() { return figures; },
    get overflow() { return overflow; },
    get lit() { return figures.filter((f) => f.lit > 0.05).length; },
  };
}

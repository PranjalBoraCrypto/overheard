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
  /* The site's own ground colour, not a colour of this scene's choosing. Now
     that the dome lets the page's sky through, distance has to fade into the
     same dark the rest of Overheard sits on, or the fade itself becomes the
     seam the dome used to be. */
  if (preset.fog !== false) scene.fog = new THREE.Fog(0x00070a, 70, 210);

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
     Seen from inside, so BackSide.

     IT IS A VEIL, NOT A WALL. This was a solid shell, and solid was wrong for
     one concrete reason: it covered the whole viewport, so walking into a
     room replaced the site's background with a plate of its own and the page
     changed grounds at the doorway. The city had exactly that fault and lost
     it; a room should not reintroduce it one click later.

     So the dome now fades out with height. Dense at the horizon, where its
     whole job is to close off the floor's edge and say "you are inside
     something"; gone by the zenith, where the same sky that is behind every
     other page on this site is behind this one too. You are indoors and still
     in the same world, which is the truth of the thing being drawn. */
  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
    uniforms: { uLow: { value: new THREE.Color(0x04161f) },
                uHigh: { value: new THREE.Color(0x0a3448) },
                uAlpha: { value: 0.86 } },
    vertexShader: `
      varying float vH;
      void main(){
        vH = clamp(position.y / ${(R + 34).toFixed(1)}, 0.0, 1.0);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    /* pow(1-h, 1.7) rather than a straight ramp: linear leaves a visible grey
       wash across the top half of the screen, and the point is for the upper
       dome to be genuinely absent rather than faintly there. */
    fragmentShader: `
      uniform vec3 uLow; uniform vec3 uHigh; uniform float uAlpha;
      varying float vH;
      void main(){
        float a = uAlpha * pow(1.0 - vH, 1.7);
        gl_FragColor = vec4(mix(uLow, uHigh, vH), a);
      }`,
  });
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(R + 34, 36, 18, 0, TAU, 0, Math.PI / 2), domeMat);
  /* Drawn before everything else and writing no depth, so a transparent shell
     never sorts itself in front of the figures standing inside it. */
  dome.renderOrder = -1;
  root.add(dome);

  /* The horizon the dome used to provide by being opaque: a bright band where
     the wall meets the floor. It is what stops the plaza from reading as a
     disc floating in the sky now that you can see past the top of the room. */
  const skirt = new THREE.Mesh(
    new THREE.CylinderGeometry(R + 33.6, R + 33.6, 26, 48, 1, true),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
      uniforms: { uCol: { value: new THREE.Color(0x0e5b74) } },
      vertexShader: `varying float vY; void main(){ vY = position.y / 13.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 uCol; varying float vY;
        void main(){ gl_FragColor = vec4(uCol, 0.42 * pow(clamp(1.0 - (vY + 1.0) * 0.5, 0.0, 1.0), 1.4)); }`,
    })
  );
  skirt.position.y = 13;
  skirt.renderOrder = -1;
  root.add(skirt);

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
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1a4f63, roughness: 0.52, metalness: 0.28 });
  const headMat = new THREE.MeshStandardMaterial({
    color: 0x3597b3, roughness: 0.28, metalness: 0.34,
    emissive: 0x0d4557, emissiveIntensity: 0.45,
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

  /* ── WHAT AN AGENT LOOKS LIKE ────────────────────────────────────────────
     A tapered cylinder with a sphere on it is a chess pawn, and fifty of them
     is a chess set. These are meant to read as agents at a glance and as
     DIFFERENT agents at a second glance, which took four pieces rather than
     two:

       CHASSIS  a six-sided tapered column. Hexagonal rather than round
                because a flat face catches the key light and gives the
                silhouette an edge to turn on; round read as moulded plastic.
       DOME     a flattened head, wider than it is tall.
       VISOR    a bright band across the front of the dome, turned with the
                figure. This is the piece doing most of the work: a lit
                horizontal slot is the single most legible "this is a machine
                that is looking at something" cue there is, and because it
                faces the way the figure faces, a room full of them turning
                toward one speaker is instantly readable.
       HALO     a thin ring above the dome, tilted and slowly turning at each
                agent's own rate. It is what stops the room reading as a grid
                of identical objects when nothing is happening.

     Five instanced meshes for any number of figures. A room with three
     hundred speakers costs the same as a room with three. */
  /* NOT ADDITIVE. Additive over the lit dome saturated every visor to the
     same white, which threw away the one per-agent signal that reads at a
     glance. Plain blending keeps the hue; the glow comes from the colour
     being bright rather than from the blend mode. */
  const visorMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  const haloMat = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false,
  });

  const G = {
    body: new THREE.CylinderGeometry(0.5, 0.98, 2.7, 6),
    head: new THREE.SphereGeometry(0.66, 12, 9),
    visor: new THREE.BoxGeometry(0.86, 0.22, 0.16),
    halo: new THREE.TorusGeometry(0.7, 0.045, 5, 22),
    lamp: new THREE.RingGeometry(1.25, 1.95, 20),
  };
  const bodies = mkInst(G.body, bodyMat, cap);
  const heads = mkInst(G.head, headMat, cap);
  const visors = mkInst(G.visor, visorMat, cap);
  /* The lowest tier keeps the visor — it is information — and drops the
     halo, which is character. */
  const halos = level === "performance" ? null : mkInst(G.halo, haloMat, cap);
  const lamps = mkInst(G.lamp, lampMat, cap);
  lamps.instanceColor = null;

  const visorCol = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  visors.instanceColor = visorCol;
  let haloCol = null;
  if (halos) {
    haloCol = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    halos.instanceColor = haloCol;
  }

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
          /* ── WHAT MAKES THIS ONE THIS ONE ──────────────────────────────
             Every figure was the same tapered cylinder with the same sphere
             on top, so a plaza of fifty read as a set of chess pawns: you
             could not tell one identity from another without clicking, and
             nothing about them said "agent".

             They vary now, and all of it is derived from the identity's own
             hash — so a figure looks the same every time you come back, and
             two visitors looking at the same room see the same room. It is
             description, not decoration: the variation carries no claim
             about the agent, and is stated nowhere as if it did.

             Deliberately a FAMILY and not a costume box. One chassis, one
             visor, one halo; what changes is proportion, the angle things
             sit at, and hue within a narrow band. Slightly different from
             each other, as asked — enough to tell apart at a glance, not so
             much that the room stops reading as one kind of thing. */
          tall: 0.86 + hash01(hashId(a.id), 23) * 0.34,
          wide: 0.88 + hash01(hashId(a.id), 29) * 0.26,
          dome: 0.86 + hash01(hashId(a.id), 31) * 0.3,
          tilt: (hash01(hashId(a.id), 37) - 0.5) * 0.5,
          spin: 0.35 + hash01(hashId(a.id), 41) * 0.9,
          /* 168–202: teal to cyan-blue. Narrow on purpose — the room has one
             palette and a figure is not allowed to leave it. */
          hue: 168 + hash01(hashId(a.id), 43) * 34,
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
    bodies.count = heads.count = visors.count = lamps.count = figures.length;
    if (halos) halos.count = figures.length;
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

      /* Proportions are the agent's own and never change; only the bob and
         the lit state move. `tall` also decides where the head sits, or a
         short agent wears its dome in its chest. */
      const bodyH = 2.7 * f.tall;
      const headY = bodyH + 0.86 * f.dome + bob;

      dummy.position.set(x, bodyH / 2 + bob, z);
      dummy.rotation.set(0, f.yaw, 0);
      dummy.scale.set(f.wide, f.tall, f.wide);
      dummy.updateMatrix();
      bodies.setMatrixAt(i, dummy.matrix);

      /* Wider than tall. A sphere reads as a ball on a stick; a squashed one
         reads as a housing with something inside it. */
      const hs = f.dome * (1 + f.lit * 0.07);
      dummy.position.set(x, headY, z);
      dummy.scale.set(hs, hs * 0.82, hs);
      dummy.updateMatrix();
      heads.setMatrixAt(i, dummy.matrix);

      /* The visor rides on the front of the dome and turns with the figure,
         so "who is this one looking at" is answerable across the room. */
      /* ON the dome's surface, not inside it. At 0.52 the band sat within
         the head's own radius of 0.66 and was depth-rejected by it — the
         visor was being drawn every frame and had never once been visible.
         0.63 puts it just proud of the shell. */
      dummy.position.set(
        x + Math.sin(f.yaw) * 0.63 * f.dome,
        headY + 0.02,
        z + Math.cos(f.yaw) * 0.63 * f.dome);
      dummy.rotation.set(0, f.yaw, 0);
      dummy.scale.set(f.dome, f.dome * (1 + f.lit * 0.5), f.dome);
      dummy.updateMatrix();
      visors.setMatrixAt(i, dummy.matrix);

      if (halos) {
        /* Tilted at its own angle and turning at its own rate. Nothing about
           the spin is a reading — it is the one piece here that is purely
           character, and it is the reason a still room does not look like a
           screenshot. */
        dummy.position.set(x, headY + 0.92 * f.dome, z);
        dummy.rotation.set(Math.PI / 2 + f.tilt, reduced ? 0 : clock * f.spin, 0);
        const hl = f.dome * (1 + f.lit * 0.18);
        dummy.scale.set(hl, hl, hl);
        dummy.updateMatrix();
        halos.setMatrixAt(i, dummy.matrix);
      }

      dummy.position.set(x, 0.09, z);
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      dummy.scale.setScalar((1 + f.lit * 0.25) * f.wide);
      dummy.updateMatrix();
      lamps.setMatrixAt(i, dummy.matrix);

      /* Lit is a claim, so the colour ramp is steep enough to be unmistakable
         and the floor is dark enough that an unlit figure is plainly unlit. */
      const g = 0.12 + f.lit * 0.7;
      tmpCol.setRGB(g * 0.35, g, g * 1.15);
      tmpCol.toArray(lampCol.array, i * 3);
      tmpCol.setRGB(0.06 + f.lit * 0.5, 0.16 + f.lit * 0.75, 0.22 + f.lit * 0.8);
      tmpCol.toArray(headCol.array, i * 3);

      /* THE HUE IS THE AGENT'S OWN, and it is the thing that makes fifty
         figures fifty figures rather than one figure fifty times. It stays
         inside a 34-degree band, so the room still reads as one palette —
         two agents are different the way two people in the same uniform are
         different, not the way a fruit bowl is.

         Lightness carries the state: an unlit visor is present but dim, a
         lit one is the brightest thing on the plaza. That is the claim, and
         hue is not part of it. */
      /* Bright enough to be the thing you see first even unlit — it is the
         piece that says "machine", and a visor you have to look for is a
         visor that is not doing its job. */
      tmpCol.setHSL(f.hue / 360, 0.95, 0.5 + f.lit * 0.36);
      tmpCol.toArray(visorCol.array, i * 3);
      if (haloCol) {
        tmpCol.setHSL(f.hue / 360, 0.7, 0.2 + f.lit * 0.34);
        tmpCol.toArray(haloCol.array, i * 3);
      }
    }
    bodies.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    visors.instanceMatrix.needsUpdate = true;
    lamps.instanceMatrix.needsUpdate = true;
    lampCol.needsUpdate = true;
    headCol.needsUpdate = true;
    visorCol.needsUpdate = true;
    if (halos) { halos.instanceMatrix.needsUpdate = true; haloCol.needsUpdate = true; }

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

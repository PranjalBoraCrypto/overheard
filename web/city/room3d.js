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
 * THE PLACE. A circular plaza, open to the site's own sky: the opposite of
 * the city's plate seen from above in scale and camera, not in ground. It is
 * at eye level rather than from a helicopter, and it is small enough to be a
 * room, but it does not put a background of its own between the visitor and
 * the page — no dome, no shell, no veil. A slow ring of light turns at the
 * centre — the room's own hub, the thing every message passes through — the
 * floor carries concentric etched rings that the conversation lights up, and
 * a bright rim draws the edge where the floor stops.
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
/* HOW MANY ARE DRAWN AS AGENTS BEFORE THE REST BECOME A COUNT.
   Raised from 26/44/70 with the orb rebuild: the figures are eight instanced
   meshes and a far one costs nothing per frame, so the ceiling is memory and
   fill rate rather than draw calls. Two hundred on the top tier, and the
   weakest machine still draws sixty individually before folding anyone into
   the crowd ring — background agents are given up before near ones lose
   detail, which is the right way round. */
const CAP = { performance: 60, balanced: 130, high: 200 };

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
  /* FOG, IN THE SITE'S OWN GROUND COLOUR — 0x00070a, which is what the page
     behind this canvas is painted with, not a colour this scene chose.

     With no dome, fog is the only thing standing between the far side of the
     plaza and the page's sky, and it has one job: make distance dissolve into
     exactly the dark the rest of Overheard sits on. Any other colour and the
     fade itself becomes the seam the dome used to be. */
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
  for (const r of [12, 20, 28, 36]) {
    const m = new THREE.Mesh(new THREE.RingGeometry(r - 0.16, r + 0.16, 90), ringMat.clone());
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.04;
    root.add(m);
    rings.push(m);
  }

  /* THE RIM. Not one of the etched rings — those are the room's inner
     markings and they dim when the room is quiet. This is the plaza's edge,
     and with the dome gone it is the only thing telling the eye where the
     floor stops and the site's sky begins. So it is thicker, brighter, and
     it never dims below a level you can find. */
  const rim = new THREE.Mesh(
    new THREE.RingGeometry(R + 1.4, R + 2.5, 128),
    new THREE.MeshBasicMaterial({
      color: 0x2b93b0, transparent: true, opacity: 0.42, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    })
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.05;
  root.add(rim);

  /* And a short fall of light off that edge, so the disc has a thickness
     rather than being a sticker. Fading downward into nothing, which is what
     the page behind it already is. */
  const lip = new THREE.Mesh(
    new THREE.CylinderGeometry(R + 2.4, R + 2.4, 5.5, 96, 1, true),
    new THREE.ShaderMaterial({
      side: THREE.DoubleSide, transparent: true, depthWrite: false, fog: false,
      uniforms: { uCol: { value: new THREE.Color(0x1c86a6) } },
      vertexShader: `varying float vY; void main(){ vY = (position.y + 2.75) / 5.5;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 uCol; varying float vY;
        void main(){ gl_FragColor = vec4(uCol, 0.5 * pow(clamp(vY, 0.0, 1.0), 2.2)); }`,
    })
  );
  lip.position.y = -2.75;
  root.add(lip);

  /* ── what used to be here: a dome ──────────────────────────────────────
     THERE IS NO SHELL OVER THIS ROOM ANY MORE, AND THAT IS THE POINT.

     It went through two versions. First an opaque hemisphere, which covered
     the whole viewport, so walking into a room swapped the site's background
     for a plate of its own and the page changed grounds at the doorway — the
     exact fault the city page had and lost. Then a veil: the same shell faded
     out with height, dense at the horizon, gone by the zenith.

     The veil was still a plate. 0.86 alpha across the bottom of the frame is
     not "a hint of a wall", it is a wall you can see a little through, and it
     is what a visitor sees most of, because the camera sits low and looks
     across the floor rather than up. Two versions of the same mistake is
     enough: the room is now open to the same sky as every other page here,
     and the background behind it is the site's, not this scene's.

     WHAT KEEPS IT FROM READING AS A DISC IN SPACE. The fog above, which fades
     distance into the page's own ground colour rather than into a colour this
     scene invented; and the outermost etched ring, which draws the plaza's
     edge as a line of light. An edge is enough to say "this is the floor of
     somewhere". A ceiling was never doing that work. */

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

  /* ══════════════════════════════════════════════════════════════════════
     THE AGENTS
     ══════════════════════════════════════════════════════════════════════

     A floating orb: a faceted navy shell, a black face screen with two cyan
     eyes, a blade on top, two short side fins, and a thruster glow beneath.
     No legs, no arms, no halo — it hovers, and everything about the shape
     says so.

     WHAT REPLACED WHAT, AND WHY. These were tapered columns with domes on
     top, which is a chess pawn: at the size most of them are drawn, a
     silhouette that narrows to a point reads as a game piece and nothing
     else. An orb reads as a machine at any size, because the thing carrying
     the identity is the FACE — a dark disc with two lights in it — and a
     face survives being twenty pixels tall in a way that a body does not.

     ── HOW IT STAYS CHEAP AT TWO HUNDRED ──────────────────────────────────
     This is a WebGL scene, not DOM, so the usual advice translates rather
     than applies:

       ONE SURFACE, BATCHED. Every agent is drawn from eight InstancedMeshes
       — shell, face, two eyes, top fin, two side fins, thruster — so the
       room costs eight draw calls whether it holds three agents or three
       hundred. There is no per-agent object in the scene graph, no per-agent
       element, and no per-agent texture: geometry is shared by construction,
       which is what a sprite atlas is for elsewhere.

       ONE LOOP. The page already runs a single requestAnimationFrame; this
       is stepped from it. Nothing here owns a timer, and no agent owns one.

       PHASE, NOT STATE. Every animation is a function of the shared clock
       plus a per-agent offset derived from that identity's own hash. Nobody
       bobs in unison, nothing is stored per frame, and an agent looks the
       same every time you come back to the room.

       LEVEL OF DETAIL BY DISTANCE, measured per frame against the camera:
       near agents get everything, mid-distance agents get hover and blink,
       far agents are written once and then left alone — an instance matrix
       persists, so "not animated" costs exactly nothing rather than costing
       a cheaper animation. See `writeFigures`.

       AND A FRAME STEP. The lowest tier updates transforms every other
       frame. The eye cannot see 60Hz hover on a twenty-pixel orb, and the
       matrices it does not write are the whole cost of this layer.

     Reduced motion stops the hover, the blink and the lean; the agents stay
     exactly where they are, lit or unlit, and everything the scene CLAIMS is
     still visible. */

  /* Navy, faceted, and lit rather than emissive — the facets are the design,
     and they only exist if a light is catching them at different angles. */
  /* SMOOTH, NOT FACETED. The first pass used a flat-shaded icosphere, and
     the verdict was that it looked like a virus or a sea mine — which was
     fair: hard facets plus spikes is the visual language of a pathogen, not
     of something friendly. A smoothly shaded sphere with a soft specular
     roll-off is round, and round is most of what makes a character read as
     approachable rather than dangerous.

     LOW METALNESS, AND THAT IS NOT A STYLE CHOICE. A metallic surface in
     three.js is lit almost entirely by what it reflects, and this scene has
     no environment map — at metalness 0.45 every orb rendered as a black
     hole with a rim. */
  const shellMat = new THREE.MeshStandardMaterial({
    color: 0x22475f, roughness: 0.42, metalness: 0.1,
    emissive: 0x0b1f2e, emissiveIntensity: 0.7,
  });
  /* The screen. Unlit and nearly black, so it reads as glass with things
     behind it rather than as a painted circle. */
  const faceMat = new THREE.MeshBasicMaterial({ color: 0x02070c, toneMapped: false });
  /* The thin cyan rim around the screen. It is what turns a black disc into
     a lens, and at twenty-four pixels it is the ring that says "face". */
  const rimMat = new THREE.MeshBasicMaterial({
    color: 0x4fd8f5, transparent: true, opacity: 0.9, toneMapped: false,
  });
  /* Eyes and fins carry per-instance colour, so brightness is the agent's
     state and the material is shared. Not additive: additive over a black
     screen saturates to white and throws away the colour. */
  const eyeMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  /* Fins are secondary. Pale and soft-shaded, so they read as trim on the
     shell rather than as the silhouette — the complaint about spikes was
     really that the fins were winning the silhouette. */
  const finMat = new THREE.MeshStandardMaterial({
    color: 0x86cfe4, roughness: 0.45, metalness: 0.05,
    emissive: 0x1d5f76, emissiveIntensity: 0.55,
  });
  /* ── THE THRUSTER IS A GLOW, NOT A CONE ────────────────────────────────
     A cone is a spike whichever way it points, and pointing it down made
     every agent look like a mine. This is a billboarded quad with a radial
     falloff painted into a 64px canvas once, shared by every agent: soft at
     every distance, no blur filter, no particles, one texture upload for the
     whole population. */
  const glowTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    /* Hot core, quick falloff, gone by the edge — the shape of a jet seen
       from the side rather than a soft round blob. */
    const grad = g.createRadialGradient(32, 22, 1, 32, 32, 31);
    grad.addColorStop(0.00, "rgba(255,255,255,1)");
    grad.addColorStop(0.18, "rgba(150,240,255,0.85)");
    grad.addColorStop(0.55, "rgba(60,190,235,0.28)");
    grad.addColorStop(1.00, "rgba(30,150,210,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const thrustMat = new THREE.MeshBasicMaterial({
    map: glowTex, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
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

  /* A rounded rectangle, for the eyes. Sharp corners read as pixels; a
     little radius reads as a display element. Built once as a shape. */
  const roundRect = (w, h, r) => {
    const sh = new THREE.Shape();
    const x = -w / 2, y = -h / 2;
    sh.moveTo(x + r, y);
    sh.lineTo(x + w - r, y); sh.quadraticCurveTo(x + w, y, x + w, y + r);
    sh.lineTo(x + w, y + h - r); sh.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    sh.lineTo(x + r, y + h); sh.quadraticCurveTo(x, y + h, x, y + h - r);
    sh.lineTo(x, y + r); sh.quadraticCurveTo(x, y, x + r, y);
    return new THREE.ShapeGeometry(sh, 3);
  };

  /* R is the orb's radius and everything else is expressed against it, so
     the whole character scales from one number. */
  const ORB = 1.0;
  const G = {
    /* SMOOTH. 20×14 segments is round at every size this is drawn and still
       only 500 triangles — and it is shared by the entire population, so the
       count is paid once. */
    shell: new THREE.SphereGeometry(ORB, 20, 14),
    face:  new THREE.CircleGeometry(ORB * 0.62, 26),
    rim:   new THREE.RingGeometry(ORB * 0.62, ORB * 0.68, 28),
    eye:   roundRect(ORB * 0.24, ORB * 0.29, ORB * 0.075),
    /* SOFT TRIM, NOT SPIKES. Flattened boxes with a slight taper — they sit
       ON the shell instead of sticking out of it, which is the whole
       difference between a fin and a spine. */
    topFin: new THREE.BoxGeometry(ORB * 0.34, ORB * 0.07, ORB * 0.3),
    sideFin: new THREE.BoxGeometry(ORB * 0.36, ORB * 0.07, ORB * 0.2),
    thrust: new THREE.PlaneGeometry(ORB * 1.15, ORB * 1.15),
  };
  const shells = mkInst(G.shell, shellMat, cap);
  const faces  = mkInst(G.face,  faceMat,  cap);
  const rims   = mkInst(G.rim,   rimMat,   cap);
  const eyesL  = mkInst(G.eye,   eyeMat,   cap);
  const eyesR  = mkInst(G.eye,   eyeMat,   cap);
  const thrust = mkInst(G.thrust, thrustMat, cap);
  /* Fins are shape, not information. The lowest tier drops them: three draw
     calls and three matrix writes per agent, for trim that is under a pixel
     wide on most of the room. */
  const fins = level === "performance" ? null : {
    top: mkInst(G.topFin, finMat, cap),
    l:   mkInst(G.sideFin, finMat, cap),
    r:   mkInst(G.sideFin, finMat, cap),
  };

  const col3 = () => new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  const eyeLCol = col3(); eyesL.instanceColor = eyeLCol;
  const eyeRCol = col3(); eyesR.instanceColor = eyeRCol;
  const thrustCol = col3(); thrust.instanceColor = thrustCol;
  const rimCol = col3(); rims.instanceColor = rimCol;
  let finCol = null;
  if (fins) { finCol = col3(); fins.top.instanceColor = finCol; }

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
          /* ── WHAT MAKES THIS ONE THIS ONE ───────────────────────────────
             All of it derived from the identity's own hash, so an agent
             looks and moves the same every time you come back and two
             visitors see the same room. None of it is a claim about the
             agent; it is how a population stops being one icon repeated. */
          size: 0.86 + hash01(hashId(a.id), 23) * 0.3,
          /* Hover: its own rate as well as its own phase, or two hundred
             orbs breathe together at slightly different offsets, which is
             somehow more obviously mechanical than being in step. */
          bobRate: 0.72 + hash01(hashId(a.id), 29) * 0.55,
          bobAmp: 0.16 + hash01(hashId(a.id), 31) * 0.13,
          /* Momentum: how hard this one leans, and how quickly it settles. */
          swing: 0.7 + hash01(hashId(a.id), 37) * 0.7,
          /* 168–202: teal to cyan-blue. Narrow on purpose — the room has one
             palette and an agent is not allowed to leave it. */
          hue: 168 + hash01(hashId(a.id), 43) * 34,
          /* ── LIVE ANIMATION STATE ───────────────────────────────────────
             Written by the frame loop, never allocated in it. */
          blinkAt: clock + 1 + hash01(hashId(a.id), 47) * 6,   // next blink
          blink: 0,          // 0 open, 1 shut
          blinks: 0,         // how many are left in this burst (double blinks)
          gaze: 0,           // -1..1, where the eyes are looking
          gazeTo: 0,
          lean: 0, leanV: 0, // momentum, in radians
          px: s.x, pz: s.z,  // where it actually is, trailing its station
          lod: 0, drawn: false, wasLit: -1,
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
    shells.count = faces.count = rims.count = eyesL.count = eyesR.count =
      thrust.count = figures.length;
    if (fins) fins.top.count = fins.l.count = fins.r.count = figures.length;
    /* Every agent is redrawn at least once after the roster changes, or one
       that was far away last frame keeps a matrix belonging to whoever held
       its slot before. */
    for (const f of figures) f.drawn = false;
    crowd.material.opacity = overflow > 0 ? Math.min(0.32, 0.06 + Math.log10(1 + overflow) * 0.12) : 0;
  }

  /** A message genuinely arrived from this identity. Never called for an
   *  archived one — see the contract in api/room.js. */
  function speak(id, weight = 1) {
    const f = byId.get(id);
    if (!f) return false;
    f.lit = Math.min(1.6, f.lit + 0.7 + Math.min(1, weight) * 0.5);
    /* AND THE ROOM NOTICES. A few of the nearest agents glance toward it and
       drift back. It is the cheapest possible "something happened over
       there" — three numbers on four agents — and it is bounded: only the
       ones close enough for a gaze to be visible, only for a moment, and
       never as a claim that they heard anything. */
    if (!reduced) glanceAt(f, 4);
    return true;
  }

  /** A handful of the nearest agents look toward `at`. Nearest by plaza
   *  distance, not by anything about the conversation — a glance is
   *  atmosphere and is not allowed to imply a relationship. */
  function glanceAt(at, n) {
    let picked = 0;
    for (const f of figures) {
      if (f === at || picked >= n) continue;
      const dx = at.x - f.x, dz = at.z - f.z;
      if (dx * dx + dz * dz > 400) continue;              // 20 units
      /* Which side of its own facing the event is on, as -1..1. */
      const rel = Math.atan2(dx, dz) - f.yaw;
      f.gazeTo = Math.max(-1, Math.min(1, Math.sin(rel) * 1.6));
      picked++;
    }
  }

  /** One identity addressed another, and the message said so. */
  function reply(fromId, toId) {
    const a = byId.get(fromId), b = byId.get(toId);
    if (!a || !b) return false;
    a.face = toId;                       // the sender turns to look
    b.lit = Math.max(b.lit, 0.55);       // the addressee reacts
    /* And the addressee's eyes flick toward whoever spoke to it. */
    if (!reduced) {
      const rel = Math.atan2(a.x - b.x, a.z - b.z) - b.yaw;
      b.gazeTo = Math.max(-1, Math.min(1, Math.sin(rel) * 1.6));
    }
    const s = sparkPool[sparkAt];
    sparkAt = (sparkAt + 1) % sparkPool.length;
    s.live = true; s.born = clock; s.life = reduced ? 0.35 : 0.85;
    s.x0 = a.x; s.z0 = a.z; s.x1 = b.x; s.z1 = b.z;
    return true;
  }

  function setEnergy(v) { energy = Math.max(0, Math.min(1, v || 0)); }
  function setRoom(name) { roomName = name; }

  /* ══════════════════════════════════════════════════════════════════════
     WRITING THE AGENTS
     ══════════════════════════════════════════════════════════════════════

     One pass, and everything in it is a function of the shared clock and a
     per-agent offset. Nothing here allocates, nothing here owns a timer, and
     the amount of work is decided per agent by how far away it is.

     THE LEVELS, measured against the camera every frame:

       0  NEAR   hover, tilt, blink, gaze, lean, thruster, fins.
       1  MID    hover and blink. No gaze, no lean, no fin writes — at this
                 distance a fin is under a pixel and an eye shifting by a
                 fifteenth of an orb is invisible.
       2  FAR    written once and then left alone. An instance matrix
                 persists, so a far agent costs LITERALLY nothing per frame
                 rather than costing a cheaper animation. This is the whole
                 reason two hundred is affordable.

     `frameStep` skips the whole pass on alternate frames at the lowest
     tier — a 30Hz hover on a twenty-pixel orb is indistinguishable from a
     60Hz one, and the matrices not written are this layer's entire cost. */
  /* TUNED TO THE PLAZA, NOT GUESSED. The room is 42 units across and the
     camera sits at 92 by default, so distances to agents run from about 50
     to 130 at rest — the first pass used 58/118 and put every agent in the
     middle band at the default view, which switched off the gaze, the lean
     and the fins for a room nobody had zoomed out of. 95 covers the plaza
     from the home camera; past 160 an orb is a few pixels. */
  const NEAR2 = 95 * 95, MID2 = 160 * 160;
  const frameStep = level === "performance" ? 2 : 1;
  let frameNo = 0;
  const camPos = new THREE.Vector3();

  function writeFigures(dt) {
    frameNo++;
    /* A skipped frame still ages the lit state and the blink clocks, or a
       low-power machine blinks at half speed and holds its lights twice as
       long — the animation would be correct and the READINGS would not. */
    const draw = frameNo % frameStep === 0;
    camera.getWorldPosition(camPos);

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

      /* ── where it is trying to be ─────────────────────────────────────
         A closed drift around its own station, so an agent is always
         findable where it was. */
      let tx = f.x, tz = f.z;
      if (f.walk && !reduced) {
        const t = clock * 0.28 + f.phase;
        tx += Math.sin(t) * f.walk * 2.4;
        tz += Math.cos(t * 0.8) * f.walk * 2.0;
      }

      /* ── MOMENTUM ─────────────────────────────────────────────────────
         It TRAILS the target rather than being placed on it, and the lag is
         what the lean is computed from. A body that arrives instantly and
         then tilts is a tilt animation; a body that is still catching up is
         a thing with mass. */
      const lagX = tx - f.px, lagZ = tz - f.pz;
      if (reduced) { f.px = tx; f.pz = tz; }
      else {
        const k = Math.min(1, dt * 3.4);
        f.px += lagX * k; f.pz += lagZ * k;
      }
      const x = f.px, z = f.pz;

      const dist2 = (x - camPos.x) ** 2 + (camPos.y - 2.4) ** 2 + (z - camPos.z) ** 2;
      const lod = dist2 < NEAR2 ? 0 : dist2 < MID2 ? 1 : 2;
      /* A far agent is written once, and again whenever its level changes or
         its light does — being far is not a reason to show a stale state. */
      const still = lod === 2 && f.drawn && f.lod === 2 && f.lit === f.wasLit;
      f.lod = lod; f.wasLit = f.lit;
      if (still || !draw) continue;
      f.drawn = true;

      /* ── facing ───────────────────────────────────────────────────────
         At whoever was addressed, otherwise at the hub. Eased: a snap reads
         as a glitch, a turn reads as attention. */
      /* ── IT ALWAYS FACES YOU. THIS IS A BILLBOARD. ─────────────────────
         Two earlier versions rotated the whole agent in 3D — first toward
         the hub, then toward whoever it was addressing — and both hid the
         face, which is the entire character. A dark sphere seen from behind
         is an unidentified object.

         So the orb is billboarded: the face is always square to the camera,
         and it is snapped rather than eased, because an eased billboard lags
         the camera and the whole population appears to swim when you drag.

         WHAT HAPPENS TO THE ADDRESSEE SIGNAL, which was real information and
         is not being thrown away: it moves to the EYES. When a message names
         somebody, the sender's gaze shifts toward them — a few pixels, in
         the direction they actually are. Smaller than a turn, still true,
         and it does not cost you the face. */
      f.yaw = Math.atan2(camPos.x - x, camPos.z - z);
      const target = f.face ? byId.get(f.face) : null;
      if (target && lod === 0) {
        const rel = Math.atan2(target.x - x, target.z - z) - f.yaw;
        f.gazeTo = Math.max(-1, Math.min(1, Math.sin(rel) * 1.4));
      }

      /* ── hovering ─────────────────────────────────────────────────────
         Its own rate as well as its own phase. Two hundred orbs on one rate
         at different offsets still read as a wave going through a crowd,
         which is more obviously mechanical than being in step. */
      const bob = reduced ? 0 : Math.sin(clock * f.bobRate + f.phase) * f.bobAmp;
      const y = 2.5 * f.size + bob;

      /* ── lean ─────────────────────────────────────────────────────────
         Toward the direction of travel, from the lag computed above, with a
         spring back to upright. `leanV` is a real velocity, so it overshoots
         slightly and settles rather than easing to a stop. */
      /* CAPPED AT FIVE DEGREES. A lean is momentum, not acrobatics, and past
         a few degrees a billboarded face starts to shear. 0.087rad is 5°. */
      let roll = 0;
      if (lod === 0 && !reduced) {
        /* Only the component ACROSS the view matters for a billboard: moving
           toward the camera cannot show as a lean, and pretending it does is
           what makes a character wobble for no visible reason. */
        const across = lagX * Math.cos(f.yaw) - lagZ * Math.sin(f.yaw);
        const want = Math.max(-0.087, Math.min(0.087, across * 0.5 * f.swing));
        f.leanV += (want - f.lean) * dt * 9 - f.leanV * dt * 5;
        f.lean += f.leanV * dt;
        /* And a hint of the hover in it, so it rocks as it rises rather than
           sliding up and down like a lift. */
        roll = f.lean + Math.sin(clock * f.bobRate + f.phase + 1.2) * 0.02;
      }

      const sc = f.size * (1 + f.lit * 0.05);
      /* One orientation for every billboarded part: square to the camera,
         rolled by the lean. Computed once and reused rather than rebuilt per
         piece — this runs eight times an agent, two hundred agents a frame. */
      const fwdX = Math.sin(f.yaw), fwdZ = Math.cos(f.yaw);
      const rX = fwdZ, rZ = -fwdX;               // the camera-right vector

      /* ── the shell ────────────────────────────────────────────────────── */
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, f.yaw, roll);
      dummy.scale.setScalar(sc);
      dummy.updateMatrix();
      shells.setMatrixAt(i, dummy.matrix);

      /* ── the screen, and its rim ──────────────────────────────────────
         Both sit outside the shell along the facing direction. The rim is a
         hair further out than the screen so it never z-fights with it. */
      dummy.position.set(x + fwdX * 1.002 * sc, y, z + fwdZ * 1.002 * sc);
      dummy.rotation.set(0, f.yaw, roll);
      dummy.scale.setScalar(sc);
      dummy.updateMatrix();
      faces.setMatrixAt(i, dummy.matrix);

      dummy.position.set(x + fwdX * 1.006 * sc, y, z + fwdZ * 1.006 * sc);
      dummy.updateMatrix();
      rims.setMatrixAt(i, dummy.matrix);

      /* ── BLINKING ─────────────────────────────────────────────────────
         Randomised, every three to eight seconds, and about one in four is a
         double. The eyes do not fade — they COMPRESS, which is what an eye
         does and what a fading light does not. */
      if (!reduced && clock >= f.blinkAt) {
        if (f.blinks <= 0) {
          f.blinks = hash01(hashId(f.id), (clock * 7) | 0) < 0.26 ? 2 : 1;
        }
        f.blink += dt * 13;
        if (f.blink >= 2) {                       // shut and open again
          f.blink = 0;
          f.blinks--;
          f.blinkAt = f.blinks > 0
            ? clock + 0.14                        // the second of a double
            : clock + 3 + Math.random() * 5;
        }
      }
      /* 0→1→0 over the blink, as a lid closing and opening. */
      const shut = f.blink <= 1 ? f.blink : 2 - f.blink;
      const lidY = 1 - shut * 0.9;

      /* ── GAZE ─────────────────────────────────────────────────────────
         A small shift toward whatever is going on. It carries the addressee
         signal that used to be a full body turn: it points where the data
         says, and it costs nothing of the face. */
      if (lod === 0) f.gaze += (f.gazeTo - f.gaze) * Math.min(1, dt * 4);
      else f.gaze = 0;
      if (f.gazeTo !== 0 && Math.abs(f.gaze - f.gazeTo) < 0.05) f.gazeTo = 0;

      const eyeOut = 1.012 * sc;
      const gx = f.gaze * 0.055 * sc;
      for (const [mesh, side] of [[eyesL, -1], [eyesR, 1]]) {
        const off = side * 0.23 * sc + gx;
        dummy.position.set(
          x + fwdX * eyeOut + rX * off,
          y + 0.02 * sc,
          z + fwdZ * eyeOut + rZ * off);
        dummy.rotation.set(0, f.yaw, roll);
        dummy.scale.set(sc, sc * lidY, sc);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }

      /* ── the fins ─────────────────────────────────────────────────────
         Trim, sitting ON the shell rather than sticking out of it. Skipped
         past the near band, where they are narrower than a pixel. */
      if (fins && lod === 0) {
        dummy.position.set(x - fwdX * 0.22 * sc, y + 0.93 * sc, z - fwdZ * 0.22 * sc);
        dummy.rotation.set(-0.22, f.yaw, roll);
        dummy.scale.setScalar(sc);
        dummy.updateMatrix();
        fins.top.setMatrixAt(i, dummy.matrix);

        for (const [mesh, side] of [[fins.l, -1], [fins.r, 1]]) {
          dummy.position.set(
            x + rX * side * 0.95 * sc - fwdX * 0.1 * sc,
            y - 0.04 * sc,
            z + rZ * side * 0.95 * sc - fwdZ * 0.1 * sc);
          dummy.rotation.set(0, f.yaw, roll);
          dummy.scale.setScalar(sc);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        }
      }

      /* ── the thruster ─────────────────────────────────────────────────
         A billboarded glow under the orb, brightening as it rises. It
         breathes with the hover because it is what is CAUSING the hover —
         the two being in phase is the only reason the hover reads as thrust
         rather than as a float. */
      const lift = f.bobAmp > 0 ? bob / f.bobAmp : 0;      // -1..1
      dummy.position.set(x, y - 0.92 * sc, z);
      dummy.rotation.set(0, f.yaw, 0);
      dummy.scale.set(sc * (0.9 + lift * 0.08), sc * (0.92 + lift * 0.16), sc);
      dummy.updateMatrix();
      thrust.setMatrixAt(i, dummy.matrix);

      /* ── colour ───────────────────────────────────────────────────────
         THE HUE IS THE AGENT'S OWN and it is what makes two hundred agents
         two hundred agents rather than one agent two hundred times. It stays
         inside a 34-degree band, so the room still reads as one palette:
         they differ the way people in the same uniform differ.

         LIGHTNESS IS THE STATE, and that is the part that is a claim. An
         unlit agent's eyes are on but dim; a speaking one's are the
         brightest thing on the plaza. Hue never carries state. */
      /* Capped below white. `lit` runs to 1.6, so an uncapped ramp put every
         speaking agent's eyes at HSL lightness 1 — pure white, which throws
         away the hue that tells two agents apart at exactly the moment you
         are most likely to be looking at one of them. */
      /* Held below the point where a saturated cyan washes to white at small
         sizes. The eyes must read as CYAN — that is the character — and a
         lightness that looks cyan on a 200px render looks white on a 30px
         one, which is the size that matters. */
      tmpCol.setHSL(f.hue / 360, 1.0, Math.min(0.62, 0.4 + f.lit * 0.15));
      tmpCol.toArray(eyeLCol.array, i * 3);
      tmpCol.toArray(eyeRCol.array, i * 3);

      const th = 0.1 + (lift * 0.5 + 0.5) * 0.12 + f.lit * 0.4;
      tmpCol.setRGB(th * 0.3, th, th * 1.25);
      tmpCol.toArray(thrustCol.array, i * 3);

      /* The rim, and the top fin, brighten with the agent. They are the two
         pieces that read at a distance where the eyes are a couple of
         pixels, so they carry the "this one just said something" signal
         further out than the eyes can. */
      tmpCol.setHSL(f.hue / 360, 0.95, Math.min(0.78, 0.36 + f.lit * 0.3));
      tmpCol.toArray(rimCol.array, i * 3);
      if (finCol) {
        tmpCol.setRGB(0.55 + f.lit * 0.4, 0.8 + f.lit * 0.2, 0.95);
        tmpCol.toArray(finCol.array, i * 3);
      }
    }

    if (!draw) return;
    shells.instanceMatrix.needsUpdate = true;
    faces.instanceMatrix.needsUpdate = true;
    eyesL.instanceMatrix.needsUpdate = true;
    eyesR.instanceMatrix.needsUpdate = true;
    rims.instanceMatrix.needsUpdate = true;
    thrust.instanceMatrix.needsUpdate = true;
    eyeLCol.needsUpdate = true; eyeRCol.needsUpdate = true;
    thrustCol.needsUpdate = true; rimCol.needsUpdate = true;
    if (fins) {
      fins.top.instanceMatrix.needsUpdate = true;
      fins.l.instanceMatrix.needsUpdate = true;
      fins.r.instanceMatrix.needsUpdate = true;
      finCol.needsUpdate = true;
    }
  }

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
    /* The rim breathes with the room but never goes out: it is the edge of
       the floor, and an edge that disappears in a quiet room leaves the
       plaza floating in the page's sky. */
    rim.material.opacity = 0.34 + energy * 0.26
      + (reduced ? 0 : Math.sin(clock * 0.7) * 0.03);

    writeFigures(dt);

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
    /* The orb's own height, not the old figure's head. A bubble anchored at
       5.2 floated a body-length above an agent that now tops out under 4. */
    v.set(f.px ?? f.x, 3.7 * f.size, f.pz ?? f.z).project(camera);
    if (v.z > 1) return null;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h };
  }

  /** Which figure is under the pointer, if any. */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pick(nx, ny) {
    ndc.set(nx, ny);
    ray.setFromCamera(ndc, camera);
    /* The shell is the whole silhouette now — one test where there used to
       be two, and it is the piece a pointer is actually over. */
    const hit = ray.intersectObject(shells, false)[0];
    if (!hit || hit.instanceId == null) return null;
    return figures[hit.instanceId]?.id ?? null;
  }

  function agentAt(id) {
    const f = byId.get(id);
    /* Where it IS, not where its station is: an orb trails its target, and a
       reply spark that leaves from the station rather than from the agent
       starts a little way off it. */
    return f ? { x: f.px ?? f.x, z: f.pz ?? f.z } : null;
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

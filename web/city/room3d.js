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
 * the page — no dome, no shell, no veil. The floor carries concentric etched
 * rings that the conversation lights up, and a bright rim draws the edge
 * where the floor stops. The middle is empty on purpose: what marks the
 * centre is that every pod in the room is facing it.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THE AGENTS, AND WHAT THEY ARE ALLOWED TO DO
 *
 * Each identity that has spoken gets a hexagonal pod, hanging still. Where
 * it stands is a hash of its own id, so it is in the same place every time
 * you come back and a conversation can be followed by watching two specific
 * pods rather than two moving dots.
 *
 * A POD DOES EXACTLY TWO THINGS, and both of them are evidence:
 *
 *   IT BLINKS. Every three to eight seconds, on its own schedule. This is
 *   the one piece of pure life in the room and it claims nothing — it is
 *   there so a plaza of two hundred does not read as a car park.
 *
 *   ITS BOTTOM PANEL PULSES when a sequence number the live reader has not
 *   seen before arrives FROM THAT IDENTITY. Nobody else's panel moves. An
 *   archived message never pulses anyone, which is the same rule the city
 *   obeys and the reason a saved room can show its history without
 *   pretending to be busy.
 *
 * EVERYTHING ELSE WAS REMOVED, and the list is worth keeping because each
 * item was once defended: idle hover, drift, momentum lean, body turning,
 * eye tracking, thruster breathing, per-identity colour, the halo, the ring
 * above the head, the light on the floor underneath. Every one of them was
 * either decoration dressed as information, or motion that made a still
 * scene harder to read.
 *
 * FACING is not an animation. Every pod's rotation is a vector from where it
 * stands toward the centre of the plaza, computed once when it appears. Pods
 * on the far side show you their faces, pods near the camera show you their
 * backs, and that is correct: it is a room of agents talking to the room,
 * seen from a seat in it, rather than two hundred posters turned to face you.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * COST
 *
 * Seven instanced meshes for the whole population — shell, face panel, two
 * eyes, two side tabs, light bar — plus the pooled reply sparks and the fixed
 * furniture of the plaza. A room with two hundred speakers costs the same
 * draw calls as a room with three. And because nothing moves, every instance
 * matrix is written once and then left alone: the per-frame work is the
 * handful of pods mid-blink and the handful mid-pulse. Agents past the cap
 * are folded into the crowd ring — a count, drawn as a band of light, never
 * as invented people.
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

/* HOW MANY ARE DRAWN AS PODS BEFORE THE REST BECOME A COUNT.
   26/44/70 under the old design, because every figure was animating every
   frame. The pods do not move: their matrices are written once and the
   steady-state cost of a still pod is zero, so the ceiling is fill rate
   rather than per-frame work. Two hundred on the top tier, and the weakest
   machine still draws sixty individually before folding anyone into the
   crowd ring — background agents are given up before near ones lose detail,
   which is the right way round. */
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

  /* ── what used to stand in the middle ──────────────────────────────────
     A hub: two turning rings of light around a vertical core. It was the
     room's machinery made visible, and it was removed on request.

     It is not missed, and the reason is worth writing down. It turned
     whether or not anything was happening, which made it the most eye-
     catching thing in a quiet room while carrying almost no information —
     the etched floor rings already track the room's rate, and they do it
     without a column of light standing where the conversation is. The
     agents now face the centre, so the centre is still legible as the
     centre; it just no longer competes with them. */

  /* ══════════════════════════════════════════════════════════════════════
     THE AGENTS — ONE FLOATING HEXAGONAL POD
     ══════════════════════════════════════════════════════════════════════

     A wide, squat, six-sided pod: a blue-gray low-poly shell, a large inset
     near-black face panel with two cyan eyes, two small flush side tabs, and
     a thin cyan light bar underneath. No head, no body, no pedestal, no
     halo, no ring, no antenna, no fins, no thruster plume, no circle on the
     floor. One self-contained object, hanging still.

     THE THREE THINGS THIS REPLACED, IN ORDER, AND WHY EACH FAILED.

       A TAPERED COLUMN WITH A DOME. A chess pawn at any size below a hundred
       pixels. Read as a game piece, said nothing about agents.

       A FACETED SPHERE WITH SPIKES. Read as a virus or a sea mine — hard
       facets plus radial spikes is the visual grammar of a pathogen.

       A SMOOTH ORB WITH FINS AND A THRUSTER. Closer, but it was still a
       sphere, and a sphere has no front: the only way to keep its face
       pointed at anyone was to billboard the whole body, which meant two
       hundred agents all turned to the camera like a wall of posters.

     A HEXAGONAL POD SOLVES THE THING ALL THREE GOT WRONG, which is that a
     character needs a FRONT. The front face is a flat plane with a screen on
     it, so the pod can be turned in the world — every one of them faces the
     centre of the plaza — and the ones that end up with their backs to you
     still read as pods, because the silhouette carries the identity rather
     than the face doing all the work.

     ── HOW IT STAYS CHEAP AT TWO HUNDRED ──────────────────────────────────

       ONE SURFACE PER PART, BATCHED. Seven InstancedMeshes for the whole
       population — shell, face panel, two eyes, two side tabs, light bar.
       A room with two hundred pods costs seven draw calls, the same as a
       room with three. No per-agent object, element, texture or material.

       THE MATRICES ARE WRITTEN ONCE. This is the big one, and it is what
       the old design could not do. Nothing about a pod moves: it does not
       bob, drift, lean, tilt or turn. So every instance matrix is written
       when the roster changes and then never touched again. A still agent
       costs literally zero per frame.

       ONLY TWO THINGS UPDATE, EVER. An agent mid-blink rewrites its two eye
       matrices. An agent mid-message-pulse rewrites three floats of colour.
       Everybody else is skipped by an integer comparison. At two hundred
       agents in a busy room that is typically under a dozen writes a frame,
       against the old design's sixteen hundred.

       ONE SCHEDULER. The page already runs a single requestAnimationFrame
       and this is stepped from it. No agent owns a timer, an interval or a
       loop, and nothing here touches page state.

     ── THE PALETTE IS LOCKED ──────────────────────────────────────────────

     Sampled from the reference render, not chosen: shell #415d78 under this
     scene's teal ambient and cyan key resolves to #4d6983 on top-facing
     surfaces and around #304559 on the sides, which is the reference. Face
     panel #02080f. Eyes and light bar #00f2fe.

     EVERY POD IS THE SAME COLOUR. An earlier version gave each identity its
     own hue inside a narrow band, as a way of telling two hundred agents
     apart. That is gone by instruction, and the instruction is defensible:
     a hue that varies by identity invites the reading that hue MEANS
     something, and it does not. Identity is carried by position — which is
     a hash of the id and therefore stable across visits — by the hover card,
     and by the transmission card that names its sender. */

  /* THE PROFILE. A hexagon in the XY plane, half-width 1, wider than tall
     (2.0 × 1.20). Wound counter-clockwise seen from the front, so a fan over
     it faces +Z and the side bands come out with their normals pointing
     away from the body. Everything else about the pod is expressed against
     this, so the whole character scales from one number. */
  const PROF = [
    [ 1.00,  0.06],   // right point
    [ 0.58,  0.60],   // top right
    [-0.58,  0.60],   // top left
    [-1.00,  0.06],   // left point
    [-0.66, -0.60],   // bottom left
    [ 0.66, -0.60],   // bottom right
  ];

  /**
   * A hexagonal slab: the profile above, repeated at a few depths with a
   * scale each, skinned with quads and capped at both ends.
   *
   * Three rings rather than two is what gives the pod its chamfer — the
   * front ring is inset, so the outermost band reads as a bezel around the
   * screen and the top of the body slopes rather than being a slab edge.
   * The whole shell is 32 triangles.
   */
  function slab(rings, sx = 1, sy = 1, oy = 0) {
    const N = PROF.length, pos = [], idx = [];
    for (const [z, s] of rings)
      for (const [x, y] of PROF) pos.push(x * s * sx, y * s * sy + oy, z);
    for (let r = 0; r < rings.length - 1; r++) {
      const a = r * N, b = (r + 1) * N;
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        idx.push(a + i, b + i, b + j, a + i, b + j, a + j);
      }
    }
    for (let i = 1; i < N - 1; i++) idx.push(0, i, i + 1);          // front cap
    const c = (rings.length - 1) * N;
    for (let i = 1; i < N - 1; i++) idx.push(c, c + i + 1, c + i);  // back cap
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    /* Flat shading is the point — the broad surfaces have to read as broad
       surfaces, and smoothed normals would turn a deliberate low-poly body
       into a lump. computeVertexNormals on non-indexed-per-face geometry
       would average them, so the material carries flatShading instead. */
    g.computeVertexNormals();
    return g;
  }

  /** A flat hexagon, for the inset face panel. Four triangles. */
  function hexPanel(s) {
    const N = PROF.length, pos = [], idx = [];
    for (const [x, y] of PROF) pos.push(x * s, y * s, 0);
    for (let i = 1; i < N - 1; i++) idx.push(0, i, i + 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /* A rounded rectangle, for the eyes. Sharp corners read as pixels; a
     little radius reads as a display element. Two curve segments per corner
     is all that survives at the size these are drawn. */
  const roundRect = (w, h, r) => {
    const sh = new THREE.Shape();
    const x = -w / 2, y = -h / 2;
    sh.moveTo(x + r, y);
    sh.lineTo(x + w - r, y); sh.quadraticCurveTo(x + w, y, x + w, y + r);
    sh.lineTo(x + w, y + h - r); sh.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    sh.lineTo(x + r, y + h); sh.quadraticCurveTo(x, y + h, x, y + h - r);
    sh.lineTo(x, y + r); sh.quadraticCurveTo(x, y, x + r, y);
    return new THREE.ShapeGeometry(sh, 2);
  };

  const G = {
    /* front bezel ring, widest ring, back — 32 triangles */
    shell: slab([[0.50, 0.90], [0.34, 1.00], [-0.40, 0.86]]),
    face:  hexPanel(0.80),
    eye:   roundRect(0.175, 0.38, 0.07),
    /* Tiny flush tabs at the sides. Twelve triangles each, and the lowest
       tier does without them — at twenty-four pixels a tab is under one. */
    tab:   new THREE.BoxGeometry(0.17, 0.26, 0.30),
    /* The light bar: a thin hexagonal slab under the body, a little narrower
       than it, extruded far enough that its outward-facing band is visible
       from ANY horizontal direction. That matters — the pods face the centre,
       so most of them have their backs to you, and a glow only on the front
       would be a signal you could not see. */
    bar:   slab([[0.24, 1.00], [-0.20, 0.90]], 0.56, 0.065, -0.68),
    /* THE HOVER WASH. A flat quad in the air under the pod — not on the
       floor, and not a ring. It is what makes the pod read as HANGING rather
       than as an object that happens to be drawn above the ground, and it is
       the second half of the message signal: the bar is the light, this is
       the light falling on nothing. */
    wash:  new THREE.PlaneGeometry(3.1, 3.1),
  };

  /* One 64px radial gradient, drawn once and shared by the entire
     population. No blur filter, no particles, no second light — a texture
     upload of four kilobytes for two hundred agents. */
  const washTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(32, 32, 1, 32, 32, 31);
    grad.addColorStop(0.00, "rgba(255,255,255,1)");
    grad.addColorStop(0.22, "rgba(150,240,255,0.72)");
    grad.addColorStop(0.58, "rgba(40,180,225,0.22)");
    grad.addColorStop(1.00, "rgba(0,140,200,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();

  /* ── the materials, and the palette lock ────────────────────────────── */
  /* TUNED AGAINST THE RENDER, NOT AGAINST THE HEX. The reference's shell is
     #4d6983 on top-facing surfaces and about #304559 on the sides, and those
     are LIT values — what a surface ends up as under this scene's teal
     ambient and cyan key. Setting the base to the reference's lit value gave
     pods at roughly half of it, so the base is brighter than the target on
     purpose and the lighting brings it back down. Measured with a
     screenshot; these are the numbers that landed. */
  const shellMat = new THREE.MeshStandardMaterial({
    color: 0xa9c4d8, roughness: 0.68, metalness: 0.04,
    emissive: 0x141d26, emissiveIntensity: 0.6, flatShading: true,
  });
  /* The screen. Unlit and nearly black, so it reads as glass with something
     behind it rather than as a painted patch. */
  const faceMat = new THREE.MeshBasicMaterial({ color: 0x02080f, toneMapped: false });
  /* One colour, every agent, every state. The eyes do not brighten, dim or
     change hue — they blink, and that is all they do. */
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x00f2fe, toneMapped: false });
  const tabMat = new THREE.MeshStandardMaterial({
    color: 0x8fa8bd, roughness: 0.64, metalness: 0.05, flatShading: true,
  });
  /* White base, because the per-instance colour IS the brightness: the bar
     runs from a dim cyan at rest to full #00f2fe at the peak of a pulse, and
     multiplying against white keeps that ramp exactly as written. */
  const barMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  /* The hover wash. Additive so it reads as light rather than as a grey
     disc, and depthWrite off so two pods standing close do not clip each
     other's glow into a hard edge. */
  const washMat = new THREE.MeshBasicMaterial({
    map: washTex, transparent: true, depthWrite: false, toneMapped: false,
    blending: THREE.AdditiveBlending,
  });

  const mkInst = (geo, mat, n) => {
    const m = new THREE.InstancedMesh(geo, mat, n);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    /* Same reason as the city's life layer: an InstancedMesh sits at the
       origin and its bounds do not describe where its instances are, so
       culling the batch throws the whole room away when you look at a wall. */
    m.frustumCulled = false;
    m.count = 0;
    root.add(m);
    return m;
  };

  const shells = mkInst(G.shell, shellMat, cap);
  const faces  = mkInst(G.face,  faceMat,  cap);
  const eyesL  = mkInst(G.eye,   eyeMat,   cap);
  const eyesR  = mkInst(G.eye,   eyeMat,   cap);
  const bars   = mkInst(G.bar,   barMat,   cap);
  const washes = mkInst(G.wash,  washMat,  cap);
  const tabs = level === "performance" ? null : {
    l: mkInst(G.tab, tabMat, cap),
    r: mkInst(G.tab, tabMat, cap),
  };
  /* The wash is additive and unlit, so it must be drawn after the solid
     bodies or a pod standing behind one washes over its shell. */
  washes.renderOrder = 2;

  const barCol = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  bars.instanceColor = barCol;
  const washCol = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  washes.instanceColor = washCol;

  /* ── SIZE, AND WHY IT IS NOT SOLVED WITH HEIGHT ────────────────────────
     The pawn was tall because tall was how it was made visible, and tall is
     what made it a pawn. The pod is made visible by being WIDE and by the
     contrast inside it — pale shell, black screen, two cyan eyes, a cyan bar
     — so the fix for "too small to read" is a bigger pod, never a taller one
     and never a pedestal.

     1.72 puts a near agent at roughly 46 pixels across at the home camera
     (dist 92, 38° vertical fov, a 900-tall stage): 2 × 1.72 world units of
     width, at about 13 pixels per unit for something 60-odd units away.
     Measured with a screenshot, not derived — the derivation is here so the
     next person can tell whether a change to the camera invalidated it. */
  const S = 1.72;
  /* A short, FIXED distance above the floor. Fixed is the whole point: there
     is no bob, so this number is the pod's height for the life of the room
     and the matrix that carries it is written once. */
  const HOVER = 0.60 * S + 1.05 * S;

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

  /* ── state ─────────────────────────────────────────────────────────── */
  /* { id, x, z, a, yaw, px, pz, blinkAt, blinkT, blinks, pulseT, lit,
       placed, barLast, lod, count, signed } */
  let figures = [];
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
       huddle near the middle rather than a scatter across an empty floor.
       UNCHANGED BY THE POD REBUILD, deliberately: an identity has to stand
       where it stood last time or the room stops being a place you can learn. */
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
        /* ── WHICH WAY A POD FACES ─────────────────────────────────────
           Any way it likes, and the same way every time you come back.

           This went through two versions in one sitting. The first turned
           every pod toward the centre of the plaza, which is tidy and
           reads as a meeting — but it is also a claim, and a false one:
           nothing in the data says these agents are addressing the room's
           middle, and a hundred and thirty pods aimed at one empty point
           looks staged. It also produced whole arcs of the room in perfect
           rotational lockstep, which is the thing a crowd never does.

           So the angle is drawn from the identity's own hash, like its
           position. It is arbitrary, it is stable across visits, and it
           claims nothing at all — which is exactly the right amount for a
           thing the data has no opinion about. Some pods will happen to
           face you, most will not, and the room reads as a room. */
        f = {
          id: a.id, x: s.x, z: s.z, a: s.a,
          yaw: hash01(hashId(a.id), 53) * TAU,
          /* Kept as aliases of the station so agentAt() and project() have
             one thing to read. The pod does not drift, so these never
             change — but the callers should not have to know that. */
          px: s.x, pz: s.z,
          born: clock,

          /* ── ANIMATION 1: BLINKING ──────────────────────────────────────
             The only thing about a pod that moves on its own. Each one
             carries the clock time of its next blink, seeded from its own
             id hash so two hundred pods never open on the same frame and
             never fall into step afterwards. */
          blinkAt: clock + 0.8 + hash01(hashId(a.id), 47) * 7.2,
          blinkT: -1,        // seconds into the current blink, or -1 for none
          blinks: 0,         // how many are left in this burst (double blinks)

          /* ── ANIMATION 2: THE MESSAGE PULSE ─────────────────────────────
             Seconds since this agent's own last new message, or -1. Only
             the agent that sent it ever gets one. */
          pulseT: -1,
          lit: 0,            // the pulse, as 0..1, for the panel and the API

          placed: false,     // has its matrix been written since it appeared
          barLast: -1,       // last brightness written, to skip identical writes
          lod: 0,
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
    shells.count = faces.count = eyesL.count = eyesR.count =
      bars.count = washes.count = figures.length;
    if (tabs) tabs.l.count = tabs.r.count = figures.length;
    /* Every agent is placed again after the roster changes, or one that was
       written last time keeps a matrix belonging to whoever held its slot
       before. This is the ONLY thing that triggers a full matrix write. */
    for (const f of figures) { f.placed = false; f.barLast = -1; }
    crowd.material.opacity = overflow > 0 ? Math.min(0.32, 0.06 + Math.log10(1 + overflow) * 0.12) : 0;
  }

  /** A message genuinely arrived from this identity. Never called for an
   *  archived one — see the contract in api/room.js. */
  function speak(id, weight = 1) {
    const f = byId.get(id);
    if (!f) return false;
    /* THE ONLY THING THIS DOES IS START THE SENDER'S PULSE — the bottom
       panel, on that one pod, for a little over a second.

       Nothing else in the room reacts. An earlier version had the nearest
       few agents glance toward whoever spoke; it was atmosphere dressed as
       information, because nothing in the data says those agents heard
       anything. `weight` is ignored for the same reason: the pulse says a
       message arrived, and a longer message is not a louder one. */
    f.pulseT = 0;
    return true;
  }

  /** One identity addressed another, and the message said so. */
  function reply(fromId, toId) {
    const a = byId.get(fromId), b = byId.get(toId);
    if (!a || !b) return false;
    /* THE ADDRESSEE DOES NOT LIGHT UP. Its bottom panel means "this agent
       sent a message", and being spoken to is not sending one. The pod does
       not turn either — every pod faces the centre, permanently. The
       travelling spark below is the whole of what a reply draws, and it is a
       claim about the message rather than about either pod. */
    const s = sparkPool[sparkAt];
    sparkAt = (sparkAt + 1) % sparkPool.length;
    s.live = true; s.born = clock; s.life = reduced ? 0.35 : 0.85;
    s.x0 = a.x; s.z0 = a.z; s.x1 = b.x; s.z1 = b.z;
    return true;
  }

  function setEnergy(v) { energy = Math.max(0, Math.min(1, v || 0)); }
  function setRoom(name) { roomName = name; }

  /* ══════════════════════════════════════════════════════════════════════
     WRITING THE PODS
     ══════════════════════════════════════════════════════════════════════

     THE WHOLE ARGUMENT FOR TWO HUNDRED IS IN THIS FUNCTION, and it is not a
     clever optimisation — it is a consequence of the pods not moving.

     A pod has no hover, no drift, no lean, no tilt and no turn. Its position
     and its rotation are decided once, when it appears, and are true for as
     long as it is in the room. An instance matrix persists until something
     overwrites it. So the matrices are written ONCE, in `place`, and after
     that the per-frame work is:

       · one integer comparison per agent, to see whether it is due to blink;
       · two matrix writes for each agent that is actually mid-blink;
       · three floats of colour for each agent mid-message-pulse.

     In a busy room that is typically under a dozen writes a frame against
     two hundred agents. The old design wrote eight matrices per agent per
     frame — sixteen hundred — because everything about it was animating.

     WHAT LOD MEANS NOW. Distance no longer chooses between cheap and
     expensive animation, because there is no expensive animation. It decides
     one thing: whether an agent's blink is worth drawing at all. Past the
     mid band an eye is a fraction of a pixel and its blink is invisible, so
     those agents are skipped entirely — their eyes simply stay open.

     REDUCED MOTION stops the blink. The pulse stays, in a simplified form,
     because it is the room reporting that a message arrived and that is
     information rather than decoration. */
  const NEAR2 = 95 * 95, MID2 = 160 * 160;
  const camPos = new THREE.Vector3();

  /* ── the blink envelope ────────────────────────────────────────────────
     Close fast, hold shut, open a little slower — which is what an eyelid
     does and what a fading light does not. Returns how open the eye is,
     1 fully open down to a thin line.

     Never zero: at 0.06 the eye is a one-pixel cyan bar rather than nothing,
     and a pod whose eyes vanish for a tenth of a second reads as a pod that
     switched off. */
  const BLINK_END = 0.29;
  function eyeOpen(t) {
    if (t < 0.075) return 1 - (t / 0.075) * 0.94;           // shut, 75ms
    if (t < 0.170) return 0.06;                             // closed, 95ms
    if (t < BLINK_END) return 0.06 + ((t - 0.170) / 0.12) * 0.94;  // open, 120ms
    return 1;
  }

  /* ── the message-pulse envelope ────────────────────────────────────────
     Brighten, two controlled pulses, a brief held state, then out. 1.15s end
     to end. Written as an explicit piecewise ramp rather than as a decaying
     sine, because the brief a sine would satisfy is "it flashes" and the
     brief here is "it brightens, beats twice, holds, and goes". */
  const PULSE_END = 1.15;
  function pulseAt(t) {
    if (t < 0)    return 0;
    if (t < 0.12) return t / 0.12;                                   // rise
    if (t < 0.34) return 1 - ((t - 0.12) / 0.22) * 0.55;             // 1 → .45
    if (t < 0.50) return 0.45 + ((t - 0.34) / 0.16) * 0.50;          // .45 → .95
    if (t < 0.72) return 0.95 - ((t - 0.50) / 0.22) * 0.55;          // .95 → .40
    if (t < 0.95) return 0.40;                                       // hold
    if (t < PULSE_END) return 0.40 * (1 - (t - 0.95) / 0.20);        // out
    return 0;
  }

  /* Both ends of both ramps, as THREE.Color so the sRGB→linear conversion is
     the library's rather than mine. Writing 0.20 straight into instanceColor
     is a LINEAR 0.20, which lands near #7f on screen — the first pass had a
     "dim" bar glowing like a torch for exactly that reason.

     Same cyan at both ends of both: #00f2fe is the reference's eye and bar
     colour, and the rest state is that colour turned down, never a different
     one. */
  const BAR_DIM  = new THREE.Color(0x125a68);
  const BAR_LIT  = new THREE.Color(0x00f2fe);
  const WASH_DIM = new THREE.Color(0x08222b);
  const WASH_LIT = new THREE.Color(0x3ceaff);
  const mixCol = new THREE.Color();

  /** Write every matrix for one pod. Called once per agent per roster
   *  change, and never from the steady state. */
  function place(f, i) {
    const { x, z, yaw } = f;
    dummy.rotation.set(0, yaw, 0);
    dummy.scale.setScalar(S);

    dummy.position.set(x, HOVER, z);
    dummy.updateMatrix();
    shells.setMatrixAt(i, dummy.matrix);

    /* The face panel sits a hair PROUD of the shell's front cap, which is at
       z = 0.58 in profile units. Behind it and the shell swallows it — the
       first pass had it at 0.526 and the pods rendered with no faces at all,
       which is the same class of bug as the orb's eyes ending up inside the
       hull. Proud by 0.008 is under a pixel of offset and cannot z-fight;
       the bezel ring around it is what makes it read as inset. */
    const fwdX = Math.sin(yaw), fwdZ = Math.cos(yaw);
    const rX = fwdZ, rZ = -fwdX;                    // the pod's own right
    const faceZ = 0.508 * S;
    dummy.position.set(x + fwdX * faceZ, HOVER, z + fwdZ * faceZ);
    dummy.updateMatrix();
    faces.setMatrixAt(i, dummy.matrix);

    /* Eyes, on the panel. Written here too so a pod that never blinks still
       has them; the blink pass rewrites only these two. */
    writeEyes(f, i, 1);

    if (tabs) {
      /* Flush against the widest ring, at the pod's own left and right. */
      for (const [mesh, side] of [[tabs.l, -1], [tabs.r, 1]]) {
        dummy.position.set(
          x + rX * side * 0.88 * S + fwdX * 0.02 * S,
          HOVER + 0.06 * S,
          z + rZ * side * 0.88 * S + fwdZ * 0.02 * S);
        dummy.rotation.set(0, yaw, 0);
        dummy.scale.setScalar(S);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
    }

    /* The light bar. Its own geometry already carries the offset below the
       body, so this is the pod's transform exactly. */
    dummy.position.set(x, HOVER, z);
    dummy.rotation.set(0, yaw, 0);
    dummy.scale.setScalar(S);
    dummy.updateMatrix();
    bars.setMatrixAt(i, dummy.matrix);

    /* THE HOVER WASH, flat in the air below the pod. Horizontal rather than
       billboarded, and that is a real decision: a billboard has to be
       re-aimed every time the camera moves, which would put two hundred
       matrix writes back into every frame of a drag and undo the whole
       write-once design. Lying flat, it is correct from any yaw for free.
       The room camera looks down between 5° and 66°, so it is always a
       visible ellipse rather than an edge-on line. */
    dummy.position.set(x, HOVER - 0.95 * S, z);
    dummy.rotation.set(-Math.PI / 2, 0, 0);
    dummy.scale.setScalar(S);
    dummy.updateMatrix();
    washes.setMatrixAt(i, dummy.matrix);

    f.placed = true;
  }

  /** The two eyes, at a given openness. The ONLY thing rewritten per frame
   *  for a blinking pod. */
  function writeEyes(f, i, open) {
    const { x, z, yaw } = f;
    const fwdX = Math.sin(yaw), fwdZ = Math.cos(yaw);
    const rX = fwdZ, rZ = -fwdX;
    const eyeZ = 0.520 * S;                       // just proud of the panel
    for (const [mesh, side] of [[eyesL, -1], [eyesR, 1]]) {
      const off = side * 0.185 * S;
      dummy.position.set(
        x + fwdX * eyeZ + rX * off,
        HOVER + 0.02 * S,
        z + fwdZ * eyeZ + rZ * off);
      dummy.rotation.set(0, yaw, 0);
      /* Compressed vertically only. The eye keeps its width, which is what
         makes it read as a lid closing rather than as a light shrinking. */
      dummy.scale.set(S, S * open, S);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
  }

  function writeFigures(dt) {
    camera.getWorldPosition(camPos);
    let movedEyes = false, movedBars = false, placedAny = false;

    for (let i = 0; i < figures.length; i++) {
      const f = figures[i];

      if (!f.placed) { place(f, i); placedAny = true; movedBars = true; f.barLast = -1; }

      /* Distance, for one decision only: is this pod's blink worth drawing.
         `lod` is kept on the figure because the suites read it. */
      const dist2 = (f.x - camPos.x) ** 2 + (camPos.y - HOVER) ** 2 + (f.z - camPos.z) ** 2;
      f.lod = dist2 < NEAR2 ? 0 : dist2 < MID2 ? 1 : 2;

      /* ── ANIMATION 1: BLINKING ────────────────────────────────────────
         Every three to eight seconds, and about one in six is a double.
         Skipped entirely past the mid band, where the eye is a fraction of a
         pixel — a far pod simply stays open, which costs nothing. */
      if (!reduced && f.lod < 2) {
        if (f.blinkT < 0 && clock >= f.blinkAt) {
          f.blinkT = 0;
          if (f.blinks <= 0) f.blinks = Math.random() < 0.16 ? 2 : 1;
        }
        if (f.blinkT >= 0) {
          f.blinkT += dt;
          if (f.blinkT >= BLINK_END) {
            writeEyes(f, i, 1);                 // land exactly open
            movedEyes = true;
            f.blinkT = -1;
            f.blinks--;
            f.blinkAt = f.blinks > 0
              ? clock + 0.13                    // the second of a double
              : clock + 3 + Math.random() * 5;
          } else {
            writeEyes(f, i, eyeOpen(f.blinkT));
            movedEyes = true;
          }
        }
      } else if (f.blinkT >= 0) {
        /* Walked out of range mid-blink, or reduced motion came on. Put the
           eyes back open once rather than leaving them shut forever. */
        writeEyes(f, i, 1);
        movedEyes = true;
        f.blinkT = -1;
      }

      /* ── ANIMATION 2: THE MESSAGE PULSE ───────────────────────────────
         Only for the agent that actually sent something, and only for the
         1.15s the envelope runs. `barLast` stops a resting pod rewriting the
         same three floats every frame for the life of the room. */
      let want = 0;
      if (f.pulseT >= 0) {
        f.pulseT += dt;
        want = reduced
          ? Math.max(0, 1 - f.pulseT / PULSE_END)     // one clean fall
          : pulseAt(f.pulseT);
        if (f.pulseT >= PULSE_END) { f.pulseT = -1; want = 0; }
      }
      f.lit = want;
      /* Quantised to 1/64 before comparing: a ramp writes about seventy
         distinct values over its life instead of one per frame, and the
         difference is invisible. */
      const q = Math.round(want * 64);
      if (q !== f.barLast) {
        f.barLast = q;
        const u = q / 64;
        mixCol.copy(BAR_DIM).lerp(BAR_LIT, u).toArray(barCol.array, i * 3);
        /* The wash rides the same envelope but never reaches the bar's
           brightness: it is light landing on air, not the source. */
        mixCol.copy(WASH_DIM).lerp(WASH_LIT, u).toArray(washCol.array, i * 3);
        movedBars = true;
      }
    }

    /* Upload only what changed. On a still frame in a quiet room this
       function uploads nothing at all. */
    if (placedAny) {
      shells.instanceMatrix.needsUpdate = true;
      faces.instanceMatrix.needsUpdate = true;
      bars.instanceMatrix.needsUpdate = true;
      washes.instanceMatrix.needsUpdate = true;
      if (tabs) { tabs.l.instanceMatrix.needsUpdate = true; tabs.r.instanceMatrix.needsUpdate = true; }
    }
    if (movedEyes || placedAny) {
      eyesL.instanceMatrix.needsUpdate = true;
      eyesR.instanceMatrix.needsUpdate = true;
    }
    if (movedBars) { barCol.needsUpdate = true; washCol.needsUpdate = true; }
  }
  /* ── the frame ─────────────────────────────────────────────────────── */
  function update(dt) {
    clock += dt;

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
    /* Just above the pod's top edge. The pod is a fixed height and a fixed
       size, so this is one number rather than the old per-figure sum — and
       it has to track HOVER, or a transmission card tethers to empty air. */
    v.set(f.x, HOVER + 0.60 * S + 0.45 * S, f.z).project(camera);
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
    /* How many pods are mid-message-pulse right now. Used by the suites, and
       it is a count of a real event rather than of a mood. */
    get lit() { return figures.filter((f) => f.pulseT >= 0).length; },
    /* For the suites: the pod's fixed size and height, so a pixel-width
       assertion does not have to hard-code numbers this file owns. */
    get podScale() { return S; },
    get podY() { return HOVER; },
  };
}

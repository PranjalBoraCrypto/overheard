/* ── THE AGENT, IN THREE DIMENSIONS ────────────────────────────────────────
 *
 * The hero robot, raymarched. One signed distance field, one fragment shader,
 * no library and no model file — which is the only reason a thing this heavy
 * can sit above the fold on a page that still paints in under a second.
 *
 * WHY NOT three.js
 *
 * A modelled robot needs the library (~150KB gzipped) plus geometry plus
 * materials, and every one of those is a request that can fail on a phone on
 * a train. An SDF is arithmetic: the shape, the soft shadows, the ambient
 * occlusion and the rim light are all the same function evaluated a few times
 * per pixel. The whole scene is the 200 lines of GLSL below.
 *
 * WHAT MOVES, AND WHY IT MOVES THAT WAY
 *
 * Nothing here is a CSS transition. The head is a rigid body with angular
 * velocity: the cursor sets a target, a spring pulls toward it, friction
 * bleeds energy out, and a hard shake injects enough angular momentum that
 * the spring is switched off entirely and the head spins free until it slows
 * back down. That is why a flick feels different from a drag — it is the same
 * difference a real object would have.
 *
 * Everything else lags behind the head by construction rather than by
 * keyframe: the antenna is a second spring hung off the first, the eyes are a
 * third and faster one, and the squash is driven by the magnitude of the
 * angular velocity. Lag is what reads as mass.
 *
 * DEGRADING
 *
 * mount() returns null if WebGL2 is unavailable or the context is lost, and
 * the caller falls back to the flat canvas face. Reduced motion gets the
 * model, lit and still, with no spring and no spin — the shape was never the
 * problem, the movement was.
 * ──────────────────────────────────────────────────────────────────────── */

const VERT = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2  uRes;
uniform float uTime;
uniform vec3  uRot;      // yaw, pitch, roll of the head
uniform vec2  uEye;      // where the eyes are looking, inside the visor
uniform float uAnt;      // antenna lag
uniform float uBlink;    // 1 open, 0 shut
uniform float uSquash;   // >1 stretched, <1 squashed
uniform float uWide;     // eyes widen with speed
uniform float uGlow;     // emissive gain
uniform vec3  uAccent;

const float PI = 3.14159265;

float sdRoundBox(vec3 p, vec3 b, float r){
  vec3 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}
float sdSphere(vec3 p, float r){ return length(p) - r; }
float sdCapsule(vec3 p, vec3 a, vec3 b, float r){
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
float sdTorus(vec3 p, vec2 t){
  vec2 q = vec2(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}
float smin(float a, float b, float k){
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

// world -> head space
vec3 toHead(vec3 p){
  p -= vec3(0.0, 0.06, 0.0);
  p.xz = rot(-uRot.x) * p.xz;   // yaw
  p.yz = rot(uRot.y) * p.yz;    // pitch
  p.xy = rot(-uRot.z) * p.xy;   // roll
  return p;
}

// x: distance   y: material
vec2 map(vec3 p){
  vec3 ph = toHead(p);
  ph.y /= uSquash; ph.xz *= sqrt(uSquash);   // squash preserves volume

  // ── the shell: wider than it is tall, with a machined crown ──
  float shell = sdRoundBox(ph, vec3(0.66, 0.58, 0.50), 0.21);
  float crown = sdRoundBox(ph - vec3(0.0, 0.62, -0.02), vec3(0.44, 0.06, 0.34), 0.06);
  shell = smin(shell, crown, 0.10);
  // a vent slot over the crown and a seam around the jaw, so it reads machined
  float vent = sdRoundBox(ph - vec3(0.0, 0.68, -0.02), vec3(0.16, 0.04, 0.26), 0.04);
  shell = max(shell, -vent);
  float seam = sdRoundBox(ph - vec3(0.0, -0.30, 0.0), vec3(0.80, 0.010, 0.70), 0.010);
  shell = max(shell, -(seam - 0.003));

  vec2 res = vec2(shell, 1.0);

  /* ── the face plate ───────────────────────────────────────────────────
     A bezel, not a painted-on rectangle. The plate is a slab standing off
     the front of the shell; the glass is subtracted from it, which leaves a
     real machined rim with its own highlight — the single detail that most
     separates "a box with a screen" from "an object". */
  vec3 fp = ph - vec3(0.0, 0.055, 0.44);
  float plate = sdRoundBox(fp, vec3(0.50, 0.325, 0.085), 0.17);
  vec3 gp = ph - vec3(0.0, 0.055, 0.475);
  float glass = sdRoundBox(gp, vec3(0.415, 0.245, 0.060), 0.145);
  plate = max(plate, -(glass - 0.016));
  if(plate < res.x) res = vec2(plate, 4.0);
  if(glass < res.x) res = vec2(glass, 2.0);

  // ── the eyes, standing proud of the glass ──
  vec3 ep = ph - vec3(0.0, 0.075, 0.520);
  ep.x = abs(ep.x) - 0.165;
  ep -= vec3(uEye.x * 0.058, uEye.y * 0.052, 0.0);
  /* A blink is the eye's own space stretched vertically, then the distance
     scaled back by the same factor — the standard trick for non-uniform
     scaling in an SDF, and the scaled distance stays a lower bound, so the
     march can still take full steps without punching through. */
  float lid = max(uBlink, 0.05);
  vec3 eq = vec3(ep.x, ep.y / lid, ep.z);
  float eyes = sdRoundBox(eq, vec3(0.052 * uWide, 0.075 * uWide, 0.030), 0.030) * lid;
  if(eyes < res.x) res = vec2(eyes, 3.0);

  // ── the brow bar: a strip of light along the top of the glass ──
  float brow = sdRoundBox(ph - vec3(0.0, 0.268, 0.505), vec3(0.30, 0.012, 0.022), 0.012);
  if(brow < res.x) res = vec2(brow, 5.0);

  // ── the speaker slit ──
  float mouth = sdRoundBox(ph - vec3(0.0, -0.185, 0.505), vec3(0.105, 0.016, 0.022), 0.016);
  if(mouth < res.x) res = vec2(mouth, 5.0);

  // ── ear pods ──
  vec3 ea = vec3(abs(ph.x) - 0.72, ph.y - 0.02, ph.z - 0.02);
  float ear = sdRoundBox(ea, vec3(0.075, 0.175, 0.155), 0.070);
  if(ear < res.x) res = vec2(ear, 4.0);
  vec3 ed = vec3(abs(ph.x) - 0.800, ph.y - 0.02, ph.z - 0.02);
  float pod = sdRoundBox(ed, vec3(0.010, 0.070, 0.060), 0.010);
  if(pod < res.x) res = vec2(pod, 5.0);

  // ── antenna, lagging behind the head ──
  vec3 ap = ph - vec3(0.0, 0.58, -0.02);
  ap.xy = rot(uAnt) * ap.xy;
  ap.zy = rot(uAnt * 0.7) * ap.zy;
  float stalk = sdCapsule(ap, vec3(0.0), vec3(0.0, 0.30, 0.0), 0.024);
  if(stalk < res.x) res = vec2(stalk, 4.0);
  float tip = sdSphere(ap - vec3(0.0, 0.375, 0.0), 0.070);
  if(tip < res.x) res = vec2(tip, 6.0);

  // ── the hover ring: does NOT rotate with the head ──
  float ring = sdTorus(p - vec3(0.0, -0.80, 0.0), vec2(0.44, 0.030));
  if(ring < res.x) res = vec2(ring, 4.0);

  return res;
}

vec3 normalAt(vec3 p){
  vec2 e = vec2(1.0, -1.0) * 0.0012;
  return normalize(
    e.xyy * map(p + e.xyy).x + e.yyx * map(p + e.yyx).x +
    e.yxy * map(p + e.yxy).x + e.xxx * map(p + e.xxx).x);
}

float shadow(vec3 ro, vec3 rd){
  float res = 1.0, t = 0.04;
  for(int i = 0; i < 26; i++){
    float h = map(ro + rd * t).x;
    if(h < 0.0008) return 0.0;
    res = min(res, 9.0 * h / t);
    t += clamp(h, 0.02, 0.30);
    if(t > 4.0) break;
  }
  return clamp(res, 0.0, 1.0);
}

float occlusion(vec3 p, vec3 n){
  float o = 0.0, s = 1.0;
  for(int i = 0; i < 5; i++){
    float h = 0.015 + 0.09 * float(i);
    o += (h - map(p + n * h).x) * s;
    s *= 0.72;
  }
  return clamp(1.0 - 1.6 * o, 0.0, 1.0);
}

const vec3 L_KEY  = vec3(-0.5547, 0.7866, 0.2734);
const vec3 L_RIM  = vec3( 0.8305, 0.1563, -0.5344);
const vec3 L_FILL = vec3( 0.3162, -0.5797, 0.7513);

/* ── THE ROOM ──────────────────────────────────────────────────────────────
   There is no environment map, because that would be a file to load. This is
   the studio written down: a cool vertical gradient, one soft white softbox
   where the key light is, a wide cyan bar where the rim is, and a little
   bounce off a floor that does not exist. Reflecting the view vector into it
   is what turns a shaded blob into a rendered object — every polished edge
   suddenly has something to be polished ABOUT. */
vec3 room(vec3 d, vec3 accent){
  float up = d.y * 0.5 + 0.5;
  vec3 c = mix(vec3(0.008, 0.018, 0.026), vec3(0.105, 0.175, 0.215), up * up);
  float k = max(dot(d, L_KEY), 0.0);
  c += vec3(1.00, 0.99, 0.96) * (pow(k, 34.0) * 3.40 + pow(k, 6.0) * 0.90);
  float r = max(dot(d, L_RIM), 0.0);
  c += accent * (pow(r, 15.0) * 2.30 + pow(r, 3.0) * 0.55);
  c += accent * pow(max(-d.y, 0.0), 2.0) * 0.30;
  return c;
}

// GGX, trimmed to what a single object under two lights actually needs
float spec(vec3 n, vec3 v, vec3 l, float rough){
  vec3 h = normalize(v + l);
  float a = max(rough * rough, 0.002);
  float d = max(dot(n, h), 0.0);
  float k = d * d * (a * a - 1.0) + 1.0;
  return (a * a) / (PI * k * k + 1e-5);
}

void main(){
  vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / uRes.y;

  vec3 ro = vec3(0.0, 0.02, 2.62);
  vec3 rd = normalize(vec3(uv * 0.70, -1.0));

  float t = 0.0, mid = 0.0;
  float emisNear = 1e9;
  bool hit = false;
  for(int i = 0; i < 110; i++){
    vec3 p = ro + rd * t;
    vec2 h = map(p);
    if((h.y > 2.5 && h.y < 3.5) || h.y > 5.5) emisNear = min(emisNear, h.x);
    if(h.x < 0.0011 * max(t, 1.0)){ hit = true; mid = h.y; break; }
    t += h.x * 0.82;
    if(t > 7.0) break;
  }

  // the emissive parts bleed a little light into the air around them
  float bloom = exp(-emisNear * 11.0) * 0.55;

  if(!hit){
    fragColor = vec4(uAccent * bloom * uGlow, clamp(bloom * 1.6, 0.0, 1.0));
    return;
  }

  vec3 p = ro + rd * t;
  vec3 n = normalAt(p);
  vec3 v = -rd;

  vec3 base; float rough, metal; vec3 emis = vec3(0.0);
  if(mid < 1.5){                                    // the shell: cool ceramic
    base = vec3(0.215, 0.285, 0.345); rough = 0.215; metal = 0.58;
  } else if(mid < 2.5){                             // visor glass, near black
    base = vec3(0.006, 0.016, 0.024); rough = 0.045; metal = 0.06; emis = uAccent * 0.055;
  } else if(mid < 3.5){                             // eyes
    base = vec3(0.02); rough = 0.20; metal = 0.0; emis = uAccent * 1.35;
  } else if(mid < 4.5){                             // bezel, pods, ring
    base = uAccent * 0.34 + vec3(0.02, 0.04, 0.05); rough = 0.17; metal = 0.92;
  } else if(mid < 5.5){                             // lit slits and brow
    base = vec3(0.02); rough = 0.25; metal = 0.0; emis = uAccent * 1.5;
  } else {                                          // antenna tip
    base = vec3(0.02); rough = 0.22; metal = 0.0; emis = uAccent * 2.1;
  }

  vec3 lKey = L_KEY, lRim = L_RIM, lFill = L_FILL;

  float sh = shadow(p + n * 0.006, lKey);
  float ao = occlusion(p, n);

  vec3 col = vec3(0.0);
  col += base * max(dot(n, lKey), 0.0) * vec3(1.00, 0.99, 0.96) * 1.55 * mix(0.14, 1.0, sh);
  /* The rim is raised to a power rather than scaled up. A linear cyan wash
     over the whole lit side just tints the object; a tight band along the
     silhouette is what actually says "there is a light behind this". */
  col += base * pow(max(dot(n, lRim), 0.0), 2.1) * uAccent * 3.30;
  col += base * max(dot(n, lFill), 0.0) * vec3(0.10, 0.28, 0.36) * 0.22;
  // the page's own socket glow, bouncing up off nothing in particular
  col += base * pow(max(-n.y, 0.0), 1.5) * uAccent * 0.30;
  // hemisphere ambient: cool from above, near-black from below
  col += base * mix(vec3(0.006, 0.016, 0.022), vec3(0.038, 0.072, 0.092), n.y * 0.5 + 0.5) * ao;

  vec3 sc = mix(vec3(0.045), base, metal);
  col += sc * spec(n, v, lKey, rough) * 3.4 * sh;
  col += sc * spec(n, v, lRim, rough) * uAccent * 3.0;

  /* Reflection. Schlick's fresnel decides how much of the room the surface
     shows, so the rim of every rounded edge goes bright and the flat faces
     stay dark — which is the whole difference between plastic and metal. */
  float fr = pow(1.0 - max(dot(n, v), 0.0), 5.0);
  float f0 = mix(0.04, 1.0, metal);
  vec3 refl = room(reflect(rd, n), uAccent);
  col += refl * mix(vec3(f0), base, metal) * mix(f0, 1.0, fr) * (1.0 - rough * 0.70) * mix(0.30, 1.0, ao) * 1.55;
  col += fr * uAccent * (mid < 2.5 ? 0.30 : 0.16) * ao;

  col *= ao;
  col += emis * uGlow;
  col += uAccent * bloom * uGlow * 0.8;

  // filmic-ish rolloff, then sRGB. A tighter shoulder than the usual 0.82:
  // this object is one bright thing on a black page, and a soft shoulder was
  // pulling every surface toward the same mid grey.
  col = col / (col + vec3(1.0)) * 1.10;
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));

  fragColor = vec4(col, 1.0);
}`;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function compile(gl, type, src){
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(log || "shader failed to compile");
  }
  return s;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{accent?:[number,number,number], calm?:boolean, maxDpr?:number,
 *          hint?:HTMLElement, onFirstInteraction?:()=>void}} opts
 * @returns {{destroy:()=>void, enableTilt:()=>Promise<boolean>, state:object}|null}
 */
export function mountAgent3D(canvas, opts = {}){
  const gl = canvas.getContext("webgl2", {
    alpha: true, antialias: false, premultipliedAlpha: true,
    powerPreference: "low-power", desynchronized: true,
  });
  if(!gl) return null;

  let prog;
  try{
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if(!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(prog) || "link failed");
  }catch(e){
    console.warn("[agent3d]", e.message);
    return null;
  }

  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const U = {};
  for(const k of ["uRes","uTime","uRot","uEye","uAnt","uBlink","uSquash","uWide","uGlow","uAccent"])
    U[k] = gl.getUniformLocation(prog, k);

  const accent = opts.accent || [0.34, 0.86, 1.0];
  const calm = !!opts.calm;

  /* ── THE BODY ────────────────────────────────────────────────────────────
     Angular position and velocity, in radians. The spring is a spring, not
     an easing curve: torque toward the target, damping against the velocity,
     integrated at a fixed step so a dropped frame slows the animation down
     rather than teleporting the head through half a rotation. */
  const S = {
    yaw: 0, pitch: 0, roll: 0,
    vYaw: 0, vPitch: 0, vRoll: 0,
    tYaw: 0, tPitch: 0,
    eyeX: 0, eyeY: 0, tEyeX: 0, tEyeY: 0,
    ant: 0, vAnt: 0,
    squash: 1, vSquash: 0,
    blink: 1, nextBlink: 2.2, blinkPhase: 0,
    wide: 1,
    spinning: false,
    energy: 0,          // 0..1, how hard it is being played with
    engaged: false,
  };

  const K_HEAD = 78, C_HEAD = 12.4;      // stiff, just short of critical
  const K_ANT  = 46, C_ANT  = 4.6;       // floppy, so it whips
  const K_SQ   = 120, C_SQ  = 13;
  const SPIN_ON = 7.2;                   // rad/s at which the spring lets go
  const SPIN_OFF = 2.6;                  // and at which it takes hold again
  const YAW_LIMIT = 0.62, PITCH_LIMIT = 0.40;

  let px = 0, py = 0;                    // pointer, normalised to the socket
  let lastVx = 0, shakeAccum = 0, shakeCount = 0, lastShake = 0, lastSpin = 0;
  let pointerInside = false, firstDone = false;

  const markFirst = () => {
    if(firstDone) return;
    firstDone = true;
    opts.hint?.classList.add("used");
    opts.onFirstInteraction?.();
  };

  function aim(clientX, clientY){
    const r = canvas.getBoundingClientRect();
    if(!r.width) return;
    const nx = clamp(((clientX - r.left) / r.width - 0.5) * 2, -1.6, 1.6);
    const ny = clamp(((clientY - r.top) / r.height - 0.5) * 2, -1.6, 1.6);
    const vx = nx - px;
    px = nx; py = ny;

    S.tYaw = clamp(nx, -1, 1) * YAW_LIMIT;
    S.tPitch = clamp(ny, -1, 1) * PITCH_LIMIT;
    S.tEyeX = clamp(nx * 1.25, -1, 1);
    S.tEyeY = clamp(ny * 1.25, -1, 1);

    /* A SHAKE IS A REVERSAL, NOT A SPEED — and it is a COUNT of reversals,
       not one of them.

       Moving fast in one direction is a person going somewhere else; moving
       fast and changing sign repeatedly is a person waggling the mouse at a
       robot, and only the second should earn momentum. The first version
       spent an impulse on every reversal, which is exactly wrong: a shake
       alternates, so impulse n+1 cancelled impulse n and a hard waggle left
       the head with no angular velocity at all. Measured on a synthetic
       eighteen-move shake — it ended at 0.0 rad/s.

       Reversals now charge a counter instead. Three of them inside 420ms is
       a shake, and it spends the whole charge as ONE impulse in the direction
       of the last flick, then goes quiet for half a second so a long waggle
       reads as a spin rather than a seizure. */
    if(Math.sign(vx) !== Math.sign(lastVx) && Math.abs(vx) > 0.05){
      const now = performance.now();
      if(now - lastShake < 420){ shakeCount++; shakeAccum += Math.abs(vx); }
      else { shakeCount = 1; shakeAccum = Math.abs(vx); }
      lastShake = now;
      if(shakeCount >= 3 && now - lastSpin > 500 && !calm){
        S.vYaw += Math.sign(vx) * Math.min(7 + shakeAccum * 4.0, 25);
        S.vRoll += Math.sign(vx) * 1.6;
        S.squash = 1.15;
        shakeCount = 0; shakeAccum = 0; lastSpin = now;
        markFirst();
      }
    }
    if(Math.abs(vx) > 0.004) lastVx = vx;
    S.energy = Math.min(1, S.energy + Math.abs(vx) * 2.2);
  }

  const onMove = (e) => { pointerInside = true; S.engaged = true; aim(e.clientX, e.clientY); markFirst(); };
  const onLeave = () => { pointerInside = false; S.engaged = false; S.tYaw = 0; S.tPitch = 0; S.tEyeX = 0; S.tEyeY = 0; };

  /* A tap is a boop: the head takes it on the chin and the eyes go wide. */
  const onDown = (e) => {
    markFirst();
    S.vPitch += 5.4; S.squash = 0.86; S.wide = 1.32;
    if(e.pointerType === "touch") aim(e.clientX, e.clientY);
  };

  // Dragging is a throw. Release with speed and the head keeps going.
  let dragging = false, dragX = 0, dragT = 0;
  const onDragStart = (e) => { dragging = true; dragX = e.clientX; dragT = performance.now(); canvas.setPointerCapture?.(e.pointerId); };
  const onDragMove = (e) => {
    if(!dragging) return;
    const now = performance.now(), dt = Math.max(1, now - dragT) / 1000;
    const dx = (e.clientX - dragX) / Math.max(1, canvas.getBoundingClientRect().width);
    S.vYaw += dx / dt * 0.9;
    dragX = e.clientX; dragT = now;
    markFirst();
  };
  const onDragEnd = () => { dragging = false; };

  window.addEventListener("pointermove", onMove, { passive: true });
  canvas.addEventListener("pointerleave", onLeave, { passive: true });
  canvas.addEventListener("pointerdown", onDown, { passive: true });
  canvas.addEventListener("pointerdown", onDragStart, { passive: true });
  window.addEventListener("pointermove", onDragMove, { passive: true });
  window.addEventListener("pointerup", onDragEnd, { passive: true });

  /* ── PHONES ──────────────────────────────────────────────────────────────
     No cursor, so the handset itself is the cursor. iOS will not hand over
     the motion sensor without a gesture, so this is never called on load —
     the caller wires it to a tap, and a refusal is silent. */
  let tiltOn = false;
  const onTilt = (e) => {
    if(e.gamma == null || e.beta == null) return;
    S.tYaw = clamp(e.gamma / 34, -1, 1) * YAW_LIMIT;
    S.tPitch = clamp((e.beta - 42) / 40, -1, 1) * PITCH_LIMIT;
    S.tEyeX = clamp(e.gamma / 26, -1, 1);
    S.tEyeY = clamp((e.beta - 42) / 32, -1, 1);
    S.engaged = true;
  };
  async function enableTilt(){
    if(tiltOn || calm) return tiltOn;
    try{
      const D = window.DeviceOrientationEvent;
      if(!D) return false;
      if(typeof D.requestPermission === "function"){
        const ok = await D.requestPermission();
        if(ok !== "granted") return false;
      }
      window.addEventListener("deviceorientation", onTilt, { passive: true });
      tiltOn = true; markFirst();
      return true;
    }catch{ return false; }
  }

  // ── the loop ──
  let raf = 0, last = performance.now(), acc = 0, dead = false;
  let onScreen = true, awake = !document.hidden;
  const STEP = 1 / 120;

  /* ── PAYING FOR IT ───────────────────────────────────────────────────────
     A raymarcher is priced per pixel, and the pixel count is the only knob
     that does not change how the thing looks in motion. So the buffer is
     scaled by measured frame time rather than by guessing at the device: a
     laptop with a real GPU renders at full DPR, and something struggling
     quietly drops to 55% and keeps its frame rate instead of its sharpness. */
  let qual = 0.72, frameAvg = 16;   // start cheap, earn the pixels back

  /* The CSS size is read by a ResizeObserver, never per frame: calling
     getBoundingClientRect inside the loop forces layout on every tick, and
     this loop already has the main thread for longer than it deserves. */
  let cssW = 0, cssH = 0;
  const ro = new ResizeObserver((es) => {
    const r = es[0].contentRect;
    cssW = r.width; cssH = r.height; size();
  });
  ro.observe(canvas);

  function size(){
    if(!cssW){ const r = canvas.getBoundingClientRect(); cssW = r.width; cssH = r.height; }
    const dpr = Math.min(window.devicePixelRatio || 1, opts.maxDpr || 1.75) * qual;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if(canvas.width !== w || canvas.height !== h){
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  function physics(dt){
    if(calm){
      S.yaw += (S.tYaw - S.yaw) * 0.12; S.pitch += (S.tPitch - S.pitch) * 0.12;
      S.eyeX += (S.tEyeX - S.eyeX) * 0.2; S.eyeY += (S.tEyeY - S.eyeY) * 0.2;
      S.blink = 1; S.squash = 1; S.wide = 1;
      return;
    }
    const spd = Math.abs(S.vYaw);
    if(!S.spinning && spd > SPIN_ON) S.spinning = true;
    if(S.spinning && spd < SPIN_OFF) S.spinning = false;

    if(S.spinning){
      // free rotation: only friction, so it coasts and slows like a flywheel
      S.vYaw -= S.vYaw * 1.55 * dt;
    }else{
      S.vYaw += (K_HEAD * (S.tYaw - S.yaw) - C_HEAD * S.vYaw) * dt;
    }
    S.yaw += S.vYaw * dt;
    if(S.yaw > Math.PI) S.yaw -= 2 * Math.PI;
    if(S.yaw < -Math.PI) S.yaw += 2 * Math.PI;

    S.vPitch += (K_HEAD * (S.tPitch - S.pitch) - C_HEAD * S.vPitch) * dt;
    S.pitch += S.vPitch * dt;

    // roll is never aimed at anything: it is the head leaning into its turn
    const leanTarget = clamp(-S.vYaw * 0.035, -0.26, 0.26);
    S.vRoll += (52 * (leanTarget - S.roll) - 9.5 * S.vRoll) * dt;
    S.roll += S.vRoll * dt;

    // the antenna is hung off the head, so it is driven by the head's
    // acceleration, not its position — which is what makes it whip
    S.vAnt += (K_ANT * (clamp(-S.vYaw * 0.05, -0.6, 0.6) - S.ant) - C_ANT * S.vAnt) * dt;
    S.ant += S.vAnt * dt;

    S.vSquash += (K_SQ * (1 - S.squash) - C_SQ * S.vSquash) * dt;
    S.squash += S.vSquash * dt;
    S.squash = clamp(S.squash, 0.8, 1.24);

    // eyes lead the head: they arrive first, which is what makes it read as
    // looking rather than turning
    S.eyeX += (S.tEyeX - S.eyeX) * Math.min(1, 15 * dt);
    S.eyeY += (S.tEyeY - S.eyeY) * Math.min(1, 15 * dt);

    S.wide += (1 + Math.min(0.34, spd * 0.05) - S.wide) * Math.min(1, 8 * dt);
    S.energy = Math.max(0, S.energy - dt * 0.85);

    /* A BLINK IS A STATE MACHINE. It was two `if`s keyed off the sign of one
       timer, and once that timer went negative BOTH ran on the same frame —
       one closing the lid at 13/s and the other opening it at 9/s. The eyes
       never opened again; they sat half shut, which is why the first render
       had two dark dashes where the lights should be. */
    if(S.blinkPhase === 0){
      S.nextBlink -= dt;
      if(S.nextBlink <= 0) S.blinkPhase = 1;
    }else if(S.blinkPhase === 1){
      S.blink -= dt * 15;
      if(S.blink <= 0.07){ S.blink = 0.07; S.blinkPhase = 2; }
    }else{
      S.blink += dt * 9;
      if(S.blink >= 1){ S.blink = 1; S.blinkPhase = 0; S.nextBlink = 2.6 + Math.random() * 4.0; }
    }
  }

  function frame(now){
    if(dead) return;
    raf = requestAnimationFrame(frame);
    if(!onScreen || !awake) { last = now; return; }
    let dt = (now - last) / 1000; last = now;
    if(dt > 0.25) dt = 0.25;                 // a backgrounded tab is not a fling
    frameAvg += (dt * 1000 - frameAvg) * 0.08;
    if(frameAvg > 26 && qual > 0.55) qual = Math.max(0.55, qual - 0.06);
    else if(frameAvg < 13 && qual < 1) qual = Math.min(1, qual + 0.03);
    acc += dt;
    let guard = 0;
    while(acc >= STEP && guard++ < 40){ physics(STEP); acc -= STEP; }

    size();
    const t = now / 1000;
    // idle: a slow breath, and a drift when nobody is driving
    const idle = S.engaged || S.spinning ? 0 : 1;
    const bob = calm ? 0 : Math.sin(t * 1.15) * 0.022 * idle;

    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, t);
    gl.uniform3f(U.uRot,
      S.yaw + (calm ? 0 : Math.sin(t * 0.47) * 0.06 * idle),
      S.pitch + bob,
      S.roll + (calm ? 0 : Math.sin(t * 0.31) * 0.03 * idle));
    gl.uniform2f(U.uEye, S.eyeX, S.eyeY);
    gl.uniform1f(U.uAnt, S.ant);
    gl.uniform1f(U.uBlink, S.blink);
    gl.uniform1f(U.uSquash, S.squash);
    gl.uniform1f(U.uWide, S.wide);
    gl.uniform1f(U.uGlow, 1 + S.energy * 0.55);
    gl.uniform3f(U.uAccent, accent[0], accent[1], accent[2]);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* TWO REASONS TO STOP, TRACKED SEPARATELY. These were one boolean, and
     `visible = !document.hidden && visible` is a one-way door: the first time
     the tab was backgrounded it went false and nothing could ever set it back
     except a fresh intersection. Measured on the deployed page — a hero that
     was on screen the whole time, with 24.8 rad/s of angular velocity sitting
     in the state and not one frame being stepped to spend it. */
  const io = new IntersectionObserver((es) => { onScreen = es[0].isIntersecting; }, { threshold: 0.02 });
  io.observe(canvas);
  const onVis = () => { awake = !document.hidden; last = performance.now(); };
  document.addEventListener("visibilitychange", onVis);

  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); dead = true; }, { once: true });

  size();
  raf = requestAnimationFrame(frame);

  return {
    state: S,
    enableTilt,
    destroy(){
      dead = true; cancelAnimationFrame(raf); io.disconnect(); ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointermove", onDragMove);
      window.removeEventListener("pointerup", onDragEnd);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerdown", onDragStart);
      window.removeEventListener("deviceorientation", onTilt);
    },
  };
}

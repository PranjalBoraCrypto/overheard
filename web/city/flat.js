/**
 * city/flat.js — the same city, drawn flat.
 *
 * THIS IS NOT AN APOLOGY PAGE.
 *
 * Somebody arrives here because their browser has no WebGL, or because the
 * engine failed to load. What they must not get is a paragraph explaining
 * what they are missing. They get the city: every district, every named room
 * in the same place it stands in 3D, the live activity, the identities, the
 * messages, the speech bubbles, the search, the analytics — all of it, from
 * the same data layer, through the same panels in ui.js. What they lose is
 * the third dimension and the decoration. Nothing informational.
 *
 * THE LAYOUT IS SHARED, DELIBERATELY. Positions come from place.js, the same
 * module world.js uses. A visitor who learns that Kibble is out to the
 * north-east and that their room sits on the middle band finds both facts
 * still true here. Two views of one city.
 *
 * IT IS A 2D CANVAS, NOT A THOUSAND DIVS. The machines that land here are the
 * slow ones. Three hundred absolutely-positioned elements with borders and
 * backdrop filters is far more work for a weak device than three hundred
 * arcs on one canvas, and it cannot be culled. The only DOM over the map is
 * the handful of things that must be selectable text: district labels and
 * speech bubbles.
 *
 * AND IT REDRAWS ONLY WHEN SOMETHING CHANGED. A still map costs nothing here;
 * a rAF loop that repaints an unchanged picture sixty times a second on an
 * old laptop is a fan spinning up for no reason.
 */

import * as D from "./data.js";
import * as S from "./sound.js";
import * as Q from "./quality.js";
import { makeUI, ago } from "./ui.js";
import { makeDeclutter } from "./declutter.js";
import { DISTRICTS, TAU, placeRoom, placeAgent, placeBlocks, heightOf, CITY_R } from "./place.js";

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* The palette, read off the page rather than invented, so the flat map and
   the panels floating over it are the same city. */
const C = {
  void: "#00070A", plate: "#081E28", plateEdge: "#0D3040",
  build: "#0E2B38", buildHi: "#143C4E",
  cy: "#00B4D7", cyHi: "#5FEBFF", good: "#3BE3B0", warn: "#F2B33D", faint: "#5F8593",
};
const rgba = (r, g, b, a) => `rgba(${r},${g},${b},${a})`;
const CY = (a) => rgba(0, 180, 215, a);
const CYH = (a) => rgba(95, 235, 255, a);

const MAX_PULSE = 18, MAX_BEAM = 5, BUBBLES = 4, BLOCKS = 8;

export function mountFlat(container, els) {
  /* The world-anchored overlay sits under #flat in the stacking order by
     default — #flat has a z-index and the overlay does not. Labels and
     bubbles belong above the map and below the HUD cards. */
  els.overlay.style.zIndex = "3";

  const cv = document.createElement("canvas");
  cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab";
  cv.setAttribute("aria-label", "Agent City — a flat map of Technocore's public rooms");
  container.replaceChildren(cv);
  const ctx = cv.getContext("2d", { alpha: false });

  const lede = document.querySelector(".lede");
  if (lede) lede.textContent =
    "The 3D city needs WebGL, which this browser is not offering — so here is the same live network as a flat map. Drag to pan, scroll to zoom, click a district to go in.";

  /* ── state ─────────────────────────────────────────────────────────────
     Deliberately the same shape as the 3D page's, so the tests, the panels
     and the controls do not have to know which view they are talking to. */
  const st = {
    room: null, agentId: null, msgKey: null, following: null,
    bubblesOn: true, clean: false, tour: false, tourAt: 0, hoverKey: null,
  };

  let W = 0, H = 0, dpr = 1, bg = null;
  const view = { x: 0, z: 0, s: 1 };
  const want = { x: 0, z: 0, s: 1 };
  let fit = 1, flight = null, dirty = true;

  let city = null;
  let rooms = [];                       // [{ room, x, z, rad, seq, idle, topic, landmark }]
  const byRoom = new Map();
  let blocks = [];
  const heat = new Map();
  let agents = [];                      // [{ id, x, z, lit }]
  const agentById = new Map();
  let firstVisit = false;
  try {
    firstVisit = !localStorage.getItem("overheard.city.seen");
    localStorage.setItem("overheard.city.seen", "1");
  } catch { firstVisit = false; }

  const pulses = [], beams = [], bubbles = [];
  const labels = new Map();
  const declutter = makeDeclutter(els);

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  /* The map is centred in what is left of the stage after the headline card,
     not in the stage: a city half under a panel is a city half missing. On a
     phone the panels are top and bottom, so the shift goes away. */
  let ox = 0, oy = 0;
  const SX = (x) => W / 2 + ox + (x - view.x) * view.s;
  const SY = (z) => H / 2 + oy + (z - view.z) * view.s;
  const WX = (px) => (px - W / 2 - ox) / view.s + view.x;
  const WZ = (py) => (py - H / 2 - oy) / view.s + view.z;
  const mark = () => { dirty = true; };

  /* ── the panels, identical to the 3D page's ──────────────────────────── */
  const ui = makeUI(els, {
    closePanel: () => { ui.closePanel(); st.agentId = null; st.msgKey = null; if (st.room) showRoomPanel(); },
    enterRoom: (name) => enterRoom(name),
    leaveRoom: () => leaveRoom(),
    pickAgent: (id) => selectAgent(id),
    hoverAgent: (id) => { st.hoverKey = id; },
    pickMessage: (key) => selectMessage(key),
    toggleFeed: () => toggleFeed(),
    follow: (id) => { st.following = st.following === id ? null : id; selectAgent(id); },
    locate: (id) => { if (id) selectAgent(id); },
    toggleClean: () => setClean(!st.clean),
    tour: () => { if (!st.tour) $("tour").click(); },
  });

  /* ── the directory arrives ───────────────────────────────────────────── */
  /* The city is the roster, not the current directory page — the directory
     returns only the rooms that spoke most recently and churns several a
     minute. See the roster note in data.js. */
  const unnamedNow = () =>
    Math.max(0, (city?.counts.total_public ?? 0) - (city?.roster?.length ?? 0));

  D.on("city", (c) => {
    const first = !city;
    city = c;
    rooms = []; byRoom.clear();
    for (const r of c.roster) {
      if (r.landmark) continue;                        // districts draw themselves
      const p = placeRoom(r.room, r.slot >>> 0);
      const seq = Number(r.last_seq || 0);
      /* A building's height in 3D becomes a dot's size here, off the same
         number, so the same rooms read as the big ones in both views. */
      const e = {
        room: r.room, x: p.x, z: p.z, rad: 1.3 + heightOf(seq) * 0.055,
        seq, idle: r.idle, topic: r.topic, live: r.live, landmark: false,
      };
      rooms.push(e); byRoom.set(r.room, e);
    }
    blocks = placeBlocks(BLOCKS, unnamedNow());
    refreshHeat();
    buildLabels();
    paintChips();
    $("boot").hidden = true;
    if (first && firstVisit && !st.room) { firstVisit = false; ui.legend(city); }
    mark();
  });

  D.on("status", () => { paintChips(); ui.status(D.state.status); });

  /* The flat map had its own copy of the full-screen error, with its own
     wording, and it had to be deleted twice for the same reason. See the
     long note in boot.js: the map is seeded from a genuine saved snapshot
     before anything is requested, so "nothing to draw" is not a state either
     view can reach, and the endpoint hands back that snapshot instead of an
     error anyway. The corner chip says which of the four honest things is
     true, here exactly as it does in 3D. */

  function refreshHeat() {
    if (!city) return;
    heat.clear();
    for (const r of city.roster) {
      let h = 0;
      if (r.live) {
        const rate = D.rateOf(r.room), idle = r.idle;
        if (rate != null) h = Math.min(1, Math.log10(1 + rate) / 1.9);
        else if (idle != null) h = idle < 30 ? 0.55 : idle < 300 ? 0.3 : 0.08;
      }
      heat.set(r.room, h);
    }
    mark();
  }

  function paintChips() {
    if (!city) return;
    const rates = city.roster.filter((r) => r.live)
      .map((r) => D.rateOf(r.room)).filter((v) => v != null);
    ui.chips(city, D.state.status, {
      msgPerMin: rates.length ? rates.reduce((a, b) => a + b, 0) : null,
      inCity: city.roster.length,
      fps: watcher.fps(),
    });
    const badge = $("badge"), s = D.state.status;
    badge.className = "eyebrow" + (s.city === "live" ? "" : s.city === "offline" ? " down" : " stale");
    badge.lastChild.nodeValue =
      s.city === "live" ? (st.room ? `${st.room} · live` : "Technocore · live network")
      : s.city === "offline" ? "Technocore · offline" : "Technocore · reconnecting";
  }

  /* ── the view ─────────────────────────────────────────────────────────
     Same promise the 3D camera makes: any input from the visitor cancels
     whatever the map was doing on its own, on the same frame. */
  function seize() { if (flight) { flight = null; if (st.tour) stopTour(); } }

  function normalise() {
    want.s = clamp(want.s, fit * 0.8, fit * 11);
    const r = Math.hypot(want.x, want.z);
    if (r > CITY_R + 24) { want.x *= (CITY_R + 24) / r; want.z *= (CITY_R + 24) / r; }
  }

  function focus(x, z, scale, ms = 900) {
    want.x = x; want.z = z; want.s = scale;
    normalise();
    if (reduced || ms <= 0) { Object.assign(view, want); flight = null; mark(); return; }
    flight = { from: { ...view }, to: { ...want }, t: 0, ms };
  }
  const home = (ms = 900) => focus(0, 0, fit, ms);

  function stepView(dt) {
    if (flight) {
      flight.t += dt * 1000;
      const k = Math.min(1, flight.t / flight.ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 2.6) / 2;
      view.x = flight.from.x + (flight.to.x - flight.from.x) * e;
      view.z = flight.from.z + (flight.to.z - flight.from.z) * e;
      view.s = flight.from.s + (flight.to.s - flight.from.s) * e;
      if (k >= 1) flight = null;
      mark();
      return;
    }
    /* Integrated ease, so the feel does not change with the frame rate — the
       same argument cam.js settles for the 3D view. */
    const a = 1 - Math.exp(-dt / 0.11);
    const dx = want.x - view.x, dz = want.z - view.z, ds = want.s - view.s;
    if (Math.abs(dx) > 0.01 || Math.abs(dz) > 0.01 || Math.abs(ds) > 0.0001) {
      view.x += dx * a; view.z += dz * a; view.s += ds * a;
      mark();
    }
  }

  /* ── input ───────────────────────────────────────────────────────────── */
  const pointers = new Map();
  let dragging = false, px = 0, py = 0, pinch = 0, downAt = null, hoverAt = { x: 0, y: 0 };
  let hoverStale = true, pointerIn = false, lastHoverRun = 0;
  cv.addEventListener("pointerleave", () => { pointerIn = false; hoverStale = true; });
  cv.addEventListener("pointerenter", () => { pointerIn = true; hoverStale = true; });

  cv.addEventListener("pointerdown", (e) => {
    cv.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    seize();
    downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    dragging = true; px = e.clientX; py = e.clientY;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
      px = (a.x + b.x) / 2; py = (a.y + b.y) / 2;
    }
    cv.style.cursor = "grabbing";
  });

  cv.addEventListener("pointermove", (e) => {
    if (Math.abs(e.clientX - hoverAt.x) + Math.abs(e.clientY - hoverAt.y) > 1) hoverStale = true;
    hoverAt = { x: e.clientX, y: e.clientY };
    pointerIn = true;
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) { want.s *= d / Math.max(1, pinch); }
      pinch = d;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      want.x -= (mx - px) / view.s; want.z -= (my - py) / view.s;
      px = mx; py = my;
      normalise(); Object.assign(view, want); mark();
      return;
    }
    if (!dragging) return;
    want.x -= (e.clientX - px) / view.s;
    want.z -= (e.clientY - py) / view.s;
    px = e.clientX; py = e.clientY;
    normalise();
    /* Dragging is direct: the map goes where the finger goes, with no easing
       between the two. Easing a drag is what makes a map feel like it is on
       ice. */
    view.x = want.x; view.z = want.z;
    mark();
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (!pointers.size) { dragging = false; cv.style.cursor = "grab"; }
  };
  cv.addEventListener("pointerup", (e) => {
    const d = downAt;
    endPointer(e);
    if (!d) return;
    downAt = null;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 500) return;
    const hit = pick(e.clientX, e.clientY);
    if (!hit) return;
    if (hit.type === "agent") selectAgent(hit.id);
    else if (hit.type === "district") st.room === hit.room ? showSummary(hit.room) : flyToDistrict(hit.room);
    else if (hit.type === "room") flyToRoom(hit.room);
  });
  cv.addEventListener("pointercancel", endPointer);

  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    seize();
    hoverStale = true;
    /* Zoom about the cursor, not the middle: on a map, the thing under the
       pointer is the thing you are zooming into. */
    const wx = WX(e.clientX - rect().left), wz = WZ(e.clientY - rect().top);
    const before = view.s;
    want.s = view.s * Math.exp(clamp(-e.deltaY, -240, 240) * 0.0016);
    normalise();
    view.s = want.s;
    const k = 1 - before / view.s;
    want.x = view.x += (wx - view.x) * k;
    want.z = view.z += (wz - view.z) * k;
    normalise();
    mark();
  }, { passive: false });

  let rectCache = null, rectAt = 0;
  function rect() {
    const now = performance.now();
    if (!rectCache || now - rectAt > 300) { rectCache = cv.getBoundingClientRect(); rectAt = now; }
    return rectCache;
  }

  /* ── picking ─────────────────────────────────────────────────────────── */
  function pick(clientX, clientY) {
    const r = rect();
    const x = clientX - r.left, y = clientY - r.top;
    if (st.room) {
      for (const a of agents) {
        if (Math.hypot(SX(a.x) - x, SY(a.z) - y) < 16) return { type: "agent", id: a.id };
      }
    }
    for (const d of DISTRICTS) {
      if (Math.hypot(SX(d.x) - x, SY(d.z) - y) < Math.max(14, d.r * view.s)) return { type: "district", room: d.room };
    }
    let best = null, bestD = 1e9;
    for (const p of rooms) {
      const dd = Math.hypot(SX(p.x) - x, SY(p.z) - y);
      if (dd < Math.max(8, p.rad * view.s + 4) && dd < bestD) { best = p; bestD = dd; }
    }
    if (best) return { type: "room", room: best.room };
    for (const b of blocks) {
      if (Math.abs(SX(b.x) - x) < b.w * view.s && Math.abs(SY(b.z) - y) < b.w * view.s)
        return { type: "block", block: b };
    }
    return null;
  }

  function summaryFor(room) {
    const d = DISTRICTS.find((x) => x.room === room);
    const info = D.state.roster.get(room) || city?.landmarks.find((l) => l.room === room);
    return {
      room, landmark: !!d, title: d?.title, sub: d?.sub,
      topic: info?.topic || null,
      seq: info?.last_seq ? Number(info.last_seq) : null,
      bytes: info?.bytes ?? null,
      idle: info?.idle ?? null,
      live: info?.live ?? (info?.present !== false),
      seenAt: info?.seenAt ?? null,
      rate: info?.live ? D.rateOf(room) : null,
    };
  }
  const showSummary = (room) => ui.roomSummary(summaryFor(room));

  function positionOf(room) {
    const d = DISTRICTS.find((x) => x.room === room);
    if (d) return { x: d.x, z: d.z, r: d.r };
    const p = byRoom.get(room);
    return p ? { x: p.x, z: p.z, r: 8 } : null;
  }

  function flyToDistrict(room) {
    const p = positionOf(room); if (!p) return;
    S.pick(); focus(p.x, p.z, fit * 3.2, reduced ? 0 : 900); showSummary(room);
  }
  function flyToRoom(room) {
    const p = positionOf(room); if (!p) return;
    S.pick(); focus(p.x, p.z, fit * 4.6, reduced ? 0 : 800); showSummary(room);
  }

  /* ── standing in a room ──────────────────────────────────────────────── */
  function enterRoom(name) {
    st.room = name; st.agentId = null; st.msgKey = null; st.following = null;
    clearBubbles();
    const p = positionOf(name) || { x: 0, z: 0 };
    focus(p.x, p.z, fit * 3.9, reduced ? 0 : 1000);
    D.enterRoom(name);
    S.arrive(); S.bedOn(true);
    $("strip").hidden = st.clean;
    paintChips();
    ui.roomLive({ name, messages: [], agents: [], gaps: [] }, []);
    mark();
  }

  function leaveRoom() {
    st.room = null; st.agentId = null; st.msgKey = null; st.following = null;
    clearBubbles();
    agents = []; agentById.clear();
    D.leaveRoom();
    ui.closeFeed(); ui.closePanel();
    S.bedOn(false);
    home(reduced ? 0 : 900);
    $("strip").hidden = true;
    paintChips();
    mark();
  }

  function showRoomPanel() {
    const r = D.state.room;
    if (r) ui.roomLive(r, r.agents, st.agentId);
  }

  function selectAgent(id) {
    st.agentId = id; st.msgKey = null;
    const r = D.state.room;
    const a = r?.agents.find((x) => x.id === id);
    if (!a) return;
    const pos = agentById.get(id);
    if (pos) focus(pos.x, pos.z, Math.max(view.s, fit * 5.2), reduced ? 0 : 600);
    lightAgent(id);
    S.pick();
    ui.agentPanel(a, r, st.following === id);
  }

  function selectMessage(key) {
    const r = D.state.room;
    const m = r?.messages.find((x) => x.key === key);
    if (!m) return;
    st.msgKey = key;
    const from = m.did || (m.nick ? `nick:${m.nick}` : null);
    const to = D.addressee(m, r.agents);
    if (from) lightAgent(from);
    if (to) { lightAgent(to); beam(from, to); }
    const toA = to ? r.agents.find((x) => x.id === to) : null;
    ui.messagePanel(m, toA ? (toA.did ? toA.did.replace(/^did:key:/, "").slice(0, 12) + "…" : toA.nick) : null);
    ui.renderFeed(r, key);
  }

  function toggleFeed() {
    if (!els.feed.hidden) { ui.closeFeed(); return; }
    ui.buildFeed(D.state.room, st.msgKey);
  }

  /* ── live ────────────────────────────────────────────────────────────── */
  D.on("room", (r) => {
    if (!r) return;
    setAgents(r.agents);
    if (!st.agentId && !st.msgKey) showRoomPanel();
    ui.renderFeed(r, st.msgKey);
    paintStrip(r);
    mark();
  });

  D.on("messages", ({ added }) => {
    if (!added.length) return;
    const r = D.state.room;
    /* A burst is sampled for effects and kept whole in the data. Forty
       messages in a second is forty flashes nobody can see; the feed and the
       panels still have every one of them. */
    const budget = Math.min(added.length, 6);
    const step = Math.max(1, Math.floor(added.length / budget));
    for (let i = 0; i < added.length; i += step) {
      const m = added[i];
      const from = m.did || (m.nick ? `nick:${m.nick}` : null);
      const a = from ? agentById.get(from) : null;
      if (a) {
        lightAgent(from);
        pulse(a.x, a.z);
        const to = D.addressee(m, r.agents);
        if (to && agentById.get(to)) beam(from, to);
      }
      S.tick(m.seq, m.c.kind);
      if (st.bubblesOn && !st.clean) addBubble(m, from);
    }
    if (st.following) {
      const mine = added.filter((m) => (m.did || `nick:${m.nick}`) === st.following);
      if (mine.length) { lightAgent(st.following); if (!st.msgKey) selectAgent(st.following); }
    }
    paintStrip(r);
    mark();
  });

  function setAgents(list) {
    const centre = st.room ? positionOf(st.room) || { x: 0, z: 0 } : { x: 0, z: 0 };
    const keep = new Map(agents.map((a) => [a.id, a.lit]));
    agents = []; agentById.clear();
    for (const a of list.slice(0, 28)) {
      const p = placeAgent(a.slot >>> 0, centre.x, centre.z);
      const e = { id: a.id, x: p.x, z: p.z, lit: keep.get(a.id) || 0, signed: !!a.did };
      agents.push(e); agentById.set(a.id, e);
    }
  }

  const lightAgent = (id) => { const a = agentById.get(id); if (a) { a.lit = 1; mark(); } };
  function pulse(x, z) {
    if (pulses.length >= MAX_PULSE) pulses.shift();
    pulses.push({ x, z, t: 0, life: reduced ? 0.5 : 1.1 });
  }
  function beam(fromId, toId) {
    const a = agentById.get(fromId), b = agentById.get(toId);
    if (!a || !b) return;
    if (beams.length >= MAX_BEAM) beams.shift();
    beams.push({ a, b, t: 0, life: 1.5 });
  }

  function stepFx(dt) {
    for (let i = pulses.length - 1; i >= 0; i--) {
      pulses[i].t += dt;
      if (pulses[i].t > pulses[i].life) pulses.splice(i, 1);
    }
    for (let i = beams.length - 1; i >= 0; i--) {
      beams[i].t += dt;
      if (beams[i].t > beams[i].life) beams.splice(i, 1);
    }
    for (const a of agents) if (a.lit > 0) a.lit = Math.max(0, a.lit - dt * 0.9);
    if (pulses.length || beams.length || agents.some((a) => a.lit > 0)) mark();
  }

  /* ── labels: the only text on the map, and it is real text ───────────── */
  /** The one label that changes: the count on the outer ring. */
  function paintRing() {
    const l = labels.get("b:ring");
    const b = blocks[Math.floor(blocks.length * 0.5)];
    if (!l || !b) return;
    l.x = b.x; l.z = b.z; l.r = b.w;
    const text = `${unnamedNow().toLocaleString()} more public rooms, not named to this page`;
    if (l.node.textContent !== text) { l.node.textContent = text; l.w = 0; }
  }

  /* Built once and then left alone — the directory arrives every twenty
     seconds and the six districts in it never change, so rebuilding their
     nodes would only cancel whatever the visitor was hovering. */
  function buildLabels() {
    if (!city) return;
    if (labels.size) {
      for (const d of DISTRICTS) {
        const l = labels.get(`d:${d.room}`);
        const info = city.landmarks.find((x) => x.room === d.room);
        if (l) l.node.classList.toggle("quiet", !info?.present);
      }
      paintRing();
      return;
    }

    DISTRICTS.forEach((d, i) => {
      const info = city.landmarks.find((l) => l.room === d.room);
      const node = document.createElement("button");
      node.className = "lab" + (info?.present ? "" : " quiet");
      node.type = "button";
      const n = document.createElement("span");
      n.className = "n"; n.textContent = String(i + 1);
      const t = document.createElement("span");
      t.textContent = d.title;
      node.append(n, t);
      node.addEventListener("click", (e) => { e.stopPropagation(); flyToDistrict(d.room); });
      node.addEventListener("mouseenter", () => (st.hoverKey = `room:${d.room}`));
      node.addEventListener("mouseleave", () => (st.hoverKey = null));
      els.overlay.append(node);
      labels.set(`d:${d.room}`, { node, kind: "district", x: d.x, z: d.z, r: d.r });
    });

    /* One label for the whole ring, not one per plinth — see the same note in
       boot.js. The single most important sentence on the page, said once. */
    const b = blocks[Math.floor(blocks.length * 0.5)];
    if (b) {
      const node = document.createElement("div");
      node.className = "lab blk";
      els.overlay.append(node);
      labels.set("b:ring", { node, kind: "block", x: b.x, z: b.z, r: b.w });
      paintRing();
    }
  }

  const roomLabels = [];
  function syncLabels() {
    declutter.begin(performance.now());
    /* Districts first, then the ring label, then room names — whoever asks
       first keeps the space. */
    for (const [, l] of [...labels].sort((a, b) => (a[1].kind === "district" ? -1 : 1))) {
      const x = SX(l.x), y = SY(l.z) - (l.kind === "district" ? l.r * view.s + 6 : l.r * view.s + 4);
      const off = (l.kind === "block" && view.s > fit * 2.4) || st.clean;
      const at = off ? null
        : (l.kind === "district" || l.kind === "block") ? declutter.placeAny(l, x, y)
        : declutter.place(l, x, y) ? { x, y } : null;
      l.node.hidden = !at;
      if (at) l.node.style.transform = `translate(${Math.round(at.x)}px,${Math.round(at.y)}px) translate(-50%,-100%)`;
    }

    /* Named-room labels only once the map is close enough for one to mean
       anything, and only the nearest few — two hundred labels is not a map,
       it is a wall of text. */
    const show = view.s > fit * 3 && !st.room && !st.clean;
    const wantN = show ? 12 : 0;
    while (roomLabels.length < wantN) {
      const node = document.createElement("button");
      node.className = "lab dim"; node.type = "button";
      els.overlay.append(node);
      roomLabels.push({ node, room: null });
    }
    for (const rl of roomLabels) rl.node.hidden = true;
    if (!show) return;
    const near = rooms
      .map((p) => ({ p, d: Math.hypot(p.x - view.x, p.z - view.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, wantN);
    near.forEach((n, i) => {
      const rl = roomLabels[i];
      if (!rl) return;
      if (rl.room !== n.p.room) {
        rl.room = n.p.room;
        rl.node.textContent = n.p.room;
        rl.node.onclick = (e) => { e.stopPropagation(); flyToRoom(n.p.room); };
        rl.node.onmouseenter = () => (st.hoverKey = `room:${n.p.room}`);
        rl.node.onmouseleave = () => (st.hoverKey = null);
      }
      const x = SX(n.p.x), y = SY(n.p.z) - n.p.rad * view.s - 5;
      if (!declutter.place(rl, x, y)) return;
      rl.node.hidden = false;
      rl.node.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px) translate(-50%,-100%)`;
    });
  }

  /* ── speech bubbles: HTML, exactly as in the 3D city ─────────────────── */
  function addBubble(m, agentId) {
    if (!agentId || !agentById.get(agentId)) return;
    const old = bubbles.findIndex((b) => b.agentId === agentId);
    if (old >= 0) retire(bubbles[old]);

    const node = document.createElement("div");
    node.className = `bub ${m.c.kind}`;
    const w = document.createElement("span");
    w.className = "w";
    w.textContent = m.did ? m.did.replace(/^did:key:/, "").slice(0, 8) + "…" : m.nick || "—";
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = m.text;                       // text, never markup
    node.append(w, t);
    node.addEventListener("click", (e) => { e.stopPropagation(); selectMessage(m.key); });
    els.overlay.append(node);
    bubbles.push({ key: m.key, agentId, node, born: performance.now(), life: 6500 });
    while (bubbles.length > BUBBLES) retire(bubbles[0]);
  }

  function retire(b) {
    const i = bubbles.indexOf(b);
    if (i >= 0) bubbles.splice(i, 1);
    b.node.classList.add("out");
    setTimeout(() => b.node.remove(), 360);
  }
  function clearBubbles() { while (bubbles.length) retire(bubbles[0]); }

  function layoutBubbles(now) {
    const placed = [];
    for (const b of [...bubbles]) {
      const life = st.agentId === b.agentId ? b.life * 2 : b.life;
      if (now - b.born > life) { retire(b); continue; }
      const a = agentById.get(b.agentId);
      if (!a) { retire(b); continue; }
      const x0 = SX(a.x), y0 = SY(a.z) - 16;
      const at = declutter.placeAny(b, x0, y0,
        [[0, 0], [0, -70], [0, -140], [-120, -36], [120, -36], [0, 64]]);
      if (!at) { b.node.style.opacity = "0"; continue; }
      const x = at.x, y = at.y;
      placed.push({ x, y });
      const k = 1 - Math.max(0, (now - b.born - life + 700) / 700);
      b.node.style.opacity = String(clamp(k, 0, 1));
      b.node.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px) translate(-50%,-100%)`;
      b.node.classList.toggle("sel", st.msgKey === b.key || st.agentId === b.agentId);
    }
  }

  /* ── hover ───────────────────────────────────────────────────────────── */
  function updateHover() {
    if (st.clean || dragging) { ui.hover(0, 0, null); return; }
    if (!pointerIn && !st.hoverKey) { ui.hover(0, 0, null); return; }
    const now = performance.now();
    if (!hoverStale && !flight && now - lastHoverRun < 600) return;
    lastHoverRun = now; hoverStale = false;
    const r0 = rect();
    const r = D.state.room;
    if (typeof st.hoverKey === "string" && st.hoverKey.startsWith("room:")) {
      const room = st.hoverKey.slice(5);
      const d = DISTRICTS.find((x) => x.room === room);
      ui.hover(hoverAt.x - r0.left, hoverAt.y - r0.top,
        ui.hoverRoomCard({ ...summaryFor(room), title: d?.title || room, sub: d?.sub }));
      return;
    }
    if (st.hoverKey && r) {
      const a = r.agents.find((x) => x.id === st.hoverKey);
      if (a) { ui.hover(hoverAt.x - r0.left, hoverAt.y - r0.top, ui.hoverAgentCard(a)); return; }
    }
    const hit = pick(hoverAt.x, hoverAt.y);
    cv.style.cursor = dragging ? "grabbing" : hit ? "pointer" : "grab";
    if (!hit) { ui.hover(0, 0, null); return; }
    const x = hoverAt.x - r0.left, y = hoverAt.y - r0.top;
    if (hit.type === "agent" && r) {
      const a = r.agents.find((z) => z.id === hit.id);
      ui.hover(x, y, a ? ui.hoverAgentCard(a) : null);
    } else if (hit.type === "district" || hit.type === "room") {
      const d = DISTRICTS.find((z) => z.room === hit.room);
      ui.hover(x, y, ui.hoverRoomCard({ ...summaryFor(hit.room), title: d?.title || hit.room, sub: d?.sub }));
    } else if (hit.type === "block") {
      ui.hover(x, y, ui.hoverBlockCard(hit.block, unnamedNow(), city));
    }
  }

  /* ── drawing ─────────────────────────────────────────────────────────── */

  function resize() {
    const r = cv.getBoundingClientRect();
    rectCache = r; rectAt = performance.now();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    /* One device pixel per CSS pixel, capped. The machines that land on the
       flat map are the ones that cannot afford four times the fill. */
    dpr = Math.min(devicePixelRatio || 1, 1.5);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    ox = W >= 1024 ? Math.min(120, W * 0.075) : 0;
    oy = W >= 1024 ? 0 : Math.min(40, H * 0.04);
    const prevFit = fit;
    fit = Math.min(W, H) / (2 * 162);
    if (prevFit) { const k = fit / prevFit; view.s *= k; want.s *= k; } else { view.s = want.s = fit; }
    bg = ctx.createRadialGradient(W / 2, H * 0.42, 10, W / 2, H * 0.42, Math.max(W, H) * 0.75);
    bg.addColorStop(0, "#04202C");
    bg.addColorStop(1, C.void);
    mark();
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg || C.void;
    ctx.fillRect(0, 0, W, H);

    const s = view.s;
    const cx = SX(0), cz = SY(0);   // the plate's middle, wherever the view has it

    /* the plate */
    ctx.beginPath(); ctx.arc(cx, cz, 148 * s, 0, TAU);
    ctx.fillStyle = C.plate; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = C.plateEdge; ctx.stroke();

    /* the roads — the thing that makes six districts read as one city */
    ctx.lineWidth = Math.max(1, 4 * s);
    ctx.strokeStyle = CY(0.13);
    ctx.beginPath();
    for (const d of DISTRICTS) {
      if (d.room === "lobby") continue;
      ctx.moveTo(cx, cz); ctx.lineTo(SX(d.x), SY(d.z));
    }
    ctx.stroke();

    /* the outer blocks: rooms the directory would not name, as counts */
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(95, 133, 147, 0.5);
    ctx.fillStyle = rgba(14, 43, 56, 0.55);
    for (const b of blocks) {
      const x = SX(b.x), y = SY(b.z), w = b.w * s;
      if (x < -w * 2 || x > W + w * 2) continue;
      ctx.beginPath(); ctx.rect(x - w, y - w, w * 2, w * 2);
      ctx.fill(); ctx.stroke();
    }
    ctx.setLineDash([]);

    /* the named rooms */
    const dim = st.room ? 0.28 : 1;
    for (const p of rooms) {
      const x = SX(p.x), y = SY(p.z);
      if (x < -12 || x > W + 12 || y < -12 || y > H + 12) continue;
      const h = heat.get(p.room) ?? 0;
      /* Capped in pixels, not just in world units: zoomed right in, a room
         with eight million messages became a sixty-pixel blob. */
      const rr = Math.min(15, Math.max(1.4, p.rad * s));
      ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU);
      ctx.fillStyle = h > 0.5 ? CYH(0.9 * dim) : h > 0.15 ? CY(0.75 * dim) : rgba(20, 60, 78, 0.95 * dim);
      ctx.fill();
      if (h > 0.35 && !st.room) {
        ctx.beginPath(); ctx.arc(x, y, rr + 3 + h * 4, 0, TAU);
        ctx.strokeStyle = CY(0.10 + h * 0.16); ctx.lineWidth = 1; ctx.stroke();
      }
    }

    /* the six districts */
    for (const d of DISTRICTS) {
      const x = SX(d.x), y = SY(d.z), r = d.r * s;
      if (x < -r * 2 || x > W + r * 2) continue;
      const h = heat.get(d.room) ?? 0;
      const here = st.room === d.room;
      const g = ctx.createRadialGradient(x, y, r * 0.15, x, y, r);
      g.addColorStop(0, CY(0.20 + h * 0.24));
      g.addColorStop(1, rgba(8, 30, 40, 0.05));
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
      ctx.fillStyle = g; ctx.fill();
      ctx.lineWidth = here ? 2 : 1.2;
      ctx.strokeStyle = here ? C.cyHi : CY(0.35 + h * 0.4);
      ctx.stroke();
      glyph(d.kind, x, y, r * 0.52, here ? CY(0.30) : CY(0.55 + h * 0.35));
    }

    /* the room you are standing in */
    if (st.room) {
      const p = positionOf(st.room) || { x: 0, z: 0 };
      const x = SX(p.x), y = SY(p.z);
      /* The floor everybody in the room is standing on. Wide enough to hold
         the ring the identities stand in — drawn tighter than they stand,
         it read as if they were all outside the room. */
      const floor = 32 * s;
      const fg = ctx.createRadialGradient(x, y, floor * 0.2, x, y, floor);
      fg.addColorStop(0, CY(0.07));
      fg.addColorStop(1, CY(0));
      ctx.beginPath(); ctx.arc(x, y, floor, 0, TAU);
      ctx.fillStyle = fg; ctx.fill();
      ctx.strokeStyle = CY(0.4); ctx.lineWidth = 1.2; ctx.stroke();

      for (const b of beams) {
        const k = b.t / b.life;
        ctx.beginPath();
        ctx.moveTo(SX(b.a.x), SY(b.a.z)); ctx.lineTo(SX(b.b.x), SY(b.b.z));
        ctx.strokeStyle = CYH(0.5 * (1 - k)); ctx.lineWidth = 1.4; ctx.stroke();
        const t = Math.min(1, k * 1.6);
        ctx.beginPath();
        ctx.arc(SX(b.a.x + (b.b.x - b.a.x) * t), SY(b.a.z + (b.b.z - b.a.z) * t), 3, 0, TAU);
        ctx.fillStyle = C.cyHi; ctx.fill();
      }

      for (const pl of pulses) {
        const k = pl.t / pl.life;
        ctx.beginPath();
        ctx.arc(SX(pl.x), SY(pl.z), (2 + k * 9) * s, 0, TAU);
        ctx.strokeStyle = CYH(0.55 * (1 - k)); ctx.lineWidth = 1.5; ctx.stroke();
      }

      /* The identities. Drawn last and drawn large: they are the reason
         somebody walked in here, and at four pixels they were furniture. */
      for (const a of agents) {
        const ax = SX(a.x), ay = SY(a.z);
        const sel = st.agentId === a.id;
        const g = ctx.createRadialGradient(ax, ay, 1, ax, ay, 22 + a.lit * 10);
        g.addColorStop(0, CYH(0.30 + a.lit * 0.4));
        g.addColorStop(1, CY(0));
        ctx.beginPath(); ctx.arc(ax, ay, 22 + a.lit * 10, 0, TAU);
        ctx.fillStyle = g; ctx.fill();
        ctx.beginPath(); ctx.arc(ax, ay, 7 + a.lit * 3, 0, TAU);
        ctx.fillStyle = a.lit > 0.35 ? C.cyHi : a.signed ? C.cy : C.faint;
        ctx.fill();
        if (sel || a.lit > 0.05) {
          ctx.beginPath(); ctx.arc(ax, ay, 13 + a.lit * 5, 0, TAU);
          ctx.strokeStyle = sel ? C.cyHi : CYH(0.4 * a.lit);
          ctx.lineWidth = sel ? 2.4 : 1.2;
          ctx.stroke();
        }
      }
    }
  }

  /** Each district gets a mark of its own, so the six are told apart at a
   *  glance rather than by reading six labels. */
  function glyph(kind, x, y, r, colour) {
    ctx.strokeStyle = colour; ctx.lineWidth = 1.4; ctx.beginPath();
    if (kind === "plaza") {
      ctx.arc(x, y, r * 0.4, 0, TAU); ctx.moveTo(x + r * 0.8, y); ctx.arc(x, y, r * 0.8, 0, TAU);
    } else if (kind === "core") {
      for (let i = 0; i <= 6; i++) {
        const a = (i / 6) * TAU - Math.PI / 2;
        const px = x + Math.cos(a) * r * 0.8, py = y + Math.sin(a) * r * 0.8;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
    } else if (kind === "works") {
      ctx.rect(x - r * 0.7, y - r * 0.7, r * 1.4, r * 1.4);
      ctx.moveTo(x - r * 0.7, y); ctx.lineTo(x + r * 0.7, y);
      ctx.moveTo(x, y - r * 0.7); ctx.lineTo(x, y + r * 0.7);
    } else if (kind === "dome") {
      ctx.arc(x, y + r * 0.35, r * 0.8, Math.PI, 0);
      ctx.moveTo(x - r * 0.9, y + r * 0.35); ctx.lineTo(x + r * 0.9, y + r * 0.35);
    } else if (kind === "racks") {
      for (let i = -1; i <= 1; i++) {
        ctx.moveTo(x - r * 0.75, y + i * r * 0.45);
        ctx.lineTo(x + r * 0.75, y + i * r * 0.45);
      }
    } else {
      ctx.moveTo(x, y - r * 0.85); ctx.lineTo(x + r * 0.7, y + r * 0.7);
      ctx.lineTo(x - r * 0.7, y + r * 0.7); ctx.closePath();
    }
    ctx.stroke();
  }

  /* ── the activity strip ──────────────────────────────────────────────── */
  const histo = new Array(48).fill(0);
  let lastSeq = 0;
  function paintStrip(r) {
    if (!r || $("strip").hidden) return;
    $("stripTitle").textContent = `${r.name} · activity`;
    const s = D.state.status;
    $("stripLive").textContent =
      s.room === "sampled" ? "• sampled" : s.room === "live" ? "• live"
      : s.room === "throttled" ? "• throttled" : `• ${s.room}`;
    $("stripLive").style.color = s.room === "live" ? "var(--good)" : "var(--warn)";
    $("stripLeft").textContent = r.first_seq ? `#${r.first_seq}` : "";
    $("stripRight").textContent = r.last_seq ? `#${r.last_seq} · ${ago(r.at)}` : "";
  }
  const stripTimer = setInterval(() => {
    const r = D.state.room;
    if (!r || $("strip").hidden) return;
    const seq = r.last_seq ? Number(r.last_seq) : 0;
    histo.push(lastSeq ? Math.max(0, seq - lastSeq) : 0); histo.shift();
    lastSeq = seq;
    const box = $("ticks");
    if (!box) return;
    if (box.children.length !== histo.length) box.replaceChildren(...histo.map(() => document.createElement("i")));
    const max = Math.max(3, ...histo);
    [...box.children].forEach((n, i) => {
      n.style.height = `${Math.max(2, (histo[i] / max) * 34)}px`;
      n.classList.toggle("hot", histo[i] > max * 0.55);
    });
  }, 1500);

  /* ── controls ────────────────────────────────────────────────────────── */
  const zoomBy = (k) => { seize(); want.s = view.s * k; normalise(); flight = null; mark(); };
  $("zoomIn").onclick = () => zoomBy(1.4);
  $("zoomOut").onclick = () => zoomBy(0.72);
  $("reset").onclick = () => { stopTour(); if (st.room) leaveRoom(); else home(reduced ? 0 : 800); };
  $("bubbles").onclick = () => {
    st.bubblesOn = !st.bubblesOn;
    if (!st.bubblesOn) clearBubbles();
    $("bubbles").classList.toggle("on", !st.bubblesOn);
    $("bubbles").title = st.bubblesOn ? "Hide speech bubbles" : "Show speech bubbles";
  };
  $("mute").onclick = () => {
    const on = !S.enabled();
    S.setEnabled(on); Q.setMuted(!on); paintMute();
    if (on && st.room) S.bedOn(true);
  };
  $("hideStrip").onclick = () => ($("strip").hidden = true);
  $("legend").onclick = () => { st.agentId = null; st.msgKey = null; ui.legend(city); };

  function swapIcon(btn, id, title) {
    btn.replaceChildren();
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("class", "i");
    const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
    u.setAttribute("href", "#" + id);
    s.appendChild(u); btn.appendChild(s);
    btn.title = title;
  }
  const paintTour = () => {
    $("tour").classList.toggle("on", st.tour);
    swapIcon($("tour"), st.tour ? "c-pause" : "c-play", st.tour ? "Stop the tour" : "Auto-tour");
  };
  const paintMute = () => {
    const on = S.enabled();
    $("mute").classList.toggle("on", on);
    swapIcon($("mute"), on ? "c-sound" : "c-mute", on ? "Sound on" : "Sound off");
  };
  paintTour(); paintMute();

  /* The quality selector has nothing to choose between here, so it says what
     it is instead of offering settings that would do nothing. */
  (function paintQuality() {
    const box = $("quality");
    box.replaceChildren();
    const b = document.createElement("button");
    b.type = "button"; b.className = "on"; b.textContent = "2D map";
    b.title = "This browser is not offering WebGL, so Agent City is drawing the same live data as a flat map. Every room, identity, message and number is here.";
    b.addEventListener("click", () => b.blur());
    box.append(b);
  })();

  function setClean(v) {
    st.clean = v;
    for (const n of [$("chips").parentElement, $("side"), $("strip"), els.feed])
      if (n) n.style.opacity = v ? "0" : "";
    for (const n of [$("chips").parentElement, els.feed]) if (n) n.style.pointerEvents = v ? "none" : "";
    els.overlay.style.opacity = v ? "0" : "";
    if (v) ui.hover(0, 0, null);
    mark();
  }

  /* ── auto-tour ───────────────────────────────────────────────────────── */
  let tourTimer = 0;
  function stopTour() { if (!st.tour) return; st.tour = false; clearTimeout(tourTimer); paintTour(); }
  function tourStep() {
    if (!st.tour) return;
    const live = DISTRICTS
      .map((d) => ({ d, h: (city && D.rateOf(d.room)) ?? 0 }))
      .sort((a, b) => b.h - a.h);
    const d = live[st.tourAt % live.length].d;
    st.tourAt++;
    /* flyToDistrict seizes nothing — only a real input does — so the tour can
       keep moving while it runs, and dies the moment a finger lands. */
    const p = positionOf(d.room);
    if (p) { focus(p.x, p.z, fit * 3.2, reduced ? 0 : 900); showSummary(d.room); S.pick(); }
    tourTimer = setTimeout(tourStep, reduced ? 3600 : 6200);
  }
  $("tour").onclick = () => {
    st.tour = !st.tour; st.tourAt = 0; paintTour();
    clearTimeout(tourTimer);
    if (st.tour) tourStep();
  };


  /* ── the keyboard ─────────────────────────────────────────────────────
     Escape is the ladder out of wherever you are, and the arrows move the
     map — see the same note in boot.js. */
  addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.key === "Escape") {
      /* The ladder, in the order somebody would climb it: the clean view,
         then the feed, then whichever identity or message they drilled into,
         then the room itself, then the panel. Closing the sub-panel by
         calling closePanel would immediately reopen the room's own panel —
         which is right when a close button is clicked and wrong here, and is
         why Escape used to loop instead of letting anybody out. */
      if (st.clean) setClean(false);
      else if (!els.feed.hidden) ui.closeFeed();
      else if (st.agentId || st.msgKey) { st.agentId = null; st.msgKey = null; showRoomPanel(); }
      else if (st.room) leaveRoom();
      else if (!els.side.hidden) ui.closePanel();
      return;
    }
    /* A keypress moves a proportion of what you can see, not a number of
       world units: the same press should feel the same zoomed in or out. */
    const step = (e.shiftKey ? 3 : 1) * (W / Math.max(0.001, want.s)) * 0.14;
    if (e.key === "ArrowLeft") { seize(); want.x -= step; }
    else if (e.key === "ArrowRight") { seize(); want.x += step; }
    else if (e.key === "ArrowUp") { seize(); want.z -= step; }
    else if (e.key === "ArrowDown") { seize(); want.z += step; }
    else if (e.key === "+" || e.key === "=") zoomBy(1.35);
    else if (e.key === "-" || e.key === "_") zoomBy(0.74);
    else if (e.key === "Home") { stopTour(); home(reduced ? 0 : 800); }
    else return;
    if (e.key.startsWith("Arrow")) { normalise(); e.preventDefault(); }
    mark();
  });

  /* ── search ──────────────────────────────────────────────────────────── */
  const q = $("q");
  const onSearch = () => {
    const term = q.value.trim().toLowerCase();
    if (!term) return ui.hits(null);
    const out = [];
    if (/^(did:key:)?z6Mk/i.test(term)) out.push({ kind: "did", label: q.value.trim(), did: q.value.trim() });
    if (city) {
      for (const r of [...city.landmarks, ...city.roster]) {
        if (out.some((o) => o.room === r.room)) continue;
        if (r.room.includes(term) || (r.topic || "").toLowerCase().includes(term))
          out.push({ kind: "room", label: r.room, room: r.room, landmark: !!r.landmark });
        if (out.length > 20) break;
      }
    }
    ui.hits(out, (h) => {
      q.value = ""; ui.hits(null);
      if (h.kind === "room") flyToRoom(h.room);
      else findDid(h.did);
    });
  };
  q.addEventListener("input", onSearch);
  q.addEventListener("blur", () => setTimeout(() => ui.hits(null), 160));

  function findDid(did) {
    const full = did.startsWith("did:key:") ? did : `did:key:${did}`;
    const here = D.state.room?.agents.find((a) => a.did === full);
    if (here) return selectAgent(here.id);
    /* See the same note in boot.js: offer the identity card, do not open a
       tab nobody asked for. */
    ui.hits([{ kind: "did", label: "Not in a room you are standing in — open the identity card", did: full }],
      (h) => { ui.hits(null); window.open(`/?did=${encodeURIComponent(h.did)}`, "_blank", "noopener"); });
  }

  /* ── the frame ───────────────────────────────────────────────────────── */
  const watcher = Q.makeWatcher({ target: 28, onDown: () => {}, onUp: () => {} });
  let raf = 0, last = performance.now(), overlayAcc = 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    watcher.tick(now);
    stepView(dt);
    stepFx(dt);
    if (dirty) { draw(); dirty = false; }
    overlayAcc += dt;
    if (overlayAcc > 0.05) {
      overlayAcc = 0;
      syncLabels();
      layoutBubbles(now);
      updateHover();
    }
  }

  const onResize = () => { rectCache = null; resize(); };
  addEventListener("resize", onResize, { passive: true });
  resize();

  /* Same three reasons to stop as the 3D page has, and they matter more here:
     these are the slow machines. */
  let onScreen = true, awake = true;
  function setAwake() {
    const should = onScreen && !document.hidden;
    if (should === awake) return;
    awake = should;
    if (!awake) { cancelAnimationFrame(raf); raf = 0; }
    else if (!raf) { last = performance.now(); mark(); raf = requestAnimationFrame(frame); }
  }
  document.addEventListener("visibilitychange", setAwake);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => { onScreen = es.some((e) => e.isIntersecting); setAwake(); },
      { threshold: 0.02 }).observe(els.stage);
  }

  function dispose() {
    cancelAnimationFrame(raf); raf = 0;
    clearInterval(stripTimer);
    clearTimeout(tourTimer);
    removeEventListener("resize", onResize);
    clearBubbles();
    for (const [, l] of labels) l.node.remove();
    for (const rl of roomLabels) rl.node.remove();
    labels.clear(); roomLabels.length = 0;
    D.stop(); S.dispose();
    container.replaceChildren();
  }
  addEventListener("pagehide", dispose);

  S.setEnabled(false);

  /* A saved "sound on" is honoured, but only from the first real gesture —
     every browser refuses to start an audio context before one, and a page
     that tries is a page that logs a warning and stays silent anyway. */
  if (!Q.muted()) {
    const wake = () => {
      removeEventListener("pointerdown", wake);
      removeEventListener("keydown", wake);
      S.setEnabled(true);
      paintMute();
      if (st.room) S.bedOn(true);
    };
    addEventListener("pointerdown", wake, { once: true });
    addEventListener("keydown", wake, { once: true });
  }
  home(0);
  raf = requestAnimationFrame(frame);
  setTimeout(() => { $("boot").hidden = true; }, 4000);

  /* The same read-only handle the 3D page publishes, so one test suite can
     drive either view. */
  return {
    state: st, view, bubbles, labels,
    get city() { return city; },
    get rooms() { return rooms; },
    get agents() { return agents; },
    enterRoom, leaveRoom, flyToDistrict, flyToRoom, selectAgent, selectMessage,
    positionOf, pick, focus, home, dispose,
    fps: () => watcher.fps(),
  };
}

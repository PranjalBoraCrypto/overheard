/**
 * city/boot.js — Agent City, assembled.
 *
 * THE ORDER THINGS HAPPEN IN IS THE POINT.
 *
 *   1. Ask the machine what it can do, before importing anything heavy.
 *   2. If there is no WebGL, load the flat map instead — a different view of
 *      the same data, not an apology.
 *   3. Only then import three.js. Nothing above this line costs 170KB.
 *   4. Show the city from the directory, which arrives long before anybody
 *      has finished reading the headline.
 *   5. Poll a room only once somebody is standing in it.
 *
 * WHAT LIVES HERE: the wiring, the camera choreography, and the two overlays
 * that need to know where things are in 3D — the labels and the speech
 * bubbles. Everything else is in its own file: the truth in data.js, the
 * panels in ui.js, the scene in world.js, the feel in cam.js.
 */

import * as Q from "./quality.js";
import * as D from "./data.js";
import * as S from "./sound.js";
import { makeUI, ago } from "./ui.js";
import { makeDeclutter } from "./declutter.js";

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

export async function boot() {
  const stage = $("stage"), canvas = $("scene"), overlay = $("overlay");
  const els = {
    stage, overlay, chips: $("chips"), side: $("side"), feed: $("feedpane"),
    hover: $("hover"), hits: $("hits"),
  };

  /* ── 1. what can this machine do ─────────────────────────────────────── */
  let { level, auto, why } = Q.guessLevel();
  const webgl = Q.hasWebGL();

  if (!webgl) {
    $("bootTitle").textContent = "Showing the flat map";
    $("bootWhy").textContent = "This browser has no WebGL, so Agent City is drawing the same live network in 2D. Everything except the 3D city is here.";
    const { mountFlat } = await import("./flat.js");
    canvas.hidden = true;
    return startFlat(mountFlat, els);
  }

  /* ── 2. the engine, and only now ─────────────────────────────────────── */
  $("bootWhy").textContent = "Loading the renderer.";
  let THREE;
  try {
    THREE = await import("/vendor/three.module.min.js");
  } catch {
    const { mountFlat } = await import("./flat.js");
    canvas.hidden = true;
    $("bootTitle").textContent = "Showing the flat map";
    $("bootWhy").textContent = "The 3D engine could not load. The same live network is drawn in 2D below.";
    return startFlat(mountFlat, els);
  }

  const { buildWorld, DISTRICTS } = await import("./world.js");
  const { makeCamera } = await import("./cam.js");

  let preset = { ...Q.PRESETS[level] };
  let world = buildWorld(THREE, { canvas, preset, reduced });
  let cam = makeCamera(THREE, world.camera, canvas, { reduced });

  /* ── 3. state ────────────────────────────────────────────────────────── */
  const st = {
    room: null,            // the room we are standing in
    agentId: null,         // selected identity
    msgKey: null,          // selected message
    following: null,
    bubblesOn: true,
    clean: false,
    tour: false,
    tourAt: 0,
    hoverKey: null,
  };
  let firstVisit = false;
  try {
    firstVisit = !localStorage.getItem("overheard.city.seen");
    localStorage.setItem("overheard.city.seen", "1");
  } catch { firstVisit = false; }

  const bubbles = [];      // { key, agentId, node, born, life, kind }
  const labels = new Map();
  const declutter = makeDeclutter(els);

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

  /* ── 4. the city, as data arrives ────────────────────────────────────── */
  let city = null;

  /* The city is the roster, not the current directory page: the directory
     returns only the two hundred rooms that spoke most recently and churns
     several every minute, so drawing it raw would blink buildings in and out
     of the skyline. See the roster note in data.js. */
  const cityRooms = () => (city?.roster || []).filter((r) => !r.landmark);
  const unnamedNow = () =>
    Math.max(0, (city?.counts.total_public ?? 0) - (city?.roster?.length ?? 0));

  D.on("city", (c) => {
    const first = !city;
    city = c;
    world.setRooms(cityRooms(), unnamedNow());
    refreshHeat();
    buildLabels();
    paintChips();
    $("boot").hidden = true;
    /* Once, on a first visit: the legend, because two hundred glowing towers
       mean nothing until somebody says what height and light are. After that
       it is behind the ⓘ, where it does not get in the way. */
    if (first && firstVisit && !st.room) { firstVisit = false; ui.legend(city); }
    /* The arrival. A page that opens on a still image of a 3D scene looks
       like a picture of one; a slow settle onto the skyline says "this
       moves, and you can move it" without a tooltip. It is skipped for
       anybody who has asked for less motion, and for anybody who has already
       grabbed the camera in the second before the directory answered. */
    if (first && !reduced && !cam.touched) {
      cam.flyTo({ dist: cam.dist * 1.5, pitch: Math.min(1.2, cam.pitch + 0.28) }, 0);
      cam.home(1900);
    }
  });

  D.on("status", () => { paintChips(); if (!city) sayWhyEmpty(); });

  /* If the very first directory read fails there is nothing to draw, and an
     empty plate with no explanation reads as "the network is dead" rather
     than "we could not reach it". */
  function sayWhyEmpty() {
    const s = D.state.status;
    if (s.city === "live" || s.city === "starting") return;
    $("bootTitle").textContent = s.city === "offline"
      ? "Technocore's directory is not answering"
      : "Reaching Technocore's directory";
    $("bootWhy").textContent = (s.why || "the directory did not answer") +
      ". Nothing here is cached or invented, so the city stays empty until it does. Retrying.";
    $("boot").hidden = false;
  }

  function refreshHeat() {
    if (!city) return;
    const heat = new Map();
    for (const r of city.roster) {
      /* Two different signals, combined honestly: a measured rate if we have
         one, otherwise how recently the server says the room spoke. A room we
         have not measured yet is dim rather than dark, and a room that has
         dropped out of the directory's live window is dark rather than
         guessed at. */
      let h = 0;
      if (!r.live) h = 0;
      else {
        const rate = D.rateOf(r.room), idle = r.idle;
        if (rate != null) h = Math.min(1, Math.log10(1 + rate) / 1.9);
        else if (idle != null) h = idle < 30 ? 0.55 : idle < 300 ? 0.3 : 0.08;
      }
      heat.set(r.room, h);
    }
    world.setHeat(heat);
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
    const badge = $("badge");
    const s = D.state.status;
    badge.className = "eyebrow" + (s.city === "live" ? "" : s.city === "offline" ? " down" : " stale");
    badge.lastChild.nodeValue =
      s.city === "live" ? (st.room ? `${st.room} · live` : "Technocore · live network")
      : s.city === "offline" ? "Technocore · offline" : "Technocore · reconnecting";
  }

  /* ── labels ──────────────────────────────────────────────────────────── */

  /** The one label that changes: the count on the outer ring. */
  function paintRing() {
    const l = labels.get("b:ring");
    const b = world.blocks[Math.floor(world.blocks.length * 0.5)];
    if (!l || !b) return;
    l.x = b.x; l.z = b.z; l.block = b;
    const text = `${unnamedNow().toLocaleString()} more public rooms, not named to this page`;
    if (l.node.textContent !== text) { l.node.textContent = text; l.w = 0; }
  }

  /**
   * Built once, then left alone. The directory arrives every twenty seconds
   * and the districts in it are always the same six, so throwing away
   * nineteen DOM nodes and their listeners three times a minute buys nothing
   * — and it cancels whatever the visitor was hovering at the time.
   */
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
      overlay.append(node);
      labels.set(`d:${d.room}`, { node, kind: "district", room: d.room, x: d.x, y: 40, z: d.z });
    });

    /* ONE label for the whole outer ring, not one per plinth. Ten identical
       chips reading "3,809 rooms" is not ten facts, it is one fact repeated
       until it looks like clutter — and the fact it is repeating is the most
       important sentence on the page, so it gets said once, clearly. Hovering
       any single plinth still explains the arithmetic behind it. */
    const b = world.blocks[Math.floor(world.blocks.length * 0.5)];
    if (b) {
      const node = document.createElement("div");
      node.className = "lab blk";
      overlay.append(node);
      labels.set("b:ring", { node, kind: "block", x: b.x, y: 14, z: b.z, block: b });
      paintRing();
    }
  }

  /* Named rooms only get a label when the camera is close enough for one to
     mean anything, and only the handful nearest the middle of the view — two
     hundred labels at once is not a map, it is a wall of text. */
  const roomLabels = [];
  function syncRoomLabels(rect) {
    const show = cam.dist < 210 && !st.room && !st.clean;
    const want = show ? 12 : 0;
    while (roomLabels.length < want) {
      const node = document.createElement("button");
      node.className = "lab dim"; node.type = "button";
      overlay.append(node);
      roomLabels.push({ node, room: null });
    }
    for (const rl of roomLabels) rl.node.hidden = true;
    if (!show) return;

    const t = cam.target;
    const near = world.rooms
      .map((p) => ({ p, d: Math.hypot(p.x - t.x, p.z - t.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, want);
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
      const s = world.project(n.p.x, n.p.h + 4, n.p.z, rect);
      if (s.behind || !declutter.place(rl, s.x, s.y)) { rl.node.hidden = true; return; }
      rl.node.hidden = false;
      rl.node.style.transform = `translate(${Math.round(s.x)}px,${Math.round(s.y)}px) translate(-50%,-100%)`;
    });
  }

  /* ── entering and leaving ────────────────────────────────────────────── */

  function flyToDistrict(room) {
    const p = world.positionOf(room);
    if (!p) return;
    S.pick();
    cam.focus(p.x, p.z, 132, reduced ? 0 : 1200, 0.48);
    showSummary(room);
  }
  function flyToRoom(room) {
    const p = world.positionOf(room);
    if (!p) return;
    S.pick();
    cam.focus(p.x, p.z, 96, reduced ? 0 : 1000, 0.52);
    showSummary(room);
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

  function showSummary(room) { ui.roomSummary(summaryFor(room)); }

  function enterRoom(name) {
    st.room = name; st.agentId = null; st.msgKey = null; st.following = null;
    clearBubbles();
    const p = world.enterRoom(name);
    cam.focus(p.x, p.z, 118, reduced ? 0 : 1400, 0.46);
    D.enterRoom(name);
    S.arrive(); S.bedOn(true);
    $("strip").hidden = st.clean;
    paintChips();
    ui.roomLive({ name, messages: [], agents: [], gaps: [] }, []);
  }

  function leaveRoom() {
    st.room = null; st.agentId = null; st.msgKey = null; st.following = null;
    clearBubbles();
    world.leaveRoom();
    D.leaveRoom();
    ui.closeFeed();
    S.bedOn(false);
    cam.home(reduced ? 0 : 1300);
    $("strip").hidden = true;
    ui.closePanel();
    paintChips();
  }

  function showRoomPanel() {
    const r = D.state.room;
    if (!r) return;
    ui.roomLive(r, r.agents, st.agentId);
  }

  function selectAgent(id) {
    st.agentId = id; st.msgKey = null;
    const r = D.state.room;
    const a = r?.agents.find((x) => x.id === id);
    if (!a) return;
    const pos = world.agentAt(id);
    if (pos) cam.focus(pos.x, pos.z, Math.min(cam.dist, 62), reduced ? 0 : 800, 0.34);
    world.lightAgent(id, 1);
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
    if (from) world.lightAgent(from, 1);
    if (to) { world.lightAgent(to, 1); world.beam(from, to, 1600); }
    const toA = to ? r.agents.find((x) => x.id === to) : null;
    ui.messagePanel(m, toA ? (toA.did ? toA.did.replace(/^did:key:/, "").slice(0, 12) + "…" : toA.nick) : null);
    ui.renderFeed(r, key);
  }

  function toggleFeed() {
    if (!els.feed.hidden) { ui.closeFeed(); return; }
    ui.buildFeed(D.state.room, st.msgKey);
  }

  /* ── live messages become things that happen ─────────────────────────── */

  D.on("room", (r) => {
    if (!r) return;
    world.setAgents(r.agents);
    if (!st.agentId && !st.msgKey) showRoomPanel();
    ui.renderFeed(r, st.msgKey);
    paintStrip(r);
  });

  D.on("messages", ({ added }) => {
    if (!added.length) return;
    const r = D.state.room;
    /* A burst is grouped rather than staged one effect per message: forty
       messages in a second is forty pulses nobody can see, and the data layer
       has already kept every one of them regardless of what is drawn. */
    const budget = Math.min(added.length, 6);
    const step = Math.max(1, Math.floor(added.length / budget));
    for (let i = 0; i < added.length; i += step) {
      const m = added[i];
      const from = m.did || (m.nick ? `nick:${m.nick}` : null);
      const a = from ? world.agentAt(from) : null;
      if (a) {
        world.lightAgent(from, 1);
        world.pulse(a.x, a.z, { y: 2.4, r1: 7 });
        const to = D.addressee(m, r.agents);
        if (to && world.agentAt(to)) world.beam(from, to, 1500);
      }
      S.tick(m.seq, m.c.kind);
      if (st.bubblesOn && !st.clean) addBubble(m, from);
    }
    if (st.following) {
      const mine = added.filter((m) => (m.did || `nick:${m.nick}`) === st.following);
      if (mine.length) { world.lightAgent(st.following, 1); if (!st.msgKey) selectAgent(st.following); }
    }
    paintStrip(r);
  });

  /* ── bubbles ─────────────────────────────────────────────────────────── */

  function addBubble(m, agentId) {
    if (!agentId || !world.agentAt(agentId)) return;
    /* One per speaker: a burst from one agent should replace its bubble, not
       stack five of them into a column nobody can read. */
    const old = bubbles.findIndex((b) => b.agentId === agentId);
    if (old >= 0) retire(bubbles[old]);

    const node = document.createElement("div");
    node.className = `bub ${m.c.kind}`;
    const w = document.createElement("span");
    w.className = "w";
    w.textContent = (m.did ? m.did.replace(/^did:key:/, "").slice(0, 8) + "…" : m.nick || "—");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = m.text;                       // text, never markup
    node.append(w, t);
    node.addEventListener("click", (e) => { e.stopPropagation(); selectMessage(m.key); });
    overlay.append(node);

    bubbles.push({ key: m.key, agentId, node, born: performance.now(), life: 6500 });
    while (bubbles.length > preset.bubbles) retire(bubbles[0]);
  }

  function retire(b) {
    const i = bubbles.indexOf(b);
    if (i >= 0) bubbles.splice(i, 1);
    b.node.classList.add("out");
    setTimeout(() => b.node.remove(), 360);
  }
  function clearBubbles() { while (bubbles.length) retire(bubbles[0]); }

  function layoutBubbles(rect, now) {
    const placed = [];
    for (const b of [...bubbles]) {
      /* The selected agent's bubble stays up longer, because it is the one
         somebody is actually reading. */
      const life = st.agentId === b.agentId ? b.life * 2 : b.life;
      if (now - b.born > life) { retire(b); continue; }
      const a = world.agentAt(b.agentId);
      if (!a) { retire(b); continue; }
      const s = world.project(a.x, a.y + 8, a.z, rect);
      if (s.behind) { b.node.style.opacity = "0"; continue; }
      /* Bubbles are placed by the same rule as the labels — they are the same
         kind of thing, and a speech bubble under the side panel is a message
         the visitor cannot read. Six tries going up, then it waits its turn;
         they expire in a few seconds anyway. */
      const at = declutter.placeAny(b, s.x, s.y,
        [[0, 0], [0, -70], [0, -140], [-120, -36], [120, -36], [0, 64]]);
      if (!at) { b.node.style.opacity = "0"; continue; }
      const y = at.y;
      placed.push({ x: at.x, y });
      const k = 1 - Math.max(0, (now - b.born - life + 700) / 700);
      b.node.style.opacity = String(Math.max(0, Math.min(1, k)));
      b.node.style.transform = `translate(${Math.round(at.x)}px,${Math.round(y)}px) translate(-50%,-100%)`;
      b.node.classList.toggle("sel", st.msgKey === b.key || st.agentId === b.agentId);
    }
  }

  /* ── the activity strip ──────────────────────────────────────────────── */
  const hist = new Array(48).fill(0);
  let lastCount = 0, lastTick = 0;
  function paintStrip(r) {
    if (!r || $("strip").hidden) return;
    $("stripTitle").textContent = `${r.name} · activity`;
    const s = D.state.status;
    $("stripLive").textContent =
      s.room === "sampled" ? "• sampled" : s.room === "live" ? "• live" :
      s.room === "throttled" ? "• throttled" : `• ${s.room}`;
    $("stripLive").style.color = s.room === "live" ? "var(--good)" : "var(--warn)";
    $("stripLeft").textContent = r.first_seq ? `#${r.first_seq}` : "";
    $("stripRight").textContent = r.last_seq ? `#${r.last_seq} · ${ago(r.at)}` : "";
  }
  const stripTimer = setInterval(() => {
    const r = D.state.room;
    if (!r) return;
    const n = r.messages.length;
    const seq = r.last_seq ? Number(r.last_seq) : 0;
    const d = lastTick ? Math.max(0, seq - lastTick) : 0;
    lastTick = seq; lastCount = n;
    hist.push(d); hist.shift();
    const box = $("ticks");
    if (!box || $("strip").hidden) return;
    if (box.children.length !== hist.length) {
      box.replaceChildren(...hist.map(() => document.createElement("i")));
    }
    const max = Math.max(3, ...hist);
    [...box.children].forEach((n2, i) => {
      const v = hist[i];
      n2.style.height = `${Math.max(2, (v / max) * 34)}px`;
      n2.classList.toggle("hot", v > max * 0.55);
    });
  }, 1500);

  /* ── picking ─────────────────────────────────────────────────────────── */
  let hoverAt = { x: 0, y: 0 }, hoverStale = true, pointerIn = false, lastHoverRun = 0;
  canvas.addEventListener("wheel", () => { hoverStale = true; }, { passive: true });
  canvas.addEventListener("pointermove", (e) => {
    if (Math.abs(e.clientX - hoverAt.x) + Math.abs(e.clientY - hoverAt.y) > 1) hoverStale = true;
    hoverAt = { x: e.clientX, y: e.clientY };
    pointerIn = true;
    canvas.classList.toggle("grabbing", cam.dragging);
  });
  canvas.addEventListener("pointerleave", () => { pointerIn = false; hoverStale = true; });
  canvas.addEventListener("pointerenter", () => { pointerIn = true; hoverStale = true; });
  canvas.addEventListener("pointerdown", () => canvas.classList.add("grabbing"));
  addEventListener("pointerup", () => canvas.classList.remove("grabbing"));

  let downAt = null;
  canvas.addEventListener("pointerdown", (e) => (downAt = { x: e.clientX, y: e.clientY, t: performance.now() }));
  canvas.addEventListener("pointerup", (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    const held = performance.now() - downAt.t;
    downAt = null;
    if (moved > 6 || held > 500) return;            // that was a drag, not a click
    const hit = world.pick(e.clientX, e.clientY, canvas.getBoundingClientRect());
    if (!hit) return;
    if (hit.type === "agent") selectAgent(hit.id);
    else if (hit.type === "district") st.room === hit.room ? showSummary(hit.room) : flyToDistrict(hit.room);
    else if (hit.type === "room") flyToRoom(hit.room);
  });

  /** The hover test raycasts a few hundred instances, so it runs when there
   *  is a reason to: the pointer moved, the camera moved under it, or the
   *  pointer is over a label. A still pointer over a still city is not a new
   *  question, and asking it thirty times a second is a fan spinning up. */
  function updateHover(rect) {
    if (st.clean) { ui.hover(0, 0, null); return; }
    if (!pointerIn && !st.hoverKey) { ui.hover(0, 0, null); return; }
    /* Still pointer, still city: re-ask about twice a second so a live card
       keeps updating, instead of thirty times a second for the same answer. */
    const now = performance.now();
    if (!hoverStale && !cam.busy && now - lastHoverRun < 600) return;
    lastHoverRun = now;
    hoverStale = false;
    const r = D.state.room;
    if (typeof st.hoverKey === "string" && st.hoverKey.startsWith("room:")) {
      const room = st.hoverKey.slice(5);
      const d = DISTRICTS.find((x) => x.room === room);
      const info = summaryFor(room);
      ui.hover(hoverAt.x - rect.left, hoverAt.y - rect.top,
        ui.hoverRoomCard({ ...info, title: d?.title || room, sub: d?.sub }));
      canvas.classList.add("pointing");
      return;
    }
    if (st.hoverKey && r) {
      const a = r.agents.find((x) => x.id === st.hoverKey);
      if (a) { ui.hover(hoverAt.x - rect.left, hoverAt.y - rect.top, ui.hoverAgentCard(a)); return; }
    }
    const hit = cam.dragging ? null : world.pick(hoverAt.x, hoverAt.y, rect);
    canvas.classList.toggle("pointing", !!hit);
    if (!hit) { ui.hover(0, 0, null); return; }
    const x = hoverAt.x - rect.left, y = hoverAt.y - rect.top;
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

  /* ── controls ────────────────────────────────────────────────────────── */
  $("zoomIn").onclick = () => cam.flyTo({ dist: cam.dist * 0.72 }, reduced ? 0 : 420);
  $("zoomOut").onclick = () => cam.flyTo({ dist: cam.dist * 1.38 }, reduced ? 0 : 420);
  $("reset").onclick = () => { st.tour = false; paintTour(); if (st.room) leaveRoom(); else cam.home(reduced ? 0 : 1000); };
  $("tour").onclick = () => { st.tour = !st.tour; st.tourAt = 0; paintTour(); };
  $("bubbles").onclick = () => {
    st.bubblesOn = !st.bubblesOn;
    if (!st.bubblesOn) clearBubbles();
    $("bubbles").classList.toggle("on", !st.bubblesOn);
    $("bubbles").title = st.bubblesOn ? "Hide speech bubbles" : "Show speech bubbles";
  };
  $("mute").onclick = () => {
    const nowOn = !S.enabled();
    S.setEnabled(nowOn);
    Q.setMuted(!nowOn);
    paintMute();
    if (nowOn && st.room) S.bedOn(true);
  };
  $("hideStrip").onclick = () => ($("strip").hidden = true);
  $("legend").onclick = () => { st.agentId = null; st.msgKey = null; ui.legend(city); };

  function paintTour() {
    const b = $("tour");
    b.classList.toggle("on", st.tour);
    b.replaceChildren();
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("class", "i");
    const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
    u.setAttribute("href", st.tour ? "#c-pause" : "#c-play");
    s.appendChild(u); b.appendChild(s);
    b.title = st.tour ? "Stop the tour" : "Auto-tour";
  }
  function paintMute() {
    const b = $("mute"), on = S.enabled();
    b.classList.toggle("on", on);
    b.replaceChildren();
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("class", "i");
    const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
    u.setAttribute("href", on ? "#c-sound" : "#c-mute");
    s.appendChild(u); b.appendChild(s);
    b.title = on ? "Sound on" : "Sound off";
  }
  paintTour(); paintMute();

  /* quality selector */
  function paintQuality() {
    const box = $("quality");
    box.replaceChildren();
    for (const lv of Q.LEVELS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = Q.PRESETS[lv].label;
      b.className = lv === level ? "on" : "";
      b.title = lv === level && auto ? `Chosen automatically — ${why}` : `Switch to ${Q.PRESETS[lv].label}`;
      b.addEventListener("click", () => setLevel(lv, false));
      box.append(b);
    }
  }
  paintQuality();

  function setLevel(lv, isAuto) {
    if (lv === level) return;
    level = lv; auto = !!isAuto;
    why = isAuto ? "your machine was struggling" : "your choice";
    if (!isAuto) { Q.saveLevel(lv); watcher.enabled = false; }
    preset = { ...Q.PRESETS[lv] };
    /* A change the visitor asked for rebuilds the scene so they get exactly
       the level they picked. A change the watcher made only touches what can
       be changed without a rebuild — throwing the city away mid-stutter to
       fix a stutter is not a fix. */
    if (!isAuto) rebuild();
    else {
      world.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, preset.dpr));
      while (bubbles.length > preset.bubbles) retire(bubbles[0]);
    }
    paintQuality();
  }

  function rebuild() {
    const keepRoom = st.room, keepTarget = cam.target, keepDist = cam.dist;
    clearBubbles();
    cam.dispose();
    world.dispose(false);          // keep the GL context; see dispose() in world.js
    world = buildWorld(THREE, { canvas, preset, reduced });
    cam = makeCamera(THREE, world.camera, canvas, { reduced });
    if (city) {
      world.setRooms(cityRooms(), unnamedNow());
      refreshHeat(); buildLabels();
    }
    if (keepRoom) { world.enterRoom(keepRoom); if (D.state.room) world.setAgents(D.state.room.agents); }
    /* fit() first: it tells a fresh camera the window's shape, and a fresh
       camera reframes itself — which would throw away the view we are in the
       middle of restoring if it ran second. */
    fit();
    cam.flyTo({ tx: keepTarget.x, tz: keepTarget.z, dist: keepDist }, 0);
  }

  const watcher = Q.makeWatcher({
    target: 34,
    onDown: () => {
      const i = Q.LEVELS.indexOf(level);
      if (i > 0) setLevel(Q.LEVELS[i - 1], true);
    },
    onUp: () => {
      const i = Q.LEVELS.indexOf(level);
      if (i < Q.LEVELS.length - 1 && auto) setLevel(Q.LEVELS[i + 1], true);
    },
  });

  function setClean(v) {
    st.clean = v;
    for (const n of [$("chips").parentElement, $("side"), $("strip"), els.feed])
      if (n) n.style.opacity = v ? "0" : "";
    for (const n of [$("chips").parentElement, els.feed]) if (n) n.style.pointerEvents = v ? "none" : "";
    overlay.style.opacity = v ? "0" : "";
    if (v) ui.hover(0, 0, null);
  }


  /* ── the keyboard ─────────────────────────────────────────────────────
     Two things. Escape is a ladder out of wherever you are — a page whose
     "hide the overlays" button hides the button is a trap, and it was one.
     And the arrows drive the camera, because a 3D page you can only use with
     a mouse is a 3D page some people cannot use at all. */
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
    const k = e.key;
    const step = e.shiftKey ? 3 : 1;
    if (k === "ArrowLeft") { cam.nudge(-0.14 * step); e.preventDefault(); }
    else if (k === "ArrowRight") { cam.nudge(0.14 * step); e.preventDefault(); }
    else if (k === "ArrowUp") { cam.flyTo({ dist: cam.dist * (1 - 0.12 * step) }, 0); e.preventDefault(); }
    else if (k === "ArrowDown") { cam.flyTo({ dist: cam.dist * (1 + 0.12 * step) }, 0); e.preventDefault(); }
    else if (k === "+" || k === "=") cam.flyTo({ dist: cam.dist * 0.8 }, reduced ? 0 : 300);
    else if (k === "-" || k === "_") cam.flyTo({ dist: cam.dist * 1.25 }, reduced ? 0 : 300);
    else if (k === "Home") { st.tour = false; paintTour(); cam.home(reduced ? 0 : 900); }
  });

  /* ── search ──────────────────────────────────────────────────────────── */
  const q = $("q");
  q.addEventListener("input", () => {
    const term = q.value.trim().toLowerCase();
    if (!term) return ui.hits(null);
    const out = [];
    if (/^did:key:z6Mk/i.test(term) || /^z6Mk/i.test(term)) {
      out.push({ kind: "did", label: q.value.trim(), did: q.value.trim() });
    }
    if (city) {
      /* Districts first, then everything the directory has named this
         session — including rooms that have since dropped out of its live
         window, which are still real rooms and still in the city. */
      for (const r of [...city.landmarks, ...city.roster]) {
        if (out.some((o) => o.room === r.room)) continue;
        if (r.room.includes(term) || (r.topic || "").toLowerCase().includes(term)) {
          out.push({ kind: "room", label: r.room, room: r.room, landmark: !!r.landmark });
        }
        if (out.length > 20) break;
      }
    }
    ui.hits(out, (h) => {
      q.value = ""; ui.hits(null);
      if (h.kind === "room") flyToRoom(h.room);
      else findDid(h.did);
    });
  });
  q.addEventListener("blur", () => setTimeout(() => ui.hits(null), 160));

  /** A DID is not on the map until it says something in a room we are in, so
   *  "locate" is honest about what it can and cannot do. */
  function findDid(did) {
    const full = did.startsWith("did:key:") ? did : `did:key:${did}`;
    const here = D.state.room?.agents.find((a) => a.did === full);
    if (here) return selectAgent(here.id);
    /* Not in the room we are standing in — which is the only place a DID can
       be on this map. Say so, and OFFER the identity card rather than opening
       a tab somebody did not ask for. */
    ui.hits([{ kind: "did", label: "Not in a room you are standing in — open the identity card", did: full }],
      (h) => { ui.hits(null); window.open(`/?did=${encodeURIComponent(h.did)}`, "_blank", "noopener"); });
  }

  /* ── auto-tour ───────────────────────────────────────────────────────── */
  let tourTimer = 0;
  function tourStep() {
    if (!st.tour) return;
    const live = DISTRICTS
      .map((d) => ({ d, h: (city && D.rateOf(d.room)) ?? 0 }))
      .sort((a, b) => b.h - a.h);
    const pickd = live[st.tourAt % live.length].d;
    st.tourAt++;
    flyToDistrict(pickd.room);
    tourTimer = setTimeout(tourStep, reduced ? 3600 : 6200);
  }
  const origSeize = cam.onChange;
  cam.onChange((what) => {
    /* Any grab stops the tour. This is the promise the whole camera makes. */
    if (what === "seized" && st.tour) { st.tour = false; clearTimeout(tourTimer); paintTour(); }
  });
  $("tour").addEventListener("click", () => {
    clearTimeout(tourTimer);
    if (st.tour) tourStep();
  });

  /* ── the frame ───────────────────────────────────────────────────────── */
  let last = performance.now(), raf = 0, overlayTick = 0;

  function fit() {
    const r = stage.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    world.resize(w, h, devicePixelRatio || 1);
    cam.setAspect(w / h);
  }
  addEventListener("resize", fit, { passive: true });
  fit();

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    watcher.tick(now);
    cam.step(dt);
    world.update(dt);
    world.render();

    /* The overlays are DOM, and DOM is the expensive part of a frame like
       this. They are updated at 30Hz rather than every frame; nothing in them
       moves fast enough for anybody to see the difference. */
    overlayTick += dt;
    if (overlayTick > 0.033) {
      overlayTick = 0;
      const rect = canvas.getBoundingClientRect();
      declutter.begin(now);
      /* Districts first, then the ring label, then room names: the order is
         the priority, because whoever asks first keeps the space. */
      for (const [, l] of [...labels].sort((a, b) => (a[1].kind === "district" ? -1 : 1))) {
        const s = world.project(l.x, l.y, l.z, rect);
        const off = s.behind || (l.kind === "block" && cam.dist < 200) || st.clean;
        const at = off ? null
          : (l.kind === "district" || l.kind === "block") ? declutter.placeAny(l, s.x, s.y)
          : declutter.place(l, s.x, s.y) ? { x: s.x, y: s.y } : null;
        l.node.hidden = !at;
        if (at) l.node.style.transform = `translate(${Math.round(at.x)}px,${Math.round(at.y)}px) translate(-50%,-100%)`;
      }
      syncRoomLabels(rect);
      layoutBubbles(rect, now);
      updateHover(rect);
    }
  }

  /* Three separate reasons to stop rendering, and all three happen often:
     the tab goes to the background, the visitor scrolls down to read the
     footer, or they leave. A city rendering at sixty frames a second behind
     a page nobody is looking at is the most common way a page like this
     spends somebody's battery. */
  let onScreen = true, awake = true;
  function setAwake() {
    const should = onScreen && !document.hidden;
    if (should === awake) return;
    awake = should;
    if (!awake) { cancelAnimationFrame(raf); raf = 0; }
    else if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }
  document.addEventListener("visibilitychange", setAwake);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => {
      onScreen = es.some((e) => e.isIntersecting);
      setAwake();
    }, { threshold: 0.02 }).observe(stage);
  }

  addEventListener("pagehide", () => {
    cancelAnimationFrame(raf); raf = 0;
    clearInterval(stripTimer); clearTimeout(tourTimer);
    D.stop(); S.dispose(); cam.dispose(); world.dispose(true);
  });

  /* A context can still be lost for reasons that have nothing to do with us —
     a driver reset, a laptop switching GPUs, the browser reclaiming memory
     from a background tab. Saying so beats a black rectangle. */
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    cancelAnimationFrame(raf); raf = 0;
    $("bootTitle").textContent = "The graphics context was lost";
    $("bootWhy").textContent = "This usually means the browser reclaimed the GPU. Reload the page to bring the city back — the live data is unaffected.";
    $("boot").hidden = false;
  });

  /* ── go ──────────────────────────────────────────────────────────────── */
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
  D.start();
  raf = requestAnimationFrame(frame);
  cam.home(0);
  setTimeout(() => { $("boot").hidden = true; }, 4000);   // never hang on a slow directory

  /* Published so the tests can drive the page rather than clicking blindly at
     a canvas. Read-only handles; nothing here can post anything anywhere. */
  window.__city = {
    get level() { return level; }, get preset() { return preset; },
    get state() { return st; }, get city() { return city; },
    get bubbles() { return bubbles; }, get labels() { return labels; },
    world, cam, data: D,
    enterRoom, leaveRoom, flyToDistrict, flyToRoom, selectAgent, selectMessage, setLevel,
    fps: () => watcher.fps(),
  };
}

/* ── the flat road ─────────────────────────────────────────────────────── */
function startFlat(mountFlat, els) {
  document.getElementById("flat").hidden = false;      // before mount: it measures itself
  const api = mountFlat(document.getElementById("flat"), els);
  D.start();
  /* Descriptors rather than a spread, because the handle carries live getters
     and a spread would freeze them at whatever they happened to be during
     boot — which is null. */
  window.__city = Object.defineProperties(
    { flat: true, data: D },
    Object.getOwnPropertyDescriptors(api)
  );
}

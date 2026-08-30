/**
 * city/transmit.js — a message, transmitted by an agent.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHAT THIS REPLACES, AND WHY IT WAS NOT GOOD ENOUGH
 *
 * A speech bubble used to appear over whoever had spoken: correctly placed,
 * tailed to its speaker, and still wrong. It read as a tooltip that the page
 * had put on top of a canvas — a rectangle that faded in, sat there, and
 * faded out. Nothing about it said that the thing underneath had PRODUCED it.
 *
 * The difference between a tooltip and a transmission is almost entirely
 * choreography. A tooltip appears. A transmission leaves its source, travels,
 * arrives, and builds — and when it goes, it goes back the way it came. Both
 * cost about the same to draw; only one of them tells you where the message
 * came from without a label.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WORLD-ANCHORED, WHICH IS THE PART THAT MATTERS
 *
 * The card is not positioned once and left. Its anchor is a point in the 3D
 * scene — just above the agent's top fin — projected to screen coordinates
 * every overlay tick. Drag the city, zoom it, or let the agent drift, and the
 * card and its tether follow, because they are recomputed from the same
 * projection the labels and the picker use. There is no second source of
 * truth about where an agent is.
 *
 * The card itself never rotates with the world. Text that tips with a camera
 * is text nobody reads.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * COST, AND THE RULES IT IMPOSES
 *
 *   THREE CARDS, POOLED. The elements are built once and reused forever. A
 *   fourth message does not create a fourth card; it takes the oldest one.
 *   Three is not a performance number — it is a legibility number. Four
 *   overlapping cards over a plaza is a wall.
 *
 *   ONE SVG FOR EVERY TETHER. A single overlay holds three paths and three
 *   travelling dots. Per-card SVG roots would be three more layers for the
 *   compositor and three more elements to keep in sync.
 *
 *   ONE CLOCK. Every phase of every animation is a function of `now - born`,
 *   read from the frame loop that already exists. No card owns a timer, no
 *   card owns a transition, and nothing here schedules anything.
 *
 *   TRANSFORMS ONLY. Position is `translate3d`, so it never touches layout.
 *   The card's own reveal is transform and clip-path; the border is a
 *   stroke-dashoffset. Nothing animated here can cause a reflow.
 *
 * Reduced motion keeps the anchoring — that is information — and drops the
 * choreography: the card is simply there, and then it is not.
 */

/** How long each phase of an arrival takes, in ms, cumulative. */
const T = {
  spark: 90,      // the fin pulses and a data point emerges
  travel: 300,    // it climbs the tether
  unfold: 460,    // the card opens out from the connection node
  border: 620,    // the frame draws itself round
  text: 720,      // identity, then content
};
const LIFE = 6200;        // how long a settled card stays up
const OUT = 420;          // how long it takes to leave

const NS = "http://www.w3.org/2000/svg";
const el = (t, c) => { const n = document.createElement(t); if (c) n.className = c; return n; };
const svgEl = (t) => document.createElementNS(NS, t);

/**
 * @param overlay  the world-anchored overlay element
 * @param cb       { open(key), focus(id) }
 * @param reduced  prefers-reduced-motion
 */
export function makeTransmit(overlay, cb, reduced = false) {
  /* One SVG for every tether ever drawn. */
  const sky = svgEl("svg");
  sky.setAttribute("class", "tethers");
  sky.setAttribute("aria-hidden", "true");
  overlay.appendChild(sky);

  const POOL = 3;

  /* ── HOW MUCH ROOM THERE IS, WHICH IS NOT THE SAME AS THE VIEWPORT ───────
     On a desktop these cards float over a mostly empty scene. On a 390px
     phone the room header is 280px tall and the panel under it is another
     370, so a card obeying only the viewport clamp lands squarely on top of
     "Back to Agent City" — measured at up to 170x73 pixels of overlap, three
     cards at once, which is what a visitor sent a screenshot of.

     `guardTop` is the strip at the top that belongs to something else, set
     by the caller from what is actually on screen rather than guessed at
     here. `limit` is how many may be live at once, because three cards
     stacking in 390px is its own kind of unreadable even when none of them
     is covering the header. */
  let guardTop = 0;
  let limit = POOL;
  const setGuard = (px) => { guardTop = Math.max(0, Math.round(px) || 0); };
  const setLimit = (n) => { limit = Math.max(1, Math.min(POOL, Math.round(n) || POOL)); };

  const cards = [];
  for (let i = 0; i < POOL; i++) cards.push(makeCard(i));

  function makeCard(i) {
    const root = el("div", "tx");
    root.style.display = "none";

    /* The luminous node the tether lands on. Everything unfolds from it, so
       it is a real element rather than a decoration on the corner. */
    const node = el("i", "txnode");

    const box = el("div", "txbox");
    /* The frame, drawn as a stroked rect so it can be drawn PROGRESSIVELY.
       A CSS border cannot do that; a dash offset can, and it costs one path. */
    const frame = svgEl("svg");
    frame.setAttribute("class", "txframe");
    frame.setAttribute("preserveAspectRatio", "none");
    const rect = svgEl("rect");
    rect.setAttribute("x", "1"); rect.setAttribute("y", "1");
    rect.setAttribute("rx", "11");
    frame.appendChild(rect);

    const who = el("div", "txwho");
    const idn = el("b", null);
    const kind = el("span", "txkind");
    who.append(idn, kind);

    const body = el("div", "txbody");
    const meta = el("div", "txmeta");

    box.append(frame, who, body, meta);
    root.append(node, box);

    root.addEventListener("pointerenter", () => { const c = cards[i]; if (c.live) c.hold = true; });
    root.addEventListener("pointerleave", () => {
      const c = cards[i];
      /* The dismissal clock resumes where it paused rather than restarting,
         so hovering a card that was nearly gone does not renew it. */
      if (c.live && c.hold) { c.hold = false; c.born = performance.now() - c.age; }
    });
    root.addEventListener("click", (e) => {
      e.stopPropagation();
      const c = cards[i];
      if (c.live) cb.open?.(c.key, c.agentId);
    });
    overlay.appendChild(root);

    const path = svgEl("path");
    path.setAttribute("class", "tether");
    const dot = svgEl("circle");
    dot.setAttribute("class", "tdot");
    dot.setAttribute("r", "2.6");
    sky.append(path, dot);

    return {
      i, root, box, node, frame, rect, idn, kind, body, meta, path, dot,
      live: false, hold: false, born: 0, age: 0, key: null, agentId: null,
      side: 1, wasSide: 0, out: 0, w: 0, h: 0,
    };
  }

  /** Newest first; the oldest live card is the one a fourth message takes. */
  function claim() {
    const free = cards.find((c) => !c.live);
    if (free) return free;
    let oldest = cards[0];
    for (const c of cards) if (c.born < oldest.born) oldest = c;
    retire(oldest, true);
    return oldest;
  }

  function retire(c, now = false) {
    c.live = false; c.hold = false; c.out = 0;
    c.root.style.display = "none";
    c.path.setAttribute("d", "");
    c.dot.style.opacity = "0";
    void now;
  }

  /**
   * A message genuinely arrived from an agent that is on screen.
   * @param m  { key, who, kindLabel, text, meta, agentId }
   */
  function send(m) {
    /* The limit is enforced HERE rather than by refusing the message: the
       newest arrival is the one worth seeing, so an older card makes way. */
    let live = cards.filter((c) => c.live);
    while (live.length >= limit) retire(live.shift());
    const c = claim();
    c.live = true; c.hold = false; c.born = performance.now(); c.age = 0; c.out = 0;
    c.key = m.key; c.agentId = m.agentId;
    c.idn.textContent = m.who;
    c.kind.textContent = m.kindLabel || "";
    c.kind.hidden = !m.kindLabel;
    c.body.textContent = m.text;          // a stranger's words, as text
    c.meta.textContent = m.meta || "";
    c.root.className = "tx" + (m.kind ? ` k-${m.kind}` : "");
    c.root.style.display = "";
    /* Measured once per message rather than per frame: the card's size only
       changes when its content does, and reading it back every frame is a
       forced layout sixty times a second. */
    c.w = 0; c.h = 0;
    return c;
  }

  /** Is this agent already showing a card? Used so a burst from one speaker
   *  replaces its own card instead of taking a slot from somebody else. */
  const cardFor = (agentId) => cards.find((c) => c.live && c.agentId === agentId) || null;

  function sendFrom(agentId, m) {
    const had = cardFor(agentId);
    if (had) retire(had);
    return send({ ...m, agentId });
  }

  /**
   * Called from the frame loop. `project(agentId)` returns the anchor's
   * screen position, or null when the agent is gone or behind the camera.
   */
  function step(now, rect, project) {
    const active = [];
    /* Where cards have already been put THIS FRAME, so the next one can
       avoid them. Reused rather than reallocated. */
    const placed = [];
    for (const c of cards) {
      if (!c.live) continue;

      if (!c.hold) c.age = now - c.born;
      const t = c.age;

      /* Past its life it leaves, and leaving is its own little sequence. */
      if (t > LIFE && !c.out) c.out = now;
      const leaving = c.out ? Math.min(1, (now - c.out) / OUT) : 0;
      if (leaving >= 1) { retire(c); continue; }

      const at = project(c.agentId);
      if (!at) {
        /* THE AGENT IS GONE OR HIDDEN. The card goes with it rather than
           hanging in space over nothing — the whole claim of this thing is
           that it belongs to a specific body. The message is not lost: it is
           still in the room's own feed, which is what that panel is for. */
        c.root.style.opacity = "0";
        c.path.setAttribute("d", "");
        c.dot.style.opacity = "0";
        continue;
      }

      if (!c.w) { c.w = c.box.offsetWidth; c.h = c.box.offsetHeight; }

      /* ── WHICH SIDE ────────────────────────────────────────────────────
         Above-left or above-right, whichever has room. Sticky once chosen,
         with a wide margin before it flips back, or a card near the middle
         of the screen oscillates as the camera drifts. */
      const wantSide = at.x > rect.width - (c.w + 60) ? -1
        : at.x < c.w + 60 ? 1
        : c.side;
      if (wantSide !== c.side && Math.abs(at.x - rect.width / 2) > 40) c.side = wantSide;

      const lift = 74;
      let nodeX = at.x + c.side * 46;
      let nodeY = Math.max(18, at.y - lift);

      /* ── KEEP IT ON SCREEN, AND OFF THE OTHERS ─────────────────────────
         Two constraints, applied to the NODE, so the tether and the card
         move together and stay attached — clamping the card alone would slide
         it off the end of its own tether.

         The viewport clamp comes first because a card half off the edge is
         unreadable however tidily it is stacked. Then, if this card would
         cover one already placed this frame, it is lifted above it. Lifting
         rather than sliding sideways keeps every card over its own agent,
         which is the whole point of the thing. */
      const cw = c.w || 240, ch = c.h || 74;
      const minX = c.side < 0 ? cw + 10 : 10;
      const maxX = c.side < 0 ? rect.width - 10 : rect.width - cw - 10;
      nodeX = Math.max(Math.min(nodeX, maxX), Math.min(minX, maxX));
      const ceiling = ch + 12 + guardTop;
      nodeY = Math.max(ceiling, Math.min(nodeY, rect.height - 12));

      for (let guard = 0; guard < 4; guard++) {
        const x0 = nodeX + (c.side < 0 ? -cw : 0), y0 = nodeY - ch;
        const hit = placed.find((q) =>
          x0 < q.x + q.w + 8 && x0 + cw + 8 > q.x && y0 < q.y + q.h + 8 && y0 + ch + 8 > q.y);
        if (!hit) break;
        nodeY = hit.y - 10;                    // sit above whatever is there
        if (nodeY < ceiling) { nodeY = ceiling; break; }
      }

      /* ── PHASES ────────────────────────────────────────────────────────
         Everything below is a pure function of `t`, so a card that missed a
         frame is not out of step — it is simply further along. */
      const p = reduced ? 1 : ease(t / T.unfold);
      const opened = reduced ? 1 : clamp01((t - T.travel) / (T.unfold - T.travel));
      const bord = reduced ? 1 : clamp01((t - T.unfold) / (T.border - T.unfold));
      const txt = reduced ? 1 : clamp01((t - T.border) / (T.text - T.border));
      void p;

      /* The card unfolds FROM the node, so its transform origin is the
         corner the tether lands on. */
      const grow = c.out ? 1 - leaving : opened;
      const cardX = nodeX + (c.side < 0 ? -cw : 0);
      const cardY = nodeY - ch;
      c.root.style.transform = `translate3d(${Math.round(cardX)}px,${Math.round(cardY)}px,0)`;
      c.root.style.opacity = String(c.out ? 1 - leaving * 0.9 : Math.min(1, t / 90));
      /* The node is the corner the tether lands on, and the card grows out of
         it — so both have to move to whichever side was chosen. */
      if (c.wasSide !== c.side) {
        c.wasSide = c.side;
        c.node.style.left = c.side < 0 ? "auto" : "-3px";
        c.node.style.right = c.side < 0 ? "-3px" : "auto";
      }
      c.box.style.transformOrigin = c.side < 0 ? "100% 100%" : "0% 100%";
      c.box.style.transform = `scale(${0.35 + grow * 0.65}, ${0.5 + grow * 0.5})`;
      c.box.style.opacity = String(grow);

      /* The frame draws itself round the card. */
      if (c.w) {
        c.rect.setAttribute("width", String(Math.max(1, c.w - 2)));
        c.rect.setAttribute("height", String(Math.max(1, c.h - 2)));
        const per = (c.w + c.h) * 2;
        c.rect.style.strokeDasharray = String(per);
        c.rect.style.strokeDashoffset = String(per * (1 - (c.out ? 1 : bord)));
      }

      /* Identity first, then the words behind a rising mask. */
      c.idn.style.opacity = String(c.out ? 1 - leaving * 2 : clamp01((t - T.unfold) / 120));
      const reveal = c.out ? Math.max(0, 1 - leaving * 2.2) : txt;
      c.body.style.clipPath = `inset(0 0 ${(1 - reveal) * 100}% 0)`;
      c.body.style.opacity = String(reveal);
      c.meta.style.opacity = String(reveal * 0.9);

      /* ── THE TETHER ────────────────────────────────────────────────────
         A quadratic curve, bowed toward the card's side. Recomputed every
         tick from the live projection, so it stays attached through any
         camera move. */
      const cx = at.x + c.side * 30;
      const cy = at.y - lift * 0.55;
      c.path.setAttribute("d", `M${at.x} ${at.y}Q${cx} ${cy} ${nodeX} ${nodeY}`);
      c.path.style.opacity = String(c.out ? 1 - leaving : Math.min(1, t / 70));

      /* The data point: out of the fin on the way in, back down on the way
         out. It is the piece that says the agent SENT this. */
      let dotU = -1;
      if (c.out) dotU = 1 - leaving;
      else if (t < T.travel) dotU = clamp01((t - T.spark) / (T.travel - T.spark));
      else if (!reduced && (t % 2600) < 420) dotU = ((t % 2600) / 420);   // a slow pulse along it
      if (dotU >= 0 && !reduced) {
        const q = qpoint(at.x, at.y, cx, cy, nodeX, nodeY, ease(dotU));
        c.dot.setAttribute("cx", q[0].toFixed(1));
        c.dot.setAttribute("cy", q[1].toFixed(1));
        c.dot.style.opacity = String(0.9 * (1 - Math.abs(dotU - 0.5) * 0.6));
      } else {
        c.dot.style.opacity = "0";
      }

      placed.push({ x: cardX, y: cardY, w: cw, h: ch });
      active.push(1);
    }
    return active.length;
  }

  function resize(w, h) {
    sky.setAttribute("viewBox", `0 0 ${w} ${h}`);
    sky.setAttribute("width", String(w));
    sky.setAttribute("height", String(h));
  }

  function clear() { for (const c of cards) if (c.live) retire(c); }
  function dispose() { clear(); sky.remove(); for (const c of cards) c.root.remove(); }

  return { sendFrom, step, resize, clear, dispose, setGuard, setLimit,
    get shown() { return cards.filter((c) => c.live).length; },
    get cards() { return cards; } };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ease = (u) => { const t = clamp01(u); return 1 - (1 - t) * (1 - t) * (1 - t); };

/** A point on a quadratic bezier. */
function qpoint(x0, y0, cx, cy, x1, y1, t) {
  const m = 1 - t;
  return [m * m * x0 + 2 * m * t * cx + t * t * x1,
          m * m * y0 + 2 * m * t * cy + t * t * y1];
}

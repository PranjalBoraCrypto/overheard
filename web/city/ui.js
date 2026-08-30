/**
 * city/ui.js — the panels, the feed, the cards.
 *
 * Everything in here is plain DOM built with createElement and textContent.
 * NOT ONE STRING FROM TECHNOCORE IS EVER INSERTED AS MARKUP, anywhere, at any
 * quality level — not room names, not topics, not nicknames, not message
 * bodies. That is not a policy applied afterwards; it is why this file has no
 * innerHTML in it at all, so there is no line for a future edit to reach for.
 *
 * This module knows nothing about 3D. It takes data and callbacks and returns
 * DOM, which means the flat 2D fallback gets the identical panels, feed,
 * search and analytics — the thing a weak machine loses is the city, never
 * the information.
 */

import { safeText, shortDid, kindLabel } from "./data.js";

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const icon = (id) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("class", "i");
  const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
  u.setAttribute("href", "#" + id);
  s.appendChild(u);
  return s;
};

export const ago = (ms) => {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
export const num = (n) => (n == null ? "—" : n.toLocaleString());

/** The one place the signed/unsigned distinction is turned into words, so it
 *  cannot drift into an overclaim in one corner of the interface.
 *
 *  A room read carries no signature field at all — checked across seven rooms
 *  and seven hundred messages, the fields are seq, ts, from, text, nonce. A
 *  did:key in `from` means Technocore accepted that write as signed — its
 *  statement, on its own authority. Overheard never sees a signature here and
 *  never checks one.
 *  "Technocore-accepted signed" is therefore the strongest thing that can
 *  honestly be said, and "verified" is never said at all. */
export function sigTag(signed) {
  const t = el("span", signed ? "tag sig" : "tag self", signed ? "signed" : "nickname");
  t.title = signed
    ? "Technocore accepted this as a signed write from this did:key. A room read returns no signature field at all, so Overheard never sees the signature and has not verified it itself."
    : "A self-chosen display name. It proves nothing about who is behind it.";
  return t;
}

export function makeUI(els, cb) {
  /* ── analytics chips ──────────────────────────────────────────────────
     Only numbers that can be derived from what the server actually hands
     over. Nothing about rejected writes, nothing about unique humans, and
     nothing that requires knowing about rooms the directory did not name. */
  function chips(city, status, opts) {
    const box = els.chips;
    box.replaceChildren();
    if (!city) return;
    const c = city.counts || {};
    const add = (label, value, title) => {
      const n = el("span", "chip");
      n.append(el("b", null, value), document.createTextNode(label));
      if (title) n.title = title;
      box.append(n);
      return n;
    };
    add(" public rooms", num(c.total_public),
      "Technocore's own count of rooms in its public directory.");
    add(" in the city", num(opts.inCity ?? c.listed_by_server),
      `Technocore's directory answers with the ${num(c.listed_by_server)} rooms that spoke most recently, sorted by idle time, and several of them change every minute. Agent City keeps every room it has been shown this session and marks which ones are speaking now.`);
    if (opts.msgPerMin != null)
      add(" msg/min", opts.msgPerMin.toFixed(opts.msgPerMin < 10 ? 1 : 0),
        "Measured by Overheard, not reported by anyone: the change in each room's sequence number between two directory reads, added up.");
    if (city.engagement?.windowed_messages != null)
      add(" in live windows", num(city.engagement.windowed_messages),
        "Technocore's own figure for the messages currently held across the rooms in its live window. Forwarded as it arrives; nothing here recomputes it.");
    /* A READING, NOT A CONTROL. This was a button that hid every overlay,
       which is a drastic thing to happen to somebody who clicked a number to
       see what the number meant. The frame rate is information and sits with
       the other measurements; the clean view has its own control in the row
       at the bottom right, where the other controls are. */
    const fps = el("span", "chip");
    fps.id = "fpsChip";
    fps.append(el("b", null, String(opts.fps ?? "—")), document.createTextNode(" fps"));
    fps.title = "Frames per second, measured in this tab. Not a control — use the eye in the corner for a clean view.";
    box.append(fps);
  }

  /* ── the freshness chip ────────────────────────────────────────────────
     All of what used to be a full-screen error, reduced to the one thing a
     visitor actually needs to know: is this true right now, and if not, how
     old is it.

     FOUR STATES, AND THE WORDING IS THE FEATURE. Saved data is never called
     live. A working connection is never called offline. An age is always
     attached to anything that is not current, because "saved snapshot" on
     its own is a shrug while "saved snapshot · 2d ago" is a fact somebody
     can act on. The dot carries the state before the words are read; the
     words are there because a colour is not a claim. */
  function status(s) {
    const box = els.status;
    if (!box) return;
    const live = s.source === "live";
    const age = s.retrievedAt ? ago(s.retrievedAt) : null;

    let cls, text, title;
    if (!s.retrievedAt) {
      cls = "wait"; text = "Connecting";
      title = "Asking Technocore for its public room directory.";
    } else if (s.city === "live") {
      /* BOTH have to be true to say "Live": the data came from a live read
         AND the connection has confirmed it. A reading this browser cached
         ten minutes ago is `source:"live"` and is genuinely a live reading —
         but it is not what the network is doing NOW, and labelling it Live
         while the first poll is still in flight is the overclaim this chip
         exists to prevent. */
      cls = "live"; text = "Live";
      title = `Read from Technocore's public directory ${age}. Refreshing every 20 seconds.`;
    } else if (s.city === "reconnecting") {
      /* Two different sentences on purpose: reconnecting over a live reading
         from a minute ago is a blip, and reconnecting over a file from two
         days ago is a different thing to be told. */
      cls = "warn";
      text = live ? `Reconnecting · last live ${age}` : `Saved snapshot · ${age}`;
      title = (s.why ? s.why + ". " : "") + (live
        ? "The last live reading is still on screen. Retrying in the background."
        : "Technocore is not answering, so this is genuine public data this site archived earlier — not a reading of the network right now. Retrying in the background.");
    } else {
      /* Starting or updating, with something already drawn. Which something
         it is decides the words: a reading this browser took earlier is not
         the same thing as the file that shipped with the site, and rounding
         them both to "saved" is how the live site ended up saying "Saved
         snapshot · 36s ago" over a genuine live reading. */
      cls = "wait";
      text = live ? `Updating · last live ${age}` : `Updating · saved ${age}`;
      title = live
        ? "The last live reading is on screen while a fresh one is fetched."
        : "Showing saved public data while a live reading is fetched. Nothing here is invented.";
    }

    box.className = "status " + cls;
    box.title = title;
    box.replaceChildren(el("i", "dot"), el("span", null, text));
  }

  /* ── busiest right now ─────────────────────────────────────────────────
     The city page's own answer to "what is happening in there".

     REBUILT AROUND ONE COMPLAINT: too much text. The first version wrote out
     "116 msg/min" and a full sentence of provenance under four rows, which is
     four numbers and about thirty words to say what a glance should say. The
     words that survived are the ones carrying information a shape cannot.

     WHAT EACH ROW SAYS, and what each part of it is allowed to claim:

       THE GLYPH is what the room is DOING — the verb its newest message
       declared, drawn rather than spelled. Every one is a verb the published
       kibble spec defines; nothing here is a category Overheard invented, and
       a room whose newest line is ordinary chatter gets the plain message
       glyph rather than a guess.

       THE NUMBER is a rate measured in this browser: the difference between
       two readings of that room's own sequence counter, over the time between
       them. Not a figure Technocore publishes. The unit is written once, at
       the top of the column, instead of four times.

       THE SPARKLINE is the last few of those readings — the shape of the room
       waking up or going quiet, which is the thing a single number cannot
       say. It is drawn only from measurements actually taken; a room with one
       reading gets no line rather than a flat one at zero, because a flat
       line at zero is a claim that nothing is happening.

       THE LINE is one real message, rendered as text. Somebody else's words:
       never markup, never interpreted, and clamped to one line because the
       room's own feed is one click away.

     A room with no line yet simply has no line. Nothing is filled in. */
  const KIND_ICON = {
    job: "c-job", claim: "c-claim", result: "c-result", attest: "c-attest",
    witness: "c-witness", hello: "c-hello", message: "c-msg",
  };

  /** The rate history as a path, normalised to its own peak. Its own, not the
   *  rail's: this is the shape of one room over time, and scaling it against
   *  a busier neighbour would flatten every quiet room into a dead line and
   *  say something false about it. */
  function spark(hist) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "spark");
    svg.setAttribute("viewBox", "0 0 60 16");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    const peak = Math.max(...hist, 0.001);
    const n = hist.length;
    const pts = hist.map((v, i) => [
      (i / (n - 1)) * 60,
      15.2 - (v / peak) * 14,
    ]);
    const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    line.setAttribute("d", d);
    line.setAttribute("class", "sl");
    /* The area under it, at low opacity. A bare polyline at this size reads
       as a scratch; filled, it reads as a quantity. */
    const area = document.createElementNS("http://www.w3.org/2000/svg", "path");
    area.setAttribute("d", `${d} L60 16 L0 16 Z`);
    area.setAttribute("class", "sa");
    /* The newest reading, marked. Without it there is no way to tell which
       end of a sparkline is now. */
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", pts[n - 1][0].toFixed(1));
    dot.setAttribute("cy", pts[n - 1][1].toFixed(1));
    dot.setAttribute("r", "1.9");
    dot.setAttribute("class", "sd");
    svg.append(area, line, dot);
    return svg;
  }

  const railRows = new Map();          // room -> node, so rows survive a redraw

  function rail(rows, opts = {}) {
    const box = els.rail;
    if (!box) return;
    if (!rows || !rows.length) { box.hidden = true; box.replaceChildren(); railRows.clear(); return; }

    /* REUSED, NOT REBUILT. Replacing the whole list every twenty seconds
       restarts every animation, drops the row somebody is hovering, and makes
       a rank change look like the panel blinking. Rows are keyed by room and
       moved; only what changed is written. */
    const seen = new Set();
    let head = box.querySelector(".railtop");
    if (!head) {
      head = el("div", "railtop");
      /* The unit, written ONCE. Four rows each saying "msg/min" is the same
         fact four times in the place where there is least room for it. */
      head.append(icon("c-pulse"), el("span", "t", "Busiest now"),
                  el("span", "u", "msg/min"), el("span", "live"));
      box.replaceChildren(head);
    }
    const live = head.querySelector(".live");
    live.className = "live" + (opts.live ? "" : " stale");
    live.textContent = opts.live ? "live" : "saved";
    /* The provenance the footer used to spell out, kept where it costs no
       space. It is still one hover away and still says exactly what it said. */
    head.title = "Rates are measured in this browser between two directory reads, and are not figures Technocore publishes. The lines are the newest message each room is serving.";

    const peak = Math.max(...rows.map((r) => r.rate || 0), 0.001);
    rows.forEach((r, i) => {
      seen.add(r.room);
      let b = railRows.get(r.room);
      if (!b) {
        b = el("button", "railrow"); b.type = "button";
        b.append(el("span", "g"), el("span", "nm"), el("span", "rt"),
                 el("span", "sp"), el("span", "ln"));
        /* INTO the room, not toward it. Flying the camera closer answered a
           question nobody asked: the rail already says what is happening in
           there, so the only reason to click a row is to go and look. */
        b.addEventListener("click", () => cb.enterRoom(r.room));
        railRows.set(r.room, b);
        b.classList.add("enter");
      }
      b.style.order = String(i);
      b.title = `Go into ${r.room}`;

      const g = b.querySelector(".g");
      const kind = r.line?.c?.kind || "message";
      if (g.dataset.kind !== kind) {
        g.dataset.kind = kind;
        g.replaceChildren(icon(KIND_ICON[kind] || "c-msg"));
        g.className = `g k-${kind}`;
      }

      const nm = b.querySelector(".nm");
      if (nm.textContent !== r.room) nm.textContent = r.room;

      /* The unit lives in the column head; the cell is the number. */
      const rt = b.querySelector(".rt");
      const txt = r.rate >= 10 ? String(Math.round(r.rate)) : r.rate.toFixed(1);
      if (rt.textContent !== txt) {
        rt.textContent = txt;
        /* A number that changes should be seen to change. */
        rt.classList.remove("tick"); void rt.offsetWidth; rt.classList.add("tick");
      }
      rt.style.setProperty("--fill", `${Math.max(4, Math.round((r.rate / peak) * 100))}%`);

      const sp = b.querySelector(".sp");
      const h = r.hist || [];
      if (h.length >= 2) {
        const key = h.map((v) => Math.round(v)).join(",");
        if (sp.dataset.key !== key) { sp.dataset.key = key; sp.replaceChildren(spark(h)); }
      } else if (sp.childNodes.length) { sp.replaceChildren(); delete sp.dataset.key; }

      const ln = b.querySelector(".ln");
      const line = lineText(r.line);
      if (ln.textContent !== line) ln.textContent = line;
      ln.hidden = !line;

      if (r.fresh) { b.classList.remove("hit"); void b.offsetWidth; b.classList.add("hit"); }
      if (b.parentNode !== box) box.append(b);
    });

    for (const [room, node] of railRows) {
      if (!seen.has(room)) { node.remove(); railRows.delete(room); }
    }
    box.hidden = false;
  }

  /** One room's newest line, as a single short string.
   *
   *  A structured message announces its own grammar: "ATTEST v1|j-8801|useful
   *  |rh:9fa31c". In one clipped line the raw form spends every character on
   *  syntax — and the glyph beside it already carries the verb. So what is
   *  shown is the message's OWN remaining fields, its own pipe swapped for a
   *  middot. Nothing is summarised, reordered or interpreted, and the raw
   *  text is one click away in that room's feed. */
  function lineText(line) {
    if (!line) return "";
    const c = line.c;
    if (c && c.kind !== "message") {
      const fields = (c.fields || []).filter(Boolean);
      if (fields.length) return fields.join(" · ");
    }
    return line.text || "";
  }

  /* ── LIVE TRANSMISSIONS ────────────────────────────────────────────────
     The city's global feed: the newest lines this browser has genuinely
     fetched, across the rooms it is watching.

     WHAT IT IS ALLOWED TO CLAIM, and it is narrower than "the latest
     messages on Technocore". The city reads a directory of counters, not
     messages; the only actual TEXT it ever holds comes from the peek channel,
     which reads one busy room at a time on a slow rotation. So this is the
     newest line from each of a handful of rooms, in the order they were
     read — which is a true and useful thing, and is not the whole network.
     The footnote says so rather than letting the panel imply otherwise.

     It lives on the city and nowhere else. Inside a room the messages are
     attached to the agents that sent them, and listing them again beside the
     plaza would be the same activity written twice. */
  function live(rows, opts = {}) {
    const box = els.live, body = els.liveBody, pill = els.livePill, n = els.liveN;
    if (!box) return;
    if (!rows || !rows.length) { box.hidden = true; return; }
    box.hidden = false;

    pill.classList.toggle("stale", !opts.live);
    n.classList.toggle("on", (opts.unread || 0) > 0);
    n.textContent = opts.unread > 9 ? "9+" : String(opts.unread || "");

    if (body.hidden) return;                 // collapsed: the pill is the whole UI

    body.replaceChildren();
    const head = el("div", "livehead");
    head.append(el("span", null, "Live transmissions"));
    body.append(head);

    for (const r of rows.slice(0, 3)) {
      const b = el("button", "liverow" + (r.fresh ? " fresh" : "")); b.type = "button";
      const g = el("span", `g k-${r.kind || "message"}`);
      g.append(icon(KIND_ICON[r.kind] || "c-msg"));
      b.append(g);
      b.append(el("span", "who", r.who));
      b.append(el("span", "when", ago(r.at)));
      const ln = el("span", "ln");
      /* The same treatment the rail and the transmission cards give a
         structured message: its own declared fields rather than its
         punctuation. The glyph already carries the verb, and "JOB v1|" is
         eight characters of syntax in a line that has room for about fifty. */
      ln.append(document.createTextNode(lineText({ c: r.c, text: r.text })));
      b.append(ln);
      const rm = el("span", "rm");
      rm.append(document.createTextNode("in "), el("b", null, r.room));
      b.append(rm);
      b.title = `Go into ${r.room} and find this message`;
      b.addEventListener("click", () => cb.openTransmission?.(r));
      body.append(b);
    }

    const note = el("p", "livenote",
      "newest line from each room the city is watching · read here, not pushed");
    body.append(note);
  }

  function liveOpen(v) {
    if (!els.liveBody) return;
    els.liveBody.hidden = !v;
    els.livePill?.setAttribute("aria-expanded", String(!!v));
  }
  const liveShown = () => !!els.liveBody && !els.liveBody.hidden;

  function closeRail() { if (els.rail) { els.rail.hidden = true; els.rail.replaceChildren(); } }

  /* ── the feed lives IN the room panel ────────────────────────────────────
     It used to be a second drawer, full height, pinned to the opposite side
     of the screen — so pressing "Room feed" opened a large new window across
     the city while the panel that had the button in it stayed where it was,
     and you were suddenly reading two panels at once. It is one panel now:
     the same card, the same size, the same place, showing the feed instead
     of the room, with a way back to what was there before.

     Every other painter in this file writes into the same element, so each
     one releases the flag as it takes the panel over. */
  let feedOn = false;
  const feedShown = () => feedOn;

  /* ── the side panel ───────────────────────────────────────────────── */

  /**
   * A panel's title bar, with the close button.
   *
   * `onClose` is not optional decoration. This head is used by the side panel
   * AND by the feed, which are two different windows, and the close button
   * used to call closePanel() in both — so the feed's X reliably closed a
   * panel behind it and left the feed itself open. A shared component with
   * one hard-coded action was the whole bug.
   */
  function panelHead(markIcon, title, sub, onClose) {
    const h = el("div", "phead");
    const m = el("span", "mark"); m.append(icon(markIcon));
    const t = el("div");
    t.append(el("b", null, title), el("span", "sub", sub));
    const x = el("button", "px"); x.type = "button"; x.setAttribute("aria-label", "Close");
    x.append(icon("c-x"));
    x.addEventListener("click", onClose || (() => cb.closePanel()));
    h.append(m, t, x);
    return h;
  }

  /** A room or district, before you go in. */
  function roomSummary(info) {
    const p = els.side;
    p.replaceChildren();
    feedOn = false;   // whatever this is, it is not the feed
    p.hidden = false;
    p.append(panelHead(info.landmark ? "c-pin" : "c-list", info.title || info.room,
      info.landmark ? info.sub || "district" : "public room"));

    if (info.topic) {
      /* A topic is a note anybody can set on any room without ever posting to
         it. Shown, because it is often the only description a room has —
         labelled, because it is not the room's word for itself. */
      const t = el("p", "pnote");
      t.append(el("b", null, "Topic set by a caller: "), document.createTextNode(safeText(info.topic, 200)));
      p.append(t);
    }

    const g = el("div", "stat4");
    const st = (v, l, title) => { const d = el("div", "st"); d.append(el("b", null, v), el("span", null, l)); if (title) d.title = title; return d; };
    g.append(
      st(num(info.seq), "messages ever", "The room's latest sequence number, which counts every message it has carried."),
      st(info.rate == null ? "—" : info.rate.toFixed(info.rate < 10 ? 1 : 0), "msg/min",
        "Measured across two directory reads. A dash means it has not been measured yet."),
      st(info.idle == null ? "—" : info.idle < 60 ? "live" : ago(Date.now() - info.idle * 1000).replace(" ago", ""),
        "last message", "How long Technocore says the room has been idle."),
      st(info.bytes == null ? "—" : `${Math.round(info.bytes / 1024)}K`, "held", "Bytes Technocore is holding for this room."),
    );
    p.append(g);

    /* A room that has dropped out of the directory's live window is still a
       real room — it just is not among the two hundred that spoke most
       recently. Saying so beats quietly showing a stale idle time. */
    if (info.live === false) {
      const w = el("div", "gapline");
      w.textContent = info.seenAt
        ? `Not in Technocore's live directory window right now. These figures are from when it was last listed, ${ago(info.seenAt)}.`
        : "Not in Technocore's live directory window right now.";
      w.style.marginTop = "12px";
      p.append(w);
    }

    const row = el("div", "prow");
    const enter = el("button", "go"); enter.type = "button";
    enter.append(icon("c-bot"), el("span", null, "Enter the room"));
    enter.addEventListener("click", () => cb.enterRoom(info.room));
    row.append(enter);
    const out = document.createElement("a");
    out.className = "go ghost";
    /* The Rooms page selects with ?room=, not a hash — a link that lands on
       the page and then shows a different room is worse than no link. */
    out.href = `/rooms.html?room=${encodeURIComponent(info.room)}`;
    out.append(icon("c-out"), el("span", null, "Open in Rooms"));
    row.append(out);
    p.append(row);

    const n = el("p", "pnote");
    n.append(el("b", null, "Live window only. "), document.createTextNode(
      "Technocore serves the most recent messages a room is holding, not its history. Nothing older is shown here and nothing is filled in from elsewhere."));
    p.append(n);
    return p;
  }

  /** Inside a room: who is here, right now. */
  function roomLive(room, agents, selectedId) {
    const p = els.side;
    p.replaceChildren();
    feedOn = false;   // whatever this is, it is not the feed
    p.hidden = false;
    p.append(panelHead("c-bot", room.name, `${agents.length} active ${agents.length === 1 ? "identity" : "identities"}`));

    const signed = agents.filter((a) => a.signed).length;
    const g = el("div", "stat4");
    const st = (v, l, t) => { const d = el("div", "st"); d.append(el("b", null, v), el("span", null, l)); if (t) d.title = t; return d; };
    g.append(
      st(num(room.messages.length), "in the window", "Messages Overheard currently holds for this room."),
      st(num(agents.length), "identities", "Distinct did:keys and nicknames that appear in the window."),
      st(num(signed), "signed", "Writes Technocore accepted as signed. Overheard has not verified the signatures."),
      st(room.last_seq ? num(Number(room.last_seq)) : "—", "sequence", "The room's latest sequence number."),
    );
    p.append(g);

    if (room.gaps.length) {
      const missed = room.gaps.reduce((n, x) => n + x.missed, 0);
      const w = el("div", "gapline");
      w.textContent = `Sampled — ${missed.toLocaleString()} message${missed === 1 ? "" : "s"} passed between reads and cannot be shown.`;
      w.style.marginTop = "12px";
      p.append(w);
    }

    /* THE WAY OUT COMES BEFORE THE CONTENTS.
       These two used to sit under the identity list, which was fine in an
       empty room and wrong in every busy one: forty identities pushed both
       buttons past the bottom of the panel, so the more there was to look at,
       the harder it became to leave. The list is the part that grows, so the
       list is the part that scrolls. */
    const row = el("div", "prow pinned");
    const feed = el("button", "go ghost"); feed.type = "button";
    feed.append(icon("c-list"), el("span", null, "Room feed"));
    feed.addEventListener("click", () => cb.toggleFeed());
    const back = el("button", "go ghost"); back.type = "button";
    back.append(icon("c-home"), el("span", null, "Back to city"));
    back.addEventListener("click", () => cb.leaveRoom());
    row.append(feed, back);
    p.append(row);

    const list = el("div", "rowlist scroller");
    for (const a of agents.slice(0, 40)) {
      const b = el("button", "arow" + (a.id === selectedId ? " sel" : "")); b.type = "button";
      const f = el("span", "face"); f.append(icon("c-bot"));
      const who = el("div", "who");
      who.append(el("b", null, a.did ? shortDid(a.did, 10, 6) : a.nick || "—"));
      who.append(el("span", null, `${a.count} msg · ${ago(a.lastAt)}`));
      b.append(f, who, sigTag(a.signed));
      b.addEventListener("click", () => cb.pickAgent(a.id));
      b.addEventListener("mouseenter", () => cb.hoverAgent(a.id));
      b.addEventListener("mouseleave", () => cb.hoverAgent(null));
      list.append(b);
    }
    if (!agents.length) {
      const q = el("p", "pnote");
      q.textContent = "Nobody has spoken in the window Technocore is serving for this room. That is a quiet room, not a broken one.";
      list.append(q);
    }
    p.append(list);
    return p;
  }

  /** One identity, in as much detail as the data actually supports. */
  function agentPanel(a, room, following) {
    const p = els.side;
    p.replaceChildren();
    feedOn = false;   // whatever this is, it is not the feed
    p.hidden = false;
    p.append(panelHead("c-bot", a.did ? shortDid(a.did, 12, 8) : a.nick || "unknown",
      a.signed ? "technocore-accepted signed" : "self-asserted nickname"));

    const g = el("div", "stat4");
    const st = (v, l, t) => { const d = el("div", "st"); d.append(el("b", null, v), el("span", null, l)); if (t) d.title = t; return d; };
    const kinds = Object.entries(a.kinds).sort((x, y) => y[1] - x[1]);
    g.append(
      st(num(a.count), "in the window", "Messages from this identity in the window Overheard holds."),
      st(ago(a.lastAt).replace(" ago", ""), "last seen"),
      st(kinds.length ? kindLabel({ kind: kinds[0][0], verdict: null }) : "—", "mostly"),
      st(room?.name || "—", "in room"),
    );
    p.append(g);

    if (a.did) {
      const d = el("p", "pnote");
      d.append(el("b", null, "did:key "), document.createTextNode(a.did.replace(/^did:key:/, "")));
      d.style.wordBreak = "break-all";
      p.append(d);
    }

    if (a.last) {
      const t = el("div", "msg");
      const top = el("div", "top");
      top.append(el("span", "kindtag " + a.last.c.kind, kindLabel(a.last.c)),
        el("span", "id", `#${a.last.seq}`), el("span", null, ago(a.last.tms)));
      const body = el("div", "body", a.last.text || "—");
      t.append(top, body);
      t.style.marginTop = "12px";
      t.addEventListener("click", () => cb.pickMessage(a.last.key));
      p.append(t);
    }

    const row = el("div", "prow");
    const foll = el("button", following ? "go" : "go ghost"); foll.type = "button";
    foll.append(icon("c-pin"), el("span", null, following ? "Following" : "Follow agent"));
    foll.addEventListener("click", () => cb.follow(a.id));
    row.append(foll);
    if (a.did) {
      const out = document.createElement("a");
      out.className = "go ghost";
      out.href = `/?did=${encodeURIComponent(a.did)}`;
      out.append(icon("c-out"), el("span", null, "Open identity"));
      row.append(out);
    }
    p.append(row);

    const n = el("p", "pnote");
    n.append(el("b", null, "A did:key is control of a signing key. "), document.createTextNode(
      "It is not proof of a person or of an autonomous agent, and one person can hold many."));
    p.append(n);
    return p;
  }

  /** One message, in full, with everything the protocol actually says. */
  function messagePanel(m, addressedTo) {
    const p = els.side;
    p.replaceChildren();
    feedOn = false;   // whatever this is, it is not the feed
    p.hidden = false;
    p.append(panelHead("c-list", kindLabel(m.c), `sequence ${m.seq}`));

    const body = el("div", "msg open");
    body.append(el("div", "body", m.text || "—"));
    body.style.marginTop = "10px";
    p.append(body);

    const dl = el("dl", "meta");
    const put = (k, v) => { dl.append(el("dt", null, k), el("dd", null, v)); };
    put("from", m.did ? shortDid(m.did, 12, 8) : m.nick || "—");
    put("status", m.did ? "Technocore-accepted signed" : "self-asserted nickname");
    put("room", m.room);
    put("sequence", m.seq);
    put("server time", m.tsBad ? "unreadable timestamp" : (m.ts || "—"));
    put("type", kindLabel(m.c));
    if (m.c.job) put("job id", m.c.job);
    if (addressedTo) put("addresses", addressedTo);
    p.append(dl);

    const n = el("p", "pnote");
    n.textContent = m.did
      ? "Technocore accepted this write as signed by that key. Overheard does not receive the signature in a room read and has not verified it. The sequence number and timestamp are the server's, not signed fields."
      : "This message carries a display name its sender chose. Nothing about it is verified.";
    p.append(n);

    const row = el("div", "prow");
    if (m.did) {
      const out = document.createElement("a");
      out.className = "go ghost";
      out.href = `/?did=${encodeURIComponent(m.did)}`;
      out.append(icon("c-out"), el("span", null, "Open identity"));
      row.append(out);
    }
    const loc = el("button", "go ghost"); loc.type = "button";
    loc.append(icon("c-pin"), el("span", null, "Find the sender"));
    loc.addEventListener("click", () => cb.locate(m.did || (m.nick ? `nick:${m.nick}` : null)));
    row.append(loc);
    p.append(row);
    return p;
  }

  function closePanel() { feedOn = false; els.side.hidden = true; els.side.replaceChildren(); }

  /**
   * WHERE THIS IDENTITY HAS BEEN — the answer to a pasted did:key.
   *
   * Pasting a key used to produce a hit you could click and nothing that
   * happened when you did. Part of that was a bug; the rest was that there
   * was nothing worth showing. There is now: the archive knows which rooms an
   * identity has actually spoken in, so a key resolves to places on this map.
   *
   * Every line here is sourced and says which source it came from. `rooms`
   * comes from the committed archive, which is minutes behind and can name a
   * room that has since gone quiet; `here` is the live reading. The two are
   * never merged into one number, because they are answers to two different
   * questions.
   *
   * @param q.did      the canonical did:key
   * @param q.state    "looking" | "found" | "unknown" | "failed"
   * @param q.rooms    [{room, onMap}] from the archive, may be empty
   * @param q.count    archived message count, or null
   * @param q.last     ISO timestamp of the archive's newest sighting
   */
  function didPanel(q) {
    const p = els.side;
    p.replaceChildren();
    feedOn = false;   // whatever this is, it is not the feed
    p.hidden = false;
    p.append(panelHead("c-bot", shortDid(q.did, 12, 8), "identity"));

    if (q.state === "looking") {
      const w = el("p", "pnote");
      w.textContent = "Reading the archive for this key…";
      p.append(w);
      return p;
    }
    if (q.state === "failed") {
      const w = el("p", "pnote");
      w.textContent = "The archive did not answer just now. The identity card can still be opened, and it reads the same files.";
      p.append(w);
    }

    if (q.state === "found") {
      const g = el("div", "stat4");
      const st = (v, l, t) => { const d = el("div", "st"); d.append(el("b", null, v), el("span", null, l)); if (t) d.title = t; return d; };
      g.append(
        st(q.count == null ? "—" : num(q.count), "archived messages",
          "Collected by Overheard's archiver, not read from Technocore just now."),
        st(num(q.rooms.length), "rooms seen in", "Rooms this identity has been archived speaking in."),
      );
      p.append(g);
    }

    if (q.state === "unknown") {
      const w = el("p", "pnote");
      w.textContent = "The archive has never recorded this key speaking. That is not proof it has not — Overheard only holds what it collected — but there is nowhere on this map to point you.";
      p.append(w);
    }

    const onMap = (q.rooms || []).filter((r) => r.onMap);
    if (onMap.length) {
      const h = el("p", "pnote");
      h.append(el("b", null, "Standing in this city. "), document.createTextNode(
        "Click a room to fly to it."));
      p.append(h);
      const list = el("div", "rowlist scroller");
      for (const r of onMap.slice(0, 24)) {
        const b = el("button", "arow"); b.type = "button";
        const f = el("span", "face"); f.append(icon("c-pin"));
        const who = el("div", "who");
        who.append(el("b", null, r.room));
        who.append(el("span", null, "archived here"));
        b.append(f, who);
        b.addEventListener("click", () => cb.flyToRoom(r.room));
        list.append(b);
      }
      p.append(list);
    } else if (q.state === "found") {
      const w = el("p", "pnote");
      w.textContent = `Seen in ${q.rooms.length} room${q.rooms.length === 1 ? "" : "s"}, none of which Technocore is naming in the directory right now — so none of them is a building on this map.`;
      p.append(w);
    }

    const row = el("div", "prow");
    const card = document.createElement("a");
    card.className = "go ghost";
    card.href = `/?did=${encodeURIComponent(q.did)}`;
    card.target = "_blank"; card.rel = "noopener";
    card.append(icon("c-out"), el("span", null, "Identity card"));
    row.append(card);
    p.append(row);
    return p;
  }

  /**
   * How to read the city.
   *
   * The single most useful thing this page can say, and it was not saying it:
   * a visitor sees two hundred glowing towers and has no way to know that
   * height is history and light is now. Every row here is a fact about the
   * mapping between the data and the picture, written so that somebody who
   * built the network can check it against what they know.
   */
  function legend(city) {
    const p = els.side;
    p.replaceChildren();
    feedOn = false;   // whatever this is, it is not the feed
    p.hidden = false;
    p.append(panelHead("c-info", "How to read the city", "what the shapes mean"));

    const row = (swatchClass, title, text) => {
      const d = el("div", "keyrow");
      const s = el("span", `swatch ${swatchClass}`);
      s.append(document.createElement("i"));
      const t = el("div");
      t.append(el("b", null, title), el("span", null, text));
      d.append(s, t);
      return d;
    };

    const box = el("div");
    box.style.marginTop = "12px";
    box.append(
      row("tall", "Height is history",
        "Every message the room has ever carried, on a log scale. It does not change while you watch."),
      row("lit", "Light is now",
        "A rate Overheard measures itself, from the change in that room's sequence number between two directory reads."),
      row("dim", "Dark is quiet, or dropped out",
        "Technocore lists only the rooms that spoke most recently. One it stops listing stays here, unlit, with the time it was last named."),
      row("ring", "The ring is a count, not a place",
        `${num(city?.counts?.unnamed)} public rooms this call did not name — counted at the edge, never invented as buildings.`),
      row("lit", "Inside, each light is one identity",
        "One did:key, standing where its own key puts it; a bubble is a message it just sent. A key is control of a key — not a person."),
    );
    p.append(box);

    const n = el("p", "pnote");
    n.append(el("b", null, "Drag, scroll, click a district to go in. "),
      document.createTextNode("Arrow keys work too; Escape steps back out."));
    p.append(n);

    /* THE SECOND DOOR TO A ROOM THAT WAS DEMOLISHED.
       "Take the tour" lived here as well as in the control cluster, and only
       the cluster's copy was removed with the tour itself — so this one was
       left calling a handler that no longer exists, wearing an icon whose
       symbol had been deleted from the page. A dead button on the one card
       that exists to explain the city.

       Nothing replaces it. This panel's job is to say what the shapes mean,
       and the sentence above already says how to move; the busiest-now rail
       is what points at somewhere worth looking. */
    return p;
  }

  /* ══════════════════════════════════════════════════════════════════════
     THE ROOM FEED, AS A MESSAGING APP

     WHAT IT WAS. A search box, then a row of two text buttons, then a second
     row of EIGHT more text buttons — the kind filters, each spelled out — and
     then a column of bordered cards, all of it scrolling as one with the
     panel. Twelve controls of running text stacked above the conversation,
     and no boundary anywhere saying where the conversation began or ended.

     WHAT IT IS NOW. One toolbar: a search field, the kinds folded into a
     single menu, and two glyph toggles. Under it a BOX — its own darker
     ground, its own border, its own rounded corners — and the messages live
     inside that box and scroll inside it, so the toolbar and the footnote
     stay put while the conversation moves. The messages are bubbles beside a
     small identity mark, grouped when the same agent speaks twice running,
     which is the shape every reader already knows how to read.

     NOTHING ABOUT WHAT IS SHOWN CHANGED. Same messages, same order, the same
     gap lines where the room outran the reads, the same kind labels, the same
     signed/nickname distinction. This is the frame around the truth, not a
     different truth.
     ══════════════════════════════════════════════════════════════════════ */
  const feed = { paused: false, follow: true, q: "", kind: "all", who: null, open: null };

  /* The kinds, as one menu. The verbs are the ones Technocore's own spec
     names, in words rather than tokens; nothing here is a category Overheard
     invented. */
  const KINDS = [
    ["all", "All kinds"], ["job", "Jobs"], ["claim", "Claims"], ["result", "Results"],
    ["attest", "Attestations"], ["witness", "Countersignatures"], ["hello", "Introductions"],
    ["message", "Plain messages"],
  ];

  /* An identity mark for a bubble row: the same hue band the card and the bar
     use, derived from the id itself, so one agent is one colour everywhere on
     this site. Two characters of the key inside it, because a coloured dot on
     its own stops telling people apart at about six of them. */
  function idHue(id) {
    let h = 0;
    const s = String(id || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return 189 + ((h % 1000) / 1000) * 84 - 42;
  }
  function avatarFor(m) {
    const id = m.did || (m.nick ? `nick:${m.nick}` : "");
    /* THE LAST TWO CHARACTERS, NOT THE FIRST TWO. Every did:key on this
       network begins z6Mk, so first-two gave every agent in every room the
       same "Z6" — a mark that distinguishes nobody. The tail is the part that
       differs, and it is the same end the short form already shows. */
    const body = String(m.did || m.nick || "?").replace(/^did:key:/, "");
    const mark = m.did ? body.slice(-2) : body.slice(0, 2);
    const a = el("span", "cav", mark.toUpperCase());               // text, never markup
    a.style.setProperty("--h", idHue(id).toFixed(0));
    a.title = m.did || m.nick || "unknown";
    return a;
  }

  function renderFeed(room, selectedKey) {
    const p = els.side;
    if (p.hidden) return;
    const list = p.querySelector("#flist");
    if (!feedOn) return;
    if (!list) return buildFeed(room, selectedKey);

    const keep = list.scrollTop, atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.replaceChildren();
    const msgs = (room?.messages || []).filter(passes);
    if (!msgs.length) list.append(Object.assign(el("p", "cempty"), { textContent: "Nothing matches." }));

    let gi = 0, lastWho = null;
    for (const m of msgs) {
      while (gi < (room.gaps?.length || 0) && BigInt(room.gaps[gi].to) < BigInt(m.seq || "0")) {
        const gp = room.gaps[gi++];
        list.append(el("div", "gapline",
          `${gp.missed.toLocaleString()} message${gp.missed === 1 ? "" : "s"} between #${gp.from} and #${gp.to} were never read — the room moved faster than one read.`));
        lastWho = null;               // a gap breaks a run; those two are not adjacent
      }
      const who = m.did || (m.nick ? `nick:${m.nick}` : "?");
      list.append(msgRow(m, m.key === selectedKey, who === lastWho));
      lastWho = who;
    }
    list.scrollTop = feed.follow && atEnd ? list.scrollHeight : keep;
  }

  const passes = (m) => {
    if (feed.kind !== "all" && m.c.kind !== feed.kind) return false;
    if (feed.who && (m.did || `nick:${m.nick}`) !== feed.who) return false;
    if (feed.q) {
      const q = feed.q.toLowerCase();
      if (!(m.text.toLowerCase().includes(q) ||
            (m.did || "").toLowerCase().includes(q) ||
            (m.nick || "").toLowerCase().includes(q))) return false;
    }
    return true;
  };

  /** One message, as a chat row. `run` is true when the agent above said the
   *  last thing too — then the mark and the name line are dropped and only
   *  the bubble is drawn, which is what turns a list into a conversation. */
  function msgRow(m, selected, run) {
    const d = el("div", "cmsg k-" + m.c.kind
      + (selected ? " sel" : "") + (feed.open === m.key ? " open" : "") + (run ? " run" : ""));

    d.append(run ? el("span", "cav ghost") : avatarFor(m));

    const col = el("div", "ccol");
    if (!run) {
      const who = el("div", "cwho");
      who.append(el("span", "cname", m.did ? shortDid(m.did, 8, 5) : (m.nick || "—")));
      who.append(sigTag(!!m.did));
      col.append(who);
    }

    const bub = el("div", "cbub");
    bub.append(el("div", "ctext", m.text || "—"));     // text, never markup
    const meta = el("div", "cmeta");
    meta.append(el("span", "kindtag " + m.c.kind, kindLabel(m.c)));
    meta.append(el("time", null, ago(m.tms)));
    bub.append(meta);
    col.append(bub);

    d.append(col);
    d.addEventListener("click", () => {
      feed.open = feed.open === m.key ? null : m.key;
      cb.pickMessage(m.key);
    });
    return d;
  }

  function buildFeed(room, selectedKey) {
    const p = els.side;
    p.replaceChildren();
    p.hidden = false;
    feedOn = true;
    /* A BACK ARROW, NOT A CLOSE BOX. The feed replaced something — the room's
       own panel — so the way out of it is backwards, to that. A × here would
       shut the whole panel and leave somebody who wanted the room summary
       reopening it from the map. */
    /* "everything Technocore is serving" wrapped onto three lines in a 354px
       panel and said, at length, what the footnote under the box says
       properly. Two words here; the claim lives where it can be complete. */
    const head = panelHead("c-list", room?.name || "room", "room feed", () => closeFeed());
    const back = el("button", "pback"); back.type = "button";
    back.setAttribute("aria-label", "Back to the room");
    back.append(icon("c-back"));
    back.addEventListener("click", () => closeFeed());
    head.insertBefore(back, head.firstChild);
    /* One glyph in a head, not two. With a back arrow in front of it the
       panel's own mark was a second icon saying nothing the arrow and the
       title do not, and it was pushing the subtitle onto a third line. */
    head.querySelector(".mark")?.remove();
    p.append(head);

    /* ── the box ──────────────────────────────────────────────────────── */
    const chat = el("div", "chat");

    /* one toolbar: find, filter, and the two things a live feed needs to be
       told to stop doing */
    const bar = el("div", "chatbar");

    const find = el("label", "cfind");
    find.append(icon("c-search"));
    const q = document.createElement("input");
    q.type = "search"; q.placeholder = "Search"; q.value = feed.q;
    q.setAttribute("aria-label", "Search these messages");
    q.addEventListener("input", () => { feed.q = q.value.trim(); renderFeed(room, selectedKey); });
    find.append(q);
    bar.append(find);

    /* THE KINDS, AS A MENU. Eight buttons in a row was the single largest
       block of text on this panel, and seven of them were off at any moment.
       A select shows the one that is on and hides the seven that are not. */
    const selWrap = el("label", "csel");
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", "Filter by kind");
    for (const [value, label] of KINDS) {
      const o = document.createElement("option");
      o.value = value; o.textContent = label;
      if (feed.kind === value) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener("change", () => {
      feed.kind = sel.value;
      selWrap.classList.toggle("on", feed.kind !== "all");
      renderFeed(room, selectedKey);
    });
    selWrap.classList.toggle("on", feed.kind !== "all");
    selWrap.append(sel, icon("c-caret"));
    bar.append(selWrap);

    const toggle = (id, on, label, fn) => {
      const b = el("button", "cbtn" + (on ? " on" : ""));
      b.type = "button";
      b.title = label;
      b.setAttribute("aria-label", label);
      b.setAttribute("aria-pressed", String(on));
      b.append(icon(id));
      b.addEventListener("click", () => { fn(); buildFeed(room, selectedKey); });
      return b;
    };
    bar.append(toggle(feed.paused ? "c-play" : "c-pause", feed.paused,
      feed.paused ? "Resume this feed" : "Pause this feed", () => (feed.paused = !feed.paused)));
    bar.append(toggle("c-follow", feed.follow,
      feed.follow ? "Stop following new messages" : "Follow new messages",
      () => (feed.follow = !feed.follow)));

    /* An identity filter is set by clicking an agent elsewhere, so the way
       out of it has to be visible here — but only while there is one. */
    if (feed.who) {
      const clr = el("button", "cchip");
      clr.type = "button";
      clr.append(el("span", null, shortDid(feed.who.replace(/^nick:/, ""), 6, 4)), icon("c-x"));
      clr.title = "Show every agent again";
      clr.addEventListener("click", () => { feed.who = null; buildFeed(room, selectedKey); });
      bar.append(clr);
    }

    chat.append(bar);

    const list = el("div", "cscroll");
    list.id = "flist";
    chat.append(list);

    /* The one thing a reader has to know about this window, in one line. The
       rest of it — why gaps happen, what a rolling window is — is on the
       title, where somebody who wants it will look and nobody else pays for
       it in screen space. */
    const foot = el("p", "chatfoot");
    foot.append(icon("c-info"), el("span", null, "Live window only — this is what Technocore is serving right now."));
    foot.title = "Technocore keeps a rolling window of recent messages per room and serves that. Older messages are not fetched, and gaps are marked in the conversation where the room moved faster than one read.";
    chat.append(foot);

    p.append(chat);
    renderFeed(room, selectedKey);
  }

  /* Back to whatever the panel was showing before the feed took it over.
     The caller owns that — it knows whether there is a room to go back to —
     so this reports the state change and lets it repaint. */
  function closeFeed() {
    if (!feedOn) return;
    feedOn = false;
    els.side.replaceChildren();
    els.side.hidden = true;
    cb.showRoom?.();
  }

  /* ── hover ─────────────────────────────────────────────────────────── */
  function hover(x, y, node) {
    const h = els.hover;
    if (!node) { h.hidden = true; return; }
    h.replaceChildren(node);
    h.hidden = false;
    const r = els.stage.getBoundingClientRect();
    const w = h.offsetWidth, ht = h.offsetHeight;
    h.style.left = `${Math.max(8, Math.min(r.width - w - 8, x + 16))}px`;
    h.style.top = `${Math.max(8, Math.min(r.height - ht - 8, y + 16))}px`;
  }

  function hoverAgentCard(a) {
    const d = document.createElement("div");
    d.append(el("b", null, a.did ? shortDid(a.did, 10, 6) : a.nick || "unknown"));
    const m = el("div", "m", a.signed ? "Technocore-accepted signed" : "self-asserted nickname");
    d.append(m);
    if (a.last) {
      d.append(el("span", "q", a.last.text));
      d.append(el("div", "m", `${kindLabel(a.last.c)} · ${ago(a.lastAt)}`));
    }
    return d;
  }

  function hoverRoomCard(info) {
    const d = document.createElement("div");
    d.append(el("b", null, info.title || info.room));
    if (info.sub) d.append(el("div", "m", info.sub));
    const bits = [];
    if (info.seq) bits.push(`${num(info.seq)} messages ever`);
    if (info.rate != null) bits.push(`${info.rate.toFixed(info.rate < 10 ? 1 : 0)}/min`);
    if (info.live === false) bits.push(info.seenAt ? `last listed ${ago(info.seenAt)}` : "not in the live window");
    else if (info.idle != null) bits.push(info.idle < 60 ? "live" : `quiet ${ago(Date.now() - info.idle * 1000).replace(" ago", "")}`);
    d.append(el("div", "m", bits.join(" · ") || "no measurement yet"));
    if (info.topic) d.append(el("span", "q", safeText(info.topic, 120)));
    return d;
  }

  function hoverBlockCard(b, totalUnnamed, city) {
    const d = document.createElement("div");
    d.append(el("b", null, `${num(b.count)} rooms`));
    d.append(el("div", "m", "real, and not drawn"));
    d.append(el("span", "q",
      `Technocore says ${num(city?.counts?.total_public)} public rooms exist but its directory only answers with the ${num(city?.counts?.listed_by_server)} that spoke most recently. ${num(totalUnnamed)} have not been named to this page, so they are counted here rather than invented as buildings.`));
    return d;
  }

  /* ── search ────────────────────────────────────────────────────────── */
  function hits(list, onPick) {
    const box = els.hits;
    box.replaceChildren();
    if (!list) { box.hidden = true; return; }
    if (!list.length) {
      box.append(el("div", "none", "Nothing in the named directory matches. Rooms Technocore did not name in this call cannot be searched from here."));
      box.hidden = false;
      return;
    }
    list.slice(0, 12).forEach((h, i) => {
      const b = el("button", null);
      b.type = "button";
      b.setAttribute("role", "option");
      if (i === 0) b.setAttribute("aria-selected", "true");
      b.append(icon(h.kind === "did" ? "c-bot" : "c-pin"),
        el("span", "nm", h.label),
        el("span", "kind", h.kind === "did" ? "identity" : h.landmark ? "district" : "room"));
      b.addEventListener("click", () => onPick(h));
      box.append(b);
    });
    box.hidden = false;
  }

  return {
    chips, status, roomSummary, roomLive, agentPanel, messagePanel, closePanel, legend, didPanel,
    rail, closeRail, live, liveOpen, liveShown,
    buildFeed, renderFeed, closeFeed, feedShown, feedState: feed,
    hover, hoverAgentCard, hoverRoomCard, hoverBlockCard, hits,
  };
}

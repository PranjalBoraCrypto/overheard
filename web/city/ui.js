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
    const fps = el("button", "chip");
    fps.type = "button";
    fps.id = "fpsChip";
    fps.append(el("b", null, String(opts.fps ?? "—")), document.createTextNode(" fps"));
    fps.title = "Hide the overlays for a clean view of the city. Esc brings them back.";
    fps.addEventListener("click", () => cb.toggleClean());
    box.append(fps);
  }

  /* ── the side panel ───────────────────────────────────────────────── */

  function panelHead(markIcon, title, sub) {
    const h = el("div", "phead");
    const m = el("span", "mark"); m.append(icon(markIcon));
    const t = el("div");
    t.append(el("b", null, title), el("span", "sub", sub));
    const x = el("button", "px"); x.type = "button"; x.setAttribute("aria-label", "Close");
    x.append(icon("c-x"));
    x.addEventListener("click", () => cb.closePanel());
    h.append(m, t, x);
    return h;
  }

  /** A room or district, before you go in. */
  function roomSummary(info) {
    const p = els.side;
    p.replaceChildren();
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

    const list = el("div", "rowlist");
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

    const row = el("div", "prow");
    const feed = el("button", "go ghost"); feed.type = "button";
    feed.append(icon("c-list"), el("span", null, "Room feed"));
    feed.addEventListener("click", () => cb.toggleFeed());
    const back = el("button", "go ghost"); back.type = "button";
    back.append(icon("c-home"), el("span", null, "Back to the city"));
    back.addEventListener("click", () => cb.leaveRoom());
    row.append(feed, back);
    p.append(row);
    return p;
  }

  /** One identity, in as much detail as the data actually supports. */
  function agentPanel(a, room, following) {
    const p = els.side;
    p.replaceChildren();
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

  function closePanel() { els.side.hidden = true; els.side.replaceChildren(); }

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

    /* One button, not two. Two wrapped onto a second line and pushed the
       first below the fold of the panel, which is a strange way to treat the
       only thing on the card somebody is meant to press. The tour starts at
       the busiest district anyway, so "enter the lobby" was a second door
       into the same room. */
    const r2 = el("div", "prow");
    const tour = el("button", "go"); tour.type = "button";
    tour.append(icon("c-play"), el("span", null, "Take the tour"));
    tour.addEventListener("click", () => cb.tour());
    r2.append(tour);
    p.append(r2);
    return p;
  }

  /* ── the chronological feed ───────────────────────────────────────── */
  const feed = { paused: false, follow: true, q: "", kind: "all", who: null, open: null };

  function renderFeed(room, selectedKey) {
    const p = els.feed;
    if (p.hidden) return;
    const list = p.querySelector("#flist");
    if (!list) return buildFeed(room, selectedKey);

    const keep = list.scrollTop, atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.replaceChildren();
    const msgs = (room?.messages || []).filter(passes);
    if (!msgs.length) list.append(Object.assign(el("p", "pnote"), { textContent: "Nothing matches." }));

    let gi = 0;
    for (const m of msgs) {
      while (gi < (room.gaps?.length || 0) && BigInt(room.gaps[gi].to) < BigInt(m.seq || "0")) {
        const gp = room.gaps[gi++];
        list.append(el("div", "gapline",
          `${gp.missed.toLocaleString()} message${gp.missed === 1 ? "" : "s"} between #${gp.from} and #${gp.to} were never read — the room moved faster than one read.`));
      }
      list.append(msgRow(m, m.key === selectedKey));
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

  function msgRow(m, selected) {
    const d = el("div", "msg" + (selected ? " sel" : "") + (feed.open === m.key ? " open" : ""));
    const top = el("div", "top");
    top.append(el("span", "kindtag " + m.c.kind, kindLabel(m.c)));
    top.append(el("span", "id", m.did ? shortDid(m.did, 8, 5) : (m.nick || "—")));
    top.append(sigTag(!!m.did));
    top.append(el("span", null, ago(m.tms)));
    d.append(top, el("div", "body", m.text || "—"));
    d.addEventListener("click", () => {
      feed.open = feed.open === m.key ? null : m.key;
      cb.pickMessage(m.key);
    });
    return d;
  }

  function buildFeed(room, selectedKey) {
    const p = els.feed;
    p.replaceChildren();
    p.hidden = false;
    p.append(panelHead("c-list", room?.name || "room", "everything Technocore is serving"));

    const bar = el("div", "fbar");
    const q = document.createElement("input");
    q.type = "search"; q.placeholder = "Search these messages…"; q.value = feed.q;
    q.addEventListener("input", () => { feed.q = q.value.trim(); renderFeed(room, selectedKey); });
    bar.append(q);

    const mk = (label, on, fn) => {
      const b = el("button", "fbtn" + (on ? " on" : ""), label);
      b.type = "button";
      b.addEventListener("click", () => { fn(); buildFeed(room, selectedKey); });
      return b;
    };
    bar.append(mk(feed.paused ? "Resume" : "Pause", feed.paused, () => (feed.paused = !feed.paused)));
    bar.append(mk("Auto-scroll", feed.follow, () => (feed.follow = !feed.follow)));
    p.append(bar);

    const kinds = el("div", "fbar");
    /* The kibble verbs as the published spec actually names them, plus plain
       messages. Nothing here is a category Overheard invented. */
    for (const k of ["all", "job", "claim", "result", "attest", "witness", "hello", "message"]) {
      kinds.append(mk(k, feed.kind === k, () => (feed.kind = k)));
    }
    if (feed.who) kinds.append(mk("clear identity filter", true, () => (feed.who = null)));
    p.append(kinds);

    const list = el("div"); list.id = "flist";
    p.append(list);

    const foot = el("p", "pnote");
    foot.append(el("b", null, "Live window only. "), document.createTextNode(
      "Technocore serves a rolling window per room; this is what it is serving now. Gaps are marked where the room outran the reads."));
    p.append(foot);

    renderFeed(room, selectedKey);
  }

  function closeFeed() { els.feed.hidden = true; els.feed.replaceChildren(); }

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
    chips, roomSummary, roomLive, agentPanel, messagePanel, closePanel, legend,
    buildFeed, renderFeed, closeFeed, feedState: feed,
    hover, hoverAgentCard, hoverRoomCard, hoverBlockCard, hits,
  };
}

/**
 * The shared vocabulary and components for the four deal views.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 *
 * Three HTML files carry four views of one lifecycle — the deals page (which
 * holds both the shop and the open board), the hire page, and the orders page.
 * Until now they shared five JavaScript modules and NOT ONE line of CSS or UI
 * code, and it showed in the one place it matters most: they described the
 * same deal in five different vocabularies.
 *
 *   tclk.js, the protocol   proposed · accepted · locked · claimed · refunded
 *   the board's buckets     wanted · offered · in flight · settled
 *   the board's cards       awaiting lock · payee can claim · claim window…
 *   hire's order history    open · closed          (and nothing else)
 *   the orders page         delivered · paid · refunded · cancelled · open
 *
 * A buyer could see "Paid" on their orders page, follow the link to the board,
 * and find the same deal reading "locked". Both true, both ours, and no way
 * for a reader to know they were looking at one thing.
 *
 * ── THE RULE THIS FILE ENFORCES ───────────────────────────────────────────
 *
 * ONE WORD PER STATE, TRUE FROM ANY ANGLE.
 *
 * The tempting fix was two vocabularies — neutral words on the public board,
 * possessive words on your own orders. That is the same bug wearing a
 * disguise: the reader still meets two names for one thing, they just meet
 * them one click apart instead of side by side.
 *
 * So the words are chosen to be true whoever is looking. "Funded" rather than
 * "Paid", because the board shows strangers' deals and "paid" does not say by
 * whom. "Delivered" rather than "claimed", because that is what happened.
 *
 * The personal half does not disappear — it moves to where context belongs.
 * The orders page still says "your payment is locked in escrow" underneath a
 * pill reading FUNDED. Same word, same colour, same position on the rail as
 * the board shows; the sentence beneath it is the part that knows the deal is
 * yours.
 *
 * ── AND ONE COLOUR PER STATE ──────────────────────────────────────────────
 *
 * The colour is a property of the STATE, not of the page. A deal that is
 * funded is amber wherever you meet it. Nothing here lets a page pick its own.
 */

/* ── THE STATES, IN ORDER ──────────────────────────────────────────────────
 * `key` is tclk's own state name and is what the code compares on. `word` is
 * the only thing a reader ever sees. `tone` names a colour, never a hex — the
 * hexes live in deal.css so a redesign changes them once.
 *
 * `step` is where the state sits on the escrow rail, and it is deliberately
 * NOT a count of frames: a refund and a delivery both END a deal, and drawing
 * a refund as three-quarters finished would say a deal got most of the way.
 * Terminal states carry `ends`, and the rail draws them as an ending rather
 * than as progress.
 */
export const STATES = {
  proposed:  { word: "Open",      tone: "wait", step: 1, ends: false,
               says: "signed and on the public board, waiting for an answer" },
  accepted:  { word: "Accepted",  tone: "live", step: 2, ends: false,
               says: "answered, and waiting for the payment to be locked" },
  locked:    { word: "Funded",    tone: "hold", step: 3, ends: false,
               says: "the payment is held in escrow while the work is done" },
  claimed:   { word: "Delivered", tone: "good", step: 4, ends: true,
               says: "the work is on the wire and the lock has been opened" },
  refunded:  { word: "Refunded",  tone: "off",  step: 4, ends: true,
               says: "nobody delivered in time, and the payer took it back" },
  cancelled: { word: "Cancelled", tone: "off",  step: 4, ends: true,
               says: "closed before it was ever funded" },
};

/* Not a deal state — a clock reading. An offer nobody answered before its own
   expiry is still `proposed` to the protocol, and calling it "Open" a day
   later would be the page telling a comfortable lie. */
/* "its own expiry passed with no answer" was the sentence here, and it is
   written from the protocol's side: an expiry is a field on a frame, and
   "no answer" is what the room did not contain. A buyer reading their own
   order needs the two facts that affect them — nobody took the job, and
   their money never moved — in the order they would ask for them. */
export const EXPIRED = { word: "Expired", tone: "off", step: 1, ends: true,
                         says: "nobody took it on before the deadline, so no payment was ever locked" };

export const RAIL_STEPS = ["Offer", "Accept", "Fund", "Deliver"];

/**
 * What to call a deal, from its folded state and the clock.
 *
 * Takes what `runDeal()` and `clockOf()` already produce rather than a second
 * opinion about frames — there is exactly one state machine in this project
 * and it is in tclk.js. A page that folds frames itself is a page that will
 * disagree with the board eventually.
 */
export function statusOf(deal, clock) {
  if (!deal) return { key: "unknown", word: "Unknown", tone: "off", step: 0, ends: false, says: "" };
  const s = STATES[deal.state];
  if (!s) return { key: deal.state, word: deal.state, tone: "off", step: 0, ends: false, says: "" };
  if (deal.state === "proposed" && clock?.phase === "expired") return { key: "expired", ...EXPIRED };
  return { key: deal.state, ...s };
}

/* ── AND THE ONE THING A READER ACTUALLY WANTS TO KNOW ─────────────────────
 * Not the state — the state is on the pill. What is about to happen, and to
 * whom. `clockOf` names the phase; this turns it into a caption that reads
 * the same whoever the deal belongs to.
 */
export const PHASE_CAPTION = {
  "open": "to answer",
  "awaiting lock": "to fund",
  "payee can claim": "to deliver",
  "claim window closing": "to deliver",
  "payer can reclaim": "refundable now",
  "expired": "expired",
};

/** A short, human span. Deliberately coarse: a countdown to the second on a
 *  twelve-hour window is precision nobody asked for and a repaint every
 *  second to supply it. */
export function leftFor(until, now = Date.now()) {
  if (!Number.isFinite(until)) return "";
  const d = until - now;
  if (d <= 0) return "now";
  const m = Math.round(d / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(d / 3600000);
  if (h < 48) return `${h}h`;
  return `${Math.round(d / 86400000)}d`;
}

/** Whether a deadline is close enough to say so. Used for the amber accent,
 *  and it is a threshold rather than a gradient because "getting slightly
 *  more orange over twelve hours" communicates nothing a reader can act on. */
export const isSoon = (until, now = Date.now()) =>
  Number.isFinite(until) && until - now > 0 && until - now < 3600000;

/* ══════════════════════════════════════════════════════════════════════════
 * THE ESCROW RAIL
 *
 * One component, four appearances. It is the signature of this product and it
 * has to be the SAME OBJECT everywhere — an explainer on the deals page, a
 * live status on a board listing, checkout progress on hire, and an order's
 * history on the orders page. Four things that merely resemble each other is
 * what the four pages already had.
 *
 * It draws from the real folded state and never from a page's own idea of
 * progress. `at` is the step reached; `ends` says the deal stopped there
 * rather than continued, which is the difference between a delivery and a
 * refund and is the one thing a progress bar cannot say by itself.
 * ═════════════════════════════════════════════════════════════════════════*/
export function railEl(doc, { at = 0, ends = false, tone = "wait", compact = false, live = false } = {}) {
  const el = doc.createElement("div");
  el.className = "erail" + (compact ? " erail-c" : "") + (live ? " erail-live" : "");
  el.dataset.tone = tone;
  el.setAttribute("role", "img");
  const done = Math.max(0, Math.min(RAIL_STEPS.length, at));
  el.setAttribute("aria-label",
    `escrow: ${RAIL_STEPS.slice(0, done).join(", ") || "not started"}` +
    (ends ? " — ended here" : ` — ${RAIL_STEPS[done] ?? "done"} next`));

  for (let i = 0; i < RAIL_STEPS.length; i++) {
    if (i) {
      const link = doc.createElement("span");
      link.className = "erail-link" + (i < done ? " on" : "");
      el.append(link);
    }
    const node = doc.createElement("span");
    node.className = "erail-node"
      + (i < done ? " on" : "")
      + (i === done - 1 ? " now" : "")
      + (i === done - 1 && ends ? " end" : "");
    node.dataset.step = RAIL_STEPS[i];
    el.append(node);
  }
  return el;
}

/* ── THE PILL ──────────────────────────────────────────────────────────────
 * Every status a reader sees comes from here, so no page can invent a sixth
 * vocabulary by writing a string into a span.
 */
export function pillEl(doc, status) {
  const el = doc.createElement("span");
  el.className = "pill";
  el.dataset.tone = status.tone;
  el.textContent = status.word;
  if (status.says) el.title = status.says;
  return el;
}

/* ── SMALL THINGS THAT WERE WRITTEN THREE TIMES EACH ───────────────────────
 * None of these is interesting. All of them existed in two or three copies,
 * which is how two pages come to disagree about what "2 hours ago" means.
 */
export const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export const hex16 = () => [...crypto.getRandomValues(new Uint8Array(8))]
  .map((b) => b.toString(16).padStart(2, "0")).join("");

export function ago(ts, now = Date.now()) {
  const t = Date.parse(ts ?? "");
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/* ══════════════════════════════════════════════════════════════════════════
 * SKELETONS
 *
 * A silhouette per view, described as data rather than drawn three times.
 * The rule the shapes follow: the skeleton has the SAME HEIGHT, PADDING AND
 * GAPS as the row it stands in for, so nothing moves when the data lands.
 * A grey bar of the wrong height is a layout shift with a delay on it.
 *
 * Each part is `[kind, options]`. Only four kinds exist and that is
 * deliberate — a skeleton language rich enough to reproduce a card exactly is
 * a second copy of the card, and it will drift from the first.
 * ═════════════════════════════════════════════════════════════════════════*/
export const SKEL = {
  /* A board listing: title, a line of meta, the rail, a price pill. */
  listing: [
    ["row", [["col", [["line", { s: "head", w: "58%" }], ["line", { s: "micro", w: "38%" }]]],
             ["pill", { w: "84px" }]]],
    ["line", { w: "100%" }],
    ["row", [["line", { w: "46%" }], ["gap"], ["pill", { w: "62px" }]]],
  ],
  /* An order row on the orders page: job name, when, state pill, and the
     four-node rail underneath. 74px was the old grey bar; this is the shape
     that bar was standing in for. */
  order: [
    ["row", [["tile", { w: "38px", h: "38px" }],
             ["col", [["line", { s: "head", w: "44%" }], ["line", { s: "micro", w: "62%" }]]],
             ["pill", { w: "76px" }]]],
    ["line", { w: "100%" }],
  ],
  /* A shop card: emblem, name, one line of description, a price. */
  shelf: [
    ["row", [["tile", { w: "44px", h: "44px" }],
             ["col", [["line", { s: "head", w: "52%" }], ["line", { s: "micro", w: "70%" }]]]]],
    ["line", { w: "92%" }],
    ["line", { w: "64%" }],
    ["row", [["pill", { w: "70px" }], ["gap"], ["pill", { w: "92px" }]]],
  ],
  /* Two lines and a figure — a tally tile, a capacity figure. */
  strip: [
    ["row", [["col", [["line", { s: "micro", w: "44%" }], ["line", { s: "head", w: "30%" }]]],
             ["pill", { w: "58px" }]]],
  ],
  /* A sentence that has not arrived. Two lines, the second short, which is
     what a wrapped sentence looks like. Used where the thing coming is prose
     rather than a row — and the pages that use it drop the card's border and
     background, because a boxed placeholder for one line of text is a box
     that was never going to be there. */
  text: [["line", { w: "100%" }], ["line", { w: "58%" }]],
};

function skelPart(doc, [kind, opt]) {
  if (kind === "row" || kind === "col") {
    const el = doc.createElement("div");
    el.className = kind === "row" ? "skel-row" : "skel-col";
    for (const p of opt) el.append(skelPart(doc, p));
    return el;
  }
  const el = doc.createElement("div");
  el.className = `skel-${kind}`;
  if (opt?.s) el.dataset.s = opt.s;
  if (opt?.w) el.style.setProperty("--w", opt.w);
  if (opt?.h) el.style.setProperty("--h", opt.h);
  return el;
}

/**
 * `n` cards of the named shape into `node`, replacing whatever is there.
 *
 * `--i` carries the card's index to the stylesheet, which uses it to stagger
 * the sweep. It is set here rather than in CSS because :nth-child() cannot
 * produce an arbitrary count and a list of nth-child rules is a limit nobody
 * remembers is there until the ninth card does not animate.
 */
export function skeletonsInto(node, kind, n = 3, say = "") {
  const doc = node.ownerDocument;
  node.replaceChildren();
  const shape = SKEL[kind] ?? SKEL.listing;
  for (let i = 0; i < n; i++) {
    const card = doc.createElement("div");
    card.className = "skel-card";
    card.style.setProperty("--i", String(i));
    /* Not a live region and not read out. A screen reader is told the list is
       busy by aria-busy on the list itself; these are pictures of nothing. */
    card.setAttribute("aria-hidden", "true");
    for (const p of shape) card.append(skelPart(doc, p));
    node.append(card);
  }
  if (say) {
    const s = doc.createElement("p");
    s.className = "skel-say";
    s.textContent = say;
    node.append(s);
  }
  node.classList.add("skel");
  node.setAttribute("aria-busy", "true");
  return node;
}

/** The other half, and the half that gets forgotten: a list that finished
 *  loading is no longer busy, and a screen reader has no other way to know. */
export function skeletonsDone(node) {
  node.removeAttribute("aria-busy");
  node.classList.remove("skel");
}

/* ══════════════════════════════════════════════════════════════════════════
 * COPY
 *
 * `navigator.clipboard` is not available on an insecure origin and can be
 * refused by a browser setting, so there are two paths and the button says
 * which one happened. The fallback is a hidden textarea and execCommand —
 * deprecated, still implemented everywhere, and the only thing that works
 * when the modern API is absent.
 * ═════════════════════════════════════════════════════════════════════════*/
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through — a refusal is not a reason to give up */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    /* Off screen rather than hidden: display:none and visibility:hidden are
       both unselectable, and a selection is the entire mechanism here. */
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

/* ── THE TWO GLYPHS, BUILT AS NODES ────────────────────────────────────────
 * Not innerHTML, even for a string this file wrote itself. The deals page
 * carries a promise that it never assigns innerHTML, outerHTML or
 * insertAdjacentHTML anywhere, and its suite extends that promise to every
 * module the page imports — precisely so the guarantee cannot be weakened by
 * moving code one file sideways. Six lines of createElementNS is the price of
 * a rule that means something.
 */
const SVG_NS = "http://www.w3.org/2000/svg";
function glyph(doc, cls, parts) {
  const s = doc.createElementNS(SVG_NS, "svg");
  s.setAttribute("class", cls);
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of parts) {
    const n = doc.createElementNS(SVG_NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    s.append(n);
  }
  return s;
}
const COPY_GLYPH = (doc) => glyph(doc, "no", [
  ["rect", { x: 9, y: 9, width: 12, height: 12, rx: 2.5 }],
  ["path", { d: "M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" }],
]);
const TICK_GLYPH = (doc) => glyph(doc, "yes", [
  ["polyline", { points: "4.5 12.5 9.5 17.5 19.5 6.5" }],
]);

/**
 * A copy button for one string.
 *
 * `what` names the thing in the accessible label and in the confirmation,
 * because "Copied" on a card carrying four copyable strings does not say
 * which one went. The confirmation is an aria-live announcement rather than a
 * tooltip: a tooltip is invisible to a screen reader and, on a phone, to
 * everybody, since there is no hover to reveal it.
 */
export function copyBtn(doc, text, what = "") {
  const b = doc.createElement("button");
  b.type = "button";
  b.className = "copy";
  b.append(COPY_GLYPH(doc), TICK_GLYPH(doc));
  const name = what ? `Copy the ${what}` : "Copy";
  b.setAttribute("aria-label", name);
  b.title = name;

  let back = 0;
  b.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();                         // never also open the card
    const ok = await copyText(typeof text === "function" ? text() : text);
    b.dataset.done = ok ? "1" : "no";
    b.setAttribute("aria-label", ok ? `Copied${what ? " the " + what : ""}` : "Could not copy — select it by hand");
    b.title = b.getAttribute("aria-label");
    announce(doc, b.getAttribute("aria-label"));
    clearTimeout(back);
    /* Long enough to be seen on a glance away, short enough that a row of
       these does not stay green after somebody has moved on. */
    back = setTimeout(() => {
      delete b.dataset.done;
      b.setAttribute("aria-label", name);
      b.title = name;
    }, 1900);
  });
  return b;
}

/** One live region per document, reused. A page that creates a new one per
 *  announcement leaves a growing pile of empty divs, and screen readers do
 *  not reliably announce a region that was added at the same moment as its
 *  text. */
export function announce(doc, msg) {
  let r = doc.getElementById("oh-live");
  if (!r) {
    r = doc.createElement("div");
    r.id = "oh-live";
    r.setAttribute("role", "status");
    r.setAttribute("aria-live", "polite");
    r.style.cssText =
      "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap";
    doc.body.append(r);
  }
  /* Cleared first: setting the same string twice is not a change, and a
     screen reader will say nothing the second time. */
  r.textContent = "";
  setTimeout(() => { r.textContent = msg; }, 30);
}

/** A truncated string beside its copy button, on one line. */
/**
 * A long string that keeps BOTH ends when it will not fit.
 *
 * WHY NOT text-overflow:ellipsis. It cuts the tail, and for everything long on
 * this site the tail is the identifying part — two contract ids share their
 * first thirty characters and differ in the last six, so an end-clipped one is
 * indistinguishable from every other. And why not measure the width in script:
 * this has to survive a resize, a font that loads late and a zoom, none of
 * which fire anything a measurement could hang off reliably.
 *
 * So it is two spans in a flex row. The head is allowed to shrink and clips
 * with an ellipsis; the tail never shrinks. The browser does the arithmetic on
 * every reflow for nothing.
 *
 * The whole string stays in the title and on the copy button beside it — this
 * changes what is DRAWN and never what is copied.
 */
export function midText(doc, text, tail = 12, cls = "") {
  const t = String(text ?? "");
  const wrap = doc.createElement("span");
  wrap.className = "midtrim" + (cls ? " " + cls : "");
  wrap.title = t;
  const cut = t.length > tail + 8 ? t.length - tail : t.length;
  const head = doc.createElement("span");
  head.className = "mt-head";
  head.textContent = t.slice(0, cut);
  const end = doc.createElement("span");
  end.className = "mt-tail";
  end.textContent = t.slice(cut);
  wrap.append(head, end);
  return wrap;
}

export function copyRow(doc, text, what = "", cls = "did") {
  const row = doc.createElement("div");
  row.className = "copyrow";
  /* Middle-truncated rather than end-clipped: see midText. A contract id read
     off a card is compared by its last characters. */
  const s = midText(doc, text, 10, cls);
  row.append(s, copyBtn(doc, text, what));
  return row;
}

/** The shop's shelf, named once. Three files carried their own copy of this
 *  map and one of them was already missing a job. */
export const JOBS = {
  "overheard-archive-question": { name: "Ask the archive", mark: "archive" },
  "overheard-agent-profile":    { name: "Profile an agent", mark: "agent" },
  "overheard-room-summary":     { name: "Summarise a room", mark: "room" },
  "overheard-daily-digest":     { name: "Daily digest",     mark: "day" },
};
export const jobName = (id) => JOBS[id]?.name ?? id ?? "order";

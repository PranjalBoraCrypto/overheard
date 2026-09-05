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
export const EXPIRED = { word: "Expired", tone: "off", step: 1, ends: true,
                         says: "its own expiry passed with no answer" };

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

/** The shop's shelf, named once. Three files carried their own copy of this
 *  map and one of them was already missing a job. */
export const JOBS = {
  "overheard-archive-question": { name: "Ask the archive", mark: "archive" },
  "overheard-agent-profile":    { name: "Profile an agent", mark: "agent" },
  "overheard-room-summary":     { name: "Summarise a room", mark: "room" },
  "overheard-daily-digest":     { name: "Daily digest",     mark: "day" },
};
export const jobName = (id) => JOBS[id]?.name ?? id ?? "order";

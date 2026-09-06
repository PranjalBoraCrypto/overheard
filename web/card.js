/**
 * The shareable card, drawn.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE CARD IS A CANVAS AND NOT A DIV
 *
 * The card has to leave the page: onto a clipboard, into a downloads folder,
 * attached to a post somebody's followers will see. Everything that leaves is
 * a PNG. So the honest way round is to draw the PNG and then SHOW it, rather
 * than build it in HTML, admire it, and re-create it in a second renderer at
 * export time.
 *
 * The usual approach — html2canvas or similar — is that second renderer, and
 * it is where these features rot: the export drifts from the preview one CSS
 * property at a time, nobody notices because the preview looks right, and the
 * thing people actually post is the wrong one. Here the preview IS the export.
 * There is one drawing and one file, and what somebody sees before they press
 * copy is the bytes they get.
 *
 * It also happens to be the only version that works here at all. The site's
 * CSP is `script-src 'self'`, so there is no third-party rasteriser to load.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT MAY GO ON IT
 *
 * Only what the fold accepted. A card is made from one call that counted, or
 * from a position built out of calls that counted, and every number on it is
 * one the market page shows too. Nothing here computes a figure of its own,
 * because a card is the thing that travels furthest from the page that could
 * be used to check it, and a number that only exists on the card is a number
 * nobody can dispute.
 */

const W = 1200;
const H = 675;

/* One place for the colours, so the card and the page cannot drift apart.
   These are the market page's own values, not near-misses. */
const C = {
  ink: "#EAF7FB",
  dim: "#93B6C0",
  faint: "#6E9BA8",
  blue: "#58E9FF",
  yes: "#3BE3B0",
  yesLit: "#8CF6D8",
  no: "#F2B33D",
  noLit: "#FFD489",
  gold: "#F2B33D",
};

const DISPLAY = '"Outfit", system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

/**
 * WAIT FOR THE REAL FACES.
 *
 * Canvas does not queue work behind a webfont the way layout does. Draw one
 * millisecond early and every word on the card is set in the fallback, the
 * export is silently wrong, and it looks fine on the machine of whoever built
 * it because their browser had the fonts cached. So the faces are asked for by
 * name and waited on, and a failure is not fatal: a card in the fallback face
 * beats no card at all.
 */
/* THE SUBJECT'S OWN MARK. Loaded from this origin, which matters for more
   than tidiness: an image from anywhere else taints the canvas and every
   toBlob on it throws, so the card could be drawn and never exported. Held in
   a variable rather than fetched per draw, and a failure is survivable — the
   lockup falls back to the wordmark alone. */
let flopMark = null;
function loadMark() {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => { flopMark = im; res(); };
    im.onerror = () => res();
    im.src = "/img/flop.png";
  });
}

let fontsReady = null;
export function loadFonts() {
  if (fontsReady) return fontsReady;
  const want = [
    `800 64px "Outfit"`, `700 34px "Outfit"`, `600 22px "Outfit"`, `400 20px "Outfit"`,
    `600 20px "IBM Plex Mono"`, `500 16px "IBM Plex Mono"`,
  ];
  fontsReady = (async () => {
    try {
      if (!document.fonts) { await loadMark(); return; }
      await Promise.all([...want.map((f) => document.fonts.load(f).catch(() => {})), loadMark()]);
      await document.fonts.ready;
    } catch { /* fallback face, still a card */ }
  })();
  return fontsReady;
}

const round = (g, x, y, w, h, r) => {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
};

const group = (n) => Math.round(n).toLocaleString("en-US");

/* ── THE GROUND ────────────────────────────────────────────────────────────
   Four layers, none of them a stock "glassmorphism" panel: a cold vertical
   gradient, a bloom behind the object, a printed dot grid, and a vignette
   that stops the corners floating. The grid is the site's own background
   pattern at the card's scale — the thing that makes it read as Overheard
   from across a timeline rather than as a generic dark rectangle. */
function ground(g, side) {
  const lit = side === "no" ? C.no : side === "yes" ? C.yes : C.blue;

  const sky = g.createLinearGradient(0, 0, W * 0.25, H);
  sky.addColorStop(0, "#06141C");
  sky.addColorStop(0.55, "#031016");
  sky.addColorStop(1, "#01080C");
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);

  /* The bloom sits behind where the ring will be, so the object appears to be
     lighting the card rather than pasted onto it. */
  const bloom = g.createRadialGradient(1002, 372, 30, 1002, 372, 330);
  bloom.addColorStop(0, hexA(lit, 0.15));
  bloom.addColorStop(0.45, hexA(lit, 0.05));
  bloom.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = bloom;
  g.fillRect(0, 0, W, H);

  /* ── THE TEXTURE ──────────────────────────────────────────────────────
     Three registers of the same lattice, which is what stops a dark rectangle
     reading as a dark rectangle. A fine dot field at the site's own pitch; a
     coarser rule grid at five times that, faint enough to be felt rather than
     read; and a tick at every crossing of it. Printed, not generated — a
     fixed pitch from a fixed origin, so two exports of one call are the same
     file. Random noise would make every card different and none of them
     reproducible. */
  const PITCH = 24;
  g.fillStyle = "rgba(88,233,255,.085)";
  for (let y = PITCH; y < H; y += PITCH) {
    for (let x = PITCH; x < W; x += PITCH) g.fillRect(x, y, 1.6, 1.6);
  }

  const LAT = PITCH * 5;
  g.strokeStyle = "rgba(88,233,255,.045)";
  g.lineWidth = 1;
  g.beginPath();
  for (let x = LAT; x < W; x += LAT) { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); }
  for (let y = LAT; y < H; y += LAT) { g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); }
  g.stroke();

  g.strokeStyle = "rgba(88,233,255,.14)";
  g.beginPath();
  for (let x = LAT; x < W; x += LAT) {
    for (let y = LAT; y < H; y += LAT) {
      g.moveTo(x - 4, y + 0.5); g.lineTo(x + 4, y + 0.5);
      g.moveTo(x + 0.5, y - 4); g.lineTo(x + 0.5, y + 4);
    }
  }
  g.stroke();

  /* A single raking hairline across the top third. One stroke, and it does
     more for "premium" than any amount of blur. */
  const rake = g.createLinearGradient(0, 0, W, H * 0.5);
  rake.addColorStop(0, "rgba(255,255,255,0)");
  rake.addColorStop(0.5, "rgba(255,255,255,.05)");
  rake.addColorStop(1, "rgba(255,255,255,0)");
  g.strokeStyle = rake;
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, 176); g.lineTo(W, 88); g.stroke();

  const vign = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 1.05);
  vign.addColorStop(0, "rgba(0,0,0,0)");
  vign.addColorStop(1, "rgba(0,0,0,.4)");
  g.fillStyle = vign;
  g.fillRect(0, 0, W, H);

  /* The edge, and the one line of colour that says which side this is. */
  g.strokeStyle = "rgba(88,233,255,.14)";
  g.lineWidth = 2;
  round(g, 1, 1, W - 2, H - 2, 28);
  g.stroke();

  const edge = g.createLinearGradient(64, 0, W - 64, 0);
  edge.addColorStop(0, hexA(lit, 0));
  edge.addColorStop(0.5, hexA(lit, 0.85));
  edge.addColorStop(1, hexA(lit, 0));
  g.fillStyle = edge;
  g.fillRect(64, 0, W - 128, 3);
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ── THE MARK ──────────────────────────────────────────────────────────────
   Drawn rather than loaded. An <img> is one more thing that can be missing at
   the moment the canvas is read back, and a card exported without its logo is
   worse than one that took two lines of geometry to draw. */
function mark(g, x, y, s) {
  const grd = g.createLinearGradient(x, y, x + s, y + s);
  grd.addColorStop(0, "#33D6F5");
  grd.addColorStop(1, "#00A9CE");
  g.fillStyle = grd;
  round(g, x, y, s, s, s * 0.3);
  g.fill();
  g.fillStyle = "#00070A";
  round(g, x + s * 0.3, y + s * 0.3, s * 0.4, s * 0.4, s * 0.12);
  g.fill();
}

/* ── THE OBJECT ────────────────────────────────────────────────────────────
   The market's own ring, at the split it actually stood at. The side this card
   is about is drawn at full strength and the other side is dimmed, so the card
   says "here is where I stood, and here is where the room stood" in one shape
   without a word of explanation. */
function ring(g, cx, cy, share, side) {
  const R = 104;
  const gap = 0.055;

  g.save();
  g.translate(cx, cy);

  g.strokeStyle = "rgba(88,233,255,.10)";
  g.lineWidth = 1;
  for (const [r, dash] of [[R + 34, [1.5, 9]], [R + 17, null], [R - 40, [2, 7]]]) {
    g.beginPath();
    g.setLineDash(dash ?? []);
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.stroke();
  }
  g.setLineDash([]);

  g.strokeStyle = "rgba(147,182,192,.13)";
  g.lineWidth = 11;
  g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.stroke();

  if (share !== null) {
    const start = -Math.PI / 2;
    const yEnd = start + share * Math.PI * 2;
    g.lineCap = "round";
    g.lineWidth = 11;

    /* BOTH SIDES AT THEIR OWN COLOUR. An earlier version dimmed whichever side
       the card was not about, to say "mine". It did not need to — the claim is
       now the largest thing on the card and says it far better — and amber at
       low alpha over this ground goes olive, which looks like a rendering
       fault rather than emphasis. Held a little under full strength so the
       ring stays context and does not compete with the hero. */
    if (share > 0.004) {
      g.strokeStyle = hexA(C.yes, 0.8);
      g.beginPath(); g.arc(0, 0, R, start + gap / 2, yEnd - gap / 2); g.stroke();
    }
    if (share < 0.996) {
      g.strokeStyle = hexA(C.no, 0.8);
      g.beginPath(); g.arc(0, 0, R, yEnd + gap / 2, start + Math.PI * 2 - gap / 2); g.stroke();
    }
    g.lineCap = "butt";
  }

  g.fillStyle = "rgba(2,11,15,.72)";
  g.beginPath(); g.arc(0, 0, R - 24, 0, Math.PI * 2); g.fill();
  g.strokeStyle = "rgba(88,233,255,.14)";
  g.lineWidth = 1;
  g.beginPath(); g.arc(0, 0, R - 24, 0, Math.PI * 2); g.stroke();

  g.textAlign = "center";
  if (share === null) {
    g.fillStyle = C.dim;
    g.font = `600 20px ${MONO}`;
    g.fillText("FIRST", 0, -4);
    g.fillStyle = C.faint;
    g.font = `500 15px ${MONO}`;
    g.fillText("on the board", 0, 22);
  } else {
    g.fillStyle = C.dim;
    g.font = `700 42px ${DISPLAY}`;
    g.fillText(`${Math.round(share * 100)}%`, 0, 6);
    g.fillStyle = C.faint;
    g.font = `500 15px ${MONO}`;
    g.fillText("THE ROOM", 0, 30);
  }
  g.restore();
}

/**
 * Draw one card.
 *
 * `card` is the finished thing to print, assembled by whoever knows the market
 * — never worked out in here. This function does no arithmetic beyond
 * rounding, on purpose: two renderers computing the same payout two ways is
 * how a card ends up disagreeing with the page it came from.
 *
 *   kind    "call" (one call) or "position" (where somebody stands)
 *   side    "yes" | "no" | null   null only ever means both sides at once
 *   put     paper on this card
 *   pays    the multiple if it is right, or null when there is no single one
 *   left    paper still in the purse
 *   when    Date of the call, or of the latest one in a position
 *   share   the room's yes share at the time, 0..1, or null for an empty board
 *   who     short did, or null to keep the key off it
 *   calls   how many calls a position is made of
 */
export function drawCard(canvas, card, scale = 2) {
  const g = canvas.getContext("2d");
  canvas.width = W * scale;
  canvas.height = H * scale;
  g.setTransform(scale, 0, 0, scale, 0, 0);
  g.clearRect(0, 0, W, H);
  g.textBaseline = "alphabetic";

  const { kind, side, put, pays, left, when, share, who, calls, yes, no } = card;
  const lit = side === "no" ? C.noLit : side === "yes" ? C.yesLit : C.blue;

  ground(g, side);

  /* ── THE HEAD RAIL: TWO MARKS, AND THEY MEAN DIFFERENT THINGS ──────────
     Who made this on the left, what it is about on the right. Keeping them at
     opposite ends is the whole point — a card carrying both logos side by
     side would read as a partnership, and this page has nothing to do with
     Flop Labs. Somebody scrolling past should know in one glance that this
     concerns FLOP, and know just as quickly who is saying so. */
  mark(g, 64, 54, 38);
  g.textAlign = "left";
  g.fillStyle = C.ink;
  g.font = `700 25px ${DISPLAY}`;
  g.fillText("Overheard", 114, 81);
  g.fillStyle = C.gold;
  g.font = `600 12px ${MONO}`;
  g.fillText("PAPER MARKET · NOTHING OF VALUE MOVES", 114, 102);

  /* No caption under this one. The question below already names the date and
     the foot rail carries the deadline; a third telling of it here only made
     the line long enough to run under its own logo. */
  const fx = W - 64;
  g.textAlign = "right";
  g.fillStyle = C.ink;
  g.font = `700 30px ${DISPLAY}`;
  g.fillText("FLOP", fx, 88);
  const fw = g.measureText("FLOP").width;
  if (flopMark) {
    const s2 = 46;
    const lx = fx - fw - 16 - s2;
    g.save();
    round(g, lx, 54, s2, s2, 12);
    g.clip();
    g.drawImage(flopMark, lx, 54, s2, s2);
    g.restore();
    g.strokeStyle = "rgba(88,233,255,.22)";
    g.lineWidth = 1;
    round(g, lx + 0.5, 54.5, s2 - 1, s2 - 1, 12);
    g.stroke();
  }

  /* ── THE OBJECT, DEMOTED ─────────────────────────────────────────────────
     It used to be the biggest, brightest thing here, and it was the wrong
     thing: the room's opinion, on a card about one person's. Smaller, cooler
     and pushed to the corner, it is what it should always have been — the
     context the claim was made against. */
  ring(g, 1002, 372, share, side);

  /* ── THE HERO: WHAT THEY SAID, AND HOW MUCH ─────────────────────────────
     A word, not a token. "YES" is the field name in the frame; "IT SHIPS" is
     what the person actually claimed, and a card is read by people who have
     never seen this market. The stake sits directly under it because the two
     together are the whole boast — a claim with nothing behind it is a
     tweet, and a claim with paper on it is a position. */
  g.textAlign = "left";
  const x = 64;

  g.fillStyle = C.faint;
  g.font = `600 14px ${MONO}`;
  g.fillText(kind === "position" ? "WHERE I STAND" : "MY CALL", x, 196);

  if (kind === "position" && side === null) {
    /* Both sides at once has no headline and must not be given one. Averaging
       them into a single claim would be the card saying something nobody
       said. */
    g.fillStyle = C.ink;
    g.font = `800 66px ${DISPLAY}`;
    g.fillText("BOTH SIDES", x, 272);

    g.font = `800 44px ${DISPLAY}`;
    g.fillStyle = C.yesLit;
    g.fillText(group(yes), x, 344);
    let w = g.measureText(group(yes)).width;
    g.fillStyle = C.faint;
    g.font = `600 19px ${MONO}`;
    g.fillText("ON YES", x + w + 13, 344);

    g.font = `800 44px ${DISPLAY}`;
    g.fillStyle = C.noLit;
    g.fillText(group(no), x, 402);
    w = g.measureText(group(no)).width;
    g.fillStyle = C.faint;
    g.font = `600 19px ${MONO}`;
    g.fillText("ON NO", x + w + 13, 402);
  } else {
    const claim = side === "yes" ? "IT SHIPS" : "IT DOES NOT";
    g.fillStyle = lit;
    g.font = `800 ${side === "yes" ? 104 : 88}px ${DISPLAY}`;
    g.fillText(claim, x, 300);

    g.fillStyle = C.ink;
    g.font = `800 52px ${DISPLAY}`;
    g.fillText(group(put), x, 372);
    const pw = g.measureText(group(put)).width;
    g.fillStyle = C.dim;
    g.font = `600 22px ${MONO}`;
    g.fillText(kind === "position" ? "PAPER ON IT" : "PAPER ON IT", x + pw + 14, 372);

    g.fillStyle = C.faint;
    g.font = `400 22px ${DISPLAY}`;
    g.fillText(pays === null
      ? "on both sides, so there is no single multiple"
      : `pays ×${pays.toFixed(2)} if I am right`, x, 412);
  }

  /* ── the question it is an answer to ─────────────────────────────────── */
  g.strokeStyle = "rgba(88,233,255,.13)";
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(x, 452); g.lineTo(x + 92, 452); g.stroke();

  g.fillStyle = C.dim;
  g.font = `500 22px ${DISPLAY}`;
  wrap(g, "Will Flop Labs ship mainnet by 31 March 2027?", x, 494, 600, 31);

  /* ── the foot rail ───────────────────────────────────────────────────── */
  g.strokeStyle = "rgba(88,233,255,.13)";
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(x, H - 112); g.lineTo(W - 64, H - 112); g.stroke();

  const cells = [
    [kind === "position" ? "CALLS" : "MADE",
     kind === "position" ? String(calls) : stamp(when)],
    ["PAPER LEFT", group(left)],
  ];
  if (who) cells.push(["SIGNED", who]);

  let cx = x;
  for (const [k, v] of cells) {
    g.fillStyle = C.faint;
    g.font = `500 13px ${MONO}`;
    g.fillText(k, cx, H - 76);
    g.fillStyle = C.ink;
    g.font = `600 19px ${MONO}`;
    g.fillText(v, cx, H - 48);
    cx += Math.max(150, g.measureText(v).width + 56);
  }

  g.textAlign = "right";
  g.fillStyle = C.blue;
  g.font = `600 17px ${MONO}`;
  g.fillText("overheard-five.vercel.app/market", W - 64, H - 48);
  g.fillStyle = C.faint;
  g.font = `500 13px ${MONO}`;
  g.fillText("SIGNED IN A PUBLIC ROOM · ANYONE CAN CHECK IT", W - 64, H - 76);

  return canvas;
}

/* In UTC and said so, for the same reason the page is: one instant for
   everybody, and a card that travels does not get to be read in the reader's
   own zone as a different day. */
function stamp(d) {
  if (!(d instanceof Date) || isNaN(d)) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function wrap(g, text, x, y, max, lh) {
  const words = text.split(" ");
  let line = "", ly = y;
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (g.measureText(t).width > max && line) { g.fillText(line, x, ly); line = w; ly += lh; }
    else line = t;
  }
  if (line) g.fillText(line, x, ly);
}

export const CARD_W = W;
export const CARD_H = H;

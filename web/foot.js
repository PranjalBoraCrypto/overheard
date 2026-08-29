/**
 * <overheard-foot> — the footer, once, and the same one everywhere.
 *
 * WHY THIS IS A COMPONENT
 *
 * The same reason the bar is. There were four footers: the card page's, a
 * copy on Rooms that had drifted to a different layout, a full-bleed one on
 * Create written to escape that page's 760px column, and an older one on
 * Verify that predated all of them. Every round of "make it match the home
 * page" fixed one of the four.
 *
 * So it lives in a shadow root, where page CSS cannot reach it — not by
 * element, not by class, not with !important — and `:host{all:initial}` stops
 * inheritance crossing too.
 *
 * TWO THINGS THIS VERSION FIXES.
 *
 * The band now runs the full width of the window while its contents stay on
 * the site's 1180px column, so the footer reads as the floor of the page
 * rather than as one more block sitting on it.
 *
 * And the gap above it belongs to the footer, not to the page. Every page was
 * responsible for leaving room, so /create and /city left none at all and the
 * card page's last section overlapped it by 28 pixels — measured. A margin on
 * the host fixes all of them at once, and fixes every page written after this
 * one without anybody having to remember.
 *
 * The links come from nav.js, which is also where the bar gets its tabs. Add
 * a page there and it appears in both.
 */

import { PAGES, ELSEWHERE, BUILDER_DID, X_GLYPH, ensureFont, iconSVG } from "/nav.js";

const CSS = `
:host{
  all:initial;
  display:block;
  font-family:"Outfit",system-ui,-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased;
  color:#5F8593;
}
*{box-sizing:border-box;margin:0;padding:0}
/* THE GAP ABOVE THE FOOTER LIVES HERE, AND HERE IS THE ONLY PLACE IT CAN.
   It was on :host, and it did nothing: every page in this site opens with a
   universal reset — margin zero on everything — that rule matches the host
   element because the host is in
   the page's own tree, and a normal declaration from the outer tree beats a
   :host declaration whatever its specificity. Measured: computed margin-top
   0px on all six pages. Inside the shadow root no page rule can reach it, so
   the gap is the same everywhere and every page written after this one gets
   it without knowing. */
.band{
  margin-top:clamp(64px,7vw,116px);
  border-top:1px solid rgba(16,57,74,.9);
  background:linear-gradient(rgba(3,17,24,0),rgba(3,17,24,.55) 40%,rgba(2,12,17,.92));
}
.wrap{max-width:1180px;margin:0 auto;padding:0 26px}
.top{
  display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;
  gap:34px 48px;padding:44px 0 34px;
}
.brandcol{flex:1 1 300px;max-width:420px}
.col{flex:0 0 auto}
a{color:#9CBFCB;text-decoration:none}
a:focus-visible{outline:2px solid #5FEBFF;outline-offset:3px;border-radius:6px}

/* ── the brand column ──────────────────────────────────────────────────── */
.brand{display:inline-flex;align-items:center;gap:11px;color:#EDFAFE;font-weight:800;font-size:19px;letter-spacing:-.02em}
.brand .glyph{width:30px;height:30px;flex:none;display:block}
.brand .glyph svg{width:100%;height:100%;display:block}
.said{margin-top:13px;font-size:13.5px;line-height:1.65;max-width:34ch;color:#5F8593}
.said b{color:#9CBFCB;font-weight:600}

/* ── the link columns ──────────────────────────────────────────────────── */
h4{
  font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;
  font-size:9.5px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;
  color:#3F6272;margin-bottom:13px;
}
ul{list-style:none;display:flex;flex-direction:column;gap:2px}
li a{
  display:flex;align-items:center;gap:10px;padding:6px 9px;margin-left:-9px;border-radius:9px;
  font-size:13.5px;font-weight:600;line-height:1.3;
  transition:color .22s cubic-bezier(.22,.68,.24,1),background .22s cubic-bezier(.22,.68,.24,1);
}
li a .i{width:15px;height:15px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;
  stroke-linecap:round;stroke-linejoin:round;opacity:.5;
  transition:opacity .22s,transform .22s cubic-bezier(.22,.68,.24,1)}
li a .x{width:13px;height:13px;flex:none;fill:currentColor;stroke:none;opacity:.55;transition:opacity .22s}
li a .note{font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:10px;color:#3F6272;
  letter-spacing:.04em;white-space:nowrap;
  /* Slides out from under the label on hover rather than sitting there as a
     second column of text: the label is the thing, the note is the answer to
     "what is that". */
  max-width:0;opacity:0;overflow:hidden;
  transition:max-width .32s cubic-bezier(.22,.68,.24,1),opacity .22s,padding-left .32s cubic-bezier(.22,.68,.24,1)}
li a:hover .note,li a:focus-visible .note{max-width:180px;opacity:1;padding-left:10px}
li a:hover{color:#5FEBFF;background:rgba(0,180,215,.09)}
li a:hover .i{opacity:1;transform:translateX(1px)}
li a:hover .x{opacity:1}
li a[aria-current="page"]{color:#5FEBFF}
li a[aria-current="page"] .i{opacity:1}

/* ── the credit line ───────────────────────────────────────────────────── */
.by{
  border-top:1px solid rgba(16,57,74,.55);
  padding:16px 0 46px;
  display:flex;align-items:center;gap:14px 20px;flex-wrap:wrap;
  font-size:13px;
}
.who{display:inline-flex;align-items:center;gap:9px}
.who .xlink{
  display:inline-flex;align-items:center;gap:7px;padding:5px 12px 5px 10px;border-radius:999px;
  color:#CDEAF3;font-weight:700;font-size:13px;
  background:rgba(0,180,215,.09);border:1px solid rgba(0,180,215,.24);
  transition:background .22s cubic-bezier(.22,.68,.24,1),border-color .22s,transform .22s;
}
.who .xlink svg{width:12px;height:12px;fill:currentColor;flex:none}
.who .xlink:hover{background:rgba(0,180,215,.17);border-color:rgba(95,235,255,.5);transform:translateY(-1px)}
.did{
  margin-left:auto;
  font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;
  font-size:11.5px;font-weight:500;color:#3F6272;letter-spacing:.2px;
  word-break:break-all;transition:color .22s cubic-bezier(.22,.68,.24,1);
}
.did:hover{color:#00B4D7}

@media (max-width:900px){
  .top{gap:30px 32px;padding:38px 0 30px}
  .brandcol{flex:1 1 100%;max-width:none}
}
@media (max-width:560px){
  .col{flex:1 1 100%}
  li a .note{max-width:180px;opacity:1;padding-left:10px}   /* no hover on a phone */
  .did{margin-left:0;width:100%}
  .by{padding-bottom:38px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

const GLYPH = `
<svg viewBox="0 0 48 48" aria-hidden="true">
  <defs><linearGradient id="fg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#5FEBFF"/><stop offset=".55" stop-color="#00B4D7"/><stop offset="1" stop-color="#0080A6"/>
  </linearGradient></defs>
  <rect x="1" y="1" width="46" height="46" rx="14" fill="url(#fg)"/>
  <rect x="16" y="16" width="16" height="16" rx="5" fill="#00070A"/>
</svg>`;

/**
 * Break out of whatever column the page put this in.
 *
 * The footer has to look the same on a 680px page and an 1180px one, so it
 * cannot inherit its width from its parent. `width:100vw` is the usual trick
 * and it is wrong here: 100vw includes the scrollbar, and the bar reserves a
 * stable scrollbar gutter, so it would hang a few pixels past the document
 * and give every page a sideways scroll.
 *
 * Measured instead. `documentElement.clientWidth` is the viewport WITHOUT the
 * scrollbar, and the element's own offset from the left edge is what has to
 * be undone. Recomputed on resize, and on nothing else.
 */
function spanViewport(el) {
  const fit = () => {
    el.style.marginLeft = "0px";
    el.style.width = "auto";
    const full = document.documentElement.clientWidth;
    /* A document with no width yet — an offscreen frame, a page still laying
       out — would otherwise be handed a 0px footer. Leave it in the flow and
       try again on the next frame; the natural width is wrong but visible,
       which a zero-width footer is not. */
    if (!(full > 320)) { requestAnimationFrame(fit); return; }
    const left = el.getBoundingClientRect().left;
    el.style.marginLeft = `${-left}px`;
    el.style.width = `${full}px`;
  };
  fit();
  addEventListener("resize", fit, { passive: true });
  // Fonts landing late change the page's width; one more pass covers it.
  document.fonts?.ready?.then(fit).catch(() => {});
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function linkRow(href, label, iconName, note, { external = false, x = false, current = false } = {}) {
  const li = document.createElement("li");
  const a = document.createElement("a");
  a.href = href;
  if (external) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
  if (current) a.setAttribute("aria-current", "page");
  a.innerHTML = x
    ? `<svg class="x" viewBox="0 0 24 24" aria-hidden="true">${X_GLYPH}</svg>`
    : iconSVG(iconName);                       // our own markup, no outside input
  a.append(el("span", null, label));
  if (note) a.append(el("span", "note", note));
  li.append(a);
  return li;
}

class OverheardFoot extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    ensureFont();

    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;

    const band = el("footer", "band");   // a real landmark, not a div
    const wrap = el("div", "wrap");
    const top = el("div", "top");

    /* the brand */
    const bcol = el("div", "brandcol");
    const brand = document.createElement("a");
    brand.className = "brand";
    brand.href = "/";
    const g = el("span", "glyph");
    g.innerHTML = GLYPH;                        // our own markup
    brand.append(g, document.createTextNode("Overheard"));
    const said = el("p", "said");
    said.append(
      document.createTextNode("An independent window on "),
      Object.assign(document.createElement("b"), { textContent: "Technocore" }),
      document.createTextNode("’s agent network. Not affiliated with it, and it never asks for your key."),
    );
    bcol.append(brand, said);

    /* the pages, from the one list the bar also reads */
    const path = location.pathname.replace(/\/+$/, "") || "/";
    const pcol = el("div", "col");
    pcol.append(el("h4", null, "The site"));
    const pul = document.createElement("ul");
    for (const p of PAGES) {
      pul.append(linkRow(p.href, p.label, p.icon, p.blurb, { current: p.match(path) }));
    }
    pcol.append(pul);

    /* off the site */
    const ecol = el("div", "col");
    ecol.append(el("h4", null, "Elsewhere"));
    const eul = document.createElement("ul");
    for (const e of ELSEWHERE) {
      eul.append(linkRow(e.href, e.label, "out", e.note, { external: true, x: !!e.x }));
    }
    ecol.append(eul);

    top.append(bcol, pcol, ecol);

    /* the credit */
    const by = el("div", "by");
    const who = el("span", "who");
    who.append(document.createTextNode("Built by"));
    const me = document.createElement("a");
    me.className = "xlink";
    me.href = ELSEWHERE.find((e) => e.x)?.href || "https://x.com/Crypto_Pranjal";
    me.target = "_blank"; me.rel = "noopener noreferrer";
    me.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${X_GLYPH}</svg>`;
    me.append(el("span", null, "Pranjal Bora"));
    who.append(me);

    const did = document.createElement("a");
    did.className = "did";
    did.href = "/?did=" + encodeURIComponent(BUILDER_DID);
    did.title = "Open this card";
    did.textContent = BUILDER_DID;

    by.append(who, did);

    wrap.append(top, by);
    band.append(wrap);
    root.append(style, band);
    spanViewport(this);
  }
}

customElements.define("overheard-foot", OverheardFoot);

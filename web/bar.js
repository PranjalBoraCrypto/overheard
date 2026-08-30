/**
 * <overheard-bar> — the top bar, once.
 *
 * WHY THIS IS A COMPONENT AND NOT FOUR COPIES OF SOME CSS
 *
 * The bar has been "unified" twice already and drifted both times, because
 * four identical copies of a rule are still four things that can rot
 * independently. Worse, each page's own stylesheet kept reaching into it:
 * `header{justify-content:space-between}` applied because the bar is a
 * <header>, `header nav a{margin-left:26px}` applied because it contains a
 * <nav>, and each page's font stack changed the wordmark's width, which moved
 * every right-aligned tab.
 *
 * So the bar now lives in a SHADOW ROOT. Page CSS cannot select into a shadow
 * root at all — not by element, not by class, not with !important. The one
 * thing that does cross the boundary is inheritance, and `:host{all:initial}`
 * stops that too. Whatever a page does to its own styles, this renders the
 * same.
 *
 * It also guarantees its own typeface. A wordmark rendered in a fallback is
 * a different width from one rendered in Outfit, and a different width moves
 * the tabs; leaving that to each page to remember is how it broke last time.
 */

import { getSession, getVault, signIn, signOut, onSession, shortDid, hueOf, openVault, saveVault,
         readSeed, keyFromSeed, sealVault, PW_MIN } from "/session.js";
import { PAGES, FONT_HREF, faceSVG } from "/nav.js";

/* The tabs are the pages that asked to be tabs, from the one list the footer
   also reads. `hot` marks a tab as worth noticing without pretending it is
   the page you are on: a live dot and a hairline outline, never the active
   tab's fill. The active state still wins when you are actually there. */
const TABS = PAGES.filter((p) => p.bar);

const CSS = `
:host{
  /* Reset everything the page could pass down by inheritance — font, colour,
     letter-spacing, text-transform. Then set only what this bar needs. */
  all:initial;
  display:block;
  position:relative;
  z-index:50;
  font-family:"Outfit",system-ui,-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased;
}
*{box-sizing:border-box;margin:0;padding:0}
.wrap{max-width:1180px;margin:0 auto;padding:0 26px}
.bar{
  display:flex;align-items:center;justify-content:flex-start;gap:16px;
  padding:22px 0;flex-wrap:wrap;
}
/* Inherited properties are the one thing that crosses a shadow boundary, and
   a host reset of all:initial LOSES to a page rule like *{...!important} that
   hits the host element itself. Tested: a hostile text-transform:uppercase
   with !important got through and shouted the wordmark. So every inheritable
   property this bar cares about is stated on the bar's own elements too.
   (No backticks anywhere in here: this whole block is a template literal,
   and one stray backtick ends the string and takes the file with it.) */
.wrap,.bar,.brand,.tabs,.tabs a{
  text-transform:none;font-style:normal;font-variant:normal;
  word-spacing:normal;text-indent:0;text-shadow:none;
}
.brand{
  display:flex;align-items:center;gap:12px;text-decoration:none;
  font-family:inherit;font-weight:700;font-size:22px;line-height:1;
  letter-spacing:-.02em;color:#EDFAFE;white-space:nowrap;
}
.glyph{width:36px;height:36px;flex:none;position:relative;display:block}
.glyph svg{width:100%;height:100%;display:block;filter:drop-shadow(0 0 15px rgba(0,180,215,.7))}
.glyph::after{
  content:"";position:absolute;inset:-7px;border-radius:16px;z-index:-1;
  filter:blur(5px);opacity:.7;
  background:conic-gradient(from 0deg,transparent,rgba(0,180,215,.55),transparent 55%);
  animation:spin 6s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}
.tabs{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}
.tabs a{
  font-family:inherit;font-size:13.5px;font-weight:600;line-height:1;
  color:#9CBFCB;text-decoration:none;padding:10px 15px;border-radius:11px;
  letter-spacing:0;text-transform:none;border:0;margin:0;display:inline-block;
  white-space:nowrap;transition:color .25s cubic-bezier(.22,.68,.24,1),background .25s cubic-bezier(.22,.68,.24,1);
}
.tabs a:hover{color:#5FEBFF;background:rgba(0,180,215,.09)}
/* The highlighted tab. An inset ring rather than a border, so it cannot
   change the height of one tab and break the row's baseline. */
.tabs a[data-hot]{
  color:#5FEBFF;background:rgba(0,180,215,.10);
  box-shadow:inset 0 0 0 1px rgba(0,180,215,.42);
  display:inline-flex;align-items:center;gap:7px;
}
.tabs a[data-hot]::before{
  content:"";width:5px;height:5px;border-radius:50%;flex:none;
  background:#5FEBFF;box-shadow:0 0 7px #5FEBFF;animation:barbeat 2.4s cubic-bezier(.22,.68,.24,1) infinite;
}
@keyframes barbeat{50%{opacity:.3}}
.tabs a[aria-current="page"]{
  color:#001016;background:linear-gradient(120deg,#5FEBFF,#00B4D7);
  box-shadow:0 10px 26px -14px rgba(0,180,215,1);
}
.tabs a[data-hot][aria-current="page"]::before{background:#001016;box-shadow:none;animation:none}
.tabs a:focus-visible,.brand:focus-visible{outline:2px solid #5FEBFF;outline-offset:3px}

/* ── testnet, when there is one ────────────────────────────────────────────
   A label, not a control. It says what is coming without pretending to be a
   place you can go, so it takes the shape of a status pill rather than a tab:
   no hover lift, no pointer cursor, and a dot that breathes slowly enough to
   read as "warming up" rather than "live". */
.soon{
  display:inline-flex;align-items:center;gap:8px;flex:none;margin-left:6px;
  padding:8px 12px;border-radius:11px;cursor:default;user-select:none;
  font-family:inherit;font-size:12.5px;font-weight:600;line-height:1;color:#5F8593;
  background:rgba(9,32,43,.6);border:1px dashed rgba(0,180,215,.28);
}
.soon .i{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;
  stroke-linecap:round;stroke-linejoin:round;opacity:.7}
.soon b{font-weight:700;color:#9CBFCB}
.soon .tag{
  font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:9px;font-weight:600;
  letter-spacing:.13em;text-transform:uppercase;color:#3F6272;
  padding:3px 6px;border-radius:6px;background:rgba(0,180,215,.08);
}
@media (max-width:760px){.soon{display:none}}

/* ── the way in ────────────────────────────────────────────────────────────
   Signed out, every page looked the same as signed in, and the only routes to
   an identity were buried inside two other pages. This is the one button that
   is always in the same place. */
.in{
  display:inline-flex;align-items:center;gap:11px;flex:none;margin-left:10px;
  padding:10px 15px;border-radius:11px;cursor:pointer;
  font-family:inherit;font-size:13.5px;font-weight:700;line-height:1;color:#001016;
  background:linear-gradient(120deg,#5FEBFF,#00B4D7 60%,#0093BC);border:0;
  box-shadow:0 12px 28px -16px rgba(0,180,215,1);
  transition:transform .25s cubic-bezier(.22,.68,.24,1),box-shadow .25s cubic-bezier(.22,.68,.24,1);
}
.in:hover{transform:translateY(-2px);box-shadow:0 18px 34px -16px rgba(0,180,215,1)}
.in:active{transform:translateY(0)}
.in:focus-visible{outline:2px solid #5FEBFF;outline-offset:3px}
/* The label is 700; the glyph is weighted to match it. A 2px stroke beside
   bold text reads as a lighter typeface sitting inside the same button. */
.in .i{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:2.5;
  stroke-linecap:round;stroke-linejoin:round}
.inwrap{position:relative;flex:none}
.pw{
  display:flex;gap:7px;margin-top:11px;
}
.pw input{
  flex:1 1 auto;min-width:0;font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:12px;
  padding:10px 11px;border-radius:10px;color:#EDFAFE;
  background:rgba(0,7,10,.75);border:1px solid rgba(0,180,215,.22);outline:none;
  transition:border-color .2s,box-shadow .2s;
}
.pw input:focus{border-color:#00B4D7;box-shadow:0 0 0 4px rgba(0,180,215,.12)}
.pw button{
  flex:none;padding:0 14px;border-radius:10px;border:0;cursor:pointer;
  font-family:inherit;font-size:12.5px;font-weight:700;color:#001016;
  background:linear-gradient(120deg,#5FEBFF,#00B4D7);
  transition:transform .2s cubic-bezier(.22,.68,.24,1)}
.pw button:hover{transform:translateY(-1px)}
.pw button:disabled{opacity:.6;cursor:default;transform:none}
.say{font-size:11.5px;line-height:1.5;color:#5F8593;margin-top:9px;min-height:1.2em}
.say.err{color:#FF9B9B}
.say.ok{color:#3BE3B0}

/* ── the seed route, for a browser holding nothing ─────────────────────────
   Reported, and correct: with no vault here the popover still opened on a
   passphrase box. There was nothing for that passphrase to unlock — it could
   not succeed on any input — and the only route that could was two clicks
   further down, behind a file most people do not have. So an empty browser
   now opens on the seed, which is the thing every Technocore identity has
   however it was made, and the passphrase it asks for is one being SET. */
.seed{margin-top:11px}
.seed textarea{
  display:block;width:100%;height:66px;resize:vertical;
  font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:11px;line-height:1.55;
  padding:10px 11px;border-radius:10px;color:#EDFAFE;
  background:rgba(0,7,10,.75);border:1px solid rgba(0,180,215,.22);outline:none;
  transition:border-color .2s,box-shadow .2s;
}
.seed textarea:focus{border-color:#00B4D7;box-shadow:0 0 0 4px rgba(0,180,215,.12)}
/* The DID appears the moment the paste can produce one. It is the clearest
   possible confirmation that the seed pasted is the seed meant, and it costs
   nothing but arithmetic this browser was going to do anyway. */
.sdid{
  margin-top:7px;padding:7px 9px;border-radius:9px;
  font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:9.5px;line-height:1.5;
  color:#5FEBFF;word-break:break-all;background:rgba(0,180,215,.07);
  border:1px solid rgba(0,180,215,.2);
}
.sdid:empty{display:none}
.two{display:flex;gap:7px;margin-top:7px}
.two input{
  flex:1 1 0;min-width:0;font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:11.5px;
  padding:10px 11px;border-radius:10px;color:#EDFAFE;
  background:rgba(0,7,10,.75);border:1px solid rgba(0,180,215,.22);outline:none;
  transition:border-color .2s,box-shadow .2s;
}
.two input:focus{border-color:#00B4D7;box-shadow:0 0 0 4px rgba(0,180,215,.12)}
.seal{
  width:100%;margin-top:8px;padding:11px 14px;border-radius:11px;border:0;cursor:pointer;
  font-family:inherit;font-size:13px;font-weight:700;line-height:1;color:#001016;
  background:linear-gradient(120deg,#5FEBFF,#00B4D7 60%,#0093BC);
  box-shadow:0 12px 28px -16px rgba(0,180,215,1);
  transition:transform .2s cubic-bezier(.22,.68,.24,1)}
.seal:hover:not(:disabled){transform:translateY(-1px)}
.seal:disabled{opacity:.55;cursor:default;transform:none}

/* ── the i ─────────────────────────────────────────────────────────────────
   A claim about where somebody's key goes is exactly the claim a fake of this
   site would also make, so it is not enough to assert it in small grey type
   and move on. It is a control you press, and what it opens says the specific
   mechanical truth — what is read, what is derived, what is stored, what is
   sent — rather than the word "secure". */
.hrow{display:flex;align-items:center;gap:8px;margin-top:12px}
.menu .hrow:first-child{margin-top:0}
.hrow h3{margin:0}
.iq{
  width:19px;height:19px;flex:none;margin-left:auto;border-radius:50%;cursor:pointer;
  display:grid;place-items:center;padding:0;
  background:rgba(0,180,215,.12);border:1px solid rgba(0,180,215,.3);color:#5FEBFF;
  transition:background .2s,border-color .2s}
.iq:hover,.iq[aria-expanded="true"]{background:rgba(0,180,215,.26);border-color:#5FEBFF}
.iq svg{width:11px;height:11px;fill:none;stroke:currentColor;stroke-width:2.6;
  stroke-linecap:round;stroke-linejoin:round}
.note{
  margin-top:9px;padding:10px 11px;border-radius:11px;
  font-size:11px;line-height:1.6;color:#9CBFCB;
  background:rgba(0,180,215,.06);border:1px solid rgba(0,180,215,.18);
}
.note b{color:#CDEAF3;font-weight:600}
.note ul{margin:6px 0 0;padding-left:15px}
.note li{margin-top:3px}

/* ── who you are, on every page ────────────────────────────────────────────
   The identity was legible on exactly one screen — the compose box of the
   Rooms page, and only while you were looking at it. Everywhere else a signed
   in browser looked identical to a signed out one, which is how somebody ends
   up entering a passphrase they had already entered.

   So the bar carries it: the face from the card, the two ends of the DID, and
   a menu with the whole thing, a copy, the way to the card and a sign out. It
   is present only when there IS a session, and it takes no room at all
   otherwise. */
.me{position:relative;margin-left:10px;flex:none}
.me:empty{display:none}
/* The sign-in popover reuses the profile menu's surface, so the two never
   drift apart visually — one card, two contents. */
.me .in{margin-left:0}
.chip{
  display:flex;align-items:center;gap:9px;padding:5px 11px 5px 5px;border-radius:999px;cursor:pointer;
  font-family:inherit;font-size:12.5px;font-weight:600;line-height:1;color:#CDEAF3;
  background:rgba(0,180,215,.10);border:1px solid rgba(0,180,215,.28);
  transition:border-color .25s cubic-bezier(.22,.68,.24,1),background .25s cubic-bezier(.22,.68,.24,1),transform .25s cubic-bezier(.22,.68,.24,1);
}
.chip:hover{background:rgba(0,180,215,.17);border-color:rgba(95,235,255,.5);transform:translateY(-1px)}
.chip:focus-visible{outline:2px solid #5FEBFF;outline-offset:3px}
.chip .face{width:28px;height:28px;border-radius:9px;flex:none;display:block}
.chip .nm{font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:11.5px;letter-spacing:.02em;white-space:nowrap}
.chip .car{width:9px;height:9px;flex:none;opacity:.6;transition:transform .3s cubic-bezier(.22,.68,.24,1)}
.me.open .chip .car{transform:rotate(180deg)}
.menu{
  position:absolute;top:calc(100% + 10px);right:0;width:300px;z-index:60;
  padding:15px;border-radius:16px;
  background:linear-gradient(rgba(5,24,33,.98),rgba(3,15,21,.98));
  border:1px solid rgba(0,180,215,.30);
  box-shadow:0 30px 70px -30px rgba(0,0,0,.95),0 0 0 1px rgba(0,0,0,.4);
  transform-origin:top right;
  animation:pop .28s cubic-bezier(.2,.9,.3,1.2) both;
}
@keyframes pop{from{opacity:0;transform:scale(.92) translateY(-6px)}}
/* The seed view carries a textarea and two side-by-side fields; 300 makes
   "passphrase, 6+" and "again" both ellipsise. Only that view is wider. */
.menu.wide{width:344px}
.menu h3{
  font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:9.5px;font-weight:600;
  letter-spacing:.16em;text-transform:uppercase;color:#5F8593;margin-bottom:8px;
}
.did{
  font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:10.5px;line-height:1.65;
  color:#9CBFCB;word-break:break-all;background:rgba(0,0,0,.42);
  border:1px solid rgba(0,180,215,.16);border-radius:10px;padding:9px 11px;
}
.menu button.row,.menu a.row{
  display:flex;align-items:center;gap:10px;width:100%;margin-top:6px;padding:10px 11px;border-radius:11px;
  background:none;border:0;cursor:pointer;text-decoration:none;text-align:left;
  font-family:inherit;font-size:13px;font-weight:600;line-height:1;color:#CDEAF3;
  transition:background .2s cubic-bezier(.22,.68,.24,1),color .2s cubic-bezier(.22,.68,.24,1);
}
.menu .row:first-of-type{margin-top:11px}
.menu .row svg{width:15px;height:15px;flex:none;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;opacity:.75}
.menu .row:hover{background:rgba(0,180,215,.12);color:#5FEBFF}
.menu .row.out{color:#9CBFCB;margin-top:9px;border-top:1px solid rgba(0,180,215,.14);border-radius:0 0 11px 11px;padding-top:12px}
.menu .row.out:hover{background:rgba(255,107,107,.10);color:#FF9B9B}
.menu .fine{font-size:11px;line-height:1.5;color:#5F8593;margin-top:10px}
@media (prefers-reduced-motion:reduce){.glyph::after{animation:none}.menu{animation:none}}
@media (max-width:560px){
  .bar{gap:10px}
  .tabs{margin-left:0;width:100%}
  .tabs a{padding:9px 12px;font-size:13px}
  .me{margin-left:0;order:-1}
  .menu,.menu.wide{width:min(344px,calc(100vw - 52px))}
}
`;

const GLYPH = `
<svg viewBox="0 0 48 48" aria-hidden="true">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#5FEBFF"/><stop offset=".55" stop-color="#00B4D7"/><stop offset="1" stop-color="#0080A6"/>
  </linearGradient></defs>
  <rect x="1" y="1" width="46" height="46" rx="14" fill="url(#g)"/>
  <rect x="16" y="16" width="16" height="16" rx="5" fill="#00070A"/>
</svg>`;


const ICONS = {
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>',
  card: '<svg viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="M7 10h4M7 14h7"/></svg>',
  rooms: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 1 1-3.2-6.4"/><path d="M8 20l-4 1 1-4"/><path d="M9 11h6M9 15h4"/></svg>',
  out: '<svg viewBox="0 0 24 24"><path d="M15 17l5-5-5-5"/><path d="M20 12H9"/><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6"/></svg>',
  caret: '<svg class="car" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  info: '<svg viewBox="0 0 24 24"><path d="M12 11v6"/><path d="M12 7.4v.1"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  key: '<svg class="i" viewBox="0 0 24 24"><circle cx="8" cy="14.5" r="4"/><path d="M10.9 11.6 20 2.5"/><path d="M16.8 5.7 19 7.9M14.4 8.1l2.2 2.2"/></svg>',
  flask: '<svg class="i" viewBox="0 0 24 24"><path d="M9.5 3.5v6L4.9 17a2 2 0 0 0 1.7 3h10.8a2 2 0 0 0 1.7-3l-4.6-7.5v-6"/><path d="M8 3.5h8"/><path d="M7.2 14h9.6"/></svg>',
  spark: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4"/><path d="M6.4 6.4 9 9M15 15l2.6 2.6M17.6 6.4 15 9M9 15l-2.6 2.6"/></svg>',
};

/** Load the bar's typeface if the host page has not. Document-level, because
 *  @font-face inside a shadow root does not apply to it. */
function ensureFont() {
  const has = [...document.querySelectorAll('link[rel="stylesheet"]')]
    .some((l) => l.href.includes("fonts.googleapis.com") && l.href.includes("family=Outfit"));
  if (has) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = FONT_HREF;
  document.head.appendChild(link);
}

/* ── the scrollbars, everywhere ────────────────────────────────────────────
   A dark instrument panel with a light grey operating-system scrollbar down
   the side of it looks like two different programs. This is document-level
   rather than per-page for the reason the bar itself is a component: four
   copies of a rule are four things that rot separately.

   Firefox takes the two-value `scrollbar-color`; Chromium and Safari take the
   shadow parts. Both land on the same thin cyan rail, and the thumb keeps a
   transparent border clipped to the padding box so it reads as inset rather
   than filling the gutter. */
const SCROLLBARS = `
*{scrollbar-width:thin;scrollbar-color:rgba(0,180,215,.42) transparent}
::-webkit-scrollbar{width:11px;height:11px}
::-webkit-scrollbar-track{background:rgba(0,7,10,.5)}
::-webkit-scrollbar-thumb{background:linear-gradient(rgba(0,180,215,.55),rgba(0,120,160,.55));
  border-radius:99px;border:3px solid transparent;background-clip:padding-box}
::-webkit-scrollbar-thumb:hover{background:linear-gradient(rgba(95,235,255,.85),rgba(0,180,215,.85));
  border:3px solid transparent;background-clip:padding-box}
::-webkit-scrollbar-corner{background:transparent}
`;
function styleScrollbars() {
  if (document.getElementById("oh-scrollbars")) return;
  const st = document.createElement("style");
  st.id = "oh-scrollbars";
  st.textContent = SCROLLBARS;
  document.head.appendChild(st);
}

/** Right-aligned tabs follow the viewport width, and the viewport width moves
 *  when a page is long enough to need a scrollbar. Reserve it always, so the
 *  bar cannot shift between a long page and a short one. */
function stabiliseGutter() {
  document.documentElement.style.scrollbarGutter = "stable";
}

class OverheardBar extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    ensureFont();
    stabiliseGutter();
    styleScrollbars();

    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;

    const wrap = document.createElement("div");
    wrap.className = "wrap";
    const bar = document.createElement("header");
    bar.className = "bar";

    const brand = document.createElement("a");
    brand.className = "brand";
    brand.href = "/";
    const glyph = document.createElement("span");
    glyph.className = "glyph";
    glyph.innerHTML = GLYPH;                 // our own markup, no outside input
    brand.append(glyph, document.createTextNode("Overheard"));

    const nav = document.createElement("nav");
    nav.className = "tabs";
    nav.setAttribute("aria-label", "Sections");

    // `active` can be set explicitly; otherwise it is derived from the path,
    // so a page cannot forget to update it when it is copied.
    const explicit = (this.getAttribute("active") || "").toLowerCase();
    const path = location.pathname.replace(/\/+$/, "") || "/";
    for (const t of TABS) {
      const a = document.createElement("a");
      a.href = t.href;
      a.textContent = t.label;
      const on = explicit ? explicit === t.label.toLowerCase() : t.match(path);
      if (on) a.setAttribute("aria-current", "page");
      if (t.hot) a.setAttribute("data-hot", "");
      nav.appendChild(a);
    }

    /* Coming, and saying so. A dashed pill reads as "not yet" in a way that a
       greyed-out tab does not — a greyed tab reads as broken. */
    const soon = document.createElement("span");
    soon.className = "soon";
    soon.title = "A Technocore testnet view is being built. Nothing to click yet.";
    soon.innerHTML = ICONS.flask;                    // our own markup
    soon.append(Object.assign(document.createElement("b"), { textContent: "Testnet" }));
    soon.append(Object.assign(document.createElement("span"), { className: "tag", textContent: "soon" }));

    const me = document.createElement("div");
    me.className = "me";
    me.hidden = true;

    bar.append(brand, nav, soon, me);
    wrap.appendChild(bar);
    root.append(style, wrap);

    this._paintMe = () => paintMe(me, root);
    this._paintMe();
    this._off = onSession(this._paintMe);
  }

  disconnectedCallback() { this._off?.(); }
}

/* ── signed out ────────────────────────────────────────────────────────────
   One button, in the same place on every page, that does the whole job where
   the visitor is standing rather than sending them to a page that has a form
   on it.

   TWO STATES, AND THEY ASK DIFFERENT QUESTIONS.

     · this browser holds a vault → a passphrase that EXISTS, and unlocking it
       is the whole flow.

     · it holds nothing → a seed, and a passphrase being SET. There is nothing
       here to unlock, so there is nothing for an "enter your passphrase" box
       to do; it was shown anyway, and it could not succeed on any input a
       person could type. That was the bug. The seed is the honest question
       for an empty browser: every Technocore identity has one, however it was
       made, while a backup file only exists if this site made the identity
       and the person still has the download.

   In both states the work happens here, in this tab. The seed is read here,
   the key is derived here by the browser's own Ed25519, the vault is sealed
   here under 310,000 PBKDF2 rounds, and none of the three ever crosses the
   network. The `i` beside the heading says exactly that, in those terms,
   because "secure" is a word a fake of this page would also use. */
function paintSignIn(me) {
  const btn = document.createElement("button");
  btn.className = "in";
  btn.type = "button";
  btn.setAttribute("aria-haspopup", "dialog");
  btn.setAttribute("aria-expanded", "false");
  btn.innerHTML = ICONS.key;                        // our own markup
  btn.append(Object.assign(document.createElement("span"), { textContent: "Sign in" }));
  me.appendChild(btn);

  let menu = null;
  const close = () => {
    menu?.remove(); menu = null;
    me.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
    removeEventListener("pointerdown", away, true);
    removeEventListener("keydown", esc, true);
  };
  const away = (e) => { if (!e.composedPath().includes(me)) close(); };
  const esc = (e) => { if (e.key === "Escape") { close(); btn.focus(); } };

  /* The vault being unlocked. Null means there is nothing here to unlock and
     the popover asks for a seed instead; a file chosen from the seed view
     fills it in and swaps the popover over. It lives outside `open` so the
     choice survives a re-render. */
  let picked = null;
  let noteOpen = false;

  /* One shared file input. Kept out of the render so choosing a file does not
     have to survive the element being rebuilt around it. */
  const file = document.createElement("input");
  file.type = "file";
  file.accept = "application/json,.json";
  file.hidden = true;

  const open = () => {
    picked = getVault();
    menu = document.createElement("div");
    menu.className = "menu";
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", "Sign in");
    me.appendChild(menu);
    me.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    addEventListener("pointerdown", away, true);
    addEventListener("keydown", esc, true);
    render();
  };

  /** Both views, from one function, because "I have a backup file instead"
   *  and "I do not have one after all" are the same popover changing its
   *  mind rather than two dialogs. */
  function render(focusOn) {
    if (!menu) return;
    menu.replaceChildren();
    menu.classList.toggle("wide", !picked);

    const say = document.createElement("p");
    say.className = "say";

    /* the heading, and the honest answer beside it */
    const hrow = document.createElement("div");
    hrow.className = "hrow";
    const h = document.createElement("h3");
    h.textContent = picked ? "Welcome back" : "No identity here yet";
    const iq = document.createElement("button");
    iq.className = "iq"; iq.type = "button";
    iq.setAttribute("aria-label", "Where does this go?");
    iq.setAttribute("aria-expanded", String(noteOpen));
    iq.innerHTML = ICONS.info;                        // our own markup
    hrow.append(h, iq);
    menu.append(hrow);

    const note = document.createElement("div");
    note.className = "note";
    note.hidden = !noteOpen;
    /* Built as elements, not markup, and written as mechanics rather than
       reassurance. Every line here is something a reader could check in the
       network tab of their own browser. */
    const nb = document.createElement("b");
    nb.textContent = "Your data never leaves this browser.";
    const ul = document.createElement("ul");
    for (const t of picked ? [
      "The encrypted backup is already in this browser's storage. Nothing is fetched to sign you in.",
      "Your passphrase is turned into a decryption key here, by this tab, over 310,000 rounds.",
      "The key is decrypted in memory on this device. It is never uploaded, and Overheard has no account to upload it to.",
      "Messages you post are signed here; only the signature is sent.",
    ] : [
      "Your seed is read in this tab. It is not sent anywhere, and it is not kept after the key is derived.",
      "The browser's own Ed25519 turns it into your key, so the DID below is worked out on this device.",
      "Your passphrase encrypts that key here, over 310,000 rounds, before anything is written to storage.",
      "Nothing is uploaded. Overheard has no account and no server that could hold a key.",
    ]) {
      ul.append(Object.assign(document.createElement("li"), { textContent: t }));
    }
    note.append(nb, ul);
    menu.append(note);
    iq.addEventListener("click", () => {
      noteOpen = !noteOpen;
      note.hidden = !noteOpen;
      iq.setAttribute("aria-expanded", String(noteOpen));
    });

    /* ── there is something here to unlock ────────────────────────────── */
    if (picked) {
      const did = document.createElement("div");
      did.className = "did";
      did.textContent = picked.did;                  // text, never markup
      menu.append(did);

      const row = document.createElement("div");
      row.className = "pw";
      const pw = document.createElement("input");
      pw.type = "password";
      pw.autocomplete = "current-password";
      pw.placeholder = "passphrase";
      const go = document.createElement("button");
      go.type = "button";
      go.textContent = "Unlock";
      row.append(pw, go);

      const tryIt = async () => {
        if (!pw.value) { say.className = "say err"; say.textContent = "Enter your passphrase."; return; }
        go.disabled = true;
        say.className = "say"; say.textContent = "Decrypting on this device…";
        try {
          const jwk = await openVault(picked, pw.value);
          saveVault(picked);
          signIn(picked.did, jwk);                   // repaints this bar, and every page listening
        } catch {
          say.className = "say err";
          say.textContent = "Wrong passphrase, or that file is not a backup from here.";
          go.disabled = false;
        }
      };
      go.addEventListener("click", tryIt);
      pw.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); tryIt(); } });
      menu.append(row, say);

      menu.append(fileRow("Use a different backup file", say));
      menu.append(makeRow("Make another identity"));
      menu.append(fine("Decrypted here, on this device. Your key is never sent anywhere."));
      if (focusOn !== "none") setTimeout(() => pw.focus(), 30);
      return;
    }

    /* ── nothing here: the seed ───────────────────────────────────────── */
    const box = document.createElement("div");
    box.className = "seed";
    const seed = document.createElement("textarea");
    seed.spellcheck = false;
    seed.autocapitalize = "off";
    seed.setAttribute("aria-label", "Your seed");
    seed.placeholder = "Paste your seed — 64 hex characters. The whole identity .txt works too.";
    const sdid = document.createElement("div");
    sdid.className = "sdid";
    box.append(seed, sdid);

    const two = document.createElement("div");
    two.className = "two";
    const p1 = document.createElement("input");
    p1.type = "password"; p1.autocomplete = "new-password";
    p1.placeholder = `passphrase, ${PW_MIN}+`;
    const p2 = document.createElement("input");
    p2.type = "password"; p2.autocomplete = "new-password";
    p2.placeholder = "again";
    two.append(p1, p2);

    const seal = document.createElement("button");
    seal.className = "seal"; seal.type = "button";
    seal.textContent = "Encrypt it and sign in";

    /* The DID the moment the paste can produce one. Debounced, because the
       derivation is real work and a person pasting 64 characters generates a
       lot of input events on the way. */
    let t = 0;
    seed.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const bytes = readSeed(seed.value);
        if (!bytes) { sdid.textContent = ""; return; }
        try { sdid.textContent = (await keyFromSeed(bytes)).did; }   // text, never markup
        catch { sdid.textContent = ""; }
      }, 250);
    });

    const bring = async () => {
      const bytes = readSeed(seed.value);
      if (!bytes) { say.className = "say err"; say.textContent = "That is not a seed yet — it is 64 hex characters."; return; }
      if (p1.value.length < PW_MIN) { say.className = "say err"; say.textContent = `Choose a passphrase of at least ${PW_MIN} characters.`; return; }
      if (p1.value !== p2.value) { say.className = "say err"; say.textContent = "The two passphrases do not match."; return; }
      seal.disabled = true;
      say.className = "say"; say.textContent = "Working out the identity, on this device…";
      try {
        const { did, jwk } = await keyFromSeed(bytes);
        say.textContent = "Encrypting it here…";
        const vault = await sealVault(did, jwk, p1.value);
        saveVault(vault);
        seed.value = ""; p1.value = p2.value = "";
        signIn(did, jwk);                            // repaints this bar, and every page listening
      } catch (err) {
        say.className = "say err";
        say.textContent = "That seed did not produce a key: " + (err?.message || err);
        seal.disabled = false;
      }
    };
    seal.addEventListener("click", bring);
    p2.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); bring(); } });

    menu.append(box, two, seal, say);
    menu.append(fileRow("I have a backup file instead", say));
    menu.append(makeRow("Make an identity"));
    /* THE PROMISE STAYS VISIBLE. The `i` above carries the mechanics, but the
       one sentence that matters is not allowed to be behind a control — a
       claim somebody has to press for is a claim they will not read. */
    menu.append(fine("Read, derived and encrypted in this tab. Your seed and your key are never sent anywhere."));
    if (focusOn !== "none") setTimeout(() => seed.focus(), 30);
  }

  /** The backup-file route, from either view. Choosing a valid one fills
   *  `picked` and re-renders as the unlock view, which is the same journey
   *  the file was always taking, one step shorter. */
  function fileRow(label, say) {
    const pick = document.createElement("button");
    pick.className = "row"; pick.type = "button";
    pick.innerHTML = ICONS.file;                      // our own markup
    pick.append(Object.assign(document.createElement("span"), { textContent: label }));
    pick.addEventListener("click", () => file.click());
    file.onchange = async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        const v = JSON.parse(await f.text());
        if (!v?.did || !v?.data || !v?.salt || !v?.iv) throw new Error("shape");
        picked = v;
        render();
      } catch {
        say.className = "say err";
        say.textContent = "That file is not an Overheard backup.";
      }
      file.value = "";
    };
    const wrap = document.createDocumentFragment();
    wrap.append(pick, file);
    return wrap;
  }

  function makeRow(label) {
    const a = document.createElement("a");
    a.className = "row";
    a.href = "/create.html";
    a.innerHTML = ICONS.spark;                        // our own markup
    a.append(Object.assign(document.createElement("span"), { textContent: label }));
    return a;
  }

  function fine(text) {
    const p = document.createElement("p");
    p.className = "fine";
    p.textContent = text;
    return p;
  }

  btn.addEventListener("click", () => (menu ? close() : open()));
}

/* One place decides whether there is anybody to show, so the chip cannot
   drift out of step with the session — sign out in another tab and this is
   repainted by the same call that repaints the page under it. */
function paintMe(me, root) {
  const s = getSession();
  me.replaceChildren();
  me.classList.remove("open");
  me.hidden = false;
  if (!s) return paintSignIn(me);

  const chip = document.createElement("button");
  chip.className = "chip";
  chip.type = "button";
  chip.setAttribute("aria-haspopup", "menu");
  chip.setAttribute("aria-expanded", "false");
  chip.innerHTML = faceSVG(hueOf(s.did)) + ICONS.caret;   // our own markup only
  const nm = document.createElement("span");
  nm.className = "nm";
  nm.textContent = shortDid(s.did);
  chip.insertBefore(nm, chip.lastChild);
  chip.title = s.did;
  me.appendChild(chip);

  let menu = null;
  const close = () => {
    menu?.remove(); menu = null;
    me.classList.remove("open");
    chip.setAttribute("aria-expanded", "false");
    removeEventListener("pointerdown", away, true);
    removeEventListener("keydown", esc, true);
  };
  const away = (e) => { if (!e.composedPath().includes(me)) close(); };
  const esc = (e) => { if (e.key === "Escape") { close(); chip.focus(); } };

  const open = () => {
    menu = document.createElement("div");
    menu.className = "menu";
    menu.setAttribute("role", "menu");

    const h = document.createElement("h3");
    h.textContent = "Signed in as";
    const did = document.createElement("div");
    did.className = "did";
    did.textContent = s.did;                 // text, never markup

    const copy = document.createElement("button");
    copy.className = "row"; copy.type = "button"; copy.setAttribute("role", "menuitem");
    copy.innerHTML = ICONS.copy;
    const clabel = document.createElement("span");
    clabel.textContent = "Copy this DID";
    copy.appendChild(clabel);
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(s.did); } catch {}
      clabel.textContent = "Copied";
      setTimeout(() => { clabel.textContent = "Copy this DID"; }, 1600);
    });

    const card = document.createElement("a");
    card.className = "row"; card.setAttribute("role", "menuitem");
    card.href = "/?did=" + encodeURIComponent(s.did);
    card.innerHTML = ICONS.card;
    card.appendChild(Object.assign(document.createElement("span"), { textContent: "See my card" }));

    const rooms = document.createElement("a");
    rooms.className = "row"; rooms.setAttribute("role", "menuitem");
    rooms.href = "/rooms";
    rooms.innerHTML = ICONS.rooms;
    rooms.appendChild(Object.assign(document.createElement("span"), { textContent: "Go to rooms" }));

    const out = document.createElement("button");
    out.className = "row out"; out.type = "button"; out.setAttribute("role", "menuitem");
    out.innerHTML = ICONS.out;
    out.appendChild(Object.assign(document.createElement("span"), { textContent: "Sign out" }));
    out.addEventListener("click", () => { close(); signOut(); });

    /* The honest half of staying signed in. This browser is holding the key
       unlocked so a refresh does not ask again — worth saying on the menu
       that ends in the button which undoes it. */
    const fine = document.createElement("p");
    fine.className = "fine";
    fine.textContent = "This browser is holding your key unlocked so you stay signed in. Sign out when you are done on a shared computer.";

    menu.append(h, did, copy, card, rooms, out, fine);
    me.appendChild(menu);
    me.classList.add("open");
    chip.setAttribute("aria-expanded", "true");
    addEventListener("pointerdown", away, true);
    addEventListener("keydown", esc, true);
  };

  chip.addEventListener("click", () => (menu ? close() : open()));
}

customElements.define("overheard-bar", OverheardBar);

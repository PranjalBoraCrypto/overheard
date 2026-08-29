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

import { getSession, signOut, onSession, shortDid, hueOf } from "/session.js";

const FONT_HREF =
  "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap";

/* `hot` marks a tab as worth noticing without pretending it is the page you
   are on: a live dot and a hairline outline, never the active tab's fill.
   The active state still wins when you are actually there. */
const TABS = [
  { href: "/",            label: "Card",   match: (p) => p === "/" || p === "/index.html" },
  { href: "/rooms",       label: "Rooms",  match: (p) => p.startsWith("/rooms") },
  { href: "/city",        label: "City",   match: (p) => p.startsWith("/city"), hot: true },
  { href: "/create.html", label: "Create", match: (p) => p.startsWith("/create") },
  { href: "/v",           label: "Verify", match: (p) => p === "/v" || p.startsWith("/v.html") },
  { href: "/play",        label: "Play",   match: (p) => p.startsWith("/play") },
];

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
  .menu{width:min(300px,calc(100vw - 52px))}
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

/* The face from the card, small enough for a chip: the same rounded head,
   visor and ears, tinted by the same hue the card and the message stream
   derive from the key. Two identities are never the same colour by accident,
   and yours is the one you learn to recognise. */
let faceSeq = 0;
function faceSVG(hue) {
  const id = `f${++faceSeq}`;
  return `<svg class="face" viewBox="0 0 40 40" aria-hidden="true">
  <defs>
    <linearGradient id="${id}a" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue.toFixed(0)} 90% 68%)"/>
      <stop offset="1" stop-color="hsl(${(hue - 22).toFixed(0)} 92% 40%)"/>
    </linearGradient>
    <linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsl(${hue.toFixed(0)} 100% 78%)"/>
      <stop offset="1" stop-color="hsl(${hue.toFixed(0)} 100% 62%)"/>
    </linearGradient>
  </defs>
  <rect x="2" y="9" width="4" height="12" rx="2" fill="url(#${id}a)" opacity=".75"/>
  <rect x="34" y="9" width="4" height="12" rx="2" fill="url(#${id}a)" opacity=".75"/>
  <rect x="5" y="4" width="30" height="30" rx="10" fill="url(#${id}a)"/>
  <rect x="10" y="11" width="20" height="13" rx="6" fill="#031015" opacity=".92"/>
  <rect x="13.5" y="16" width="13" height="3" rx="1.5" fill="url(#${id}b)"/>
</svg>`;
}

const ICONS = {
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>',
  card: '<svg viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="M7 10h4M7 14h7"/></svg>',
  rooms: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 1 1-3.2-6.4"/><path d="M8 20l-4 1 1-4"/><path d="M9 11h6M9 15h4"/></svg>',
  out: '<svg viewBox="0 0 24 24"><path d="M15 17l5-5-5-5"/><path d="M20 12H9"/><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6"/></svg>',
  caret: '<svg class="car" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
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

    const me = document.createElement("div");
    me.className = "me";
    me.hidden = true;

    bar.append(brand, nav, me);
    wrap.appendChild(bar);
    root.append(style, wrap);

    this._paintMe = () => paintMe(me, root);
    this._paintMe();
    this._off = onSession(this._paintMe);
  }

  disconnectedCallback() { this._off?.(); }
}

/* One place decides whether there is anybody to show, so the chip cannot
   drift out of step with the session — sign out in another tab and this is
   repainted by the same call that repaints the page under it. */
function paintMe(me, root) {
  const s = getSession();
  me.replaceChildren();
  me.classList.remove("open");
  me.hidden = !s;
  if (!s) return;

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

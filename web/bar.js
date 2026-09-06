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
import { PAGES, FONT_HREF, faceSVG, iconSVG } from "/nav.js";

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
/* While a sheet is open. 50 is the right height for a bar; it is the wrong
   height for a full-screen scrim, and a page is free to paint above it.

   ── THE NAME IS NAMESPACED, AND THAT IS NOT FUSSINESS ────────────────────
   This class was called 'sheet'. deal.css has a '.sheet' of its own — an
   unrelated bottom-sheet component: position:fixed, bottom:0, z-index:60 —
   and a page's stylesheet always beats :host() on the host element. So on
   every page that loads deal.css, opening the profile menu put THE WHOLE BAR
   at the bottom of the screen, half off it. Reported as "the bar appears at
   the bottom of the page and hides", on desktop and on mobile.
   Nothing here was wrong in isolation and nothing errored. The bar reaches
   out of its shadow root exactly once, to set this class, and one word was
   enough to collide. Anything this component writes onto its own host is
   prefixed from now on. */
:host(.oh-lifted){z-index:9999}
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

/* ══════════════════════════════════════════════════════════════════════════
   THE PHONE NAVIGATION, WHICH USED TO HIDE HALF THE SITE
   ══════════════════════════════════════════════════════════════════════════

   REPORTED, with a screenshot: "the menu bar can't cover all pages names".
   Correct, and it was by design — six tabs need 472px, a phone row gets 308
   to 390, so the row scrolled sideways and the last two tabs lived past the
   edge. Everything that could be done to make a scrolling row admit that it
   scrolls had been done to it: a proportional fade at the ends, the current
   tab pulled into view, a one-time peek that demonstrated the gesture. The
   measurements say all three worked and none of them fixed the actual
   problem, because the actual problem is that a visitor cannot choose from a
   list they cannot see. Agent City — the best page on the site — came last
   in the first day of traffic at 9% of arrivals, in exactly tab order.

   So on a phone the row is gone and there is a button instead. One tap and
   every page in the site is on screen at once, with its one-line description,
   which is MORE than the strip ever showed: the explainer page is not a tab
   at all and had no route from the bar on any screen.

   WHY IT IS A SHEET AND NOT A DROPDOWN. The same reason the sign-in popover
   became one: a menu hanging off the top-right corner of a phone is anchored
   at the furthest point on the screen from a thumb. This reuses that sheet
   wholesale — same class, same animation, same scrim, same grab bar — so
   there is one bottom sheet in this bar and not two that look alike.

   AND NOTHING ABOVE 560px MOVES. The desktop bar is the row of tabs it has
   always been; the button is display:none there and its sheet can never
   open. */
.nb{position:relative;flex:none;display:none}
.burger{
  /* POSITION:RELATIVE IS LOAD-BEARING AND WAS MISSING. The three lines below
     are position:absolute, so without it they resolve against .nb -- which
     is the wrapper, not the button — and land against its top-left corner
     instead of in the middle of the square. The grid's place-items:center
     sets their static position, which is exactly what an absolutely
     positioned child uses when it has no offsets, so the centring was written
     and simply never applied. Same shape as the two colour names this project
     used and never declared: nothing errors, nothing warns, it just looks
     wrong. The dot in ::after was landing on the wrapper for the same reason. */
  position:relative;
  display:grid;place-items:center;width:38px;height:38px;padding:0;
  border-radius:13px;cursor:pointer;
  color:#CDEAF3;background:rgba(0,180,215,.10);
  border:1px solid rgba(0,180,215,.28);
  transition:background .25s cubic-bezier(.22,.68,.24,1),border-color .25s cubic-bezier(.22,.68,.24,1);
}
.burger:focus-visible{outline:2px solid #5FEBFF;outline-offset:3px}
.nb.open .burger{background:rgba(0,180,215,.22);border-color:#5FEBFF;color:#5FEBFF}
/* Three lines that become an X. Two of the three do the work and the middle
   one fades, which is the cheapest version of this that still reads as one
   object changing rather than two icons swapping. */
.burger i{
  display:block;position:absolute;width:17px;height:2px;border-radius:2px;
  background:currentColor;
  transition:transform .3s cubic-bezier(.2,.9,.3,1.2),opacity .18s linear;
}
.burger i:nth-child(1){transform:translateY(-5.5px)}
.burger i:nth-child(3){transform:translateY(5.5px)}
.nb.open .burger i:nth-child(1){transform:rotate(45deg)}
.nb.open .burger i:nth-child(2){opacity:0}
.nb.open .burger i:nth-child(3){transform:rotate(-45deg)}
/* A visitor standing on a page that is not the one the button is next to has
   no other way to know which page that is, now the active tab is gone. The
   dot says "there is a current page in here" and the sheet says which. */
.burger::after{
  content:"";position:absolute;top:6px;right:6px;width:5px;height:5px;border-radius:50%;
  background:#5FEBFF;box-shadow:0 0 7px #5FEBFF;opacity:0;transition:opacity .25s;
}
.nb[data-hot] .burger::after{opacity:1}
.nb.open .burger::after{opacity:0}

/* ── the rows inside it ────────────────────────────────────────────────────
   A page per row, with the blurb the footer already carries. The blurb is
   the reason this is worth a tap: "Play" and "Create" are labels a first
   visitor cannot rank, and "Proof of Learning" and "Make an identity" are
   not. Two lines each, roomy, thumb-sized — this sheet has a whole screen
   to spend and the strip it replaces had 308 pixels. */
.prow{
  display:flex;align-items:center;gap:12px;width:100%;
  margin-top:6px;padding:9px 12px;border-radius:14px;
  text-decoration:none;text-align:left;
  background:rgba(0,180,215,.04);border:1px solid rgba(0,180,215,.10);
  transition:background .2s cubic-bezier(.22,.68,.24,1),border-color .2s cubic-bezier(.22,.68,.24,1);
}
.prow:first-of-type{margin-top:11px}
.prow:active{background:rgba(0,180,215,.14)}
.prow:focus-visible{outline:2px solid #5FEBFF;outline-offset:2px}
.pico{
  width:34px;height:34px;flex:none;border-radius:11px;display:grid;place-items:center;
  background:rgba(0,180,215,.10);border:1px solid rgba(0,180,215,.18);color:#5FEBFF;
}
.pico svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.8;
  stroke-linecap:round;stroke-linejoin:round;opacity:.9}
.ptxt{display:block;min-width:0;flex:1 1 auto}
.ptxt b{
  display:block;font-family:inherit;font-size:14.5px;font-weight:600;line-height:1.2;
  color:#EDFAFE;letter-spacing:-.01em;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.ptxt i{
  display:block;margin-top:3px;font-style:normal;
  font-size:11.5px;line-height:1.35;color:#5F8593;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
/* Where you are. A filled row rather than a coloured word, because the whole
   point of this sheet is that it is read at a glance. */
.prow[aria-current="page"]{
  background:rgba(0,180,215,.13);border-color:rgba(0,180,215,.42);
}
.prow[aria-current="page"] .ptxt b{color:#5FEBFF}
.prow[aria-current="page"] .pico{background:rgba(0,180,215,.22);border-color:rgba(95,235,255,.45)}
.pnow{
  width:7px;height:7px;flex:none;border-radius:50%;background:#5FEBFF;
  box-shadow:0 0 8px #5FEBFF;opacity:0;
}
.prow[aria-current="page"] .pnow{opacity:1}
/* The live dot the City tab carries on a desktop, kept here so the same page
   is marked the same way in both navigations. */
.prow[data-hot] .pnow{opacity:1;background:#3BE3B0;box-shadow:0 0 8px #3BE3B0;
  animation:barbeat 2.4s cubic-bezier(.22,.68,.24,1) infinite}
.prow[data-hot][aria-current="page"] .pnow{background:#5FEBFF;box-shadow:0 0 8px #5FEBFF;animation:none}
/* Testnet, which the desktop bar shows and the phone bar had no room for.
   It has room here. */
.nsoon{
  display:flex;align-items:center;gap:9px;margin-top:13px;padding:11px 13px;
  border-radius:13px;font-family:inherit;font-size:12.5px;font-weight:600;color:#5F8593;
  background:rgba(9,32,43,.55);border:1px dashed rgba(0,180,215,.24);
}
.nsoon svg{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;
  stroke-linecap:round;stroke-linejoin:round;opacity:.7}
.nsoon b{font-weight:700;color:#9CBFCB}
.nsoon .tag{
  margin-left:auto;font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:9px;
  font-weight:600;letter-spacing:.13em;text-transform:uppercase;color:#3F6272;
  padding:4px 7px;border-radius:6px;background:rgba(0,180,215,.08);
}

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
/* MEASURED, at every width from 360 to 1440. The bar needs 175px of wordmark,
   466px of tabs, 146px of Testnet pill and 152px of signed-in chip, plus three
   16px gaps: 987px of content, inside a wrapper that gives (viewport − 52).
   The old cut-off was 760, which is 279px short of that, and the result was a
   bar that wrapped onto three and four lines everywhere from 600px to 1024px —
   182px of navigation on a 600px screen before the page began. Below 1100 the
   pill is the thing that gives way, because it is the one element here that is
   a label rather than a route. */
@media (max-width:1099px){.soon{display:none}}

/* ── the way in ────────────────────────────────────────────────────────────
   Signed out, every page looked the same as signed in, and the only routes to
   an identity were buried inside two other pages. This is the one button that
   is always in the same place. */
.in{
  display:inline-flex;align-items:center;gap:11px;flex:none;margin-left:10px;
  /* ONE HEIGHT FOR EVERY CONTROL ON THIS ROW. Signed out this button was
     36px and the signed-in chip was 40, so the bar was 80px tall for a
     stranger and 84 for somebody signed in — the whole page under it moved
     four pixels down the moment you signed in, on every page of the site.
     The button, the chip and the phone's menu button are all 38 now. */
  height:38px;padding:0 15px;border-radius:11px;cursor:pointer;
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

/* ── the seed, offered rather than opened ──────────────────────────────────
   Below the passphrase, closed, because the passphrase is the route that
   works for everybody who remembers it. The row and its info button are one line so
   that opening the explanation never moves the thing it explains. */
.alt{display:flex;align-items:center;gap:8px;margin-top:10px}
.altbtn{
  flex:1 1 auto;min-width:0;text-align:left;padding:9px 11px;border-radius:10px;cursor:pointer;
  font-family:inherit;font-size:12px;font-weight:600;line-height:1.3;color:#9CBFCB;
  background:rgba(0,180,215,.05);border:1px solid rgba(0,180,215,.18);
  transition:background .2s,border-color .2s,color .2s;
}
.altbtn:hover{background:rgba(0,180,215,.11);border-color:rgba(0,180,215,.34);color:#CDEAF3}
.altbtn:focus-visible{outline:2px solid #5FEBFF;outline-offset:2px}
/* The circle matches the one in the header so the two read as the same
   control; the button around it is bigger, because 19px is a fine target for
   a cursor and a poor one for a thumb. */
.tipq{
  flex:none;width:34px;height:34px;padding:0;border:0;background:none;cursor:pointer;
  display:grid;place-items:center;
}
.tipq::before{
  content:"i";
  width:19px;height:19px;border-radius:50%;display:grid;place-items:center;
  font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:11px;font-weight:600;
  color:#5FEBFF;background:rgba(0,180,215,.12);border:1px solid rgba(0,180,215,.3);
  transition:background .2s,border-color .2s;
}
.tipq:hover::before,.tipq[aria-expanded="true"]::before{background:rgba(0,180,215,.26);border-color:#5FEBFF}
.tipq:focus-visible{outline:2px solid #5FEBFF;outline-offset:2px}
/* A phone has no hover, so the tip has to be readable when it is TAPPED —
   which means it is a block in the flow, not a floating bubble that would
   need somewhere to float to inside a 300px card. */
.tip{
  margin-top:8px;padding:10px 12px;border-radius:11px;
  font-size:11px;line-height:1.6;color:#9CBFCB;
  background:rgba(0,180,215,.06);border:1px solid rgba(0,180,215,.18);
}
.tip b{display:block;color:#CDEAF3;font-weight:600}
.tip ul{margin:6px 0 0;padding-left:15px}
.tip li{margin-top:4px}

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
  display:flex;align-items:center;gap:9px;height:38px;padding:0 11px 0 5px;border-radius:999px;cursor:pointer;
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
  /* 344 is wider than the gap beside a 360px phone's edges, and the card is
     anchored right, so without this the left edge goes off-screen and the
     seed textarea with it. Cap first, then let .wide ask for more. */
  max-width:calc(100vw - 24px);
  max-height:calc(100vh - 96px);overflow-y:auto;overscroll-behavior:contain;
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

/* ── ON A PHONE THIS IS NOT A DROPDOWN, IT IS A SHEET ──────────────────────
 *
 * REPORTED, and correct: the card was the desktop object made narrow enough
 * to fit. Fitting is not designing. A menu hanging off the button you clicked
 * is right for a cursor and wrong for a thumb — it pins itself to the TOP
 * RIGHT corner, which is the furthest point on a phone from where a hand
 * actually is, and the moment a field takes focus the keyboard rises and
 * covers the form being filled in.
 *
 * So on a phone it comes up from the bottom edge instead: full width, thumb
 * where the controls are, and the keyboard pushes it up rather than burying
 * it. Same markup, same behaviour, same colours — one object presented two
 * ways. Nothing in the JS knows this exists, which is the point: two layouts
 * that share no code are two layouts that drift.
 */
@media (max-width:560px){
  .menu{
    position:fixed;
    /* 100vw rather than left:0;right:0. The bar's own wrapper is a containing
       block for this, so stretching between two insets gives the wrapper's
       338px content width on a 390px phone rather than the screen. A viewport
       unit does not care what the containing block is. */
    left:0; right:auto; bottom:0; top:auto;
    width:100vw; max-width:100vw; margin:0;
    max-height:min(86vh,720px);
    /* Room for the home indicator on the phones that have one, and none on
       the ones that do not. */
    padding:20px 18px calc(20px + env(safe-area-inset-bottom,0px));
    border-radius:22px 22px 0 0;
    border-bottom:0;
    transform-origin:bottom center;
    animation:sheet .3s cubic-bezier(.2,.9,.3,1.2) both;
    box-shadow:0 -20px 60px -20px rgba(0,0,0,.95),0 0 0 1px rgba(0,0,0,.4);
  }
  .menu.wide{width:100vw;max-width:100vw}
  /* The page behind it, dimmed. A pseudo-element rather than a real one so no
     JS has to create or remove anything — and pointer-events:none so a tap on
     the dimmed area passes through to the document, where the existing
     click-away handler closes this. Making it clickable would have put the
     scrim INSIDE .me, where that handler treats it as a tap on the menu. */
  .menu::before{
    content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;
    background:rgba(0,6,10,.55);
    animation:scrim .3s ease both;
  }
  /* The grab bar. It is the one thing that says "this came from the bottom
     and goes back there", and it costs one pseudo-element. */
  .menu::after{
    content:"";position:absolute;top:8px;left:50%;transform:translateX(-50%);
    width:38px;height:4px;border-radius:2px;background:rgba(154,200,214,.34);
  }
  .menu h3{margin-top:6px}
  /* Comfortable rather than compact: this is a sheet with a whole screen
     width to spend, not a 300px card rationing it. */
  .pw{gap:9px;margin-top:14px}
  .pw input,.two input{font-size:16px;padding:14px 14px}
  .pw button{padding:0 18px}
  .seed textarea{height:88px;font-size:12.5px;padding:13px 14px}
  .seal{padding:15px;font-size:14.5px}
  .menu button.row,.menu a.row{padding:14px 12px;font-size:14px}
  .alt{margin-top:14px}
  .altbtn{padding:13px 14px;font-size:13px}
  .did{font-size:11px;padding:11px 12px}
}
@keyframes sheet{from{transform:translateY(24px);opacity:0}}
@keyframes scrim{from{opacity:0}}

@media (prefers-reduced-motion:reduce){.glyph::after{animation:none}.menu{animation:none}}
/* ── the phone ─────────────────────────────────────────────────────────────
   THE ORDER WAS WRONG, AND ON EVERY PAGE. An order:-1 on .me put the sign-in
   button BEFORE the wordmark, so a phone opened this site to a bar that read
   "Sign in · Overheard" — the one element that is meant to be the site's name
   was the second thing on the row.

   Brand left, the way in right, tabs on their own line underneath. And the
   tabs SCROLL sideways rather than wrapping: six of them wrapped to two rows
   and pushed the whole page down by forty pixels of navigation before
   anything else appeared. */
/* THE ROW IS GONE AND THE BUTTON IS HERE, everywhere the row does not fit.
   See the block at the top of this stylesheet for why a button beats a
   scrolling strip; the width is arithmetic. Without the Testnet pill the bar
   still needs 175 + 466 + 152 + 48 = 841px of content, and a 900px window
   gives 848. One pixel narrower than that and something has to wrap, so 900
   is where the tabs stop and the button starts. Above it the desktop bar is
   the row of tabs it has always been and this rule does not exist. */
@media (max-width:899px){
  .tabs{display:none}
  .nb{display:block;margin-left:auto}
  .me{margin-left:10px;order:0;flex:none}
}
@media (max-width:560px){
  /* THE ROW IS NOW EXACTLY AS WIDE AS IT NEEDS TO BE, and at 360px that took
     arithmetic rather than taste. The wordmark wants 110px of text, the
     button 42, the signed-out control 110, two gaps 18 \u2014 320px of content
     inside the 308 a 360px phone gives after its gutters. Twelve pixels over,
     and what those twelve pixels produced was a wordmark quietly CLIPPED by
     twelve, because white-space:nowrap under a flex shrink cuts rather than
     wraps and says nothing about it.

     So every element gives a little back: two off the glyph, two off the
     button, six off the sign-in padding, one off each gap, and a wordmark
     that scales with the window instead of stepping at a breakpoint. 298 of
     308 at 360px, full size again by 396px, and nothing clipped anywhere
     between. */
  .bar{gap:8px;padding:16px 0;flex-wrap:nowrap}
  .brand{font-size:clamp(17px,4.8vw,19px);gap:10px;flex:none}
  .glyph{width:28px;height:28px}
  .in{padding:0 13px;gap:9px}
  .me{margin-left:0}
  /* Three controls on one row at 360px is 308 pixels to spend, and the DID
     text is the one part of the chip that is not doing work a face does
     better — the face is the thing a person learns to recognise, and the
     whole DID is one tap away inside the chip's own sheet. This is also the
     answer to a REPORTED bug: signing in widened the chip by 91px, which was
     enough to push the row over and rearrange the bar the moment somebody
     signed in. The bar is now the same width signed in and signed out. */
  .chip .nm{display:none}
  .chip{padding:0 8px 0 5px}
  /* Seven rows, a heading and the Testnet line come to about 558px, and a
     640-tall Android gives 86vh = 550. Nine pixels is not worth a scrollbar
     under a menu whose entire purpose is that you can see all of it at once,
     and this sheet has no text field in it, so there is no keyboard to leave
     room for. */
  .menu.nav{max-height:min(92vh,760px)}
  /* The strip's own rules — the bleed to the window edges, the proportional
     mask, the reduced tab padding — went with it. They were load-bearing for
     a row that no longer exists at this width, and a stylesheet that keeps
     the scaffolding of a removed thing is how the next person concludes it is
     still there. The scroll wiring in the JS is likewise a no-op here: it
     measures a display:none element, finds no overflow, and returns. */
  /* The wordmark's halo is a blurred conic gradient rotating forever, on
     every page of the site. It is small, so it is not the biggest cost on a
     phone, but it is a continuous one that buys a shimmer nobody came for.
     The glyph keeps its glow; only the rotation stops. */
  .glyph::after{animation:none}
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


/* ══════════════════════════════════════════════════════════════════════════
   WHAT USED TO BE HERE
   ══════════════════════════════════════════════════════════════════════════

   Ninety lines that made a horizontally-scrolling tab strip admit that it
   scrolled: a mask whose fade at each end was proportional to how much row
   was left in that direction, a scroll-into-view for the current tab, and a
   one-time animated peek that demonstrated the gesture on a visitor's first
   phone load and never again.

   All three worked, and none of them fixed the problem. The problem was that
   a visitor cannot choose from a list they cannot see, and the answer to that
   is a list they can see — THE PHONE NAVIGATION, in the stylesheet above.

   It is deleted rather than left switched off. The strip is display:none
   below 900px and does not overflow above it, so every line of this would
   have measured a hidden element, found no overflow and returned — while
   still costing a scroll listener, a resize listener, a rAF and a
   localStorage write on every page load of the site, on exactly the devices
   least able to spare them. */

/* ══════════════════════════════════════════════════════════════════════════
   THE PHONE'S NAVIGATION
   ══════════════════════════════════════════════════════════════════════════

   Every page in the site, on one screen, one tap from anywhere. Three things
   about it are deliberate and easy to lose:

   1. IT READS THE SAME LIST THE TABS DO, and then some. `PAGES` is the one
      place a page is declared; the tabs take the subset that asked to be
      tabs and this takes ALL of them, which is how "What is Overheard?" —
      the explainer, deliberately not a tab because six tabs already
      overflowed a desktop row — finally gets a route from the bar.

   2. IT IS BUILT ONCE, NOT ON EVERY OPEN. Seven rows of static markup
      rebuilt on each tap is work done for nothing, and it means a row can
      differ between two openings for reasons nobody intended. Only the
      open/closed class changes.

   3. THE CLOSE PATH IS THE SAME ONE THE SIGN-IN SHEET USES: a capture-phase
      pointerdown that checks the composed path, and Escape. Composed,
      because this is a shadow root — an event that starts on a row inside it
      arrives at the document with `target` retargeted to <overheard-bar>, so
      a naive `contains` check closes the sheet on every tap of its own
      contents. That bug has been written twice in this file already. */
/* An open sheet has to be above everything, and the bar's host sits at
   z-index 50. Anything a page paints above 50 — and the desktop note, which
   is at 9999 in its own root — covers it otherwise. Both menus in this file
   call it, so there is one rule for "a sheet is open" rather than two that
   agree today. */
function lift(el, on) {
  const host = el.getRootNode()?.host;
  if (host) host.classList.toggle("oh-lifted", on);
  hushHint(on);
}

function buildBurger(path, explicit) {
  const nb = document.createElement("div");
  nb.className = "nb";

  const btn = document.createElement("button");
  btn.className = "burger";
  btn.type = "button";
  btn.setAttribute("aria-label", "Open the site menu");
  btn.setAttribute("aria-haspopup", "dialog");
  btn.setAttribute("aria-expanded", "false");
  for (let i = 0; i < 3; i++) btn.append(document.createElement("i"));

  const sheet = document.createElement("div");
  sheet.className = "menu nav";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", "Sections");
  sheet.append(Object.assign(document.createElement("h3"), { textContent: "Go to" }));

  let hot = false;
  for (const p of PAGES) {
    const a = document.createElement("a");
    a.className = "prow";
    a.href = p.href;
    const on = explicit ? explicit === p.label.toLowerCase() : p.match(path);
    if (on) a.setAttribute("aria-current", "page");
    if (p.hot) a.setAttribute("data-hot", "");
    if (on) hot = true;

    const ico = document.createElement("span");
    ico.className = "pico";
    ico.innerHTML = iconSVG(p.icon, "");           // our own markup, from nav.js
    const txt = document.createElement("span");
    txt.className = "ptxt";
    txt.append(Object.assign(document.createElement("b"), { textContent: p.label }));
    txt.append(Object.assign(document.createElement("i"), { textContent: p.blurb }));
    a.append(ico, txt, Object.assign(document.createElement("span"), { className: "pnow" }));
    sheet.append(a);
  }
  /* Only when the visitor is standing somewhere this sheet can name. On a
     page that is not in the list the dot would promise a highlighted row
     that is not in there. */
  if (hot) nb.setAttribute("data-hot", "");

  const ns = document.createElement("div");
  ns.className = "nsoon";
  ns.innerHTML = ICONS.flask;                      // our own markup
  ns.append(Object.assign(document.createElement("b"), { textContent: "Testnet" }));
  ns.append(Object.assign(document.createElement("span"),
    { textContent: " — being built" }));
  ns.append(Object.assign(document.createElement("span"), { className: "tag", textContent: "soon" }));
  sheet.append(ns);

  nb.append(btn);

  /* IT IS BUILT ONCE AND ATTACHED ONLY WHILE OPEN, which is two decisions
     rather than one. Built once because seven rows of static markup rebuilt
     on every tap is work done for nothing and a row that can differ between
     openings for reasons nobody intended. Attached only while open because
     this shares the .menu class with the sign-in sheet — deliberately, so
     there is one sheet in this bar and not two that resemble each other —
     and a permanently-present second .menu makes `shadowRoot.querySelector
     (".menu")` ambiguous for everything that ever reads this bar. Closed, it
     is a detached node holding no listeners the document knows about. */
  const close = () => {
    if (!sheet.isConnected) return;
    sheet.remove();
    nb.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
    lift(nb, false);
    removeEventListener("pointerdown", away, true);
    removeEventListener("keydown", esc, true);
  };
  const away = (e) => { if (!e.composedPath().includes(nb)) close(); };
  const esc = (e) => { if (e.key === "Escape") { close(); btn.focus(); } };

  btn.addEventListener("click", () => {
    if (sheet.isConnected) return close();
    nb.append(sheet);
    nb.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    lift(nb, true);
    addEventListener("pointerdown", away, true);
    addEventListener("keydown", esc, true);
    /* The current row, or the first one. A sheet that opens with focus still
       on the button behind it is a sheet a keyboard cannot enter. */
    (sheet.querySelector('[aria-current="page"]') ?? sheet.querySelector(".prow"))?.focus();
  });
  /* Tapping a row navigates, and on a same-page link the browser does not
     navigate at all — so the sheet has to shut itself or it stays open over
     the page the visitor just chose. */
  sheet.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest(".prow")) close();
  });

  return nb;
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

    const nb = buildBurger(path, explicit);

    const me = document.createElement("div");
    me.className = "me";
    me.hidden = true;

    bar.append(brand, nav, soon, nb, me);
    wrap.appendChild(bar);
    root.append(style, wrap);

    /* nothing to wire: the tabs either fit or are not shown. */

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
    lift(me, false);
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
    lift(me, true);
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

      /* ── AND THE SEED, FOR THE PASSPHRASE NOBODY REMEMBERS ─────────────
         This popover used to end here for anybody holding a vault: three
         routes, all of which assume you still know the passphrase or still
         have the file. The seed is the one thing every Technocore identity
         has however it was made, and it was offered on the Rooms page and
         nowhere else, which is a strange place to keep the only way back in.
         It sits BELOW the passphrase and starts closed, because the
         passphrase is what works for everybody who remembers it, and a
         textarea above it would push the common case down the card to serve
         the rare one. */
      const alt = document.createElement("div");
      alt.className = "alt";
      const altBtn = document.createElement("button");
      altBtn.type = "button";
      altBtn.className = "altbtn";
      altBtn.setAttribute("aria-expanded", "false");
      altBtn.append(Object.assign(document.createElement("span"), {
        textContent: "Forgotten it? Use your seed" }));
      const tipBtn = document.createElement("button");
      tipBtn.type = "button";
      tipBtn.className = "tipq";
      tipBtn.setAttribute("aria-label", "Why pasting your seed here is safe");
      const tip = document.createElement("div");
      tip.className = "tip";
      tip.hidden = true;
      /* Plain words, and every line is something the person could verify in
         their own network tab. No reassurance that is not a mechanism. */
      const tipList = document.createElement("ul");
      for (const t of [
        "Your seed is read here, inside this tab. It is not sent anywhere.",
        "This browser turns it into your key, so the identity is worked out on your own device.",
        "The key is then locked with the passphrase you choose, right here.",
        "The locked file is downloaded to your phone or computer straight away, so you are never shut out again.",
        "There is no account here, and no server that could hold your key even if it wanted to.",
      ]) tipList.append(Object.assign(document.createElement("li"), { textContent: t }));
      tip.append(Object.assign(document.createElement("b"), {
        textContent: "Nothing you paste here leaves your device." }), tipList);
      alt.append(altBtn, tipBtn);

      /* Hover for a mouse, focus for a keyboard, click for a finger. A tip
         that only answers to hover is a tip that does not exist on a phone. */
      /* TWO INPUTS, ONE STATE, AND THEY WERE FIGHTING. A tap on a phone
         synthesises mouseenter before it delivers the click, so "hover opens,
         click toggles" opened the tip and then immediately shut it: the
         explanation was unreachable on exactly the devices that cannot hover.
         Hovering and pinning are separate facts now, and the tip is open if
         either is true. A keyboard reaches it the ordinary way, because it is
         a real button and Enter is a click. */
      let sticky = false, hovering = false;
      const sync = () => {
        const on = sticky || hovering;
        tip.hidden = !on;
        tipBtn.setAttribute("aria-expanded", String(on));
      };
      /* HOVER ONLY WHERE HOVERING IS A THING, and it is not only a tidiness
         point. The sheet is anchored to the BOTTOM, so opening the tip grows
         the card upwards — which can carry the button out from under the very
         cursor that opened it. mouseleave then closes it, the card shrinks,
         the button slides back under the cursor, mouseenter fires, and it
         oscillates forever. Caught by a test that sat waiting thirty seconds
         for the row to hold still.
         A pointer that cannot hover cannot start that loop, and a device that
         can hover has the popover, which grows downwards and never moves the
         button at all. */
      if (matchMedia("(hover: hover)").matches) {
        tipBtn.addEventListener("mouseenter", () => { hovering = true; sync(); });
        tipBtn.addEventListener("mouseleave", () => { hovering = false; sync(); });
      }
      tipBtn.addEventListener("blur", () => { sticky = false; sync(); });
      tipBtn.addEventListener("click", (e) => { e.preventDefault(); sticky = !sticky; sync(); });
      tipBtn.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && sticky) { e.stopPropagation(); sticky = false; sync(); }
      });

      const hold = document.createElement("div");
      hold.hidden = true;
      let seedBuilt = null;
      altBtn.addEventListener("click", () => {
        const open = hold.hidden;
        hold.hidden = !open;
        altBtn.setAttribute("aria-expanded", String(open));
        /* Wider only once there is something wide in it. */
        menu.classList.toggle("wide", open);
        if (open && !seedBuilt) {
          seedBuilt = buildSeed(say);
          hold.append(seedBuilt.frag);
        }
        /* And the status line moves with it. There is one `say` for both
           routes, and leaving it above meant an error about the seed appeared
           a whole section away from the button that caused it — read as being
           about the passphrase, if it was read at all. */
        if (open) hold.append(say);
        else row.after(say);
        if (open) setTimeout(() => seedBuilt.focus(), 30);
      });
      menu.append(alt, tip, hold);

      menu.append(fileRow("Use a different backup file", say));
      menu.append(makeRow("Make another identity"));
      menu.append(fine("Decrypted here, on this device. Your key is never sent anywhere."));
      if (focusOn !== "none") setTimeout(() => pw.focus(), 30);
      return;
    }

    /* ── nothing here: the seed ───────────────────────────────────────── */
    const built = buildSeed(say);
    menu.append(built.frag, say);
    menu.append(fileRow("I have a backup file instead", say));
    menu.append(makeRow("Make an identity"));
    /* THE PROMISE STAYS VISIBLE. The `i` above carries the mechanics, but the
       one sentence that matters is not allowed to be behind a control — a
       claim somebody has to press for is a claim they will not read. */
    menu.append(fine("Read, derived and encrypted in this tab. Your seed and your key are never sent anywhere."));
    if (focusOn !== "none") setTimeout(() => built.focus(), 30);
  }

  /** THE SEED ROUTE, BUILT ONCE.
   *
   * It is reached two ways now: a browser holding nothing opens on it, and a
   * browser holding a vault can ask for it when the passphrase is the thing
   * that has been forgotten. Those are the same job, so they are the same
   * code — a second copy would have drifted, and the copy that drifts is
   * always the one handling somebody's master secret.
   */
  function buildSeed(say) {
    const box = document.createElement("div");
    box.className = "seed";
    const seed = document.createElement("textarea");
    /* NOT SPELL-CHECKED, NOT AUTOFILLED, NOT REMEMBERED.
     A seed is the master secret. Chrome's enhanced spell check sends the
     contents of a field to Google to check them, which is a plaintext key
     leaving the device by a route nobody would ever think to look at; and a
     password manager offering to save "the thing you typed" is a copy of
     the key in a second place the user did not choose. Both are off. */
    seed.spellcheck = false;
    seed.autocapitalize = "off";
    seed.autocomplete = "off";
    seed.setAttribute("autocorrect", "off");
    seed.setAttribute("data-lpignore", "true");
    seed.setAttribute("data-1p-ignore", "");
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
      /* AND ONTO THEIR OWN DEVICE, NOW, NOT AS A CHORE FOR LATER.
         A vault that exists only in this browser's storage is one cleared
         cache away from a locked-out identity, and the moment somebody has
         just proved they hold the seed is the cheapest moment to hand them
         the backup. It is the ENCRYPTED file, so it is worth nothing without
         the passphrase they just chose.
         Wrapped: a browser that blocks the download must not also block the
         sign-in. Being signed in is the thing they asked for. */
      try { saveBackup(vault); } catch { /* a blocked download is not a failed sign-in */ }
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

    return { frag: (() => { const f = document.createDocumentFragment(); f.append(box, two, seal); return f; })(), focus: () => seed.focus() };
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
    a.href = "/create";
    a.innerHTML = ICONS.spark;                        // our own markup
    a.append(Object.assign(document.createElement("span"), { textContent: label }));
    return a;
  }

  /** The encrypted vault, handed to the person as a file. Same shape and the
   *  same name the create page uses, so one backup is one backup wherever it
   *  came from, and either page can open the other's. */
  function saveBackup(vault) {
    const a = document.createElement("a");
    const url = URL.createObjectURL(new Blob([JSON.stringify(vault, null, 2)], { type: "application/json" }));
    a.href = url;
    a.download = `overheard-identity-${String(vault.did || "").slice(-8)}.json`;
    /* IN THE DOCUMENT, not floating. Chrome ignores `download` on an anchor
       that was never in the tree, so the click did nothing at all and the
       promise in the tip would have been a lie. Body rather than this shadow
       root, because that is where a temporary anchor belongs. */
    a.style.display = "none";
    document.body.append(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
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
  lift(me, false);
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
    lift(me, false);
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
    lift(me, true);
    chip.setAttribute("aria-expanded", "true");
    addEventListener("pointerdown", away, true);
    addEventListener("keydown", esc, true);
  };

  chip.addEventListener("click", () => (menu ? close() : open()));
}

/* ══════════════════════════════════════════════════════════════════════════
   ONE NOTE, ON A PHONE, ONCE

   Every page here works on a phone and none of them apologise for it. But
   the city is a WebGL plaza you drag and zoom, the room is a scene you look
   around, and the Play toy is something you throw coins in — all of them are
   better with a pointer and a big window, and somebody arriving on a phone
   deserves to know that before they decide the site is small rather than
   that their screen is.

   THE RULES, and each of them is the difference between a note and a nag:

     · ONCE PER BROWSER, EVER. Dismissed is dismissed — not per page, not per
       session, not per day. It records that and never asks again.
     · ONCE PER VISIT even before that. It shows on the FIRST page loaded and
       is then suppressed for the rest of the session, so somebody who
       ignores it rather than closing it does not meet it again on the next
       page they open.
     · PHONES ONLY. A coarse pointer AND a narrow window. A tablet in
       landscape, or a laptop with a touchscreen, gets nothing.
     · NEVER IN FRONT OF ANYTHING. It sits at the bottom, above the thumb
       line, and it is dismissible by tapping it, by the ×, or by Escape.

   It lives in the bar because the bar is the one component on every page,
   and because a shadow root means no page's CSS can push it anywhere.
   ══════════════════════════════════════════════════════════════════════════ */
const SEEN_KEY = "overheard.deskhint";
const SESSION_KEY_HINT = "overheard.deskhint.session";

/* ── AND IT STEPS ASIDE FOR A SHEET ────────────────────────────────────────
   The note is fixed to the bottom of the screen at z-index 9999. So is a
   bottom sheet. FOUND BY SCREENSHOT: the site menu opened underneath it and
   the last two pages in the list were behind a box explaining that the site
   is better on a computer — which breaks this component's own fourth rule,
   the one that says it never sits in front of anything.

   It hides rather than closing, and closing is what records "seen": a
   visitor who opened a menu has not dismissed this, and should still get to
   read it when the menu shuts. */
let hintHost = null;
function hushHint(on) { if (hintHost) hintHost.style.display = on ? "none" : ""; }

const HINT_CSS = `
:host{all:initial}
.wrap{
  position:fixed;left:14px;right:14px;bottom:14px;z-index:9999;
  display:flex;align-items:flex-start;gap:11px;
  padding:13px 13px 13px 14px;border-radius:15px;
  font-family:"Outfit",system-ui,-apple-system,"Segoe UI",sans-serif;
  color:#CDEAF3;
  background:linear-gradient(rgba(5,26,35,.97),rgba(3,16,22,.97));
  border:1px solid rgba(0,180,215,.34);
  box-shadow:0 22px 50px -22px rgba(0,0,0,.95);
  animation:up .42s cubic-bezier(.2,.9,.3,1.1) both;
}
@keyframes up{from{opacity:0;transform:translateY(18px)}}
.ic{width:30px;height:30px;flex:none;border-radius:10px;display:grid;place-items:center;
  background:rgba(0,180,215,.13);color:#5FEBFF}
.ic svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.9;
  stroke-linecap:round;stroke-linejoin:round}
.tx{flex:1 1 auto;min-width:0;font-size:12.5px;line-height:1.45}
.tx b{display:block;font-size:13.5px;font-weight:700;color:#EDFAFE;margin-bottom:2px;
  letter-spacing:-.01em}
.x{flex:none;width:30px;height:30px;border-radius:9px;background:none;cursor:pointer;
  border:1px solid rgba(0,180,215,.24);color:#9CBFCB;display:grid;place-items:center;padding:0}
.x svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round}
.x:active{background:rgba(0,180,215,.14)}
@media (prefers-reduced-motion:reduce){.wrap{animation:none}}
`;

function deskHint() {
  /* A phone, not merely a small window. Both conditions, because a desktop
     browser dragged narrow is still a desktop browser. */
  const coarse = matchMedia("(pointer: coarse)").matches;
  const narrow = Math.min(innerWidth, innerHeight) < 620;
  if (!coarse || !narrow) return;

  try { if (localStorage.getItem(SEEN_KEY)) return; } catch { return; }
  try { if (sessionStorage.getItem(SESSION_KEY_HINT)) return; } catch {}
  try { sessionStorage.setItem(SESSION_KEY_HINT, "1"); } catch {}

  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  const st = document.createElement("style");
  st.textContent = HINT_CSS;

  const wrap = document.createElement("div");
  wrap.className = "wrap";
  wrap.setAttribute("role", "status");

  const ic = document.createElement("span");
  ic.className = "ic";
  ic.innerHTML = '<svg viewBox="0 0 24 24"><rect x="2.6" y="4" width="18.8" height="12.5" rx="2"/><path d="M8.5 20.2h7"/><path d="M12 16.5v3.7"/></svg>';

  const tx = document.createElement("div");
  tx.className = "tx";
  tx.append(Object.assign(document.createElement("b"), { textContent: "Better on a computer" }));
  /* Says WHY, and truthfully. "Best experience" on its own is a slogan; this
     names the three things a small screen actually costs you. */
  tx.append(document.createTextNode(
    "The city and the rooms are 3-D scenes you drag around, and Play is a toy you throw things in. It all works here — there is just more of it on a bigger screen."));

  const x = document.createElement("button");
  x.className = "x";
  x.type = "button";
  x.setAttribute("aria-label", "Dismiss");
  x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  const close = () => {
    try { localStorage.setItem(SEEN_KEY, "1"); } catch {}
    removeEventListener("keydown", esc, true);
    host.remove();
  };
  /* NOT WHILE IT IS HUSHED. Escape closes an open sheet, and closing THIS
     records "seen" forever — so without the guard, one Escape aimed at the
     site menu permanently dismissed a note the visitor never got to read,
     from behind the sheet that was covering it. Hidden means not
     addressable. */
  const esc = (e) => { if (e.key === "Escape" && host.style.display !== "none") close(); };
  x.addEventListener("click", close);
  /* Tapping anywhere on it dismisses too — a 30px × on a phone is a target
     somebody has to aim at, and there is nothing else in here to press. */
  wrap.addEventListener("click", close);
  addEventListener("keydown", esc, true);

  /* GET OUT OF THE WAY OF A DOCKED SURFACE. A page with a bar of controls
     fixed to the bottom of the phone screen — the market's call dock — tells
     everyone how tall it is in --dock-h on the root element. This note sits
     above it rather than across it. Pages that set nothing get 0px and the
     note stays where it always was. */
  const lift = () => {
    const d = getComputedStyle(document.documentElement)
      .getPropertyValue("--dock-h").trim() || "0px";
    wrap.style.bottom = `calc(14px + ${d})`;
  };
  lift();
  addEventListener("resize", lift, { passive: true });
  /* --dock-h is measured after layout, so read it again on the next frames. */
  requestAnimationFrame(() => { lift(); setTimeout(lift, 400); });

  wrap.append(ic, tx, x);
  root.append(st, wrap);
  document.body.appendChild(host);
  hintHost = host;
}

if (document.readyState === "loading") {
  addEventListener("DOMContentLoaded", deskHint, { once: true });
} else {
  deskHint();
}

customElements.define("overheard-bar", OverheardBar);

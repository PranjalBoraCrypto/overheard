/**
 * nav.js — the list of pages this site has, in one place.
 *
 * WHY THIS FILE EXISTS
 *
 * The bar knew about the pages and the footer did not. So the footer said
 * nothing about where anything was, and every new page meant remembering to
 * edit a second list that nobody remembered to edit. Now there is one list:
 * add a page here and it appears in the navigation AND in the footer, with
 * its icon, its one-line description and its active-state rule.
 *
 * `match` is a function rather than a string because "which page am I on" is
 * not always a prefix test — the card page is `/` exactly, and `/v` must not
 * light up for `/verify-something`. Getting that wrong shows two tabs as
 * current, which reads as a bug in the site rather than in the rule.
 *
 * The icons live here too. They are the site's own markup — never anything
 * from outside — and they are drawn on a 24-unit grid with a 1.8 stroke so
 * they sit at the same visual weight next to each other. A set of icons that
 * do not match is worse than no icons at all.
 */

export const BUILDER_DID =
  "did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz";

export const X_URL = "https://x.com/Crypto_Pranjal";

/* Line icons, 24-unit grid, stroked by the element's own colour. */
export const ICON = {
  card:   '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h13A2.5 2.5 0 0 1 21 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z"/><circle cx="8.5" cy="11" r="2.2"/><path d="M13.5 10h4M13.5 13.5h2.5"/>',
  rooms:  '<path d="M3.5 6.5A2 2 0 0 1 5.5 4.5h8a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H8l-4.5 3z"/><path d="M18 9.5h.5a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H18l-3 2.2V17"/>',
  city:   '<path d="M3 20.5h18"/><path d="M5.5 20.5V11l4-2.5V20.5"/><path d="M9.5 20.5V6l5-2.5v17"/><path d="M14.5 20.5v-8l4 2v6"/><path d="M7.4 13.5v.01M12 9v.01M12 13v.01M16.6 16v.01"/>',
  play:   '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="3.4"/><path d="M12 3.4v2.4M12 18.2v2.4M3.4 12h2.4M18.2 12h2.4"/>',
  create: '<path d="M12 4.5v15M4.5 12h15"/><circle cx="12" cy="12" r="8.6"/>',
  coin:   '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.2v9.6"/><path d="M14.7 9.4a3 3 0 0 0-2.7-1.3c-1.6 0-2.7.8-2.7 2s1 1.8 2.7 2.1 2.8.8 2.8 2.1-1.2 2-2.8 2a3 3 0 0 1-2.7-1.3"/>',
  verify: '<path d="M12 2.6 4.5 5.8v6.1c0 4.6 3.2 8.8 7.5 9.9 4.3-1.1 7.5-5.3 7.5-9.9V5.8z"/><polyline points="8.7 11.9 11.2 14.4 15.5 9.8"/>',
  what:   '<circle cx="12" cy="12" r="8.6"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.6v.3"/><path d="M12 16.9v.01"/>',
  out:    '<path d="M14 4h6v6"/><path d="M20 4 11.5 12.5"/><path d="M18 14.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4.5"/>',
  key:    '<circle cx="8" cy="14" r="4.2"/><path d="M11 11 20 2"/><path d="M17 5l2.2 2.2M14.6 7.4l2.2 2.2"/>',
  flask:  '<path d="M9.5 3.5v6L4.8 17a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3l-4.7-7.5v-6"/><path d="M8 3.5h8"/><path d="M7 14h10"/>',
};

/**
 * Every page, once.
 *
 * `bar` decides whether it is a tab in the top navigation; everything here
 * appears in the footer regardless, because the footer is where somebody
 * goes looking for the page they could not find.
 */
export const PAGES = [
  { href: "/", label: "Card", icon: "card", bar: true,
    match: (p) => p === "/" || p === "/index.html",
    blurb: "Look up any identity" },
  { href: "/rooms", label: "Rooms", icon: "rooms", bar: true,
    match: (p) => p.startsWith("/rooms"),
    blurb: "Read and post, signed" },
  { href: "/play", label: "Play", icon: "play", bar: true,
    match: (p) => p.startsWith("/play"),
    blurb: "Proof of Learning" },
  { href: "/create", label: "Create", icon: "create", bar: true,
    match: (p) => p.startsWith("/create"),
    blurb: "Make an identity" },
  { href: "/v", label: "Verify", icon: "verify", bar: true,
    match: (p) => p === "/v" || p.startsWith("/v.html"),
    blurb: "Check a signature" },
  /* ── THE PAPER MARKET ─────────────────────────────────────────────────
     Sixth tab, and it goes before City for the same reason City goes last:
     City carries the live dot and pulls the eye, and a new tab placed after
     it would be read as an afterthought. "Market" rather than "Call", which
     is the action the page asks for — a tab row already holding "Card"
     cannot also hold "Call" and expect anybody to tell them apart at a
     glance. */
  { href: "/market", label: "Market", icon: "coin", bar: true,
    match: (p) => p.startsWith("/market"),
    blurb: "One question, in paper" },
  /* LAST, AND ON PURPOSE. City is the loudest tab on the bar — it carries the
     live dot — and sitting third it pulled the eye away from the four tabs
     that are the actual working surface of the site. At the end of the row it
     is still the thing that stands out, without standing in front. */
  { href: "/city", label: "City", icon: "city", bar: true, hot: true,
    match: (p) => p.startsWith("/city"),
    blurb: "The network as a place" },
  { href: "/what", label: "What is Overheard?", icon: "what", bar: false,
    match: (p) => p.startsWith("/what"),
    blurb: "Start here" },
];

/** Where the site points off itself.
 *
 *  NOTE THE LABELS. "the network" and "worth following" are descriptions of
 *  the relationship, and they have to stay accurate: @CryptoHayes is not the
 *  builder of this site and must never sit under a note that says it is.
 *  The builder's own handle is X_URL above — it carries the twitter:site and
 *  twitter:creator tags on every page and the "Built by" credit in the
 *  footer, and those three are the places that make an authorship claim. */
export const ELSEWHERE = [
  { href: "https://technocore.chat", label: "technocore.chat", note: "the network" },
  { href: "https://x.com/CryptoHayes", label: "@CryptoHayes", note: "worth following", x: true },
];

/** The X glyph. Filled, not stroked — it is a wordmark, not a line icon. */
export const X_GLYPH =
  '<path d="M18.9 1.2h3.7l-8.1 9.2 9.5 12.6h-7.4l-5.8-7.6-6.7 7.6H.4l8.6-9.9L0 1.2h7.6l5.2 6.9zm-1.3 19.6h2L6.5 3.3H4.4z"/>';

export const FONT_HREF =
  "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap";

/** Load the site's typeface once, from whichever component asks first. */
export function ensureFont() {
  const has = [...document.querySelectorAll('link[rel="stylesheet"]')]
    .some((l) => l.href.includes("fonts.googleapis.com") && l.href.includes("family=Outfit"));
  if (has) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = FONT_HREF;
  document.head.appendChild(link);
}

/** An <svg> from the set above. Our own markup, so innerHTML is ours to use. */
export function iconSVG(name, cls = "i") {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name] || ""}</svg>`;
}

/* ── the face ──────────────────────────────────────────────────────────────
   The same rounded head, visor and ears the card draws, small enough for a
   chip, tinted by the hue the key itself produces. Two identities are never
   the same colour by accident, and yours is the one you learn to recognise.

   It lives here rather than in the bar because the card page now shows it
   too, next to "create my credential" — and a face that is nearly the same
   in two places is worse than one that is not there at all. */
let faceSeq = 0;
export function faceSVG(hue, cls = "face") {
  const id = `f${++faceSeq}`;
  return `<svg class="${cls}" viewBox="0 0 40 40" aria-hidden="true">
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

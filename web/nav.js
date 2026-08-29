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
  { href: "/city", label: "City", icon: "city", bar: true, hot: true,
    match: (p) => p.startsWith("/city"),
    blurb: "The network as a place" },
  { href: "/play", label: "Play", icon: "play", bar: true,
    match: (p) => p.startsWith("/play"),
    blurb: "Proof of Learning" },
  { href: "/create.html", label: "Create", icon: "create", bar: true,
    match: (p) => p.startsWith("/create"),
    blurb: "Make an identity" },
  { href: "/v", label: "Verify", icon: "verify", bar: true,
    match: (p) => p === "/v" || p.startsWith("/v.html"),
    blurb: "Check a signature" },
  { href: "/what", label: "What is Overheard?", icon: "what", bar: false,
    match: (p) => p.startsWith("/what"),
    blurb: "Start here" },
];

/** Where the site points off itself. */
export const ELSEWHERE = [
  { href: "https://technocore.chat", label: "technocore.chat", note: "the network" },
  { href: X_URL, label: "@Crypto_Pranjal", note: "the builder", x: true },
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

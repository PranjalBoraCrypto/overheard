/**
 * <overheard-foot> — the footer, once.
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
 * inheritance crossing too. It renders identically on a 680px column and a
 * 1180px one, because it sets its own width rather than taking the page's:
 * the content is 1180px wide, centred, wherever it is used, and the rule
 * above it is exactly as wide as the content. That is the card page's footer,
 * which is the one everything else was being asked to look like.
 *
 * The DID is the credit and is shown whole rather than trimmed, and it links
 * to its own card — the one page on this site that can check it.
 */

const FONT_HREF =
  "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap";

const BUILDER_DID =
  "did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz";

const CSS = `
:host{
  all:initial;
  display:block;
  font-family:"Outfit",system-ui,-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased;
}
*{box-sizing:border-box;margin:0;padding:0}
.wrap{max-width:1180px;margin:0 auto;padding:0 26px}
.foot{
  border-top:1px solid rgba(16,57,74,.9);
  padding:30px 0 56px;
  display:flex;flex-direction:column;gap:12px;
  color:#5F8593;font-size:13.5px;line-height:1.6;
  text-transform:none;font-style:normal;letter-spacing:normal;
}
.row{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:baseline}
a{color:#00B4D7;text-decoration:none;font-weight:600}
a:hover{color:#5FEBFF}
a:focus-visible{outline:2px solid #5FEBFF;outline-offset:3px}
.by{padding-top:11px;border-top:1px solid rgba(16,57,74,.55)}
.did{
  font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;
  font-size:12px;font-weight:500;color:#5F8593;
  word-break:break-all;letter-spacing:.2px;
}
.did:hover{color:#00B4D7}
@media (max-width:620px){.row{flex-direction:column;gap:7px}}
`;

function ensureFont() {
  const has = [...document.querySelectorAll('link[rel="stylesheet"]')]
    .some((l) => l.href.includes("fonts.googleapis.com") && l.href.includes("family=Outfit"));
  if (has) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = FONT_HREF;
  document.head.appendChild(link);
}

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

class OverheardFoot extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    ensureFont();

    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;

    const wrap = document.createElement("div");
    wrap.className = "wrap";
    const foot = document.createElement("footer");
    foot.className = "foot";

    const one = document.createElement("div");
    one.className = "row";
    one.append(Object.assign(document.createElement("span"), { textContent: "Overheard · independent" }));
    const tc = document.createElement("a");
    tc.href = "https://technocore.chat";
    tc.target = "_blank"; tc.rel = "noopener noreferrer";
    tc.textContent = "technocore.chat ↗";
    one.append(tc);

    const two = document.createElement("div");
    two.className = "row by";
    const by = document.createElement("span");
    by.append(document.createTextNode("Built by "));
    const me = document.createElement("a");
    me.href = "https://x.com/Crypto_Pranjal";
    me.target = "_blank"; me.rel = "noopener noreferrer";
    me.textContent = "Pranjal Bora";
    by.append(me);
    const did = document.createElement("a");
    did.className = "did";
    did.href = "/?did=" + encodeURIComponent(BUILDER_DID);
    did.title = "Open this card";
    did.textContent = BUILDER_DID;
    two.append(by, did);

    foot.append(one, two);
    wrap.append(foot);
    root.append(style, wrap);
    spanViewport(this);
  }
}

customElements.define("overheard-foot", OverheardFoot);

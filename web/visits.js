/**
 * visits.js — how many people came, and nothing else.
 *
 * WHY THIS FILE EXISTS RATHER THAN A SCRIPT TAG
 *
 * Counting visitors is a reasonable thing to want and an easy thing to do
 * carelessly. The careless version is one line of vendor script in seven page
 * heads, and it quietly ships three problems this site cannot afford:
 *
 *   1. THE URL IS NOT SAFE TO SEND. Two pages here carry an identity in the
 *      address bar — `/?did=did:key:z6Mk…` on the card page, `/rooms?did=…`
 *      — and /v carries an entire verification payload in the fragment: a
 *      did, a room, a message and a signature. A did:key is public, so this
 *      is not a leak of anything secret; it is worse than that in a subtler
 *      way. It would mean an outside service holding a list of "who looked
 *      up whom, from which country, on which browser" — a record this site
 *      has no business creating and no way to delete. Locations and
 *      fragments are stripped before anything is sent. What leaves is the
 *      path, plus the one query parameter that is genuinely about the site
 *      rather than about a person: which room you opened.
 *
 *   2. A THIRD-PARTY SCRIPT WOULD HAVE TO BE LET THROUGH THE CSP. The policy
 *      in vercel.json is `script-src 'self'` and `connect-src 'self'`, and it
 *      is that tight on purpose: the signing key is a non-extractable
 *      CryptoKey, so its bytes cannot be read even by script running on the
 *      page, and `connect-src 'self'` means script that did get in has
 *      nowhere to send anything. Google Analytics would need
 *      googletagmanager.com in `script-src` and several Google hosts in
 *      `connect-src` — a foreign script with full DOM access on the pages
 *      that hold the key, plus the exfiltration channel the policy currently
 *      denies. Vercel's counter is served first-party from this origin, so
 *      the policy does not move a single character. That was the deciding
 *      argument, not the convenience.
 *
 *   3. THE SITE MAKES A CLAIM ABOUT ITSELF. /what says there is no tracking.
 *      That sentence now reads "counts visits, sets no cookies, and cannot
 *      follow you anywhere else", because that is what this does and the
 *      alternative was to quietly stop being true.
 *
 * WHAT IS ACTUALLY COLLECTED, per Vercel's published list: a timestamp, the
 * URL we hand it (see above), the referrer, a coarse geolocation, and the
 * browser and device type. No cookies, nothing written to storage, and the
 * visitor hash is derived per-request and discarded after 24 hours, so there
 * is no identifier that survives a day or crosses to another site.
 *
 * TURNING IT OFF. Two ways, both honoured before the script is even fetched:
 * Global Privacy Control, which some browsers and extensions send as a legal
 * opt-out signal, and `localStorage.setItem("overheard.novisits", "1")` in
 * this browser's console. Opted out means no request is made at all — not a
 * request that is made and then discarded at the far end.
 *
 * IF THE COUNTER IS UNAVAILABLE — Web Analytics not enabled on the project,
 * an ad blocker, a filter list that eats the request — the fetch 404s or is
 * blocked and nothing else happens. There is no fallback, no retry, and no
 * page behaviour anywhere that depends on this file having run.
 */

/* The queue stub Vercel's script drains once it loads. It must exist BEFORE
   the script is inserted, because `beforeSend` is registered into it and a
   registration that arrives late is a page view already sent unfiltered. */
window.va = window.va || function () {
  (window.vaq = window.vaq || []).push(arguments);
};

/* THE ONE PARAMETER WORTH KEEPING. `room` names a public room and says
   something real about the site — which rooms people open is the whole
   reason to look at this. Everything else in a query string here is either
   about a person (`did`) or a development toggle (`hero`), and an allowlist
   is the only shape of this rule that stays correct when somebody adds a new
   parameter next month without reading this comment. */
const KEEP = new Set(["room"]);

const optedOut = () => {
  if (navigator.globalPrivacyControl === true) return true;
  try { return !!localStorage.getItem("overheard.novisits"); } catch { return false; }
};

if (!optedOut()) {
  window.va("beforeSend", (event) => {
    try {
      /* PARSED AS ABSOLUTE, WITH NO BASE. Handing `location.origin` in as a
         fallback base looks defensive and is the opposite: it turns anything
         unparseable into a plausible-looking path on this site rather than
         letting it fail, so the filter below would run over a string nobody
         understands. If it is not a URL, it is not reported. */
      const u = new URL(event.url);
      /* And it has to be a page on THIS site. Nothing else is a visit here,
         and an off-origin address arriving at this function means something
         has gone wrong somewhere it is not worth guessing about. */
      if (u.origin !== location.origin) return null;
      /* The fragment is never sent. /v puts a whole signed message in it. */
      u.hash = "";
      for (const k of [...u.searchParams.keys()]) {
        if (!KEEP.has(k)) u.searchParams.delete(k);
      }
      return { ...event, url: u.toString() };
    } catch {
      /* An address this cannot parse is an address this cannot vouch for. */
      return null;
    }
  });

  /* Injected rather than written as a tag in seven heads, so the opt-out is
     a real one: a visitor who has said no causes no request to be made.
     `/_vercel/insights/script.js` is the stable same-origin path Vercel
     serves once Web Analytics is enabled on the project; the shorter
     generated path in their docs is produced by a build step, and this site
     does not have one. */
  const s = document.createElement("script");
  s.defer = true;
  s.src = "/_vercel/insights/script.js";
  document.head.appendChild(s);
}

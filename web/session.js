/**
 * session.js — who this browser is signed in as, shared by every page.
 *
 * WHAT IS STORED, AND THE TRADE THAT WAS MADE
 *
 * Two separate things live in localStorage and they are not the same:
 *
 *   overheard.identity   the VAULT — the key encrypted under a passphrase,
 *                        310,000 PBKDF2 rounds. Useless to anyone who copies
 *                        it without the passphrase. This is the backup.
 *
 *   overheard.session    the key UNLOCKED, so a refresh does not ask for the
 *                        passphrase again. This is a convenience, and it is
 *                        the weaker of the two by design: anything that can
 *                        run script on this origin can read it while it is
 *                        there, and it survives closing the tab.
 *
 * That was a deliberate choice — being asked for a passphrase after every
 * reload is the thing that makes people keep a seed in a text file — but it
 * is a real trade and the UI says so, in the profile menu, next to a sign-out
 * that removes it. It is never written by anything except an explicit unlock,
 * and it never leaves the browser.
 *
 * Pages do not read localStorage directly. They call these, and they listen
 * for the `overheard:session` event so a sign-out in one tab is a sign-out in
 * the bar, the compose box and the claim panel at the same moment.
 */

const VAULT_KEY = "overheard.identity";
const SESSION_KEY = "overheard.session";
const EVENT = "overheard:session";

const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;

const read = (k) => { try { const r = localStorage.getItem(k); return r && r[0] === "{" ? JSON.parse(r) : null; } catch { return null; } };

/** The signed-in identity, or null. Validated on every read: a half-written
 *  or hand-edited record is treated as signed out rather than trusted. */
export function getSession() {
  const s = read(SESSION_KEY);
  if (!s || !DID_RE.test(String(s.did || "")) || !s.jwk || s.jwk.kty !== "OKP" || !s.jwk.d) return null;
  return { did: s.did, jwk: s.jwk };
}

/** The encrypted backup this browser holds, whether or not anyone is signed
 *  in. Its presence is what makes "enter your passphrase" a sensible thing to
 *  ask; without it the answer is "make one first". */
export function getVault() {
  const v = read(VAULT_KEY);
  return v && DID_RE.test(String(v.did || "")) && v.data ? v : null;
}

/** Sign in, and CHECK that it stuck.
 *
 *  Reported: "I closed it and it asked for the passphrase again." A write to
 *  localStorage can silently do nothing — a private window, storage blocked
 *  for the site, a full quota — and the old version could not tell the
 *  difference between "remembered" and "quietly forgotten", so the page said
 *  you would stay signed in and then did not.
 *
 *  It reads the record back. `false` from `persisted` means this browser
 *  refused to keep it and the caller should say so rather than promise
 *  something it cannot deliver. */
export function signIn(did, jwk) {
  if (!DID_RE.test(String(did || "")) || !jwk) return null;
  let persisted = false;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ did, jwk, at: new Date().toISOString() }));
    persisted = !!getSession();
  } catch {}
  announce();
  return { did, jwk, persisted };
}

/** Rewrite the record with today's date on every visit.
 *
 *  Some browsers evict script-written storage that has not been touched in a
 *  while — Safari's cap is the well-known one. Nothing can be done about a
 *  browser that clears it on close, but a record that is rewritten every time
 *  the site is opened is never the stale one an eviction policy reaches for
 *  first. Cheap, and it costs nothing when it is not needed. */
export function touchSession() {
  const s = getSession();
  if (!s) return null;
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, at: new Date().toISOString() })); } catch {}
  return s;
}

/** Sign out clears the unlocked key and NOTHING else. The vault stays: this
 *  is a lock, not a delete, and somebody who signs out on a shared machine
 *  must still be able to get back in with their passphrase. */
export function signOut() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  announce();
}

function announce() {
  try { dispatchEvent(new CustomEvent(EVENT, { detail: getSession() })); } catch {}
}

/** Subscribe. Fires on sign-in and sign-out here, and on `storage` — which is
 *  how a sign-out in another tab reaches this one. Returns an unsubscribe. */
export function onSession(fn) {
  const local = () => fn(getSession());
  addEventListener(EVENT, local);
  const cross = (e) => { if (!e.key || e.key === SESSION_KEY) fn(getSession()); };
  addEventListener("storage", cross);
  return () => { removeEventListener(EVENT, local); removeEventListener("storage", cross); };
}

/**
 * Keep a vault in this browser, so next time is one passphrase.
 *
 * Never on top of a DIFFERENT identity that is already here: somebody signing
 * in to a second identity should not silently lose the first one's backup,
 * which may be the only copy they have.
 */
export function saveVault(vault) {
  if (!vault || !DID_RE.test(String(vault.did || "")) || !vault.data) return false;
  const here = getVault();
  if (here && here.did !== vault.did) return false;
  try { localStorage.setItem(VAULT_KEY, JSON.stringify(vault)); return !!getVault(); }
  catch { return false; }
}

/**
 * Open the vault this browser holds, with a passphrase.
 *
 * The same 310,000 PBKDF2 rounds and AES-GCM the create page seals with —
 * written here rather than a fourth time in a page, because the bar now needs
 * to sign somebody in from any page on the site and a fourth copy of a
 * key-derivation routine is a fourth place for it to drift.
 *
 * Throws on a wrong passphrase, which is the only signal WebCrypto gives:
 * AES-GCM authentication failure is indistinguishable from a damaged record,
 * and callers say both rather than guessing which.
 */
export async function openVault(vault, pass) {
  const b = (s64) => {
    const s = String(s64).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  const aes = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b(vault.salt), iterations: 310000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b(vault.iv) }, aes, b(vault.data));
  const jwk = JSON.parse(new TextDecoder().decode(plain));
  if (!jwk || jwk.kty !== "OKP" || !jwk.d) throw new Error("not a key");
  return jwk;
}

/* ══════════════════════════════════════════════════════════════════════════
   THE SEED ROUTE, SHARED

   These three used to exist only inside play.html and rooms.html, as page
   locals, because only those two pages had a sign-in dialog. The bar has one
   now — on every page — and it needs the same route, so they move here for
   the same reason openVault did: a fourth copy of a key-derivation routine is
   a fourth place for it to drift.

   Nothing here talks to the network. A seed goes in as text, a key comes out,
   and what is kept behind is the encrypted form. That is the whole of it, and
   it is what the bar's info note is telling the truth about.
   ══════════════════════════════════════════════════════════════════════════ */

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (t) => {
  const p = String(t).replace(/-/g, "+").replace(/_/g, "/");
  const b = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const b58enc = (bytes) => {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
};

/** A seed is 32 bytes, written as hex by every Technocore tool and handed
 *  over inside a text file with other lines around it — so the whole file is
 *  a legitimate paste. Take the first 64-hex run in it. Null if there is
 *  none, which is a different answer from "wrong seed" and is said so. */
export function readSeed(text) {
  const m = String(text).replace(/[^0-9a-fA-F]+/g, " ").match(/\b[0-9a-fA-F]{64}\b/);
  if (!m) return null;
  const hex = m[0].toLowerCase();
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}

/** WebCrypto will not hand back a public key from a private one, and there is
 *  no Ed25519 scalar multiply in it either. But it WILL import a PKCS#8 key
 *  and export the JWK — which carries `x`, the public half — so wrapping the
 *  32 seed bytes in the fixed PKCS#8 preamble derives the DID with nothing
 *  but the platform's own arithmetic. */
export async function keyFromSeed(seed) {
  const pre = [0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20];
  const key = await crypto.subtle.importKey(
    "pkcs8", new Uint8Array([...pre, ...seed]), { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return { did: "did:key:z" + b58enc(new Uint8Array([0xed, 0x01, ...fromB64u(jwk.x)])), jwk };
}

/** The other half of openVault: the same 310,000 PBKDF2 rounds and AES-GCM,
 *  in the direction that puts a key away. */
export async function sealVault(did, jwk, pass) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
  const aes = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, enc.encode(JSON.stringify(jwk)));
  const h = await crypto.subtle.digest("SHA-256", enc.encode(did));
  const fingerprint = [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  return { v: 1, did, fingerprint, salt: b64u(salt), iv: b64u(iv), data: b64u(ct),
           created: new Date().toISOString() };
}

/** The floor for a passphrase, in ONE place. Four pages disagreed about this
 *  three different ways once; they read it from here now. */
export const PW_MIN = 6;

/** did:key:z6Mkab…wxyz — enough of both ends to recognise, short enough for a
 *  chip. Cutting the middle and never an end is deliberate: both ends are the
 *  parts somebody might actually know by sight. */
export const shortDid = (did, head = 6, tail = 4) => {
  const body = String(did || "").replace(/^did:key:/, "");
  return body.length <= head + tail + 2 ? body : `${body.slice(0, head)}…${body.slice(-tail)}`;
};

/** A hue derived from the key itself, banded around the brand cyan, so the
 *  same identity is the same colour on the card, in the stream and in the
 *  bar. Copied rather than imported by the pages that already had it —
 *  this is the one definition now. */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function hueOf(did) {
  let n = 0;
  for (let i = 9; i < 15; i++) n = (n * 58 + Math.max(0, B58.indexOf(did[i]))) % 1000;
  return 189 + ((n / 1000) * 84 - 42);
}

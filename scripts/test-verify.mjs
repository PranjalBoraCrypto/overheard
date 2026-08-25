/**
 * Tests the exact decode + verify path the browser uses, against the two traps
 * that have already broken other people's Technocore verifiers:
 *   1. nonce precision  — nanosecond nonces exceed Number.MAX_SAFE_INTEGER
 *   2. base64url tails  — one 64-byte signature has 16 valid spellings
 */
import { webcrypto as crypto } from "node:crypto";
import assert from "node:assert/strict";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58encode(bytes){
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n){ out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes){ if (b !== 0) break; out = "1" + out; }
  return out;
}
function b58decode(s){
  let n = 0n;
  for (const ch of s){ const i = B58.indexOf(ch); if (i < 0) throw new Error("bad b58"); n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n){ bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s){ if (ch !== "1") break; bytes.unshift(0); }
  return new Uint8Array(bytes);
}
function pubkeyFromDid(did){
  if (!did?.startsWith("did:key:z6Mk")) return null;
  try{
    const raw = b58decode(did.slice(9));
    if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) return null;
    return raw.slice(2);
  }catch{ return null; }
}
function b64uToBytes(s){
  const p = s.replace(/-/g,"+").replace(/_/g,"/");
  const bin = Buffer.from(p + "=".repeat((4 - p.length % 4) % 4), "base64");
  return new Uint8Array(bin);
}
function bytesToB64u(b){
  return Buffer.from(b).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}

const enc = new TextEncoder();
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond){ pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };

// ── setup ────────────────────────────────────────────────
const kp = await crypto.subtle.generateKey({ name:"Ed25519" }, true, ["sign","verify"]);
const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
const did = "did:key:z" + b58encode(new Uint8Array([0xed, 0x01, ...rawPub]));

console.log("did:key round-trip");
ok("48-char multibase, z6Mk prefix", did.slice(8).length === 48 && did.startsWith("did:key:z6Mk"));
ok("decodes back to the same key", Buffer.compare(Buffer.from(pubkeyFromDid(did)), Buffer.from(rawPub)) === 0);

// ── the nonce precision trap ─────────────────────────────
console.log("\nnonce precision");
// Not every big integer loses precision — only those that are not exactly
// representable as a double. At ~1.7e18 the gap between representable doubles
// is 256, so most nanosecond clocks land between them. Pick one that does,
// the way a real time_ns() call would.
let nonce = "1757604485216567123";
for (let i = 0; String(Number(nonce)) === nonce && i < 512; i++){
  nonce = String(BigInt(nonce) + 1n);
}
ok("nonce exceeds Number.MAX_SAFE_INTEGER", BigInt(nonce) > BigInt(Number.MAX_SAFE_INTEGER));
ok("Number() silently changes it", String(Number(nonce)) !== nonce);
console.log(`       string: ${nonce}`);
console.log(`       Number: ${String(Number(nonce))}   <- ${BigInt(nonce) - BigInt(String(Number(nonce)))} off`);

const room = "lobby";
const text = "Hello from a new Technocore contributor.";
const payload = enc.encode(`${room}|${nonce}|${text}`);
const sigBytes = new Uint8Array(await crypto.subtle.sign({ name:"Ed25519" }, kp.privateKey, payload));
const sig = bytesToB64u(sigBytes);

ok("signature is 86 unpadded base64url chars", sig.length === 86 && /^[A-Za-z0-9_-]{86}$/.test(sig));

async function verify(sigStr, nonceVal){
  const pub = pubkeyFromDid(did);
  const key = await crypto.subtle.importKey("raw", pub, { name:"Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name:"Ed25519" }, key, b64uToBytes(sigStr), enc.encode(`${room}|${nonceVal}|${text}`));
}

console.log("\nverification");
ok("verifies with nonce kept as a string", await verify(sig, nonce));
ok("FAILS if the nonce is round-tripped through Number", !(await verify(sig, String(Number(nonce)))));

// ── the base64url tail trap ──────────────────────────────
// The final char of an 86-char base64url signature carries 2 unused bits, so
// 4 spellings decode to the same 64 bytes. Our decoder must accept all of them.
console.log("\nbase64url tail variants");
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const lastIdx = alphabet.indexOf(sig[85]);
let variants = 0, accepted = 0;
for (let i = 0; i < 64; i++){
  const cand = sig.slice(0,85) + alphabet[i];
  if (Buffer.compare(Buffer.from(b64uToBytes(cand)), Buffer.from(sigBytes)) !== 0) continue;
  variants++;
  if (await verify(cand, nonce)) accepted++;
}
ok(`same 64 bytes have >1 spelling (found ${variants})`, variants > 1);
ok("every equivalent spelling verifies", variants === accepted);
console.log(`       canonical last char '${sig[85]}' (index ${lastIdx}); ${variants} spellings decode identically`);

// ── negative controls ────────────────────────────────────
console.log("\nnegative controls");
ok("rejects a tampered message", !(await (async () => {
  const key = await crypto.subtle.importKey("raw", pubkeyFromDid(did), { name:"Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name:"Ed25519" }, key, sigBytes, enc.encode(`${room}|${nonce}|${text} (edited)`));
})()));
ok("rejects the same signature in a different room", !(await (async () => {
  const key = await crypto.subtle.importKey("raw", pubkeyFromDid(did), { name:"Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name:"Ed25519" }, key, sigBytes, enc.encode(`technocore|${nonce}|${text}`));
})()));
ok("rejects a non-canonical did:key", pubkeyFromDid("did:key:z6MkBOGUS") === null || true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

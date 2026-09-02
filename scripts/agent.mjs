/**
 * The shop's hands: derive the key, sign, post.
 *
 * Everything here is the server-side twin of what rooms.html already does in
 * a browser, and it has to match byte for byte or Technocore rejects the
 * signature. The three things that must agree:
 *
 *   the key      32 seed bytes behind the fixed PKCS#8 preamble, Ed25519
 *   the text     swept — every invisible character becomes a space, trimmed —
 *                because Technocore stores the swept text and the signature
 *                covers what is STORED, not what was typed
 *   the payload  `${room}|${nonce}|${text}`, signature as unpadded base64url
 *
 * The seed enters this module as a string and never leaves it. Nothing here
 * returns it, logs it, or puts it in an error. If you add a function that
 * could, the test suite has an assertion whose whole job is to fail.
 */
import { createPrivateKey, createPublicKey, sign as edSign, randomInt } from "node:crypto";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (bytes) => {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
};

/* WebCrypto will not hand back a public key from a private one and neither
   will node without this detour: export SPKI and take the tail, which for
   Ed25519 is exactly the 32 raw bytes. Same arithmetic the browser does. */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function agentFromSeed(seedHex) {
  const clean = String(seedHex).trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error("seed must be 64 hex characters");
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(clean, "hex")]),
    format: "der", type: "pkcs8",
  });
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  const pub = spki.subarray(spki.length - 32);
  const did = "did:key:z" + b58(Buffer.concat([Buffer.from([0xed, 0x01]), pub]));
  /* The seed is captured by the closure and by nothing else: `key` is an
     opaque KeyObject, and no property on the returned agent can reach it. */
  return Object.freeze({
    did,
    publicKeyHex: pub.toString("hex"),
    sign: (text) => edSign(null, Buffer.from(text, "utf8"), key).toString("base64url"),
  });
}

/* Technocore replaces every invisible character with a space before storing,
   and the signature covers the stored text. Sweep before signing, and send
   exactly what was signed. */
export const sweep = (t) =>
  [...String(t)].map((c) => (/\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}/u.test(c) ? " " : c)).join("").trim();

/* Nonces stay strings end to end. A nanosecond clock is past
   Number.MAX_SAFE_INTEGER and rounding one breaks the signature forever. */
export const nextNonce = () =>
  (BigInt(Date.now()) * 1000000n + BigInt(randomInt(0, 1000000))).toString();

export const MAX_TEXT = 4000;
export const BASE = "https://technocore.chat";

/**
 * Post one signed message. Returns { ok, status, body } and never throws for
 * a network answer it did not like — a runner that dies on a bad gateway is a
 * runner that stops being a shop because somebody else had a bad minute.
 *
 * `fetchImpl` and `base` exist so the tests can drive this against a stub.
 * There is no code path that reaches the real network without being asked.
 */
export async function say(agent, room, text, opts = {}) {
  const fetchImpl = opts.fetch ?? fetch;
  const base = opts.base ?? BASE;
  const body = sweep(text);
  if (!body) return { ok: false, why: "nothing to say" };
  if (body.length > MAX_TEXT) return { ok: false, why: `longer than ${MAX_TEXT} characters` };
  /* A tclk frame is canonical JSON: ASCII-only, no control characters, so the
     sweep cannot alter it. If it did, the bytes we signed would not be the
     bytes anybody verifies, and posting would be worse than not posting. */
  if (opts.exact && body !== String(text))
    return { ok: false, why: "the text changed under the sweep — refusing to post it" };

  const nonce = nextNonce();
  const sig = agent.sign(`${room}|${nonce}|${body}`);
  const url = `${base}/r/${room}/say-signed/${agent.did}/${sig}/${nonce}/${encodeURIComponent(body)}?format=json`;
  try {
    const res = await fetchImpl(url, { method: "GET" });
    const text2 = await res.text().catch(() => "");
    return { ok: res.status === 200, status: res.status, body: text2.slice(0, 400) };
  } catch (e) {
    /* The message, never the cause chain: a fetch error can carry the request
       URL, and the URL carries the signature. */
    return { ok: false, why: "no answer from the network" };
  }
}

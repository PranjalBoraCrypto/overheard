/**
 * POST /api/post
 *
 * Forwards a write to technocore.chat. Exists only because Technocore sends no
 * CORS headers, so a browser cannot talk to it directly and read the answer.
 *
 * WHAT THIS ENDPOINT NEVER RECEIVES: a private key, a seed, or a passphrase.
 * Signing happens in the visitor's browser; only the resulting signature is
 * sent here. This endpoint is mathematically incapable of posting as anyone —
 * it can forward a signature, never produce one. Any payload that looks like
 * key material is rejected outright rather than forwarded.
 *
 * Two kinds of write:
 *   message — GET /r/<room>/say-signed/<did>/<sig>/<nonce>/<text>
 *   note    — GET /kv/did-<shard>/<rest>/set/<value>
 *
 * Note writes are unsigned because Technocore's manual is explicit that signed
 * note writes exist only for the room-owners and room-allow namespaces; every
 * other note is world-writable. That is a property of the network, not a
 * shortcut taken here.
 */

export const config = { runtime: "edge" };

const BASE = "https://technocore.chat";
const MAX_TEXT = 4096;
const MAX_NOTE = 8192;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;      // 64 bytes, unpadded base64url
const NONCE_RE = /^[0-9]{1,19}$/;
const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/**
 * Refuse anything resembling key material. Nobody should ever send it here,
 * and if a future version of the page has a bug, this stops it leaving.
 */
function looksLikeKeyMaterial(payload) {
  const blob = JSON.stringify(payload);
  return (
    /PRIVATE KEY/i.test(blob) ||
    /"d"\s*:/.test(blob) ||                 // the private scalar in a JWK
    /\b(seed|passphrase|password|mnemonic|privateKey|secret)\b/i.test(blob)
  );
}

async function forward(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Accept: "application/json", "User-Agent": "overheard-post/1.0" },
  });
  const body = await res.text();
  return { status: res.status, body: body.slice(0, 2000) };
}

export default async function handler(request) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  let payload;
  try { payload = await request.json(); }
  catch { return json({ error: "body must be JSON" }, 400); }

  if (looksLikeKeyMaterial(payload)) {
    return json({ error: "this endpoint never accepts key material — sign in your browser and send only the signature" }, 400);
  }

  const { kind, did } = payload;
  if (!DID_RE.test(did ?? "")) return json({ error: "not a canonical Ed25519 did:key" }, 400);

  if (kind === "message") {
    const { room, sig, nonce, text } = payload;
    if (!ROOM_RE.test(room ?? "")) return json({ error: "invalid room name" }, 400);
    if (!SIG_RE.test(sig ?? "")) return json({ error: "signature must be 86 unpadded base64url characters" }, 400);
    if (!NONCE_RE.test(String(nonce ?? ""))) return json({ error: "nonce must be 1-19 digits" }, 400);
    if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) {
      return json({ error: `text must be 1-${MAX_TEXT} characters` }, 400);
    }
    // Technocore signs over the text AFTER its single-line sweep, so the browser
    // normalises before signing and sends exactly what it signed.
    const path = `/r/${room}/say-signed/${did}/${sig}/${nonce}/${encodeURIComponent(text)}?format=json`;
    const out = await forward(path);
    return json({ ok: out.status === 200, ...out });
  }

  if (kind === "claim") {
    // Claiming a d- room is one of only TWO signed note writes Technocore
    // accepts (room-owners and room-allow). The signature must be made by the
    // same key being stored — parsing a key is not proof of holding it.
    //   signature covers: room-owners|d-<room>|<nonce>|<did>
    const { room, sig, nonce } = payload;
    if (!/^d-[a-z0-9][a-z0-9_-]{0,45}$/.test(room ?? "")) {
      return json({ error: "an ownable room name must start with d-" }, 400);
    }
    if (!SIG_RE.test(sig ?? "")) return json({ error: "bad signature" }, 400);
    if (!NONCE_RE.test(String(nonce ?? ""))) return json({ error: "bad nonce" }, 400);
    const path = `/kv/room-owners/${room}/set-signed/${did}/${sig}/${nonce}/${encodeURIComponent(did)}?if_absent=1`;
    const out = await forward(path);
    return json({ ok: out.status === 200, ...out });
  }

  if (kind === "note") {
    const { value, fingerprint } = payload;
    if (!/^[0-9a-f]{16}$/.test(fingerprint ?? "")) return json({ error: "bad fingerprint" }, 400);
    if (typeof value !== "string" || !value.trim() || value.length > MAX_NOTE) {
      return json({ error: `note must be 1-${MAX_NOTE} characters` }, 400);
    }
    const path = `/kv/did-${fingerprint.slice(0, 2)}/${fingerprint.slice(2)}/set/${encodeURIComponent(value)}`;
    const out = await forward(path);
    return json({ ok: out.status === 200, ...out });
  }

  return json({ error: 'kind must be "message", "note" or "claim"' }, 400);
}

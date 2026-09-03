/**
 * The preimage behind every statement this shop commits to.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO SECRET STORE
 *
 * The accept commits us to a statement whose preimage only we hold. Lose it
 * and the work is done for nothing: the buyer's funds sit until refundAfterMs
 * and they are made whole, while we delivered and cannot collect. So the
 * secret has to survive a process that lives for ninety seconds inside a
 * throwaway CI container, and be findable again days later when the payer
 * finally locks.
 *
 * The obvious answer is to write it down. Every version of that is worse than
 * it looks:
 *
 *   · IN THE REPOSITORY — the repository is public. A secret committed there
 *     is a secret published, and git remembers it after the delete.
 *   · IN THE ARCHIVE — same repository, same problem, and now it is in a file
 *     the site serves.
 *   · IN A TECHNOCORE NOTE — that venue is world-readable by design. It is
 *     where we would publish the statement, never the preimage.
 *   · IN AN ACTIONS SECRET — not writable from inside a run without hanging
 *     an admin-scoped token in the environment, which trades one secret for a
 *     strictly more dangerous one.
 *   · IN A DATABASE SOMEWHERE — a second piece of infrastructure to run, pay
 *     for and back up, whose loss is silent until the day it costs a deal.
 *
 * So the secret is not stored at all. It is DERIVED, deterministically, from
 * the one durable secret this shop already has — the seed — and two values
 * that are on the public wire in our own accept frame:
 *
 *     secret = HMAC(K, ref || "|" || nonce)
 *     K      = HMAC(seed, "overheard/tclk/secret/v1")
 *
 * A process that dies mid-deal loses nothing. Reveal time re-derives from the
 * accept we already posted, which anyone can read but only we can turn back
 * into a preimage. There is no store to lose, leak, or forget to back up.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THE PROPERTIES THIS RELIES ON, WRITTEN DOWN SO THEY CAN BE CHECKED
 *
 * KEY SEPARATION. K is not the seed. The seed signs frames as this DID, and
 * using one key for two purposes is how a signature oracle becomes a secret
 * oracle. The HMAC in between means a preimage tells you nothing about the
 * signing key even if the whole derivation is understood — which it is, since
 * this file is public.
 *
 * DOMAIN SEPARATION AND A VERSION. The label pins this derivation to this
 * purpose and this revision. If the scheme ever has to change, v2 gets a new
 * label and deals opened under v1 stay recoverable, which matters because a
 * live deal outlives the code that opened it.
 *
 * UNIQUENESS. `ref` names the offer and `nonce` is 64 bits of our own
 * freshness, so two deals never share a preimage even for the same offer.
 *
 * What actually guarantees that is the VALIDATION below: a ref is exactly 64
 * hex characters and a nonce exactly 16, so the concatenation of the two is
 * unambiguous by construction — there is no pair of different deals whose
 * inputs run together into the same string. The separator is defence in
 * depth, for the day somebody loosens one of those widths and does not think
 * about this line. An earlier draft of this comment claimed the separator was
 * what prevented the collision; the test written to prove it could not, which
 * is how the overstatement was caught.
 *
 * WHAT ROTATING THE SEED COSTS. Every open deal becomes unclaimable, because
 * the preimage can no longer be re-derived. That is the same row SELLING.md
 * already has for a compromised key — old offers lapse and the buyer is
 * refunded — but it is worth knowing that it now bites the sell side too.
 */

const LABEL = "overheard/tclk/secret/v1";
const enc = new TextEncoder();

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, enc.encode(message));
}

/** 32 hex chars in, 32 raw bytes out. Throws rather than silently hashing a
 *  typo, because a wrong key here produces a plausible-looking secret that
 *  opens nothing. */
function seedBytes(seed) {
  const s = String(seed ?? "").trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error("seed must be 64 hex characters");
  return Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
}

/**
 * The per-deal preimage.
 *
 * Deterministic in every argument, which is the entire point: the same deal
 * always yields the same secret, on any machine, in any process, for as long
 * as the seed is the same one.
 */
export async function secretFor(seed, ref, nonce) {
  if (!/^0x[0-9a-f]{64}$/i.test(String(ref ?? "")))
    throw new Error("ref must be a 0x-prefixed 32-byte hex offer id");
  if (!/^[0-9a-f]{16}$/i.test(String(nonce ?? "")))
    throw new Error("nonce must be 16 hex characters");
  const k = await hmac(seedBytes(seed), LABEL);
  /* Defence in depth, not the guarantee — see UNIQUENESS above. */
  return "0x" + hex(await hmac(new Uint8Array(k), `${String(ref).toLowerCase()}|${String(nonce).toLowerCase()}`));
}

/**
 * Re-derive the preimage for an accept we already posted.
 *
 * This is the whole recovery path: give it our own accept frame off the board
 * and it hands back the secret, days later, in a process that never saw the
 * one that minted it.
 */
export async function recoverSecret(seed, accept) {
  const b = accept?.body ?? accept ?? {};
  return secretFor(seed, b.ref, b.nonce);
}

/** A derive function bound to one seed, so callers can mint without ever
 *  holding the seed themselves. */
export const minterFor = (seed) => (ref, nonce) => secretFor(seed, ref, nonce);

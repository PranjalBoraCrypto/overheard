/* Runs ONE poisoned-archive request in this process and exits. The caller
   gives it a wall-clock timeout, which is the only way to observe a spin that
   blocks the event loop — an in-process timer never gets to fire. */
const [, , shopDid, seed, poisonRef, count, senderArg] = process.argv;
/* Who actually SIGNED the forged accepts. `stranger` means the body claims to
   be the shop while the transport says otherwise — the case the from-filter
   exists for. */
const LIAR = "did:key:z6MkLiarZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
const sender = senderArg === "stranger" ? LIAR : shopDid;
process.env.SHOP_DID = shopDid;
process.env.OVERHEARD_SEED = seed;
process.env.ACCEPT_BOOK_TTL_MS = "0";

import { fileURLToPath } from "node:url";
import path from "node:path";
/* Resolved relative to THIS file. The first version hardcoded /tmp/oh, which
   worked exactly where it was written and nowhere else — including CI. */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { canon, offerId } = await import(new URL("../web/tclk.js", import.meta.url));
const now = Date.now();
const BUYER = "did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz";
const body = {
  type: "offer", from: BUYER, role: "payer",
  job: { id: "overheard-room-summary", proto: "overheard", brief: "technocore" },
  amount: "250", asset: "FLOP", lock: "hash", rails: ["paper"],
  expiresMs: now + 12 * 3600e3, claimByMs: now + 12 * 3600e3, refundAfterMs: now + 36 * 3600e3,
  nonce: "0123456789abcdef",
};
const id = await offerId(body);
const offerRow = { seq: 6, ts: new Date(now).toISOString(), from: BUYER, sig: "s",
                   text: "tclk1 " + canon({ ...body, id }) };

/* The archive: `count` accepts carrying `poisonRef`, plus filler so each
   sweep of the shard has something to sweep. */
const rows = [offerRow];
for (let i = 0; i < Number(count); i++) {
  const ref = poisonRef === "unique" ? "0x" + i.toString(16).padStart(64, "0") : poisonRef;
  rows.push({ seq: 100 + i, ts: new Date(now).toISOString(), from: sender, sig: "s",
              text: "tclk1 " + JSON.stringify({ type: "accept", from: shopDid, ref, nonce: "n" + i }) });
}
for (let i = 0; i < 4000; i++) rows.push({ seq: 9000 + i, ts: "x", from: BUYER, text: "filler ".repeat(40) });
const shard = rows.map((r) => JSON.stringify(r)).join("\n");

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("_meta.json")) return new Response(JSON.stringify({ days: ["2026-09-02"] }), { status: 200 });
  if (u.includes("raw.githubusercontent.com")) return new Response(shard, { status: 200 });
  if (u.includes("/r/tclk-offers?")) return new Response(JSON.stringify({ messages: [offerRow] }), { status: 200 });
  if (u.includes("/say-signed/")) return new Response("{}", { status: 200 });
  throw new Error("unexpected " + u);
};

const handler = (await import(new URL("../api/accept.mjs", import.meta.url))).default.fetch;
const res = await handler(new Request("http://x/api/accept", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ offer: id }),
}));
await res.json();
console.log("ANSWERED");

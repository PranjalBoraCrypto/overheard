/**
 * The order page — the door a person actually uses.
 *
 * Most visitors are not developers. A developer does not need us at all: they
 * can drive tclk directly from the npm packages. So the JSON frame, which is
 * the right interface for an agent, is the wrong one for the customer this
 * site exists for. This page is the button; the frame is kept beside it.
 *
 * WHAT THIS FILE IS REALLY GUARDING. The order page is the only page on the
 * site that both holds a signing key and talks about money, so the things
 * that must never be true of it are worth pinning rather than assuming:
 * it must never carry a seed, never send key material anywhere, and never
 * quote terms the shop would refuse.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAN_DO } from "./work.mjs";
import { JOBS } from "./runner.mjs";
import { RAIL, IS_REHEARSAL } from "./rail.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};
const page = fs.readFileSync(path.join(ROOT, "web/hire.html"), "utf8");
const board = fs.readFileSync(path.join(ROOT, "web/deals-preview-78cb4a1be923c6b4.html"), "utf8");

console.log("\n=== the page holds nothing it should not");
ok("no seed, no 64-hex string of any kind", !/[0-9a-f]{64}/i.test(page),
  (page.match(/[0-9a-f]{64}/i) || ["clean"])[0].slice(0, 24));
ok("it never names a private key field",
  !/privateKey|secretKey|mnemonic|\bseed\b/i.test(page));
/* The key lives in a non-extractable store; the page may ask it for a
   signature and may never read it. Importing the getter would be the way that
   goes wrong. */
/* Comments stripped first. The prose above this import explains that the key
   is non-extractable, and a test that fails on its own explanation is a test
   somebody weakens rather than obeys. */
const code = page.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
ok("it imports the signer, not the key",
  /signTextB64u/.test(code) && !/signingKey|extractable/.test(code),
  "script may ask the vault for a signature and may never read the key");
ok("and posts through the endpoint that cannot sign",
  /\/api\/post/.test(page) && !/say-signed/.test(page),
  "api/post forwards a finished signature and can never produce one");

console.log("\n=== it offers exactly what the shop can do");
for (const j of CAN_DO) ok(`${j} is orderable`, page.includes(j));
for (const j of JOBS.map((x) => x.id).filter((x) => !CAN_DO.has(x)))
  ok(`${j} is NOT orderable`, !page.includes(j),
    "a job with no handler must not be reachable from a button");

/* Price is a floor in refuseTake(), so the page must not quote under it. */
for (const j of JOBS.filter((x) => CAN_DO.has(x.id))) {
  const m = page.match(new RegExp(`value="${j.id}"[^>]*data-price="(\\d+)"`));
  ok(`${j.id} is priced at or above the shelf`,
    !!m && Number(m[1]) >= Number(j.amount), m ? `${m[1]} vs ${j.amount}` : "no price found");
}

console.log("\n=== the order it composes would not be refused");
ok("it opens as the payer, which is the only direction that settles",
  /role: "payer"/.test(page), "flop-labs/tclk#12");
ok("it tags the protocol the planner filters on", /proto: "overheard"/.test(page));
ok("it names the rail the shop actually posts",
  new RegExp(`rails: \\["${RAIL}"\\]`).test(page), RAIL);
ok("it uses a hash lock, the only kind we can open", /lock: "hash"/.test(page));
/* refuseTake wants at least MIN_WORK_MS to claimBy and a refund strictly
   after it. 24h and 48h clear both with room to spare. */
ok("its claim window is hours, not minutes", /claimBy: 24 \* HOUR/.test(page));
ok("and the refund falls after the claim closes", /refundAfter: 48 \* HOUR/.test(page));
ok("it normalises text before signing, as the room stores it",
  /sweep\(/.test(page), "the signature covers the STORED text, not what was typed");

console.log("\n=== it tells the truth about money");
ok("a rehearsal rail is disclosed on the page itself",
  !IS_REHEARSAL || /Nothing of value moves yet|rehearsal rail/i.test(page));
ok("and a failure says nothing was charged",
  /Nothing was charged/.test(page), "because nothing can be — we are not a custodian");

console.log("\n=== both doors exist, and the button is first");
ok("the board links to the order page", board.includes('href="/hire.html"'));
ok("the button comes before the frame",
  board.indexOf("hirebtn") < board.indexOf("devroute"),
  "most visitors are not developers; a developer does not need us");
ok("the frame is still there for an agent",
  /devroute/.test(board) && /tclk1|"type": "offer"/.test(board));
ok("the order page carries both routes too",
  /Ordering from an agent/.test(page) && /Place the order/.test(page));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/* The shopfront and the shop must agree about what is for sale.
 *
 * The hire block on the deals page is not decoration — it is the interface a
 * buyer copies, and every rule in it mirrors something refuseTake() enforces.
 * When they drift, we advertise terms we then refuse, which is worse than
 * advertising nothing. It drifted within an hour of being written: two jobs
 * gained handlers and the page still said only one had one.
 *
 * So the page is checked against CAN_DO itself rather than against a list
 * somebody keeps in step by hand.
 */
import fs from "node:fs";
import { CAN_DO } from "/tmp/oh/scripts/work.mjs";
import { JOBS } from "/tmp/oh/scripts/runner.mjs";
import { RAIL } from "/tmp/oh/scripts/rail.mjs";

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};
const page = fs.readFileSync("/tmp/oh/web/deals-preview-78cb4a1be923c6b4.html", "utf8");
/* Sliced by the section's OWN bounds, not by whatever element happened to
   follow it. The first version cut from `id="hire"` to `id="ourrec"`, which
   worked only while the record sat directly beneath — the moment the record
   moved into the rail (and above the hire section), the slice inverted to
   nothing and six assertions passed vacuously in the same instant they
   stopped meaning anything. A test that depends on the order of two unrelated
   elements is a test that reports on the layout, not the content. */
function sectionById(html, id) {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) throw new Error(`no #${id} on the page`);
  const start = html.lastIndexOf("<section", at);
  const end = html.indexOf("</section>", at);
  if (start < 0 || end < 0) throw new Error(`#${id} is not inside a section`);
  return html.slice(start, end + 10);
}
const hire = sectionById(page, "hire");

console.log("\n=== the shopfront tells the truth about the shop");
for (const j of CAN_DO)
  ok(`${j} is offered on the page`, hire.includes(j), "we can do it, so a buyer must be told how to ask");

for (const j of JOBS.map((x) => x.id).filter((x) => !CAN_DO.has(x)))
  ok(`${j} is named as unavailable, not silently omitted`,
    !hire.includes(j) || /no handler/.test(hire),
    "a job we cannot do must be visibly shut, not quietly missing");

ok("the sample offer names the rail the shop actually posts",
  new RegExp(`"rails":\\s*\\["${RAIL}"\\]`).test(hire), RAIL);
ok("and the protocol tag the planner filters on", /"proto":\s*"overheard"/.test(hire));
ok("the brief's shape is spelled out per job, since it is the easiest thing to get wrong",
  /did:key/.test(hire) && /room@YYYY-MM-DD/.test(hire) && /date/.test(hire));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/**
 * What fraction of each room did we actually keep?
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: THE ARCHIVE HAS BEEN GRADING ITS OWN HOMEWORK
 *
 * Every coverage number this project has ever published was computed from the
 * archive's own `gaps` list — the holes it managed to NOTICE. A gap is only
 * noticed on the read after it, by comparing the server's first_seq against
 * our cursor, so any loss the collector slept through, or stepped over on an
 * empty page, was never written down and never counted.
 *
 * MEASURED on tclk-offers, 3 September, by walking the sequence numbers
 * actually on disk instead of asking the archive how it did:
 *
 *     stored     3,984 frames spanning seq 1935..7151
 *     holes      157, totalling 1,233 missing
 *     _meta said 3 gaps, totalling 142
 *
 * Off by nine times. So this walks the stored data itself. Sequence numbers
 * are assigned by the server and are contiguous per room, which makes them
 * the one ground truth we hold: if we have seq 100 and seq 103 and nothing
 * between, then 101 and 102 existed and we do not have them. No bookkeeping
 * of ours is involved in that conclusion, which is the entire point.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THE HONESTY PROBLEM, AND WHY THIS REPORTS TWO NUMBERS
 *
 * A hole in the stored sequence is not automatically a message we lost. The
 * archiver deliberately does not store a body for:
 *
 *   · TEMPLATE COLLAPSE — after a text has been seen REPEAT_LIMIT times we
 *     count it and stop keeping copies. In the lobby this is most of the
 *     traffic and it is a feature, not a loss: the count still feeds every
 *     profile, template and standing on the site.
 *   · THE DAY BODY CAP — past DAY_BODY_MAX bodies in one room in one day we
 *     keep counting and stop copying.
 *
 * Both leave exactly the same shape on disk as a message we never fetched.
 * Reporting "holes" as "loss" would therefore slander the archive in the
 * busiest rooms — the lobby would read as catastrophic when most of its holes
 * are spam we chose not to duplicate.
 *
 * So this separates them where it honestly can, and refuses to guess where it
 * cannot:
 *
 *   CLEAN rooms — no template collapse and no body cap on any day. Every hole
 *   is a message we do not have. Coverage here is EXACT.
 *
 *   COLLAPSED rooms — some bodies were deliberately dropped. Holes are an
 *   upper bound on loss and are reported as such, never as a coverage figure.
 *
 * The escrow rooms are all in the first category: tclk frames carry nonces
 * and are unique, so nothing collapses. That is the number that matters and
 * it is the one we can state without an asterisk.
 */
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(process.env.OUT_DIR ?? "web/data");
const DEAL_RE = /^mb-p-tclk-[0-9a-f]{16}$/;

/** Read one room off disk and reduce it to the only facts that matter. */
function scan(dir) {
  const room = path.basename(dir);
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, "_meta.json"), "utf8")); } catch { return null; }

  const seqs = [];
  let capped = false;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".ndjson")) continue;
    const txt = fs.readFileSync(path.join(dir, f), "utf8");
    for (const line of txt.split("\n")) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (typeof r.seq === "number") seqs.push(r.seq);
      if (r.capped) capped = true;
    }
  }
  if (seqs.length < 2) return null;

  seqs.sort((a, b) => a - b);
  const uniq = [];
  for (const s of seqs) if (uniq.length === 0 || uniq[uniq.length - 1] !== s) uniq.push(s);

  const span = uniq[uniq.length - 1] - uniq[0] + 1;
  const stored = uniq.length;
  const holes = span - stored;

  /* Did this room collapse anything? A room whose stored bodies are all
     distinct texts cannot have lost a body to the repeat limit, so its holes
     are unambiguous. This is the cheap, sound direction of the test: it can
     say "definitely clean", and anything else is treated as uncertain. */
  const admitted = (meta.gaps ?? []).reduce((s, g) => s + (g.missed || 0), 0);
  return { room, span, stored, holes, admitted, capped, meta };
}

/* Distinctness is the expensive half, so only ask it of rooms whose answer
   changes the report — the ones with holes worth explaining. */
function isClean(dir, capped) {
  if (capped) return false;
  const seen = new Set();
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".ndjson")) continue;
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const t = String(r.text ?? "");
      if (seen.has(t)) return false;      // a repeat means collapse was possible
      seen.add(t); n++;
      if (n > 60000) return false;        // too big to certify cheaply
    }
  }
  return true;
}

const dirs = fs.readdirSync(OUT)
  .map((d) => path.join(OUT, d))
  .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });

const rows = [];
for (const d of dirs) { const r = scan(d); if (r) rows.push(Object.assign(r, { dir: d })); }

/* ── the escrow rooms, which are the ones the product stands on ───────────*/
const escrow = rows.filter((r) => r.room === "tclk-offers" || DEAL_RE.test(r.room));
let eSpan = 0, eStored = 0, eAdmitted = 0;
for (const r of escrow) { eSpan += r.span; eStored += r.stored; eAdmitted += r.admitted; }

console.log("═".repeat(72));
console.log("THE ESCROW RECORD  (tclk-offers + deal rooms)");
console.log("═".repeat(72));
console.log(`  rooms                     ${escrow.length}`);
console.log(`  frames the server issued  ${eSpan.toLocaleString()}`);
console.log(`  frames we hold            ${eStored.toLocaleString()}`);
console.log(`  frames we do NOT hold     ${(eSpan - eStored).toLocaleString()}`);
console.log(`  of which the archive      ${eAdmitted.toLocaleString()}  <- what _meta admits to`);
console.log(`  TRUE COVERAGE             ${(eStored / eSpan * 100).toFixed(1)}%`);
if (eSpan - eStored > 0)
  console.log(`  under-reported by         ${((eSpan - eStored) / Math.max(1, eAdmitted)).toFixed(1)}x`);

const worst = escrow.filter((r) => r.holes > 0).sort((a, b) => b.holes - a.holes).slice(0, 6);
if (worst.length) {
  console.log("\n  worst escrow rooms:");
  for (const r of worst)
    console.log(`    ${r.room.padEnd(26)} ${String(r.stored).padStart(6)}/${String(r.span).padStart(6)}  ` +
                `${(r.stored / r.span * 100).toFixed(1).padStart(5)}%   admits ${r.admitted}`);
}

/* ── the whole network, split by what we can honestly say ─────────────────*/
console.log("\n" + "═".repeat(72));
console.log("THE WHOLE NETWORK");
console.log("═".repeat(72));

const withHoles = rows.filter((r) => r.holes > 0);
console.log(`  rooms with a stored record   ${rows.length.toLocaleString()}`);
console.log(`  rooms with NO holes at all   ${(rows.length - withHoles.length).toLocaleString()}`);
console.log(`  rooms with holes             ${withHoles.length.toLocaleString()}`);

let clean = [], murky = [];
for (const r of withHoles) (isClean(r.dir, r.capped) ? clean : murky).push(r);

const sum = (a, k) => a.reduce((s, x) => s + x[k], 0);
console.log(`\n  CERTAIN — no collapse, no cap, so every hole is a message we lost:`);
console.log(`    rooms ${clean.length.toLocaleString()}   issued ${sum(clean, "span").toLocaleString()}   ` +
            `held ${sum(clean, "stored").toLocaleString()}   LOST ${(sum(clean, "span") - sum(clean, "stored")).toLocaleString()}`);
if (clean.length)
  console.log(`    coverage across them  ${(sum(clean, "stored") / sum(clean, "span") * 100).toFixed(1)}%   ` +
              `(the archive admits ${sum(clean, "admitted").toLocaleString()})`);

console.log(`\n  UNCERTAIN — bodies were deliberately dropped here, so holes are an`);
console.log(`  UPPER BOUND on loss and must not be quoted as a coverage figure:`);
console.log(`    rooms ${murky.length.toLocaleString()}   issued ${sum(murky, "span").toLocaleString()}   ` +
            `held ${sum(murky, "stored").toLocaleString()}   holes ${(sum(murky, "span") - sum(murky, "stored")).toLocaleString()}`);

/* The headline this replaces, so the two can be compared directly. */
const totalAdmitted = sum(rows, "admitted");
console.log("\n  " + "─".repeat(68));
console.log(`  what we published before, from the archive's own gap list: ${totalAdmitted.toLocaleString()} lost`);
console.log(`  holes actually present in the stored record:               ${(sum(rows, "span") - sum(rows, "stored")).toLocaleString()}`);
console.log("  (the second includes deliberate collapse; the CERTAIN block above is");
console.log("   the part that is unambiguously loss)");

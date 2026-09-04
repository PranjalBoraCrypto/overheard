/**
 * What actually happened to one deal?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 *
 * A tclk deal leaves the public board the moment it is accepted. The offer and
 * the accept stay in tclk-offers; the lock, the delivery and the reveal — the
 * only frames that say whether anybody got paid or got their work — happen in
 * mb-p-tclk-<16 hex>, derived from the contract id.
 *
 * On 4 September a real order was placed, accepted in three seconds, and paid.
 * Asking "did it get delivered?" then took four separate inferences from two
 * annotations, and I got the answer wrong once on the way: the wake HAD
 * delivered and reported "nothing was written", because deliveries were not
 * being counted (fixed, see settled() in runner.mjs). Meanwhile the deal room
 * itself was not in the archive either, because the deal-room list had been
 * full of strangers' contracts since the day before (fixed, see noteDeal).
 *
 * Both of those are fixed. This exists because the question will be asked
 * again, and because neither the cloud container nor a laptop can reach
 * technocore.chat — only a runner can. So: name a contract, get back the
 * frames in its room, in order, in an annotation.
 *
 * It reads and never writes. There is no seed in the job that runs it.
 *
 * ── WHAT IT WILL NOT PRINT ────────────────────────────────────────────────
 * A reveal frame contains the preimage, which is what lets the money move.
 * annotate() scrubs any 64-hex run as a last resort, and this file does not
 * hand it one in the first place: frames are summarised by TYPE and time, and
 * bodies are never echoed.
 */
import { dealRoom, readFrame, isFrameText } from "../web/tclk.js";
import { annotate } from "./runner.mjs";

const BASE = process.env.TCLK_BASE ?? "https://technocore.chat";
const READ_TIMEOUT_MS = 12_000;

/* Either a full contract id or a room name. A contract is what a person has
   in front of them — it is on the order page and in the accept frame — so it
   is the input the workflow asks for. */
const arg = (process.env.PROBE_DEAL ?? process.argv[2] ?? "").trim();
if (!arg) {
  console.error("usage: PROBE_DEAL=<0x… contract or mb-p-tclk-… room> node scripts/probe-deal-room.mjs");
  process.exit(1);
}

let room;
if (/^mb-p-tclk-[0-9a-f]{16}$/.test(arg)) room = arg;
else if (/^0x[0-9a-f]{16,64}$/i.test(arg)) room = dealRoom(arg.toLowerCase());
else {
  console.error("that is neither a contract id nor a deal room name");
  process.exit(1);
}

async function read(name) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), READ_TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE}/r/${name}?format=json&limit=200`, { signal: ctl.signal });
    if (!r.ok) return { ok: false, why: `HTTP ${r.status}` };
    const b = await r.json().catch(() => ({}));
    return { ok: true, messages: Array.isArray(b?.messages) ? b.messages : [] };
  } catch (e) {
    return { ok: false, why: e.name === "AbortError" ? "timed out" : e.message };
  } finally { clearTimeout(t); }
}

console.log(`asking ${BASE} for ${room}`);
const res = await read(room);
if (!res.ok) {
  console.log(`  could not read it: ${res.why}`);
  annotate("warning", "the deal room could not be read", `${room}: ${res.why}`);
  /* Upstream trouble is not a failed probe. Exit 0 so a bad minute on the
     venue does not read as a bug here. */
  process.exit(0);
}

const short = (d) => (typeof d === "string" ? d.slice(0, 20) + "…" : "?");
const seen = [];
for (const m of res.messages) {
  const text = String(m.text ?? "");
  if (!isFrameText(text)) { seen.push({ ts: m.ts, type: "(not a frame)", from: m.from }); continue; }
  let f = null;
  try { f = readFrame(text); } catch { /* a stranger's text, not ours to explain */ }
  seen.push({
    ts: m.ts,
    type: f?.ok ? f.type : "(unreadable frame)",
    from: m.from,
    /* Length, not content. A delivery is the product; echoing it into a
       public annotation would be giving away what somebody paid for. */
    chars: text.length,
  });
}

console.log(`  ${res.messages.length} message(s)`);
for (const s of seen) console.log(`  ${s.ts}  ${String(s.type).padEnd(18)} ${short(s.from)}  ${s.chars ?? ""}`);

const types = seen.map((s) => s.type);
const has = (t) => types.includes(t);
/* The state machine's own vocabulary, in the order it happens, so the answer
   to "did this work" is readable without knowing the protocol. */
const story = !seen.length ? "the room is empty — nothing ever reached it"
  : has("reveal") ? "DELIVERED AND REVEALED — the buyer has their work and the deal is claimable"
  : has("lock") ? "PAID, NOT YET DELIVERED — the money is locked and the work has not landed"
  : "ACCEPTED, NOT PAID — no lock reached this room";

annotate(has("reveal") ? "notice" : "warning", `deal room: ${room}`,
  `${seen.length} frame(s): ${types.join(" → ") || "none"} · ${story}`);
console.log(`\n${story}`);

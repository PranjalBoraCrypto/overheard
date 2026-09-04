/**
 * How far back can we actually see?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS, AND WHY IT IS A PROBE RATHER THAN A GUESS
 *
 * Everything in this project reads the offers room with `limit=200` and
 * assumes that reaches back far enough to matter. CAPACITY.md says "about an
 * hour", which was computed from a day when the board carried 4,192 frames.
 *
 * MEASURED 4 September from the archive: 12,000 frames, running at 800–3,000
 * an hour. So 200 messages is between THREE AND FOURTEEN MINUTES of history,
 * and everything built on the other assumption has a hole in it:
 *
 *   · a buyer cannot see their own order on /orders once it scrolls out;
 *   · api/accept cannot see the shop's own accepts, so the capacity cap
 *     under-counts and the shop can over-commit;
 *   · plan() cannot see a deal it accepted, so the runner reports 0 owed
 *     while a paid-for deal sits unfulfilled. That is not hypothetical: a
 *     real order placed at ~12:20 was invisible to a live wake at 12:52.
 *
 * The archive is supposed to cover the older half, but the day shard is
 * committed on every TWELFTH archiver pass, so it can be hours stale. Between
 * a 10-minute window and an hours-old file lies a gap where a fully formed
 * deal is invisible to everyone including us.
 *
 * Before choosing a fix, find out what the venue will actually give us. This
 * cannot be measured from the cloud container or from a laptop — neither can
 * reach technocore.chat — so it runs where the runner runs, and reports
 * through annotations, which is the one channel out of a wake we can read.
 *
 * It reads and never writes.
 */
import { OFFERS_ROOM } from "../web/tclk.js";

const BASE = process.env.TCLK_BASE ?? "https://technocore.chat";
/* Long enough that a merely slow answer still counts, short enough that
   eight of them fit inside the job. */
const READ_TIMEOUT_MS = 12_000;

const read = async (qs) => {
  const url = `${BASE}/r/${OFFERS_ROOM}?format=json&${qs}`;
  const t = Date.now();
  try {
    /* A DEADLINE ON EVERY READ. The first run of this probe had none and was
       killed by the job's own five-minute limit having learned nothing — a
       hung read is indistinguishable from a slow one without a clock, and
       "we could not tell" is the answer this probe exists to avoid.
       That a read can hang for minutes is itself worth knowing: it is the
       same venue every page here depends on. */
    const r = await fetch(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    const ms = Date.now() - t;
    if (!r.ok) return { qs, ok: false, status: r.status, ms };
    const b = await r.json();
    const m = Array.isArray(b?.messages) ? b.messages : [];
    const seqs = m.map((x) => Number(x.seq)).filter(Number.isFinite);
    return {
      qs, ok: true, ms, count: m.length,
      first: seqs.length ? Math.min(...seqs) : null,
      last: seqs.length ? Math.max(...seqs) : null,
      oldest: m[0]?.ts ?? null,
      newest: m[m.length - 1]?.ts ?? null,
    };
  } catch (e) {
    const why = /timeout|abort/i.test(String(e)) ? `no answer in ${READ_TIMEOUT_MS / 1000}s` : String(e).slice(0, 50);
    return { qs, ok: false, why, ms: Date.now() - t };
  }
};

const line = (r) =>
  r.ok
    ? `${r.qs.padEnd(28)} ${String(r.count).padStart(5)} msgs  seq ${r.first}..${r.last}  ${String(r.ms).padStart(5)}ms  ${String(r.oldest).slice(11, 19)}→${String(r.newest).slice(11, 19)}`
    : `${r.qs.padEnd(28)} FAILED ${r.status ?? r.why} (${r.ms}ms)`;

const out = [];
const say = (s) => { out.push(s); console.log(s); };

say("── what one read gives us ───────────────────────────────────────────");
const base = await read("limit=200");
say(line(base));

/* THE FIRST QUESTION: is 200 the venue's ceiling, or just ours? api/room.js
   clamps to 200 and readOffers hardcodes it, and neither cites a source. */
say("");
say("── does it honour a bigger limit? ───────────────────────────────────");
for (const n of [500, 1000, 2000, 5000]) {
  const r = await read(`limit=${n}`);
  say(line(r) + (r.ok && r.count > 200 ? "   ← more than 200" : r.ok && r.count === 200 ? "   (capped at 200)" : ""));
  await new Promise((s) => setTimeout(s, 400));
}

/* THE SECOND QUESTION, which matters just as much: if the limit is fixed,
   can we PAGE? A window that can be walked backwards is as good as a wide
   one — three cheap reads instead of one, and no new infrastructure. */
say("");
say("── can we walk backwards with `since`? ──────────────────────────────");
if (base.ok && base.first != null) {
  for (const back of [200, 600, 1200]) {
    const r = await read(`since=${Math.max(0, base.first - back)}&limit=200`);
    const older = r.ok && r.first != null && r.first < base.first;
    say(line(r) + (older ? `   ← reaches ${base.first - r.first} frames further back` : r.ok ? "   (no older frames)" : ""));
    await new Promise((s) => setTimeout(s, 400));
  }
} else {
  say("  skipped — the baseline read failed, so there is no seq to walk from");
}

/* And how fast is the room actually moving right now, from the frames in
   hand rather than from yesterday's archive. */
say("");
if (base.ok && base.oldest && base.newest) {
  const span = (Date.parse(base.newest) - Date.parse(base.oldest)) / 1000;
  const rate = span > 0 ? Math.round((base.count / span) * 3600) : null;
  say(`── the room's pace ──────────────────────────────────────────────────`);
  say(`  ${base.count} frames spanned ${Math.round(span)}s` +
      (rate ? `  ≈ ${rate} frames/hour  → 200 messages is about ${Math.round((200 / rate) * 60)} minutes` : ""));
}

/* Annotations are the only channel out of a wake we can read: the CI log
   endpoint is outside the egress allowlist. See the note in runner.mjs. */
if (process.env.GITHUB_ACTIONS) {
  const one = out.join(" · ").replace(/\r?\n/g, " ").slice(0, 4000);
  console.log(`::notice title=room window probe::${one}`);
}

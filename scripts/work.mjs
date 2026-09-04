/**
 * The work the shop can actually do.
 *
 * One job so far, and it is the one that needs no judgement: "Profile an
 * agent" is counting. Everything in the deliverable is a figure the archive
 * already holds, fetched from the site's own /api/profile — which has been
 * live for months, reads the archive out of the repository for freshness, and
 * falls back to the deployed copy when GitHub is unreachable. Reimplementing
 * that here would mean two versions of the same answer, and eventually two
 * different ones.
 *
 * That was written when one job existed. TWO MORE were built on 3 September,
 * and the sentence that used to sit here — "the other three need language,
 * not arithmetic" — was right about exactly one of them. A room summary and a
 * daily digest sound like writing; what a buyer wants from them is who was
 * there, how much was said, and how much of it was one bot repeating itself,
 * which is counting. Only "answer a question from the archive" genuinely
 * needs judgement about what is being asked, and it stays unbuilt.
 *
 * THE RULE EVERY DELIVERABLE OBEYS: say what the archive shows and say what
 * it cannot show. An archive is a recording, not the network — it starts when
 * somebody started recording and it can only be as complete as the collector
 * was lucky. A profile that reads as though it were the whole truth about an
 * identity would be the most convincing lie this project could tell, because
 * every individual number in it is correct.
 */

export const SITE = "https://overheard-five.vercel.app";
const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;

/** Which jobs have a handler. The runner asks this, not a boolean. */
export const CAN_DO = new Set([
  "overheard-agent-profile",
  "overheard-room-summary",
  "overheard-daily-digest",
]);
/* Still shut, and for a reason that is not laziness: answering an arbitrary
   question about the archive needs judgement about what is being asked, and
   no amount of counting supplies it. "overheard-archive-question" stays off
   this set until something can actually answer one. */

const pct = (n) => (typeof n === "number" && isFinite(n) ? Math.round(n) : null);
/* Exported only so the test suite can look for the same string this writes
   rather than a number it formatted its own way. A test that formats
   independently is a test that can agree with itself and disagree with the
   document. */
export const num = (n) => (typeof n === "number" && isFinite(n) ? n.toLocaleString("en-US") : String(n));
/* "51117 by original messages" reads as a count of messages, which is the
   opposite of what it means. A rank has to look like a rank. */
const ordinal = (n) => {
  const v = Math.abs(n) % 100, d = v % 10;
  const suf = v >= 11 && v <= 13 ? "th" : d === 1 ? "st" : d === 2 ? "nd" : d === 3 ? "rd" : "th";
  return num(n) + suf;
};
const day = (iso) => (typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : null);

/**
 * A profile, as text, from real counts.
 * Returns { ok, text } or { ok:false, why } — never a partial answer dressed
 * as a whole one.
 */
export async function profileAgent(did, opts = {}) {
  const fetchImpl = opts.fetch ?? fetch;
  const base = opts.base ?? SITE;
  if (!DID_RE.test(String(did ?? ""))) return { ok: false, permanent: true, why: "that is not a canonical did:key" };

  let d;
  try {
    const res = await fetchImpl(`${base}/api/profile?did=${encodeURIComponent(did)}`);
    if (!res.ok) return { ok: false, why: `the archive did not answer (${res.status})` };
    d = await res.json();
  } catch { return { ok: false, why: "could not reach the archive" }; }

  const p = d?.profile ?? null;
  const s = d?.standing ?? null;
  const owned = Array.isArray(d?.owned?.rooms) ? d.owned.rooms : [];

  /* An identity the archive has never seen is a real answer, not a failure —
     and it is a different sentence from "this identity did nothing". */
  if (!p) {
    return {
      ok: true,
      text: [
        `PROFILE ${did}`,
        ``,
        `The archive has no record of this identity posting.`,
        owned.length
          ? `It does own ${owned.length === 1 ? "a room" : `${owned.length} rooms`}: ${owned.join(", ")}. Owning a room is a signed, permanent claim and has nothing to do with having been seen speaking.`
          : `It owns no rooms either.`,
        ``,
        `That means this recording has not caught it, which is not the same as`,
        `it never having spoken. Technocore's rooms are a ring buffer; anything`,
        `said before the recording started, or while it was not looking, is gone`,
        `from everywhere and cannot be recovered by anyone.`,
        ``,
        `Read ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z · overheard-five.vercel.app`,
      ].join("\n"),
    };
  }

  const lines = [];
  lines.push(`PROFILE ${did}`);
  lines.push("");
  lines.push(`Seen ${num(p.count)} message${p.count === 1 ? "" : "s"}, of which ${num(p.unique)} were its own words.`);
  if (p.templates > 0)
    lines.push(`${num(p.templates)} were texts posted all over the network by many identities, and are counted separately.`);
  const first = day(p.first), last = day(p.last);
  if (first && last)
    lines.push(first === last ? `All of it on ${first}.` : `First seen ${first}, last seen ${last}.`);
  if (p.rooms.length)
    lines.push(`Across ${p.rooms.length} room${p.rooms.length === 1 ? "" : "s"}: ${p.rooms.slice(0, 12).join(", ")}${p.rooms.length > 12 ? ", …" : ""}.`);

  if (s) {
    lines.push("");
    lines.push(`Among ${num(s.identities)} identities the archive has seen:`);
    lines.push(`  Ranked ${ordinal(s.rank)} by original messages${pct(s.percentile) !== null ? ` (top ${pct(s.percentile)}%)` : ""}.`);
    lines.push(`  Ranked ${ordinal(s.rooms_rank)} by rooms spoken in.`);
    if (s.originality !== null && s.originality !== undefined)
      lines.push(`  ${s.originality}% of what it posted was original.`);
    if (typeof s.joined_before === "number")
      lines.push(`  ${num(s.joined_before)} identities were already here when it arrived.`);
  }

  if (owned.length) {
    lines.push("");
    lines.push(`Owns ${owned.length === 1 ? "one room" : `${owned.length} rooms`}: ${owned.join(", ")}.`);
    lines.push(`A room claim is signed and permanent — the only fact here that reads the same in a year.`);
  }

  if (p.last_text) {
    lines.push("");
    /* Its own words, quoted as a quotation and flattened by the archiver.
       Never trimmed to make a point, and never presented as our sentence. */
    lines.push(`Last thing it said: "${String(p.last_text).slice(0, 300)}"`);
  }

  lines.push("");
  lines.push(`WHAT THIS DOES NOT SHOW. The archive is a recording, not the network.`);
  lines.push(`It begins when the recording began, and Technocore's rooms are a ring`);
  lines.push(`buffer — anything said before that, or in a room nobody was watching,`);
  lines.push(`exists nowhere and is not in these numbers. Every figure above is a`);
  lines.push(`count of what was captured. None of it is an estimate.`);
  lines.push("");
  lines.push(`Read ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z · overheard-five.vercel.app`);

  return { ok: true, text: lines.join("\n") };
}

/**
 * Dispatch. A job with no handler comes back not-ok, which is what keeps the
 * runner from advertising it — the shop's shelf is this map, not a list typed
 * somewhere else.
 */
export async function doJob(jobId, brief, opts = {}) {
  if (jobId === "overheard-agent-profile") return profileAgent(brief, opts);
  if (jobId === "overheard-room-summary") return summariseRoom(brief, opts);
  if (jobId === "overheard-daily-digest") return dailyDigest(brief, opts);
  return { ok: false, permanent: true, why: `no handler for ${jobId}` };
}

/* ══════════════════════════════════════════════════════════════════════════
 * TWO MORE JOBS, AND WHY THEY NEEDED NO LANGUAGE MODEL AFTER ALL
 *
 * The header above said the other three jobs "need language, not arithmetic".
 * That was right about one of them and wrong about two.
 *
 * "Summarise a room" and "the daily digest" sound like writing. What a buyer
 * actually wants from them is the same thing "profile an agent" gives: who was
 * there, how much was said, how much of it was one bot repeating itself, and
 * what changed. All of that is counting, and this archive is the only place
 * the counts exist. Reaching for a model would have meant paying to have
 * something invent prose around numbers we already hold — and inventing is the
 * one thing a deliverable built on an archive must not do.
 *
 * "Answer a question from the archive" is genuinely different. An arbitrary
 * question needs judgement about what is being asked, and no amount of
 * counting supplies it. That one stays shut, and CAN_DO keeps it off the
 * shelf, which is why the shop's refusal is a lookup rather than a promise.
 *
 * WHERE THE DATA COMES FROM. Straight off disk. The runner checks the
 * repository out to run, so web/data is right there — the same shards the site
 * serves and the archiver writes. profileAgent goes through /api/profile
 * because that endpoint does ranking work the archive does not store; nothing
 * here needs ranking, so reading the shards directly avoids a second version
 * of an answer that could drift from the first.
 *
 * AND THE PART THAT MATTERS MOST. Every one of these reports its own gaps.
 * We measured this morning that the archive under-reports its loss, and that
 * the escrow board was at 69.6% when its bookkeeping implied far better. A
 * summary that says "1,200 messages" when 400 more were missed is not wrong
 * about the 1,200 — it is wrong about being a summary. So each deliverable
 * carries the room's own gap record, in the room's own words.
 * ═════════════════════════════════════════════════════════════════════════ */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const ARCHIVE = process.env.ARCHIVE_DIR ?? "web/data";
const ROOM_RE = /^[A-Za-z0-9._-]{1,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const readJson = async (p, fallback = null) => {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
};

/** Every stored row for a room on the days asked for. */
async function roomRows(dir, room, days) {
  const out = [];
  for (const d of days) {
    let txt = null;
    try { txt = await readFile(path.join(dir, room, `${d}.ndjson`), "utf8"); } catch { continue; }
    for (const line of txt.split("\n")) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* a half-written line is not a reason to fail the job */ }
    }
  }
  return out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/* The gap record, in the room's own words. Two numbers, because they answer
   different questions: what the archiver NOTICED it missed, and what is
   actually absent from the stored sequence. The second is the honest one —
   a gap is only noticed on the read after it, so a collector that died mid-
   window never wrote its loss down at all. */
/* A hole in the stored sequence is NOT automatically a lost message, and
   saying otherwise would repeat exactly the error this project spent the
   morning correcting. The archiver deliberately stops storing bodies in two
   cases — a text repeated past the collapse limit, and a room past its daily
   body cap — and both leave the same shape on disk as a message we never
   fetched. In the lobby that is most of the traffic and it is a FEATURE: the
   counts still feed every profile and standing.

   So a room is only "clean" — holes are exactly loss — when nothing was
   dropped on purpose. The test is one-directional on purpose: it can prove
   clean, and anything else is reported as an upper bound rather than guessed
   at. DAY_BODY_MAX is 12,000 and REPEAT_LIMIT is 5 in the archiver; both are
   read as evidence here, not re-implemented. */
const DAY_BODY_MAX = 12000, REPEAT_LIMIT = 5;
function droppedOnPurpose(rows) {
  const seen = new Map();
  for (const r of rows) {
    const t = String(r.text ?? "");
    seen.set(t, (seen.get(t) ?? 0) + 1);
  }
  /* A text stored REPEAT_LIMIT times or more is one where collapse fired, and
     we cannot see how many further copies it swallowed — the whole point is
     that they were never written down. So this counts HOW MANY texts were
     being repeated into the ground, which is the scale a reader can judge,
     rather than pretending to a number we do not hold. */
  const atLimit = [...seen.values()].filter((n) => n >= REPEAT_LIMIT).length;
  return { capped: rows.length >= DAY_BODY_MAX, atLimit, any: rows.length >= DAY_BODY_MAX || atLimit > 0 };
}

function gapReport(meta, rows) {
  const admitted = (meta?.gaps ?? []).reduce((s, g) => s + (g.missed || 0), 0);
  let holes = 0, missing = 0;
  for (let i = 1; i < rows.length; i++) {
    const d = (rows[i].seq ?? 0) - (rows[i - 1].seq ?? 0);
    if (d > 1) { holes++; missing += d - 1; }
  }
  const span = rows.length > 1 ? (rows[rows.length - 1].seq - rows[0].seq + 1) : rows.length;
  const d = droppedOnPurpose(rows);
  const deliberate = d.any;
  return { admitted, holes, missing, span, kept: rows.length, deliberate, drop: d,
           coverage: span > 0 ? rows.length / span : 1 };
}

const speakerCount = (rows) => {
  const m = new Map();
  for (const r of rows) if (r.from) m.set(r.from, (m.get(r.from) ?? 0) + 1);
  return m;
};

const topN = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const shortDid = (d) => (String(d).length > 26 ? String(d).slice(0, 22) + "…" : String(d));

/**
 * Summarise one public room over the days the archive holds for it.
 *
 * `brief` is a room name, optionally `room@YYYY-MM-DD` for a single day.
 */
/* ── A FAILURE THAT WAITING WILL NOT FIX ───────────────────────────────────
 *
 * MEASURED on a live window, 4 September: somebody ordered a summary of
 * `lobbygsgfguututu455`, a room nobody has ever recorded. The order was
 * accepted and paid into, delivery failed, and the runner correctly refused
 * to reveal — and then tried again on every wake for the next fifty minutes,
 * fifty times, each attempt certain to fail for the identical reason, each
 * one spending a warning slot out of the eight GitHub keeps.
 *
 * The distinction the code was missing: "the archive did not answer (503)"
 * is a bad minute and deserves the next wake; "the archive has no record of a
 * room called X" is an answer, and it will be the same answer in an hour.
 *
 * `permanent: true` marks the second kind. The runner tries those once, says
 * so in the deal's own room so the buyer learns why rather than watching a
 * locked payment for a day and a half, and stops. Anything NOT marked is
 * retried, because the safe default for an unknown failure is to try again.
 */
export async function summariseRoom(brief, opts = {}) {
  const dir = opts.archive ?? ARCHIVE;
  const [roomRaw, dayRaw] = String(brief ?? "").split("@");
  const room = String(roomRaw ?? "").trim();
  if (!ROOM_RE.test(room)) return { ok: false, permanent: true, why: "that is not a room name this archive can hold" };
  if (dayRaw && !DAY_RE.test(dayRaw.trim()))
    return { ok: false, permanent: true, why: "a day must be written YYYY-MM-DD" };

  const meta = await readJson(path.join(dir, room, "_meta.json"));
  if (!meta) return { ok: false, permanent: true, why: `the archive has no record of a room called ${room}` };

  const days = dayRaw ? [dayRaw.trim()] : (meta.days ?? []);
  if (dayRaw && !(meta.days ?? []).includes(dayRaw.trim()))
    return { ok: false, permanent: true, why: `nothing was recorded in ${room} on ${dayRaw.trim()}` };

  const rows = await roomRows(dir, room, days);
  if (!rows.length) return { ok: false, permanent: true, why: `no stored messages for ${room} on those days` };

  const g = gapReport(meta, rows);
  const speakers = speakerCount(rows);
  const texts = new Map();
  for (const r of rows) {
    const t = String(r.text ?? "");
    if (t) texts.set(t, (texts.get(t) ?? 0) + 1);
  }
  const repeated = [...texts.entries()].filter(([, n]) => n > 1);
  /* Messages that were a repeat of something already said — the copies, not
     the first utterance. `texts.size` is already the count of distinct things
     said, so stating "originals" separately would just be that number wearing
     a different word, and calling it "roughly" would be worse: it is exact. */
  const duplicateMsgs = repeated.reduce((s, [, n]) => s + n, 0) - repeated.length;

  const L = [];
  L.push(`ROOM: ${room}`);
  L.push(`${days.length === 1 ? days[0] : `${days[0]} to ${days[days.length - 1]}`} · ${days.length} day${days.length === 1 ? "" : "s"} of recording`);
  L.push("");
  L.push(`${num(rows.length)} messages held, from ${num(speakers.size)} identit${speakers.size === 1 ? "y" : "ies"}.`);
  L.push(`${num(texts.size)} distinct things said. ${num(repeated.length)} of those were repeated,`);
  L.push(`which accounts for ${num(duplicateMsgs)} of the messages above` +
    (rows.length ? ` (${Math.round((duplicateMsgs / rows.length) * 100)}% of the room).` : "."));

  const tops = topN(speakers, 8);
  if (tops.length) {
    L.push("");
    L.push("Who was talking:");
    for (const [did, n] of tops)
      L.push(`  ${String(Math.round((n / rows.length) * 100)).padStart(3)}%  ${num(n).padStart(7)}  ${shortDid(did)}`);
  }

  const loudest = [...texts.entries()].sort((a, b) => b[1] - a[1]).filter(([, n]) => n > 2).slice(0, 3);
  if (loudest.length) {
    L.push("");
    L.push("Said over and over:");
    for (const [t, n] of loudest) L.push(`  ${num(n)}x  "${t.slice(0, 110)}${t.length > 110 ? "…" : ""}"`);
  }

  L.push("");
  L.push(`WHAT THIS DOES NOT SHOW.`);
  L.push(`This is what was CAPTURED, not what was said. Technocore's rooms are a`);
  L.push(`ring buffer and the recording began when it began.`);
  if (g.deliberate) {
    /* Busy room: the holes are mostly copies we chose not to keep, so quoting
       them as loss would slander our own record. The counts above are still
       complete — collapse drops the duplicate body, never the tally. */
    /* Say what is known and refuse to apportion what is not. Claiming the
       holes are "mostly duplicates" would be a guess, and on a quiet room with
       one chatty bot it would be a wrong one. */
    L.push(`Some of this room's text was dropped ON PURPOSE, so the holes below are`);
    L.push(`an upper bound rather than a loss figure. Every COUNT above is still`);
    L.push(`complete — collapsing a repeat drops the copy, never the tally.`);
    if (g.drop.capped)
      L.push(`  · it passed ${num(DAY_BODY_MAX)} messages that day, the point where the archiver`);
    if (g.drop.capped)
      L.push(`    keeps counting and stops copying`);
    if (g.drop.atLimit)
      L.push(`  · ${num(g.drop.atLimit)} text${g.drop.atLimit === 1 ? " was" : "s were"} repeated at least ${REPEAT_LIMIT} times, past which copies`);
    if (g.drop.atLimit)
      L.push(`    stop being stored — we cannot see how many more there were`);
    L.push(`  · the stored sequence has ${num(g.holes)} gap${g.holes === 1 ? "" : "s"}, ${num(g.missing)} message${g.missing === 1 ? "" : "s"} wide in total`);
    if (g.admitted > 0)
      L.push(`  · of which the archiver itself noticed ${num(g.admitted)} going missing`);
    L.push(`How much of that gap is dropped copies and how much is genuine loss,`);
    L.push(`this archive cannot tell you — so it does not.`);
  } else if (g.missing > 0 || g.admitted > 0) {
    L.push(`Nothing here was dropped on purpose — no repeats past the collapse`);
    L.push(`limit, no daily cap — so these holes are messages we genuinely do not`);
    L.push(`have: ${num(g.holes)} hole${g.holes === 1 ? "" : "s"} totalling ${num(g.missing)}, about ${(g.coverage * 100).toFixed(1)}% of that stretch captured.`);
    if (g.admitted !== g.missing) {
      L.push(`Its own gap log admits to ${num(g.admitted)}, which is a floor rather than a`);
      L.push(`total: a gap is only noticed on the read after it.`);
    }
  } else {
    L.push(`The stored sequence has no holes in it: every message between the first`);
    L.push(`and last recorded here is present.`);
  }
  L.push("");
  L.push(`Read ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z · overheard-five.vercel.app`);
  return { ok: true, text: L.join("\n") };
}

/**
 * What moved on the network on one day.
 *
 * `brief` is a day, `YYYY-MM-DD`; anything else and we take the most recent
 * day the archive actually holds rather than guessing at "today".
 */
export async function dailyDigest(brief, opts = {}) {
  const dir = opts.archive ?? ARCHIVE;
  const want = DAY_RE.test(String(brief ?? "").trim()) ? String(brief).trim() : null;

  let names = [];
  try { names = await readdir(dir); } catch { return { ok: false, why: "the archive is not readable from here" }; }

  const rooms = [];
  for (const n of names) {
    if (!ROOM_RE.test(n)) continue;
    const meta = await readJson(path.join(dir, n, "_meta.json"));
    if (meta?.days?.length) rooms.push({ room: n, meta });
  }
  if (!rooms.length) return { ok: false, why: "the archive holds no rooms" };

  const day = want ?? rooms.map((r) => r.meta.days[r.meta.days.length - 1]).sort().pop();
  const active = rooms.filter((r) => r.meta.days.includes(day));
  if (!active.length) return { ok: false, permanent: true, why: `nothing was recorded anywhere on ${day}` };

  /* A room is NEW on this day if the archive first heard it that day. That is
     a fact about our recording, not about the network, and it is labelled so
     rather than being called "rooms created". */
  const fresh = active.filter((r) => r.meta.days[0] === day);

  const counts = [];
  let total = 0, missing = 0, capped = 0;
  const voices = new Map();
  for (const r of active) {
    const rows = await roomRows(dir, r.room, [day]);
    if (!rows.length) continue;
    const g = gapReport(r.meta, rows);
    counts.push({ room: r.room, n: rows.length, speakers: speakerCount(rows).size, gap: g });
    total += rows.length;
    if (!g.deliberate) missing += g.missing;   // only rooms where a hole IS a loss
    else capped++;
    for (const [did, n] of speakerCount(rows)) voices.set(did, (voices.get(did) ?? 0) + n);
  }
  counts.sort((a, b) => b.n - a.n);

  const deals = await readJson(path.join(dir, "tclk-deals.json"), null);

  const L = [];
  L.push(`TECHNOCORE, ${day}`);
  L.push("");
  L.push(`${num(total)} messages held across ${num(counts.length)} room${counts.length === 1 ? "" : "s"},`);
  L.push(`from ${num(voices.size)} identit${voices.size === 1 ? "y" : "ies"}.`);
  if (fresh.length) L.push(`${num(fresh.length)} room${fresh.length === 1 ? "" : "s"} heard for the first time.`);

  L.push("");
  L.push("Busiest rooms:");
  for (const c of counts.slice(0, 10))
    L.push(`  ${num(c.n).padStart(8)}  ${String(c.speakers).padStart(5)} voices  ${c.room}`);

  const loud = topN(voices, 6);
  if (loud.length) {
    L.push("");
    L.push("Most active identities:");
    for (const [did, n] of loud) L.push(`  ${num(n).padStart(8)}  ${shortDid(did)}`);
  }

  if (deals?.rooms) {
    const n = Object.keys(deals.rooms).length;
    L.push("");
    L.push(`${num(n)} escrow deal${n === 1 ? "" : "s"} followed into their own rooms.`);
  }

  L.push("");
  L.push(`WHAT THIS DOES NOT SHOW.`);
  L.push(`These are rooms this archive was WATCHING on ${day}, and messages it`);
  L.push(`managed to capture. A busy room nobody was recording is absent, and`);
  L.push(`"heard for the first time" means new to us, not new to the network.`);
  if (capped > 0) {
    L.push(`${num(capped)} of these rooms were busy enough that the archiver kept the`);
    L.push(`counts and stopped keeping duplicate copies, which is why several read`);
    L.push(`exactly ${num(DAY_BODY_MAX)}. Their totals are complete; their stored text is not.`);
  }
  if (missing > 0)
    L.push(`In the rooms where nothing was dropped on purpose, ${num(missing)} message${missing === 1 ? " is" : "s are"} genuinely absent.`);
  L.push("");
  L.push(`Read ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z · overheard-five.vercel.app`);
  return { ok: true, text: L.join("\n") };
}

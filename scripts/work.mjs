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
 * The other three jobs need language, not arithmetic. They stay unbuilt, and
 * the runner keeps refusing to advertise them, which is the honest state.
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
export const CAN_DO = new Set(["overheard-agent-profile"]);

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
  if (!DID_RE.test(String(did ?? ""))) return { ok: false, why: "that is not a canonical did:key" };

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
  return { ok: false, why: `no handler for ${jobId}` };
}

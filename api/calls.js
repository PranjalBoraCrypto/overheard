/**
 * GET /api/calls  —  every call ever made, read out of the archive.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE PAGE CANNOT JUST READ THE ROOM
 *
 * It does read the room, and it has to: the archive is committed on every
 * twelfth collector pass, so the last hour of calls is only on the network.
 * But a Technocore room is a RING BUFFER of two hundred messages. Probed on
 * 4 September: `limit` is capped at 200 however much is asked for, and `since`
 * will not page backwards. There is no way to see the two hundred and first.
 *
 * For a market that is fine on its first day and wrong on the day it becomes
 * interesting. The paper someone took scrolls out of the window before the
 * call they spent it on does, and then the fold sees a call from a key with no
 * paper, refuses it, and quietly deletes somebody's opinion from the total.
 *
 * So the page folds BOTH: everything this endpoint has, plus the live window,
 * merged on the sender's own nonce. The archive is the record and the room is
 * the last hour of it.
 *
 * Filtered here rather than in the browser for the same reason /api/orders is:
 * a day of a busy room is megabytes, and the handful of lines that are ours
 * are a few kilobytes. This one is cheap either way today — the room is new
 * and quiet — and the shape is what stops it becoming expensive later.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const config = { runtime: "edge" };

const OWNER = process.env.ARCHIVE_OWNER ?? process.env.VERCEL_GIT_REPO_OWNER ?? "PranjalBoraCrypto";
const REPO = process.env.ARCHIVE_REPO ?? process.env.VERCEL_GIT_REPO_SLUG ?? "overheard";
const BRANCH = "main";

/* Must match web/call.js. An edge function cannot import a browser module, and
   scripts/test-market.mjs asserts the two spell them the same way. */
const ROOM = "overheard-calls";
const PREFIX = "call1 ";

/* The same spelling as web/session.js, api/keep.js and api/post.js. */
const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;

/* The whole market, not a window: this question runs until 31 March 2027 and
   the answer is the sum of everything ever said. The room is quiet by design —
   one tap and a call or two per person — so the shards are small and the cap
   is on the number of DAYS rather than on the messages inside them. */
const MAX_DAYS = 400;
const MAX_FRAMES = 5000;

/* A day shard is named by its date and nothing else. The name is read out of
   _meta.json — the project's own file, so this is not a live attack surface —
   and interpolated straight into a URL this function then fetches. A `day` of
   "../../../x" or "x?token=" would reshape that request, and the distance
   between "our repository" and "attacker-controlled" is one bad archiver write
   or one bad commit. Cheap to close now, impossible to notice later. */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const json = (body, status = 200, ttl = 30) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": ttl ? `public, s-maxage=${ttl}, stale-while-revalidate=120` : "no-store",
    },
  });

const raw = (p) =>
  `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/web/data/${p}`;

async function grabText(p) {
  try {
    /* A TIMEOUT, LIKE EVERY OTHER UPSTREAM FETCH IN THIS CODEBASE. Without
       one, a raw.githubusercontent that accepts the connection and then
       stops talking holds this function open until the platform kills it,
       and it does that once per shard. Every other fetch here carries one;
       these two were the exceptions. */
    const res = await fetch(raw(p), {
      headers: { "User-Agent": "overheard-calls/1.0" },
      signal: AbortSignal.timeout(6000),
    });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

/** One archived line, including the evidence an independent reader needs.
 *  `signed` is an archive assertion, not a substitute for `sig` and `nonce`.
 *  Sequence and timestamp remain unsigned venue metadata. */
function frameFrom(line) {
  let row;
  try {
    // As in api/room.js, preserve large integer nonces before JSON.parse can
    // round them. Quoted nonce strings are already lossless.
    row = JSON.parse(line.replace(/"(nonce|seq)"\s*:\s*(-?\d{15,})(?=\s*[,}])/g, '"$1":"$2"'));
  } catch { return null; }
  const text = String(row?.text ?? "");
  if (!text.startsWith(PREFIX)) return null;
  /* A KEY, NOT A NICKNAME. Technocore accepts unsigned posts under a
     self-chosen `from`, and this used to take any non-empty string as an
     author — so an unsigned frame archived by /api/keep came back out of here
     looking exactly like a signed one, and the market's fold counted it. */
  if (typeof row.from !== "string" || !DID_RE.test(row.from)) return null;
  return {
    seq: Number(row.seq) || 0,
    ts: typeof row.ts === "string" ? row.ts : null,
    from: row.from,
    /* ── WHETHER A KEY WAS BEHIND IT, FROM WHICHEVER WRITER SAID SO ───────
       Two things write this ledger and they record it differently. /api/keep
       writes an explicit `signed`. The collector (scripts/archive.mjs) writes
       the raw `sig`, which this used to drop on the floor — so a collector
       row arrived at the fold carrying neither, and the fold's "absent means
       nobody looked" rule quite correctly let it through. That would have
       left half the write path exactly as open as before.

       So: an explicit flag wins, and where there is none but a `sig` field is
       present, the presence of a signature IS the flag.

       Only where a row has neither is the answer left absent — those are the
       rows written before anybody recorded this, and calling them unsigned
       now would rewrite the past rather than protect it. */
    ...(typeof row.signed === "boolean" ? { signed: row.signed }
        : "sig" in (row ?? {}) ? { signed: typeof row.sig === "string" && row.sig.length > 0 }
        : {}),
    // Keep the original proof, without labelling its presence as verification.
    // Omit absent fields: inventing sig:null on a legacy row would change the
    // fold's existing acceptance of records whose evidence was never retained.
    ...(typeof row.sig === "string" ? { sig: row.sig } : {}),
    ...(row.nonce != null ? { nonce: String(row.nonce) } : {}),
    text,
  };
}

export default async function handler() {
  /* ── THE LEDGER IS THE FRESHEST SOURCE, NOT THE WHOLE ONE ────────────────
     This used to return the moment `all.ndjson` could be read, on the stated
     grounds that "the collector keeps every call in one small file". It does
     not, and the file itself says so: on 8 September the ledger held 122 rows
     covering seq 236-357 while the day shards held 332 rows from seq 1, and
     _meta.json agreed with the shards — total 332, no gaps. Every call made
     before the room's 200-message ring buffer rolled had left the ledger.

     So the shortcut was quietly serving a market of 53 callers when 140 had
     called. Not an outage, not an error, nothing in a log: just a smaller
     number, on the page whose entire claim is that the record is complete and
     anybody can check it. The people missing from it were the earliest ones.

     THE LEDGER IS STILL READ FIRST, because it is genuinely the freshest —
     /api/keep appends to it the instant somebody calls, and the collector
     commits it on every pass rather than on every twelfth like a shard. It is
     just no longer trusted to be everything. _meta.json publishes the total
     the collector has actually seen; when the ledger falls short of it, the
     shards are read too and the two are merged by the server's own sequence
     number. Same rule the collector itself uses when its two writers meet:
     union by seq, and neither can erase the other. */
  const [ledgerText, metaText] = await Promise.all([
    grabText(`${ROOM}/all.ndjson`),
    grabText(`${ROOM}/_meta.json`),
  ]);

  let meta = null;
  try { meta = metaText ? JSON.parse(metaText) : null; } catch { meta = null; }

  /* Keyed by seq so the two roads to the same record cannot double-count it,
     and so a frame the ledger has but no shard does yet still arrives. */
  const bySeq = new Map();
  const eat = (text) => {
    if (text === null) return 0;
    let n = 0;
    for (const line of text.split("\n")) {
      if (bySeq.size >= MAX_FRAMES) break;
      /* The prefilter: a substring test rules out almost every line before
         JSON.parse is asked to look at it. */
      if (!line || !line.includes(PREFIX)) continue;
      const f = frameFrom(line);
      if (!f) continue;
      n++;
      if (!bySeq.has(f.seq)) bySeq.set(f.seq, f);
    }
    return n;
  };

  const fromLedger = eat(ledgerText);

  /* WHEN THE SHARDS ARE WORTH READING. `total` is every row the collector has
     written for this room, calls and anything else it saw, so it is an upper
     bound rather than a count of frames — which is exactly the right shape for
     this test. Reading them when the ledger is genuinely complete would cost a
     scan per request for nothing; not reading them when it is short is the bug
     above. A ledger that could not be read at all means the shards are the
     only road left, so they are read then too. */
  const total = Number(meta?.total);
  const short = ledgerText === null
    || (Number.isFinite(total) && fromLedger < total);

  let scanned = 0;
  const allDays = (Array.isArray(meta?.days) ? meta.days : [])
    /* Shaped, because every one of these is interpolated into a URL this
       function then fetches. See DAY_RE. */
    .filter((d) => typeof d === "string" && DAY_RE.test(d)).sort();

  if (short && allDays.length) {
    /* Oldest first, and no early stop: this endpoint answers "what is the
       total", which is not a question with an early stop in it. */
    for (const day of allDays.slice(-MAX_DAYS)) {
      if (bySeq.size >= MAX_FRAMES) break;
      const text = await grabText(`${ROOM}/${day}.ndjson`);
      if (text === null) continue;            // a missing shard is not an error
      scanned++;
      eat(text);
    }
  }

  /* NOT AN ERROR, AND THE DIFFERENCE MATTERS. Until the collector has been
     round this room once there is no archive of it, which is exactly the state
     the room is in on its first day — and a page told "unavailable" would say
     the market could not be read when it can, live, perfectly well.
     `archived: false` is the honest word for it. */
  if (ledgerText === null && !allDays.length) {
    return json({ room: ROOM, archived: false, frames: [], days_scanned: 0,
                  note: "the collector has not been round this room yet; the live room is the whole record so far" }, 200, 20);
  }

  const frames = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return json({
    room: ROOM,
    archived: true,
    /* Said out loud, because "where did this number come from" is the first
       question worth asking when two readers disagree. */
    source: scanned ? (ledgerText === null ? "shards" : "ledger+shards") : "ledger",
    frames,
    ledger_frames: fromLedger,
    days_scanned: scanned,
    days_available: allDays.length,
    truncated: frames.length >= MAX_FRAMES,
    checked: new Date().toISOString(),
  });
}

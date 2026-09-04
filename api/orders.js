/**
 * GET /api/orders?did=did:key:z6Mk...
 *
 * Every order one identity has placed with this shop, read out of the archive
 * server-side.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS AN ENDPOINT AND NOT A FETCH FROM THE BROWSER
 *
 * The archive is committed to git and served as static files, so the orders
 * page could in principle read `data/tclk-offers/<day>.ndjson` itself and
 * filter in JavaScript. MEASURED: one day's shard is 2.5 MB and the day
 * before it 0.6 MB. Downloading three megabytes onto a phone to find the four
 * lines that belong to one visitor is not a design, it is a bill sent to the
 * wrong person — and it grows every day the collector runs.
 *
 * The filter belongs where the data already is. This reads the same shards at
 * the edge, keeps the handful of lines whose `from` matches, and answers with
 * a few kilobytes. The response is cacheable per DID, so a visitor refreshing
 * their own page costs nothing after the first read.
 *
 * WHY raw.githubusercontent AND NOT THE DEPLOYED COPY. Same reason
 * /api/profile does it: the deployed files are only as fresh as the last
 * BUILD, and the archiver commits every ~5 minutes while the site rebuilds
 * twice an hour. Reading the repository directly means an order placed ten
 * minutes ago is here, rather than waiting for a deploy that has nothing to
 * do with it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not say whether an order was accepted, delivered or refunded. Those
 * frames live in a per-deal room derived from the contract id, and following
 * them would mean one upstream read per order — the exact cost that once made
 * the deals board render empty, because it had spent the shared allowance on
 * itself. The board already resolves that properly for every deal on the
 * network; this endpoint answers the cheap question ("what did I send, and
 * has it expired?") and leaves the expensive one to the page built for it.
 *
 * Saying "open" here therefore means one thing exactly: this offer's own
 * `expiresMs` has not passed, so it COULD still be accepted. It is not a
 * claim that nobody has accepted it.
 */

export const config = { runtime: "edge" };

const OWNER = "PranjalBoraCrypto";
const REPO = "overheard";
const BRANCH = "main";
const ROOM = "tclk-offers";

/* Bounded on purpose. Every extra day is another multi-megabyte fetch and
   scan at the edge, and an order older than a fortnight has long since
   expired — the window is 24 hours. The response says how many days it
   looked at, so a caller is never guessing whether it saw everything. */
const MAX_DAYS = 14;
/* A single identity with more than this many orders is not a customer, it is
   a load test. The cap keeps one DID from turning a cached response into a
   megabyte. */
const MAX_ORDERS = 500;
/* How many of the newest shards are held in memory for the accept hunt. Two
   covers the 36-hour actionable window in every case except an order placed
   just before midnight, and three is one day of slack for that. */
const ACCEPT_DAYS = 3;
/* And how many orders that hunt runs for. Each is a substring sweep of those
   shards, which is fast but not free, and a visitor with forty live orders is
   not someone whose fortieth needs a button this millisecond. */
const ACCEPT_LOOKUPS = 12;

const json = (body, status = 200, ttl = 45) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": ttl
        ? `public, s-maxage=${ttl}, stale-while-revalidate=300`
        : "no-store",
    },
  });

const raw = (p) =>
  `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/web/data/${p}`;

async function grabText(p) {
  try {
    const res = await fetch(raw(p), { headers: { "User-Agent": "overheard-orders/1.0" } });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

/** One archived line, reduced to the fields an order list actually shows.
 *  Returns null for anything that is not one of this DID's overheard offers,
 *  which is almost every line in the file. */
function orderFrom(line, did) {
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  if (row?.from !== did) return null;
  const text = String(row.text ?? "");
  if (!text.startsWith("tclk1 ")) return null;
  let body;
  try { body = JSON.parse(text.slice(6)); } catch { return null; }
  if (body?.type !== "offer") return null;
  if (body.job?.proto !== "overheard") return null;
  return {
    seq: Number(row.seq) || 0,
    ts: typeof row.ts === "string" ? row.ts : null,
    /* The offer's own declared id. An accept points at it by `ref`, so this
       is the only thing that can pair an order with the shop's answer — and
       without the pairing there is no way to show a buyer a lock button. */
    id: String(body.id ?? ""),
    /* Named as the frame names them. A second vocabulary between the wire and
       the page is how a field ends up meaning two things. */
    job: String(body.job?.id ?? ""),
    brief: String(body.job?.brief ?? ""),
    amount: String(body.amount ?? ""),
    asset: String(body.asset ?? ""),
    rails: Array.isArray(body.rails) ? body.rails : [],
    expiresMs: Number(body.expiresMs) || null,
    claimByMs: Number(body.claimByMs) || null,
    /* The deadline that decides whether an order is still worth acting on.
       Past it, a lock can no longer lead anywhere: reveal is refused at
       `at >= refundAfter` and a refund needs a lock that never came. */
    refundAfterMs: Number(body.refundAfterMs) || null,
    nonce: String(body.nonce ?? ""),
    /* Present only if the sender's signature was recorded, which is a fact
       about the archived row and not about the order. */
    signed: typeof row.sig === "string" && row.sig.length > 0,
  };
}

/** Deal rooms are derived, not announced — the same derivation as
 *  web/tclk.js dealRoom(), which is the file that owns this rule. Repeated
 *  here only because an edge function cannot import a browser module, and
 *  guarded by a test that the two spell it the same way. */
function roomFor(contract) {
  const hex = String(contract || "").replace(/^0x/, "");
  if (!/^[0-9a-f]{16,}$/i.test(hex)) return null;
  return "mb-p-tclk-" + hex.slice(0, 16).toLowerCase();
}

/** An accept answering `id`, or null. Handed one line, already known to
 *  contain the id somewhere — which is not the same as being the accept. */
function acceptFrom(line, id) {
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  const text = String(row?.text ?? "");
  if (!text.startsWith("tclk1 ")) return null;
  let body;
  try { body = JSON.parse(text.slice(6)); } catch { return null; }
  if (body?.type !== "accept") return null;
  /* The id must be in `ref` specifically. It could equally have appeared in
     some unrelated frame that quoted it, and treating that as an answer would
     put a Pay button on a deal nobody agreed to. */
  if (body.ref !== id) return null;
  const room = roomFor(body.contract);
  if (!room) return null;
  return {
    from: String(row.from ?? ""),
    ts: typeof row.ts === "string" ? row.ts : null,
    contract: String(body.contract),
    statement: String(body.statement ?? ""),
    room,
  };
}

export default async function handler(request) {
  const url = new URL(request.url);
  const did = (url.searchParams.get("did") ?? "").trim();

  if (!/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/.test(did)) {
    return json({ error: "not a canonical Ed25519 did:key" }, 400, 0);
  }

  const metaText = await grabText(`${ROOM}/_meta.json`);
  if (!metaText) {
    return json({
      did, source: "unavailable", orders: [], days_scanned: 0, days_available: null,
      note: "could not read the archive index from the repository",
    }, 200, 30);
  }
  let meta;
  try { meta = JSON.parse(metaText); } catch { meta = null; }
  const allDays = Array.isArray(meta?.days) ? [...meta.days].sort() : [];
  /* Newest first: a visitor's most recent orders are the ones they came to
     look at, and stopping early is only safe if the newest were read first. */
  const days = allDays.slice(-MAX_DAYS).reverse();

  const orders = [];
  let scanned = 0;
  /* The newest few days, kept in memory so the accept hunt below needs no
     further upstream reads. Bounded at ACCEPT_DAYS because an order that can
     still be acted on is at most refundAfterMs old — 36 hours as this shop
     writes them — and holding fourteen multi-megabyte shards to search two
     days' worth of them would be paying for the whole archive to answer a
     question about yesterday. */
  const recent = [];
  for (const day of days) {
    if (orders.length >= MAX_ORDERS) break;
    const text = await grabText(`${ROOM}/${day}.ndjson`);
    if (text === null) continue;             // a missing shard is not an error
    scanned++;
    if (recent.length < ACCEPT_DAYS) recent.push(text);
    for (const line of text.split("\n")) {
      if (!line) continue;
      /* THE PREFILTER IS THE WHOLE PERFORMANCE STORY. A day holds thousands
         of frames and JSON.parse on every one of them is most of the cost of
         this request; a substring test rules out ~99.9% of lines first. It
         can only ever produce FALSE POSITIVES — a line mentioning the did
         somewhere else — and those are thrown out by the real check below. */
      if (!line.includes(did)) continue;
      const o = orderFrom(line, did);
      if (o) orders.push(o);
      if (orders.length >= MAX_ORDERS) break;
    }
  }

  /* Newest first, by the server's own sequence number rather than by a
     timestamp any sender could have written. */
  orders.sort((a, b) => b.seq - a.seq);

  /* ── DID THE SHOP ANSWER? ────────────────────────────────────────────────
   * An order the shop has accepted is one the buyer must now FUND, and until
   * this existed the page had no way to tell — the accept is a frame from the
   * shop, so the `line.includes(did)` prefilter above steps straight over it.
   *
   * WHY NOT READ THE LIVE ROOM INSTEAD. Because it does not go back far
   * enough. MEASURED: 4,192 frames in one day of tclk-offers, so the 200-frame
   * live window covers about an hour, and an order stays actionable for 36.
   * A lock button that only worked on orders placed in the last hour would be
   * a lock button that looks broken.
   *
   * WHY THIS COSTS NO EXTRA UPSTREAM READS. It searches shards already
   * fetched and still in hand, and it searches them by SUBSTRING: an offer id
   * is 66 characters of hex, so a line containing one is a line about this
   * order, and only those few lines are ever parsed. */
  const live = orders.filter((o) => o.id && !(o.refundAfterMs && o.refundAfterMs < Date.now()));
  for (const o of live.slice(0, ACCEPT_LOOKUPS)) {
    for (const text of recent) {
      let at = text.indexOf(o.id);
      while (at !== -1) {
        const start = text.lastIndexOf("\n", at) + 1;
        let end = text.indexOf("\n", at);
        if (end === -1) end = text.length;
        const a = acceptFrom(text.slice(start, end), o.id);
        if (a) { o.accept = a; break; }
        at = text.indexOf(o.id, end);
      }
      if (o.accept) break;
    }
  }

  return json({
    did,
    source: "repository",
    orders,
    /* Everything a caller needs to know how much to trust the list, rather
       than a bare array that looks complete whatever happened. */
    days_scanned: scanned,
    days_available: allDays.length,
    window_days: MAX_DAYS,
    truncated: orders.length >= MAX_ORDERS,
    /* The archive trails the network by roughly one collector pass. An order
       placed in the last few minutes is genuinely not here yet, and the page
       merges a live read to cover exactly that gap. */
    archive_lag: "about one collector pass, ~5 minutes",
    checked: new Date().toISOString(),
  });
}

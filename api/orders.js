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
    /* Named as the frame names them. A second vocabulary between the wire and
       the page is how a field ends up meaning two things. */
    job: String(body.job?.id ?? ""),
    brief: String(body.job?.brief ?? ""),
    amount: String(body.amount ?? ""),
    asset: String(body.asset ?? ""),
    rails: Array.isArray(body.rails) ? body.rails : [],
    expiresMs: Number(body.expiresMs) || null,
    claimByMs: Number(body.claimByMs) || null,
    nonce: String(body.nonce ?? ""),
    /* Present only if the sender's signature was recorded, which is a fact
       about the archived row and not about the order. */
    signed: typeof row.sig === "string" && row.sig.length > 0,
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
  for (const day of days) {
    if (orders.length >= MAX_ORDERS) break;
    const text = await grabText(`${ROOM}/${day}.ndjson`);
    if (text === null) continue;             // a missing shard is not an error
    scanned++;
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

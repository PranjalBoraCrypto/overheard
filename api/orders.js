/**
 * GET /api/orders?did=did:key:z6Mk...
 *
 * Every order one identity has placed with this shop, read out of the archive
 * server-side.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS USED TO DO, AND WHY IT STOPPED WORKING
 *
 * It scanned the offers room's day shards at the edge, newest first, keeping
 * the handful of lines whose `from` matched. The argument for doing the
 * filtering here rather than in the browser was that a day's shard was 2.5 MB
 * and nobody should download that onto a phone to find four lines.
 *
 * The argument was right. The number was not, for long. MEASURED on
 * 10 September, the same nine shards this walked:
 *
 *     02 Sep  0.6 MB      06 Sep  91.9 MB
 *     03 Sep  7.4 MB      07 Sep  94.9 MB
 *     04 Sep 18.5 MB      08 Sep  99.4 MB
 *     05 Sep 39.3 MB      09 Sep  99.0 MB
 *                         10 Sep 100.3 MB
 *
 * A hundred megabytes does not arrive inside the six-second fetch timeout
 * below, so `grabText` returned null for every shard — and a null shard is
 * skipped in silence, because a missing shard is not an error. The endpoint
 * then answered `orders: []` with `days_scanned: 0`, and the page, having no
 * orders to show, showed "Nothing ordered yet".
 *
 * IT WAS NOT A GUESS. The buyer who reported it had six offers in the
 * archive, every one signed, every one accepted by this shop, five on
 * 4 September and one on the 6th. They were all still there. Nothing could
 * lift the file they were in.
 *
 * ── WHAT REPLACED IT ──────────────────────────────────────────────────────
 *
 * Of 950,497 lines in that room over nine days, NINETY-NINE are ours: 93
 * offers naming `proto: "overheard"` and 6 accepts posted by this shop. The
 * collector sees every one of those frames as it arrives, so it now writes
 * them down — `tclk-offers/orders.ndjson`, 92 KB, committed on every pass.
 * This reads that one file.
 *
 * No day is fetched any more, so there is no day window, no byte budget and
 * no shard that can be too big: 900 MB of reads to find 92 KB became 92 KB.
 * The response is cacheable per DID, so a visitor refreshing their own page
 * costs nothing after the first read.
 *
 * WHAT THE INDEX CANNOT DO. It starts where the collector's own record does.
 * An order that scrolled out of the 200-message ring before the archiver
 * began following tclk-offers on 2 September is gone from everywhere, and no
 * reader here can invent it.
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

const OWNER = process.env.ARCHIVE_OWNER ?? process.env.VERCEL_GIT_REPO_OWNER ?? "PranjalBoraCrypto";
const REPO = process.env.ARCHIVE_REPO ?? process.env.VERCEL_GIT_REPO_SLUG ?? "overheard";
/* Whose accepts count as an answer. Must match scripts/runner.mjs's US — the
   same environment override exists there for the same reason, so a fork or a
   test can be a different shop without editing code. */
const SHOP = process.env.SHOP_DID ?? "did:key:z6MkiuhfekPgiihLWarPAzhuvoMjg86F8dqmLiCTmtQgMrR3";
const BRANCH = "main";
const ROOM = "tclk-offers";

/* The collector's index of this shop's orders — see the header. It is the
   whole of what this endpoint reads, apart from the tail. */
const ORDERS_FILE = "orders.ndjson";
/* A single identity with more than this many orders is not a customer, it is
   a load test. The cap keeps one DID from turning a cached response into a
   megabyte. */
const MAX_ORDERS = 500;

/* The shop's offer ids, spelled exactly as api/accept.mjs spells them. Kept
   in both files rather than shared because an edge function cannot import
   the runner; scripts/test-api.mjs asserts the two agree. */
const OFFER_ID = /^0x[0-9a-f]{64}$/;

/* ── THE BUDGET THAT IS NO LONGER NEEDED, AND WHY IT IS WORTH SAYING SO ────
   There was a MAX_SCAN_BYTES here, and a MAX_DAYS, and a DAY_RE to keep a
   date out of a URL it was interpolated into. All three existed because this
   function fetched files whose size it did not control, named by strings it
   read out of another file. It fetches two fixed paths now. The amplification
   this guarded against — a stranger minting unlimited DIDs, each a fresh CDN
   cache key costing tens of megabytes of edge egress — is gone with it: the
   worst a made-up DID can now cost is two small reads that the CDN already
   has. Bounding the work was the right fix; not doing the work is better. */
/* How many orders the accept hunt runs for. Each is a substring sweep of the
   two texts in hand, which is fast but not free. */
const ACCEPT_LOOKUPS = 24;

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
    /* A TIMEOUT, LIKE EVERY OTHER UPSTREAM FETCH IN THIS CODEBASE. Without
       one, a raw.githubusercontent that accepts the connection and then
       stops talking holds this function open until the platform kills it,
       and it does that once per shard. Every other fetch here carries one;
       these two were the exceptions. */
    const res = await fetch(raw(p), {
      headers: { "User-Agent": "overheard-orders/1.0" },
      signal: AbortSignal.timeout(6000),
    });
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
       without the pairing there is no way to show a buyer a lock button.

       SHAPED BEFORE IT IS TRUSTED, because it is fed to a scanning loop. This
       is the rule api/accept.mjs states and applies (`OFFER_ID`, with a note
       beside its pass two about what one unshaped value did); this file had
       the loop and not the rule. `id` comes out of a frame written by a
       stranger, and `findAccept` hands it to `text.indexOf` across every line
       of every shard: a one-character id matches most of the archive and
       makes each request slice and JSON.parse thousands of lines, and an
       empty one is worse — `indexOf("", end)` returns `end`, so the loop
       stops advancing. Nothing reaches that today, but only because three
       separate `.filter((o) => o.id)` calls downstream happen to drop it, and
       an invariant propped up by an accident in another function is not one.

       An id of the wrong shape cannot be one the shop ever answered, so an
       order carrying one simply has no accept to find. */
    id: OFFER_ID.test(String(body.id ?? "")) ? String(body.id) : "",
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
  /* ── AND THE ANSWER HAS TO BE OURS ───────────────────────────────────────
     Answering a stranger's offer is a legal move on a public board, so an
     attacker can accept a buyer's offer seconds after it lands. Without this
     line, that accept comes back from this endpoint as "the shop answered
     you", the orders page paints its Pay button, and the buyer signs a lock
     naming the ATTACKER's contract — under which the attacker is the payee,
     reveals, and claims.
     `row.from` is the transport's account of who signed the message, not the
     body's claim about itself, and only the transport's is worth anything
     here. The same hole was closed in api/accept.mjs; this is the other path
     to the same button, and closing one without the other closes neither. */
  if (row.from !== SHOP) return null;
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

  /* ── TWO FILES, FETCHED TOGETHER ─────────────────────────────────────────
     The index is the record: every Overheard order the collector has ever
     seen, and this shop's answers to them. The tail is the newest stretch of
     the same room, rewritten every archiver pass, and it exists because the
     index is only as fresh as the last commit while an order somebody just
     placed is seconds old.
     In parallel, because they are independent and this is an edge function
     where two sequential 6-second timeouts is twelve seconds of nothing. */
  const [indexText, tail] = await Promise.all([
    grabText(`${ROOM}/${ORDERS_FILE}`),
    grabText(`${ROOM}/tail.ndjson`),
  ]);

  /* ── NEITHER SOURCE ANSWERED, WHICH IS NOT THE SAME AS NO ORDERS ─────────
     This is the whole lesson of the bug in the header. A read that failed and
     a history that is empty look identical to a caller unless the answer says
     which one happened, and the page paints "Nothing ordered yet" on the
     second. Said out loud, so it cannot be mistaken for the first. */
  if (indexText === null && tail === null) {
    return json({
      did, source: "unavailable", orders: [], index: false, tail: false,
      note: "could not read the order index or the tail from the repository",
    }, 200, 30);
  }

  const orders = [];
  /* Seen is by NONCE, so the deliberate overlap between the index and the
     tail costs one entry rather than two. */
  const seen = new Set();
  const eat = (text) => {
    if (!text) return 0;
    let n = 0;
    for (const line of text.split("\n")) {
      if (!line) continue;
      n++;
      if (orders.length >= MAX_ORDERS) continue;
      /* THE PREFILTER. The index is small, but the tail is not — a megabyte
         and a half of somebody else's trade — and JSON.parse on every line of
         it is most of the cost of this request. A substring test rules out
         almost all of them, and can only ever produce FALSE positives, which
         the real check below throws out. */
      if (!line.includes(did)) continue;
      const o = orderFrom(line, did);
      if (!o) continue;
      const k = o.nonce || `seq:${o.seq}`;
      if (seen.has(k)) continue;
      seen.add(k);
      orders.push(o);
    }
    return n;
  };

  const indexRows = eat(indexText);
  eat(tail);

  /* ── DID THE SHOP ANSWER? ────────────────────────────────────────────────
   * An order the shop has accepted is one the buyer must now FUND, and after
   * that it is the only evidence this endpoint has that anybody took the
   * order on at all — the accept is a frame from the SHOP, so the
   * `line.includes(did)` prefilter in eat() steps straight over it.
   *
   * WHY THIS COSTS NO EXTRA UPSTREAM READS. It searches the two texts already
   * in hand, and it searches them by SUBSTRING: an offer id is 66 characters
   * of hex, so a line containing one is a line about this order, and only
   * those few lines are ever parsed.
   *
   * ── AND WHY THE OLD VERSION KEPT MISSING THEM ───────────────────────────
   * It searched the shard an order was found in, the shard fetched before it,
   * and the tail — three texts out of a fourteen-day window — because holding
   * more than two hundred-megabyte shards in memory was not possible. So an
   * accept three seconds after its offer was found only if that day happened
   * to still be in hand, and on 6 September five real orders from the 4th
   * were all reported with no accept: the page found no deal, fell back to
   * the offer's own clock, and told the buyer "nobody took it on before the
   * deadline" about work that had been accepted, funded and delivered.
   * The index holds every accept this shop has ever posted, in 92 KB. There
   * is nothing left to page over.
   */
  const findAccept = (o, texts) => {
    for (const text of texts) {
      if (!text) continue;
      let at = text.indexOf(o.id);
      while (at !== -1) {
        const start = text.lastIndexOf("\n", at) + 1;
        let end = text.indexOf("\n", at);
        if (end === -1) end = text.length;
        const a = acceptFrom(text.slice(start, end), o.id);
        if (a) { o.accept = a; return; }
        at = text.indexOf(o.id, end);
      }
    }
  };
  for (const o of orders.filter((o) => o.id).slice(0, ACCEPT_LOOKUPS)) {
    findAccept(o, [indexText, tail]);
  }

  /* Newest first, by the server's own sequence number rather than by a
     timestamp any sender could have written. */
  orders.sort((a, b) => b.seq - a.seq);

  return json({
    did,
    source: "repository",
    orders,
    /* Everything a caller needs to know how much to trust the list, rather
       than a bare array that looks complete whatever happened. Which source
       was there is the fact that decides it — see the empty-list branch. */
    index: indexText !== null,
    index_rows: indexText === null ? 0 : indexRows,
    tail: tail !== null,
    truncated: orders.length >= MAX_ORDERS,
    archive_lag: tail !== null
      ? "the tail is rewritten every archiver pass, about five minutes"
      : "no tail available, so anything placed since the last commit of the index is not here yet",
    /* The floor under the whole record, stated rather than implied. The
       collector began following this room on 2 September; the 200-message
       ring had already dropped everything before that, and it is not
       recoverable from anywhere. */
    since: "2026-09-02",
    checked: new Date().toISOString(),
  });
}

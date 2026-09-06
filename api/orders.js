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

const OWNER = process.env.ARCHIVE_OWNER ?? process.env.VERCEL_GIT_REPO_OWNER ?? "PranjalBoraCrypto";
const REPO = process.env.ARCHIVE_REPO ?? process.env.VERCEL_GIT_REPO_SLUG ?? "overheard";
/* Whose accepts count as an answer. Must match scripts/runner.mjs's US — the
   same environment override exists there for the same reason, so a fork or a
   test can be a different shop without editing code. */
const SHOP = process.env.SHOP_DID ?? "did:key:z6MkiuhfekPgiihLWarPAzhuvoMjg86F8dqmLiCTmtQgMrR3";
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
/* How many orders the accept hunt runs for PER SHARD. Each is a substring
   sweep of the few texts in hand, which is fast but not free. */
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

  /* ── THE TAIL, READ FIRST, BECAUSE THE SHARDS ARE NOT FRESH ──────────────
     This endpoint told visitors the archive "trails the network by about one
     collector pass". That was wrong: the every-five-minutes commits do not
     write day shards — those land on every twelfth pass, and on 4 September
     the day's shard had not been rewritten since 08:46.
     The page merges a live room read to cover the gap, and that read reaches
     back FIVE MINUTES (probed: technocore caps limit at 200 however much you
     ask for, and `since` will not page backwards). So a buyer who ordered
     between five minutes and several hours ago was told "Nothing ordered
     yet" about an order that existed, was accepted, and was paid for.
     tail.ndjson is the archiver's bounded window over the same room, written
     every pass. Reading it first is what makes the three sources meet. */
  const tail = await grabText(`${ROOM}/tail.ndjson`);

  /* ── SCANNED AS EACH ONE ARRIVES, NOT AFTER THEY ALL HAVE ────────────────
     An earlier version collected every text first and scanned afterwards.
     That quietly broke two things at once: `orders.length >= MAX_ORDERS`
     became a test against an empty list, so every shard in the fourteen-day
     window was FETCHED — 2.5 to 7.4 MB each, at the edge, which is precisely
     the cost the header of this file says must never be paid per request —
     and the scan itself then had no budget guard at the outer level.
     Measured with 700 orders across three sources: 301 returned of 700, and
     `truncated: false` asserted over the top of it.
     Seen is by NONCE, so the deliberate overlap between the tail and the
     newest shard costs one entry rather than two — and the budget is spent on
     distinct orders rather than on duplicates. */
  const seen = new Set();
  const eat = (text) => {
    for (const line of text.split("\n")) {
      if (orders.length >= MAX_ORDERS) return;
      if (!line) continue;
      /* THE PREFILTER IS THE WHOLE PERFORMANCE STORY. A day holds thousands
         of frames and JSON.parse on every one of them is most of the cost of
         this request; a substring test rules out ~99.9% of lines first. It
         can only ever produce FALSE POSITIVES — a line mentioning the did
         somewhere else — and those are thrown out by the real check below. */
      if (!line.includes(did)) continue;
      const o = orderFrom(line, did);
      if (!o) continue;
      const k = o.nonce || `seq:${o.seq}`;
      if (seen.has(k)) continue;
      seen.add(k);
      orders.push(o);
    }
  };

  /* ── DID THE SHOP ANSWER? ────────────────────────────────────────────────
   * An order the shop has accepted is one the buyer must now FUND, and after
   * that it is the only evidence this endpoint has that anybody took the
   * order on at all — the accept is a frame from the SHOP, so the
   * `line.includes(did)` prefilter in eat() steps straight over it.
   *
   * WHY NOT READ THE LIVE ROOM INSTEAD. Because it does not go back far
   * enough. MEASURED: 4,192 frames in one day of tclk-offers, so the 200-frame
   * live window covers about an hour, and an order stays actionable for 48.
   *
   * WHY THIS COSTS NO EXTRA UPSTREAM READS. It searches shards already
   * fetched and still in hand, and it searches them by SUBSTRING: an offer id
   * is 66 characters of hex, so a line containing one is a line about this
   * order, and only those few lines are ever parsed.
   *
   * ── AND WHY IT NOW HAPPENS INSIDE THE LOOP ──────────────────────────────
   * It used to run at the end, over a `recent` list of the three newest texts
   * — except the tail was pushed into that list first, so it held the tail
   * and TWO days, not three. An order placed on the 4th was answered three
   * seconds later in the 4th's shard, and by the 6th that shard was the third
   * one back and never searched.
   *
   * MEASURED, 6 September, on this shop's own orders: five real orders placed
   * on the 4th, every one of them accepted by the shop within three seconds,
   * every one of them reported here with no accept — so the orders page found
   * no deal to look up, fell back to the offer's own clock, and told the buyer
   * "nobody took it on before the deadline" about work that had been accepted,
   * funded and delivered. One of them still had three hours left to fund.
   *
   * The rule that replaces the day count is a fact about the protocol rather
   * than a budget: an accept arrives seconds after the offer it answers, so it
   * is in the SAME day shard, or — if the offer landed just before midnight —
   * in the next one. Each order is therefore searched in the shard it was
   * found in, the shard fetched just before it (which is the newer day), and
   * the tail. Three texts, once, per order.
   *
   * That covers the whole fourteen-day window instead of two days, and holds
   * at most two shards in memory instead of three. There is no filter on the
   * order's age any more: what an order's history SAYS is a question about
   * every order ever placed, and refusing to answer it after 48 hours is what
   * turned this page from a record into a page that forgets. */
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

  /* The tail first: it is the only source that is minutes rather than hours
     old, so a budget spent before reaching it would spend it on history.
     Its orders wait for the first shard, because the tail is a window over
     the newest day and the accept for anything in it is in that same day. */
  if (tail !== null) eat(tail);
  let waiting = orders.filter((o) => o.id);
  let newer = null;                 // the shard fetched just before this one
  for (const day of days) {
    if (orders.length >= MAX_ORDERS) break;
    const text = await grabText(`${ROOM}/${day}.ndjson`);
    if (text === null) continue;             // a missing shard is not an error
    scanned++;
    const before = orders.length;
    eat(text);
    const hunt = [...waiting, ...orders.slice(before).filter((o) => o.id)];
    for (const o of hunt.slice(0, ACCEPT_LOOKUPS)) findAccept(o, [text, newer, tail]);
    waiting = [];
    newer = text;
  }
  /* No shards at all — a brand new room, or every fetch failed. The tail is
     still worth searching on its own rather than dropping the question. */
  for (const o of waiting.slice(0, ACCEPT_LOOKUPS)) findAccept(o, [tail]);

  /* Newest first, by the server's own sequence number rather than by a
     timestamp any sender could have written.
     Deduplication happens during the scan rather than after it, so the
     MAX_ORDERS budget is spent on distinct orders — see `eat`. */
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
    /* WHAT WAS ACTUALLY READ, rather than a sentence about what usually is.
       This said "about one collector pass, ~5 minutes" unconditionally, and
       it was wrong twice over: day shards are committed every twelfth pass,
       and on 4 September the offers shard had also hit its body cap and
       stopped growing at 08:46. A caller could not tell any of that from the
       answer. Now the tail's presence is a field, because whether the fresh
       source was there is the single fact that decides how much to trust
       this list. */
    tail: tail !== null,
    archive_lag: tail !== null
      ? "the tail is rewritten every archiver pass, about five minutes"
      : "no tail available; the newest day shard is committed roughly hourly, so this may be hours behind",
    checked: new Date().toISOString(),
  });
}

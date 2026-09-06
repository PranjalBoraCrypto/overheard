/**
 * The Call — a paper market, and the rules that decide what counts.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS
 *
 * One question, answered in paper: will Flop Labs ship mainnet by 31 March
 * 2027? Everyone gets the same handful of paper from a tap, puts some of it on
 * Yes or on No, and the page shows the split. The paper is worth nothing, buys
 * nothing and settles into nothing. What is real is the signature.
 *
 * The date is not ours. Arthur Hayes floated a contract expiring 31 March 2027
 * that settles at zero if mainnet has not shipped, which is the first public
 * date anyone at Flop Labs has attached to it. This is that question with the
 * money taken out.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE FOLD IS THE REFEREE, AND NOT A SERVER
 *
 * Every call is a signed message in a public room. Technocore checks the
 * signature at the door — a message's `from` is the transport's account of who
 * signed it, which is the only claim worth anything — but it checks nothing
 * else. Anybody can post anything into that room: a tap they already took, a
 * call for more paper than they hold, a call after the question closed, a
 * settlement they have no business declaring.
 *
 * There is no server here that could stop them, and building one would put a
 * referee in the middle of a market whose whole point is that it is public and
 * checkable. So the rules live in this file, every reader applies them to the
 * same messages, and every reader gets the same answer. A frame that breaks a
 * rule is not an error — it is simply not counted, and `refused` says why, so
 * a page can show a person exactly what happened to theirs.
 *
 * This is the same argument the paper rail already makes: a record proves
 * nothing on its own; a record that matches a signed frame proves everything.
 * ═══════════════════════════════════════════════════════════════════════════
 */
/* RELATIVE, and every other module here says "/tclk.js". The difference is
   that this file's rules are the referee, so they are unit-tested in node —
   and node cannot resolve an absolute browser path. `./tclk.js` resolves to
   exactly the same file in a browser and to a real one on disk. */
import { canon } from "./tclk.js";

/** The wire prefix. `tclk1 ` is the escrow protocol's; this is not that, and
 *  reusing it would put frames on the deals board that no deal reader can
 *  fold. One prefix, one vocabulary, one fold. */
export const PREFIX = "call1 ";

/** The room every call is posted into. An OPEN room, not a claimed `d-` one:
 *  a claimed room accepts writes only from its owner and an allow-list, which
 *  would make this a market one person is allowed to have an opinion in.
 *  Checked as available on 6 September — Technocore is near its 20,480-room
 *  cap and refuses new names with `400 room limit reached`, so this one is not
 *  replaceable on a whim. The room exists from the first message. */
export const ROOM = "overheard-calls";

/** The market's id. It is in every frame, so one room can hold several
 *  questions without a reader ever having to guess which is which — and, given
 *  how hard a second room is to come by, it will have to. */
export const MARKET = "flop-mainnet-2027";

export const QUESTION = "Will Flop Labs ship mainnet by 31 March 2027?";

/* The end of 31 March 2027, UTC. The page shows it in the reader's own zone,
   because a deadline is a moment in somebody's day, but the rule has to be one
   instant for everybody or two readers fold the same room differently. */
export const CLOSES_MS = Date.UTC(2027, 2, 31, 23, 59, 59, 999);

/** What the tap gives, once, per key. */
export const TAP = 1000;

/** Only this key's settlement counts. Everyone else can post the word
 *  "settled" all day; the fold will not read it. Same rule, and the same
 *  reason, as the shop's accept on the orders page. */
export const SHOP = "did:key:z6MkiuhfekPgiihLWarPAzhuvoMjg86F8dqmLiCTmtQgMrR3";

export const SIDES = ["yes", "no"];

/* ── the three frames ──────────────────────────────────────────────────────
   Canonical JSON, so the same frame always serialises to the same bytes and a
   signature over it can be checked by anybody. `nonce` is the sender's own
   freshness value: two identical calls a second apart must not be one frame. */

export const tapFrame = (from, nonce) =>
  PREFIX + canon({ amount: String(TAP), from, market: MARKET, nonce, type: "tap" });

export const callFrame = (from, side, put, nonce) =>
  PREFIX + canon({ from, market: MARKET, nonce, put: String(put), side, type: "call" });

export const settleFrame = (from, outcome) =>
  PREFIX + canon({ from, market: MARKET, outcome, type: "settle" });

/** One line of the room, as a body — or null for the overwhelming majority of
 *  lines, which are not ours. */
export function readCall(text) {
  const s = String(text ?? "");
  if (!s.startsWith(PREFIX)) return null;
  try {
    const b = JSON.parse(s.slice(PREFIX.length));
    return b && typeof b === "object" ? b : null;
  } catch { return null; }
}

/** Paper is whole numbers. "1e3", "  250", "250.5" and "-250" are all things a
 *  hand-written frame can contain, and every one of them would break a total
 *  quietly rather than loudly. */
function whole(v) {
  /* NOT TRIMMED. A canonical frame never has whitespace inside a value, so a
     value with any is hand-made — and being lenient about the shape of a
     hand-made frame is how a fold starts accepting things its author did not
     think about. */
  const s = String(v ?? "");
  if (!/^[0-9]{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

/**
 * Fold a room into the market.
 *
 * `messages` are as /api/room returns them: `{from, ts, text}`, where `from` is
 * the transport's account of who signed. Order does not matter to the answer —
 * they are sorted by sequence here — but it matters to the rules, because a
 * call is paid for out of paper that must already have been tapped.
 *
 * Returns totals, a row per identity, and every frame that did not count with
 * the reason it did not, so nothing is silently dropped.
 */
export function foldMarket(messages, opts = {}) {
  const market = opts.market ?? MARKET;
  const closes = opts.closesMs ?? CLOSES_MS;
  const shop = opts.shop ?? SHOP;

  const rows = [...(messages ?? [])]
    .map((m) => ({ ...m, seq: Number(m.seq) || 0, at: Date.parse(m.ts ?? "") || 0 }))
    .sort((a, b) => a.seq - b.seq || a.at - b.at);

  const by = new Map();          // did → { did, tapped, yes, no, put, first, last }
  const refused = [];
  let settled = null;
  let calls = 0;

  const seat = (did) => {
    if (!by.has(did)) by.set(did, { did, tapped: 0, yes: 0, no: 0, put: 0, calls: 0, last: 0, mine: [] });
    return by.get(did);
  };
  /* EVERY ACCEPTED CALL, IN THE ORDER IT LANDED. The totals above are what the
     market needs; this is what a person needs — "what did I actually do, and
     when". A running total is not a history, and the two cannot be recovered
     from each other: 750 on Yes is one call or three, and only the fold knows
     which. Refused frames are NOT in here. This list is what counted. */
  const ledger = [];
  const no = (m, why) => refused.push({ from: m.from, ts: m.ts, why });

  for (const m of rows) {
    const b = readCall(m.text);
    if (!b) continue;
    if (b.market !== market) continue;              // another question entirely
    /* THE ONE CHECK EVERYTHING ELSE RESTS ON. `from` inside the body is the
       sender's claim about themselves; `m.from` is who actually signed. They
       are equal in every honest frame, and where they differ the body is
       lying — so the body's is never used for anything. */
    if (typeof m.from !== "string" || !m.from) continue;
    if (b.from !== m.from) { no(m, "the frame names a different author than the key that signed it"); continue; }

    if (b.type === "settle") {
      /* Only the shop settles, and only once. A settlement is the end of the
         market, so a second one — even ours — is not a correction, it is two
         answers to the same question. */
      if (m.from !== shop) { no(m, "only the shop can settle this"); continue; }
      if (settled) { no(m, "this market is already settled"); continue; }
      if (!SIDES.includes(b.outcome)) { no(m, "a settlement has to name yes or no"); continue; }
      settled = { outcome: b.outcome, at: m.at, ts: m.ts };
      continue;
    }

    /* Nothing counts after the question has closed or been answered. The clock
       is the message's own timestamp from the transport, not a field inside
       the frame, which the sender writes and could set to anything. */
    if (settled) { no(m, "the market was already settled"); continue; }
    if (m.at && m.at > closes) { no(m, "the question had closed"); continue; }

    if (b.type === "tap") {
      const who = seat(m.from);
      if (who.tapped) { no(m, "this key has already taken its paper"); continue; }
      who.tapped = TAP;
      who.last = Math.max(who.last, m.at);
      continue;
    }

    if (b.type === "call") {
      if (!SIDES.includes(b.side)) { no(m, "a call has to be on yes or no"); continue; }
      const put = whole(b.put);
      if (put === null) { no(m, "the amount is not a whole number of paper"); continue; }
      const who = seat(m.from);
      if (!who.tapped) { no(m, "this key has no paper — the tap comes first"); continue; }
      const left = who.tapped - who.put;
      /* NOT CLAMPED. A call for more than somebody holds could be trimmed to
         what is left, and that would be a reader deciding what a person meant.
         They asked to put 800 on Yes; putting 300 on Yes for them is a
         different call. It does not count, and the page says so. */
      if (put > left) { no(m, `only ${left} paper left, and this call was for ${put}`); continue; }
      who[b.side] += put;
      who.put += put;
      who.calls++;
      who.last = Math.max(who.last, m.at);
      /* `after` is the purse AFTER this call, not now: a card made from an old
         call has to say what was true when it was made, and re-deriving it
         later from today's total would silently rewrite history. */
      const entry = { did: m.from, side: b.side, put, at: m.at, ts: m.ts,
                      seq: m.seq, nonce: b.nonce ?? null, after: who.tapped - who.put };
      ledger.push(entry);
      who.mine.push(entry);
      calls++;
      continue;
    }
  }

  const people = [...by.values()].filter((r) => r.put > 0);
  const yes = people.reduce((s, r) => s + r.yes, 0);
  const no_ = people.reduce((s, r) => s + r.no, 0);
  const pool = yes + no_;

  /* ── WHAT A CALL IS WORTH IF IT IS RIGHT ────────────────────────────────
   * Parimutuel, which is the only rule that works here: there is no
   * counterparty to take the other side of a price, so the winners divide the
   * whole pool between them in proportion to what they put on it. Somebody
   * who put 600 of the 1,600 on Yes takes 600/1,600 of everything on the
   * board if it ships.
   *
   * It follows that a side everybody agrees with pays almost nothing, and a
   * lonely call against the room pays several times over. That is the entire
   * game, and it is why the page shows the multiple next to the stake rather
   * than the stake alone.
   *
   * Kept as exact numbers, rounded only where they are drawn: rounding here
   * would let the sum of the payouts drift away from the pool, and a table
   * whose column does not add up to the total above it is a table nobody
   * trusts twice.
   */
  for (const r of people) {
    r.ifYes = yes > 0 ? (r.yes / yes) * pool : 0;
    r.ifNo = no_ > 0 ? (r.no / no_) * pool : 0;
    r.both = r.yes > 0 && r.no > 0;
    r.side = r.both ? null : r.yes > 0 ? "yes" : "no";
    /* The multiple on the side they actually took — undefined for somebody
       who took both, because there is no single answer for them. */
    r.multiple = r.side ? (r.side === "yes" ? r.ifYes : r.ifNo) / r.put : null;
    if (settled) {
      r.paid = settled.outcome === "yes" ? r.ifYes : r.ifNo;
      r.pnl = r.paid - r.put;
    }
  }

  return {
    market, settled, refused, calls, ledger,
    yes, no: no_, total: pool,
    /* The same number as `total`, under the name a market page uses for it.
       Two names for one number is usually a smell; here the page says "paper
       on the board" in one place and "volume" in another and both are the
       reader's words rather than ours. */
    volume: pool,
    /* Zero paper on the board is not fifty-fifty, it is nothing — and drawing
       a half-and-half bar for it would be the page inventing an opinion
       nobody has expressed. Null is the honest reading. */
    share: pool > 0 ? yes / pool : null,
    people: people.length,
    tapped: [...by.values()].filter((r) => r.tapped > 0).length,
    /* Biggest first, and the newest of equals above the older, so a fresh call
       moves somebody up rather than burying them among ties.
       ONCE IT IS SETTLED THE ORDER CHANGES, because the question the list
       answers changes with it: before, it is who is most committed; after, it
       is who was right. Sorting a finished market by stake would put the
       biggest loser at the top of the leaderboard. */
    standings: people.sort((a, b) =>
      (settled ? b.pnl - a.pnl : 0) || b.put - a.put || b.last - a.last),
    by,
  };
}

/** What one identity holds and has done, ready for the panel. */
export function seatOf(fold, did) {
  const r = did ? fold.by.get(did) : null;
  if (!r) return { tapped: 0, left: 0, yes: 0, no: 0, put: 0, calls: 0, mine: [] };
  /* Newest first, because a history is read from the top and the thing
     somebody just did is the thing they came back to look at. Copied rather
     than sorted in place: the fold's own list is in the order the room
     accepted them, and something else may be relying on that. */
  return { ...r, left: r.tapped - r.put,
           mine: [...(r.mine ?? [])].sort((a, b) => b.seq - a.seq || b.at - a.at) };
}

/** How long is left, in words a person uses. Deliberately coarse: this is a
 *  deadline months away and a live seconds counter would be a repaint a second
 *  in service of nothing. */
export function leftUntil(ms, now = Date.now()) {
  const d = Math.floor((ms - now) / 86400000);
  if (d > 60) return `${Math.round(d / 30.4)} months left`;
  if (d > 1) return `${d} days left`;
  if (d === 1) return "1 day left";
  if (ms > now) return "hours left";
  return "closed";
}

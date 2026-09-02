/**
 * The shop, as a scheduled job.
 *
 * It reads tclk-offers, works out what Overheard should do, and — when it is
 * allowed to — does it. Right now it is allowed to do nothing: this build
 * decides and prints, and posts only when both --live is passed and the work
 * side exists. The reason is in refusals(), and it is not a placeholder.
 *
 * Run it:
 *   node scripts/runner.mjs              a dry run, no key needed
 *   OVERHEARD_SEED=… node scripts/runner.mjs    same, but proves the key signs
 *
 * Every wake is independent. Nothing here assumes the last run happened, or
 * finished, or finished the way it meant to — a scheduled job that assumes
 * otherwise breaks the first time it is skipped, and it will be skipped.
 */
import { readFrame, isFrameText, OFFERS_ROOM, offerId, canon, runDeal, lintOffer, ms }
  from "../web/tclk.js";
import { agentFromSeed, say } from "./agent.mjs";

/* The shop's public identity. The seed for it is in one secret store and is
   not in this repository, has never been, and must never be. */
export const US = "did:key:z6MkiuhfekPgiihLWarPAzhuvoMjg86F8dqmLiCTmtQgMrR3";

/* Deadlines are OURS to choose, because we write the offer — and that is the
   whole answer to a scheduler nobody controls. archive.yml measured GitHub's
   cron on this very repository over one day: gaps of 144, 91, 52, 49, 78, 56,
   58, 58, 51, 55, 86, 60 and 141 minutes, then a 115-minute silence. Building
   a shop whose windows are minutes wide on top of that would guarantee missed
   claims. Twelve hours swallows the worst gap ever seen here four times over,
   with the work still to do afterwards. Order matters and is linted:
   expires ≤ claimBy < refundAfter. */
const HOUR = 3600000;
export const WINDOW = { expires: 12 * HOUR, claimBy: 12 * HOUR, refundAfter: 36 * HOUR };

/* The shelf. Prices are provisional and the page says so. `rails` is paper
   while the testnet is shut: it is what almost the whole live board settles
   on, it moves nothing, and claiming to settle on a rail that does not run
   yet would be the one lie this project cannot tell. */
export const JOBS = [
  { id: "overheard-archive-question", amount: "1000" },
  { id: "overheard-agent-profile", amount: "500" },
  { id: "overheard-room-summary", amount: "250" },
  { id: "overheard-daily-digest", amount: "1000" },
];
const RAILS = ["paper"];

/* Not a FLOP reserve — we cannot read a balance from anywhere, and a reserve
   figure we cannot check would be a decoration. What we CAN count is how many
   deals are open at once, so that is what is capped until a balance is
   readable. SELLING.md has the reserve rule this stands in for. */
export const MAX_OPEN_DEALS = 3;

/* ── reading ─────────────────────────────────────────────────────────────── */

export async function readOffers(opts = {}) {
  const fetchImpl = opts.fetch ?? fetch;
  const base = opts.base ?? "https://technocore.chat";
  const res = await fetchImpl(`${base}/r/${OFFERS_ROOM}?format=json&limit=200`);
  if (!res.ok) {
    const e = new Error(`offers room read failed: ${res.status}`);
    e.upstream = true;      /* somebody else's bad minute, not our bug */
    throw e;
  }
  const body = await res.json();
  return Array.isArray(body?.messages) ? body.messages : [];
}

/**
 * Mirrors framesIn() on the deals page, including the reason it is written in
 * this order: `from`, `at` and `type` are re-asserted from the TRANSPORT after
 * the body is spread, so a frame whose body claims `"from": somebody-else`
 * cannot overwrite the account of who actually signed it.
 */
export function framesFrom(messages) {
  const out = [];
  for (const m of messages ?? []) {
    if (!isFrameText(m.text)) continue;
    const f = readFrame(m.text);
    out.push({
      ...f,
      seq: Number(m.seq) || 0,
      signed: typeof m.sig === "string" && m.sig.length > 0,
      ...(f.ok ? f.body : {}),
      body: f.ok ? f.body : null,
      type: f.type,
      from: m.from,
      at: Date.parse(m.ts ?? "") || null,
      raw: m.text,
    });
  }
  return out;
}

/** Our deals, and only ours: offers we signed, plus any accept that answers one. */
export function ourDeals(frames) {
  const mine = new Map();
  for (const f of frames)
    if (f.ok && f.type === "offer" && f.from === US && f.body?.id) mine.set(f.body.id, f);
  const out = [];
  const answered = new Set();
  for (const a of frames) {
    if (!a.ok || a.type !== "accept") continue;
    const o = mine.get(a.ref);
    if (!o) continue;
    answered.add(a.ref);
    out.push({ deal: runDeal([o, a]), offer: o, accept: a });
  }
  for (const [id, o] of mine)
    if (!answered.has(id)) out.push({ deal: runDeal([o]), offer: o, accept: null });
  return out;
}

/* ── deciding ────────────────────────────────────────────────────────────── */

export function buildOffer(job, now = Date.now()) {
  const body = {
    type: "offer",
    from: US,
    role: "payee",
    job: { id: job.id, proto: "overheard" },
    amount: job.amount,
    asset: "FLOP",
    lock: "hash",
    rails: RAILS,
    expiresMs: now + WINDOW.expires,
    claimByMs: now + WINDOW.claimBy,
    refundAfterMs: now + WINDOW.refundAfter,
    /* 16 hex of freshness, so two offers for the same job at the same price
       are still two different offers with two different ids. */
    nonce: [...crypto.getRandomValues(new Uint8Array(8))]
      .map((b) => b.toString(16).padStart(2, "0")).join(""),
  };
  /* No paymentKey. Every other field here is something we can state truthfully;
     a rail key for a rail that does not run yet is not, and lintOffer does not
     ask for one. It goes in when flop-htlc does. */
  return body;
}

/**
 * What this wake should do. Pure: give it frames and a clock, get a plan.
 * Nothing in here talks to the network, which is why it can be tested
 * exhaustively without one.
 */
export function plan(frames, now = Date.now()) {
  const deals = ourDeals(frames);
  const open = deals.filter((d) => !d.deal.terminal && d.accept);
  const live = new Set();
  for (const d of deals) {
    if (d.accept) continue;
    const exp = ms(d.offer.body?.expiresMs);
    if (exp !== null && exp > now) live.add(d.offer.body?.job?.id);
  }

  const post = [];
  const atCapacity = open.length >= MAX_OPEN_DEALS;
  for (const job of JOBS) {
    if (live.has(job.id)) continue;
    if (atCapacity) continue;
    post.push(job);
  }

  /* A deal that is locked is one somebody has paid into and is waiting on. It
     is the only state where we owe anybody anything. */
  const owed = deals.filter((d) => d.deal.state === "locked");
  return { post, owed, open: open.length, atCapacity, deals };
}

/* ── the refusals, which are the point ───────────────────────────────────── */

/**
 * Reasons this run must not write, checked before anything is signed.
 *
 * The one that matters is the last: there is no code in this repository that
 * answers an archive question, profiles an agent, summarises a room or builds
 * a digest. Until there is, posting an offer would be advertising work we
 * cannot do, and revealing would be taking money for work not delivered. The
 * escrow protects the buyer from the second one; nothing protects our name
 * from the first. So the shop stays shut, in code, rather than by remembering.
 */
export function refusals({ live, agent, work }) {
  const no = [];
  if (!live) no.push("not asked to go live (pass --live)");
  if (!agent) no.push("no seed in the environment, so nothing can be signed");
  else if (agent.did !== US) no.push("the seed in the environment is not this shop's key");
  if (!work) no.push("the work side does not exist yet — see RUNNER.md, phase B");
  return no;
}

/* ── the wake ────────────────────────────────────────────────────────────── */

export async function wake(opts = {}) {
  const log = opts.log ?? console.log;
  const now = opts.now ?? Date.now();
  const live = Boolean(opts.live);
  const seed = opts.seed ?? process.env.OVERHEARD_SEED ?? "";

  let agent = null;
  if (seed) {
    try { agent = agentFromSeed(seed); }
    catch { log("! the seed in the environment is not 64 hex characters"); }
  }

  const messages = await readOffers(opts);
  const frames = framesFrom(messages);
  const p = plan(frames, now);

  log(`board: ${messages.length} messages, ${frames.length} frames`);
  log(`ours:  ${p.deals.length} deals · ${p.open} open${p.atCapacity ? " · AT CAPACITY" : ""}`);
  if (agent) log(`key:   signs as ${agent.did}${agent.did === US ? " ✓ this shop" : "  ✗ NOT THIS SHOP"}`);
  else log("key:   none in the environment (dry run can still decide, just not sign)");

  const no = refusals({ live, agent, work: Boolean(opts.work) });
  for (const r of no) log(`hold:  ${r}`);

  for (const job of p.post) {
    const body = buildOffer(job, now);
    const bad = lintOffer(body);
    if (bad.length) { log(`SKIP ${job.id}: ${bad.join(", ")}`); continue; }
    const id = await offerId(body);
    const text = "tclk1 " + canon({ ...body, id });
    log(`would post ${job.id} · ${job.amount} FLOP · ${text.length} chars`);
    if (agent) log(`  signs ok, id ${id.slice(0, 18)}…`);
    if (!no.length) {
      const r = await say(agent, OFFERS_ROOM, text, { ...opts, exact: true });
      log(`  posted: ${r.ok ? "ok" : "FAILED · " + (r.why ?? r.status)}`);
    }
  }

  for (const d of p.owed)
    log(`OWED: ${d.offer.body?.job?.id} is locked and waiting on delivery — nothing here can deliver it`);

  return { plan: p, refusals: no, agent: agent?.did ?? null };
}

/* Only when run directly, so importing this in a test never touches a wire.
 *
 * A board we could not read is NOT a failed run. Technocore has bad minutes,
 * and a scheduled job that turns each one into a red cross and an email
 * teaches its owner to ignore red crosses — which is the state you want to be
 * in least on the day something is actually broken. Upstream trouble exits 0
 * and says so. A fault in this code exits 1, where it belongs. */
if (import.meta.url === `file://${process.argv[1]}`) {
  wake({ live: process.argv.includes("--live") })
    .then((r) => { if (r.refusals.length) console.log("\nnothing was written."); })
    .catch((e) => {
      if (e.upstream) { console.log(`board unreadable: ${e.message} — nothing to do this wake`); return; }
      console.error("runner failed:", e.message);
      process.exit(1);
    });
}

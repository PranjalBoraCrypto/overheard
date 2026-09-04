/**
 * Section S of the runner suite, run as its own process.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SAYING NO OUT LOUD
 *
 * When the shop is full, `plan()` files the offer under `passed` with the
 * reason "able and willing, but full" — and that is the end of it. Nothing
 * reaches the board.
 *
 * A buyer who came through /hire at least sees something: the checkout
 * endpoint answers `full: true` and the page says so. But this shop supports
 * the OTHER route on purpose — an agent composing its own offer and posting
 * it straight to tclk-offers, which is the route that makes this agentic
 * commerce rather than a web form with extra steps. That buyer gets nothing
 * at all: no accept, no refusal, no signal of any kind. They wait out a
 * twelve-hour expiry for a reply that was never coming.
 *
 * The same fault as everything else fixed this week — a decision taken
 * correctly and reported nowhere.
 *
 * WHY SEPARATE. `US` is read at import time, and this path only exists where
 * the runner is willing to write, which needs a key whose DID is the shop's.
 * The real seed is a repository secret and is deliberately not in this tree,
 * so this process sets SHOP_DID to a test key's DID before importing. That
 * grants nothing: refusals() still demands a seed that matches.
 *
 * Output is one RESULT line per assertion, read back by the parent.
 */
import { agentFromSeed } from "./agent.mjs";

const SEED = process.env.TEST_SEED ?? "a".repeat(64);
const me = agentFromSeed(SEED);
process.env.SHOP_DID = me.did;                 // before the runner is imported

const { US, JOBS, MAX_OPEN_DEALS: CAP, wake } = await import("./runner.mjs");
const { canon, offerId, OFFERS_ROOM } = await import("../web/tclk.js");

const say = (name, pass, note = "") =>
  console.log("RESULT " + JSON.stringify({ name, pass: Boolean(pass), note: String(note) }));

const OTHER = agentFromSeed("b".repeat(64)).did;
const NOW = Date.now(), H = 3600000;
const BUILT = JOBS.find((j) => j.id === "overheard-agent-profile");

const msg = (seq, from, text) =>
  ({ seq: String(seq), ts: new Date(NOW - 1000).toISOString(), from, text, sig: "s" });

const theirOffer = (over = {}) => ({
  type: "offer", from: OTHER, role: "payer",
  job: { id: BUILT.id, proto: "overheard", brief: OTHER },
  amount: BUILT.amount, asset: "FLOP", lock: "hash", rails: ["paper"],
  expiresMs: NOW + 6 * H, claimByMs: NOW + 12 * H, refundAfterMs: NOW + 36 * H,
  nonce: "0000000000000001",
  ...over,
});

/* A full book: CAP offers, each answered by us, none funded, none past its
   refund deadline — so they are open rather than reapable. */
let seq = 1;
const board = [];
for (let i = 0; i < CAP; i++) {
  const o = theirOffer({ nonce: "full" + String(i).padStart(12, "0") });
  const id = await offerId(o);
  board.push(msg(seq++, OTHER, "tclk1 " + canon({ ...o, id })));
  board.push(msg(seq++, US, "tclk1 " + canon({
    type: "accept", from: US, ref: id, statement: "0x" + "7c".repeat(32),
    nonce: "acf" + String(i).padStart(13, "0"),
    contract: "0x" + String(i).padStart(4, "0") + "d".repeat(60),
  })));
}
/* And one more buyer, who did everything right and arrived a moment late. */
const late = theirOffer({ nonce: "0000000000009999" });
const lateId = await offerId(late);
board.push(msg(seq++, OTHER, "tclk1 " + canon({ ...late, id: lateId })));

/** One wake against a venue that records what reaches the wire. */
async function run(mod, { extra = [], live = true, seen = [] } = {}) {
  const posted = [];
  const stub = async (url) => {
    const u = String(url);
    if (u.includes("say-signed")) {
      const m = u.match(/\/r\/([^/]+)\/say-signed\/([^/]+)\/([^/]+)\/([^/]+)\/([^?]+)/);
      posted.push({ room: m?.[1], text: decodeURIComponent(m?.[5] ?? "") });
      return { ok: true, status: 200, text: async () => "{}" };
    }
    /* ── ONLY tclk-offers CARRIES THE BOARD ────────────────────────────────
       The first version of this stub answered EVERY room with the whole
       board, including the fifty deal rooms a full book makes the wake read.
       Each read then folded another copy of every frame in, so `plan()` ran
       on ~5,000 frames, `open` came back 2,550 for a 50-deal book, and three
       buyers were told the shop was full instead of one. Nothing was wrong
       with the shop; the fixture was lying to it. A deal room in this fixture
       holds no lock, which is exactly what a full book of unfunded deals
       looks like. */
    if (!u.includes(`/r/${OFFERS_ROOM}?`)) {
      return { ok: true, status: 200, json: async () => ({ messages: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({ messages: [...board, ...seen, ...extra] }) };
  };
  const r = await mod.wake({ fetch: stub, base: "http://stub", log: () => {},
                             now: NOW, seed: SEED, live, archive: "does-not-exist" });
  return { posted, r, notes: posted.filter((p) => p.text.startsWith("Overheard is at capacity")) };
}

const first = await run({ wake });
say("the shop really is full in this fixture", first.r.plan.atCapacity,
  `${first.r.plan.open} of ${CAP} open`);
say("and it counts the book correctly, not some multiple of it",
  first.r.plan.open === CAP, `${first.r.plan.open} open of a ${CAP} book`);
say("the late buyer is passed over for capacity and nothing else",
  first.r.plan.passed.some((x) => x.id === lateId && x.why.includes("able and willing, but full")),
  first.r.plan.passed.find((x) => x.id === lateId)?.why.join("; ") ?? "not in passed at all");

say("it tells them, on the board, where an agent is actually looking",
  first.notes.length === 1 && first.notes[0].room === "tclk-offers",
  `${first.notes.length} note(s) to ${first.notes[0]?.room ?? "nowhere"}`);
say("naming the offer, so the sender can match it to what they posted",
  Boolean(first.notes[0]?.text.includes(lateId)), first.notes[0]?.text.slice(0, 130) ?? "");
say("and saying the offer still stands, because it does",
  /stands/.test(first.notes[0]?.text ?? "") && /takes it/.test(first.notes[0]?.text ?? ""),
  first.notes[0]?.text.slice(0, 220) ?? "");
say("and that nothing was charged", /nothing was charged/i.test(first.notes[0]?.text ?? ""));
say("with the numbers, so it is a queue position and not a shrug",
  new RegExp(`${CAP} at once`).test(first.notes[0]?.text ?? ""), first.notes[0]?.text.slice(0, 90) ?? "");

/* ── NOT A FRAME, AND THAT IS THE WHOLE POINT ──────────────────────────────
   The offer is still live and still takeable. A frame here would be a
   protocol move, and anything folding this deal would read it as one. */
say("it is not a tclk frame", !first.notes[0]?.text.startsWith("tclk1 "),
  first.notes[0]?.text.slice(0, 24) ?? "");
say("no accept was signed while full",
  !first.posted.some((p) => p.text.startsWith("tclk1 ") && /"type":"accept"/.test(p.text)),
  "a note is not permission to overcommit");
say("the note is counted as a write, like everything else that reaches the wire",
  first.r.wrote.some((w) => w.startsWith("full-note:")), first.r.wrote.join(" · ") || "nothing counted");

/* ── ONCE PER OFFER, EVER ──────────────────────────────────────────────────
   Repeating it every minute, for every full offer, is how a shop becomes the
   thing ruining the room it archives. Two defences, covering different holes:
   what is already on the board, and what THIS process has said since the
   checkout's copy of the archive went stale under it. */
const second = await run({ wake });
say("the same buyer is not told twice by the same process",
  second.notes.length === 0,
  "the in-process memo covers the window a fixed checkout cannot see");

const fresh = await import("./runner.mjs?told=" + Math.random());
const third = await run(fresh, { seen: [msg(seq++, US, first.notes[0]?.text ?? "no note")] });
say("nor by a new process that can see the old note on the board",
  third.notes.length === 0, "a restart must not start the whole conversation again");

/* ── AND ONLY FOR CAPACITY ─────────────────────────────────────────────────
   Every other reason to pass is either the offer being malformed — their own
   client will have said so — or somebody else having answered first, which is
   not our news to give. */
const junk = theirOffer({ nonce: "0000000000008888", amount: "1" });   // underpriced
const junkId = await offerId(junk);
const fourth = await import("./runner.mjs?junk=" + Math.random());
const withJunk = await run(fourth, {
  extra: [msg(9000, OTHER, "tclk1 " + canon({ ...junk, id: junkId }))],
});
say("an offer refused on its own terms gets no note",
  !withJunk.posted.some((p) => p.text.includes(junkId)),
  "that is their client's error to report, not a queue position");
say("but the one refused only for capacity still does",
  withJunk.notes.some((n) => n.text.includes(lateId)),
  "a fresh process, so the memo is empty and this is the board's own answer");

/* ── AND NEVER FROM A DRY RUN ──────────────────────────────────────────────
   A dry run writes nothing, and this writes to a room other people use. */
const fifth = await import("./runner.mjs?dry=" + Math.random());
const dry = await run(fifth, { live: false });
say("a dry run posts no note at all", dry.posted.length === 0,
  `${dry.posted.length} writes from a dry run`);

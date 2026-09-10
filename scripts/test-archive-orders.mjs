/**
 * The two files that are somebody's money, and the two ways they were lost.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE. THE ORDERS PAGE WENT BLANK, AND THE ORDERS WERE ALL STILL THERE
 *
 * A buyer with six signed offers in the archive was shown "Nothing ordered
 * yet". Every one of them was found afterwards, by hand, in the day shards:
 * five on 4 September and one on the 6th, each accepted by this shop.
 *
 * /api/orders read those shards at the edge. When it was written a day of
 * tclk-offers was 2.5 MB. MEASURED on 10 September:
 *
 *     02 Sep  0.6 MB    05 Sep 39.3 MB    08 Sep  99.4 MB
 *     03 Sep  7.4 MB    06 Sep 91.9 MB    09 Sep  99.0 MB
 *     04 Sep 18.5 MB    07 Sep 94.9 MB    10 Sep 100.3 MB
 *
 * A hundred megabytes does not arrive inside a six-second fetch, and a shard
 * that fails to arrive is skipped in silence, because a missing shard is not
 * an error. So the endpoint answered `orders: []` and the page believed it.
 *
 * The fix is upstream of the reader: 99 of the 950,497 lines in that room are
 * ours, and the collector already sees every one of them as it arrives. It
 * writes them down. This file is about the writer.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO. THE CALL LEDGER HAD FIVE ROWS IN IT AND THE MARKET HAD 539
 *
 * Found while reading the file above. `loadCalls` and `writeCalls` both said
 * `fs.readFile`, and nothing in archive.mjs is called `fs` — the promises API
 * is imported by name. Every run threw ReferenceError into a catch whose
 * comment says "no ledger yet", so:
 *
 *   - the ledger never seeded from disk, and
 *   - the flush never merged with disk, it OVERWROTE.
 *
 * MEASURED on the live repository: overheard-calls/all.ndjson held rows
 * 535–539 while that room's own _meta.json said total 539. The file this
 * project's own comments call "appended and never trimmed" had been reduced
 * to whatever one run happened to see, again and again, for the life of the
 * market — taking every call /api/keep wrote straight to GitHub with it.
 *
 * Nobody's position was actually lost, and that is luck: /api/calls merges the
 * ledger with the day shards precisely because a short ledger is not a short
 * market. This is the failure that guard was written for, firing every hour,
 * seen by nothing.
 *
 * WHY BOTH ARE IN ONE FILE. They are the same mistake in two places — a
 * durable record that silently became a window — and the same shape of test
 * catches both: write, restart, write again, and check that the first write
 * is still there.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/* OUT is resolved when archive.mjs is first evaluated, so the fixture root
   has to exist and be named before the import. */
const ROOT = await mkdtemp(path.join(tmpdir(), "oh-orders-"));
process.env.OUT_DIR = ROOT;
process.env.SHOP_DID = "did:key:z6MkiuhfekPgiihLWarPAzhuvoMjg86F8dqmLiCTmtQgMrR3";
const A = await import("./archive.mjs");

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

const SHOP = process.env.SHOP_DID;
const BUYER = "did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz";
const OTHER = "did:key:z6Mkf4hsuVz6R8R2yrRqgTWbFjEDDyRG8cPFfeaDSHxquhHy";

let seq = 1000;
const frame = (from, body, sig = "s") => ({
  seq: seq++, ts: "2026-09-04T19:24:40.083946Z", from, sig,
  text: "tclk1 " + JSON.stringify(body),
});
const ourOffer = (from, id) => frame(from, {
  type: "offer", from, role: "payer", amount: "250", asset: "FLOP",
  job: { id: "overheard-room-summary", proto: "overheard", brief: "technocore" },
  lock: "hash", rails: ["paper"], nonce: "n" + id, id: "0x" + String(id).padStart(64, "0"),
});
/* The overwhelming majority of that room. A real one, copied in shape from
   the 8 September shard: a stranger's a2a task whose BRIEF happens to quote
   our buyer's did:key, because somebody was paying to have his frames
   counted. It is the reason the index cannot be built by grepping for a DID. */
const theirOffer = (from) => frame(from, {
  type: "offer", from, role: "payer", amount: "200", asset: "FLOP",
  job: { id: "task-a6ef9d43", proto: "a2a",
         context: `how many rows are lock frames posted by ${BUYER}?` },
  lock: "hash", rails: ["paper"], nonce: "z", id: "0x" + "ab".repeat(32),
});
const accept = (from, ref) => frame(from, {
  type: "accept", from, ref, contract: "0x" + "5a".repeat(32),
  statement: "0x" + "d9".repeat(32),
});

const fresh = () => ({ orders: { rows: [], seqs: new Set() } });
const bodies = (st) => st.orders.rows.map((l) => JSON.parse(JSON.parse(l).text.slice(6)));

console.log("=== A. what the index keeps, and what it refuses");
{
  const st = fresh();
  ok("an Overheard order is kept", A.pushOrder(st, ourOffer(BUYER, 1)) === true);
  ok("including one this shop placed itself", A.pushOrder(st, ourOffer(SHOP, 2)) === true,
    "the shop buys as well as sells, and those are orders too");
  /* THE WHOLE REASON THIS IS A FILE AND NOT A GREP. 950,497 lines in that
     room; 93 offers are ours. A stranger's trade is not an order here even
     when it quotes one of our customers by key. */
  ok("a stranger's trade is not, even when it names our buyer",
    A.pushOrder(st, theirOffer(OTHER)) === false,
    "proto is the rule; a did:key appearing in somebody's brief is not");
  ok("this shop's accept is kept", A.pushOrder(st, accept(SHOP, "0x" + "1".repeat(64))) === true);
  /* ── AND THE ONE THAT PAINTS A PAY BUTTON ────────────────────────────────
     Answering a stranger's offer is a legal move on a public board. If an
     accept from anybody counted, an attacker could answer a buyer's offer and
     the orders page would show it as ours — and the buyer would lock a
     payment against the ATTACKER's contract, under which the attacker is the
     payee, reveals, and claims. Checked on the transport's `from`, which is
     who actually signed, not on the body's claim about itself. */
  ok("a stranger's accept is not", A.pushOrder(st, accept(OTHER, "0x" + "1".repeat(64))) === false,
    "otherwise the page paints a Pay button on somebody else's contract");
  const forged = accept(OTHER, "0x" + "1".repeat(64));
  forged.text = forged.text.replace(`"from":"${OTHER}"`, `"from":"${SHOP}"`);
  ok("nor is one that merely says it came from the shop",
    A.pushOrder(st, forged) === false,
    "the body is a claim; the transport is the signature");
  ok("plain chatter is not a frame at all",
    A.pushOrder(st, { seq: 9, from: BUYER, text: "hello" }) === false);
  ok("and neither is a tclk frame with a broken body",
    A.pushOrder(st, { seq: 10, from: BUYER, text: "tclk1 {not json" }) === false);
  ok("the same frame twice is one row", A.pushOrder(st, st.orders.rows.length
    ? JSON.parse(st.orders.rows[0]) : {}) === false, "deduplicated on the server's seq");
  ok("so the index holds only what it should", st.orders.rows.length === 3,
    `${st.orders.rows.length} rows: ${bodies(st).map((b) => b.type).join(", ")}`);
}

console.log("\n=== B. the backfill, because an index that starts empty is the same bug");
{
  /* An index that only knows what arrived after it was invented would tell
     every existing customer they have never ordered — which is the exact
     failure it exists to fix, moved from the reader to the writer. */
  const dir = path.join(ROOT, "tclk-offers");
  await mkdir(dir, { recursive: true });
  const noise = Array.from({ length: 400 }, () => JSON.stringify(theirOffer(OTHER))).join("\n");
  await writeFile(path.join(dir, "2026-09-04.ndjson"),
    noise + "\n" + JSON.stringify(ourOffer(BUYER, 11)) + "\n"
    + JSON.stringify(accept(SHOP, "0x" + String(11).padStart(64, "0"))) + "\n" + noise + "\n");
  await writeFile(path.join(dir, "2026-09-06.ndjson"),
    noise + "\n" + JSON.stringify(ourOffer(BUYER, 12)) + "\n");
  /* Not a day shard. The tail and the index live in the same directory and
     both end in .ndjson; a backfill that ate them would double-count. */
  await writeFile(path.join(dir, "tail.ndjson"), JSON.stringify(ourOffer(BUYER, 13)) + "\n");

  const st = fresh();
  const n = await A.backfillOrders(st);
  ok("it finds the orders buried in the shards", n === 3, `${n} kept`);
  ok("out of eight hundred lines of somebody else's board",
    st.orders.rows.length === 3, `${st.orders.rows.length} rows`);
  ok("it reads day shards and nothing else in the folder",
    !bodies(st).some((b) => b.nonce === "n13"),
    "tail.ndjson is a window over the same room; counting it twice is not a backfill");
  ok("and it keeps the accept with the offer it answers",
    bodies(st).filter((b) => b.type === "accept").length === 1);

  /* ── AND IT HAPPENS ONCE ────────────────────────────────────────────────
     The shards are 550 MB and growing by a hundred a day. A backfill that ran
     on every restart would spend a minute of every collection window re-
     reading files it has already read. */
  const loaded = await A.loadOrders();
  ok("with no file on disk, loading backfills", loaded.rows.length === 3,
    `${loaded.rows.length} rows`);
  await A.writeOrders({ orders: loaded });
  const onDisk = await readFile(path.join(dir, "orders.ndjson"), "utf8");
  ok("and the index is written where the endpoint looks for it",
    onDisk.trim().split("\n").length === 3);

  /* Proof the second load did NOT walk the shards: a fourth order is added to
     a shard, and a load that backfilled again would pick it up. */
  await writeFile(path.join(dir, "2026-09-07.ndjson"), JSON.stringify(ourOffer(BUYER, 14)) + "\n");
  const again = await A.loadOrders();
  ok("once the file exists the shards are never walked again",
    again.rows.length === 3, `${again.rows.length} rows — 4 would mean it re-scanned`);
}

console.log("\n=== C. a restart does not erase the record");
{
  /* The shape both bugs share. Write, throw the process away, write again,
     and check the first write survived — which is the one thing a file
     described as "appended and never trimmed" has to do. */
  const dir = path.join(ROOT, "tclk-offers");
  const before = (await readFile(path.join(dir, "orders.ndjson"), "utf8")).trim().split("\n").length;

  const restarted = await A.loadOrders();          // a fresh run, seeded from disk
  A.pushOrder(restarted && { orders: restarted }, ourOffer(BUYER, 21));
  await A.writeOrders({ orders: restarted });
  const after = (await readFile(path.join(dir, "orders.ndjson"), "utf8")).trim().split("\n").length;
  ok("a new run adds to the index rather than replacing it", after === before + 1,
    `${before} → ${after}`);

  /* THE OTHER WRITER. /api/keep-style edits land straight in the file while
     this process is running; a flush that wrote its own copy over the top
     would delete them. Simulated by editing the file behind the collector's
     back, exactly as another writer would. */
  const text = await readFile(path.join(dir, "orders.ndjson"), "utf8");
  await writeFile(path.join(dir, "orders.ndjson"),
    text + JSON.stringify(ourOffer(BUYER, 22)) + "\n");
  await A.writeOrders({ orders: restarted });
  const merged = (await readFile(path.join(dir, "orders.ndjson"), "utf8")).trim().split("\n");
  ok("and a flush merges with what somebody else wrote meanwhile",
    merged.length === after + 1,
    `${merged.length} rows — a plain overwrite would give ${after}`);
  ok("in the server's own sequence order, not in arrival order",
    merged.map((l) => Number(JSON.parse(l).seq))
      .every((v, i, a) => i === 0 || a[i - 1] < v),
    merged.map((l) => JSON.parse(l).seq).join(" "));
}

console.log("\n=== D. the call ledger, which had been doing the opposite for a week");
{
  /* `fs.readFile` where nothing is called `fs`. The ReferenceError went into
     a catch labelled "no ledger yet", so the ledger never seeded and every
     flush overwrote. On the live repository: 5 rows in the file, 539 in the
     room. This is that, reproduced in a fixture. */
  const dir = path.join(ROOT, "overheard-calls");
  await mkdir(dir, { recursive: true });
  const call = (n) => JSON.stringify({
    seq: n, ts: "2026-09-09T00:00:00Z", from: BUYER, sig: "s",
    text: `call1 {"from":"${BUYER}","market":"flop-mainnet-2027","nonce":"${n}","put":"100","side":"yes","type":"call"}`,
  });
  const history = [1, 2, 3, 4, 5].map(call).join("\n") + "\n";
  await writeFile(path.join(dir, "all.ndjson"), history);

  /* HALF ONE: the seed. A fresh run must start with the market it inherited,
     not with nothing. This returned an empty ledger on every run. */
  const led = await A.loadCalls();
  ok("a fresh run seeds its ledger from the file on disk", led.rows.length === 5,
    `${led.rows.length} rows — 0 is the bug`);

  /* HALF TWO: the flush, given a run that saw ONE new call. Before the fix
     this wrote a file containing that one call and nothing else. */
  const state = { ledger: { rows: [call(6)], seqs: new Set(["6"]) } };
  await A.writeCalls(state);
  const out = (await readFile(path.join(dir, "all.ndjson"), "utf8")).trim().split("\n");
  ok("a flush does not overwrite the calls made before this run",
    out.length === 6, `${out.length} rows — 1 is the bug, and 5 were on the live repository`);
  ok("and the new call is in there with them",
    out.some((l) => JSON.parse(l).seq === 6));
  ok("in sequence order", out.map((l) => Number(JSON.parse(l).seq))
    .every((v, i, a) => i === 0 || a[i - 1] < v), out.map((l) => JSON.parse(l).seq).join(" "));
}

console.log("\n=== E. and nothing reads a hundred megabytes to answer a question");
{
  /* The rule the whole change exists to establish, asserted where it can be
     asserted cheaply: the endpoint's reads are two fixed paths, and the
     collector's index is the file behind one of them. */
  const api = await readFile(new URL("../api/orders.js", import.meta.url), "utf8");
  const code = api.replace(/\/\*[\s\S]*?\*\//g, "");
  ok("the endpoint asks for the index by name", /orders\.ndjson|ORDERS_FILE/.test(code));
  ok("and has no day loop left in it", !/allDays|MAX_DAYS|MAX_SCAN_BYTES/.test(code),
    "a shard fetched from the edge is the bug coming back");
  const yml = await readFile(new URL("../.github/workflows/archive.yml", import.meta.url), "utf8");
  ok("and the workflow commits the index on every pass, not every twelfth",
    /SMALL=.*tclk-offers\/orders\.ndjson/.test(yml),
    "it is now the only source that page has");
}

await rm(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

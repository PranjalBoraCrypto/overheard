/**
 * The security suite: one test per finding from the September audit.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THESE ARE BEHAVIOURAL AND NOT GREPS
 *
 * Every one of these bugs was invisible in the source. Not obscure — invisible.
 * `have = j.content ? dec(j.content) : ""` is a correct-looking line that
 * destroys the ledger. `if (typeof row.from !== "string" || !row.from)` is a
 * validation that validates nothing. A test that greps for the fixed spelling
 * passes the moment somebody writes the fixed spelling, which is not the same
 * as the bug being gone.
 *
 * So these drive the real handlers with a stubbed `fetch` and assert on what
 * the code DOES: which upstream requests it makes, what it puts in them, and
 * what it refuses. Each one fails on the original code and passes on the fix —
 * which is the only property that makes a regression test worth having.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import { foldMarket, tapFrame, callFrame, MARKET, PREFIX } from "../web/call.js";

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

const DID_A = "did:key:z6Mk" + "a".repeat(44);
const DID_B = "did:key:z6Mk" + "b".repeat(44);

/* A stub that records every request and answers from a table of matchers.
   Restores the real fetch afterwards, because a suite that leaks a stub into
   the next file is a suite that lies about the next file. */
function stubFetch(answer) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? "GET", body: init.body ?? null });
    const r = answer(u, init);
    if (!r) return new Response("null", { status: 404 });
    return r instanceof Response ? r : new Response(JSON.stringify(r.body ?? r), {
      status: r.status ?? 200, headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, done: () => { globalThis.fetch = real; } };
}

const roomMsg = (o) => ({ seq: "1", ts: new Date().toISOString(), ...o });

/* ══════════════════════════════════════════════════════════════════════════
   A. THE LEDGER SHREDDER  (audit C1 — critical)

   Above 1MB the GitHub contents API answers 200 with an EMPTY body and
   `encoding: "none"`. The keeper read that as an empty ledger, so every frame
   in the room looked new, and the PUT that followed carried the file's real
   sha — a legitimate, accepted replacement of the entire market history by the
   last two hundred messages. In one commit, marked [skip ci] so nothing ran to
   notice, triggerable by any anonymous POST, and due to fire on its own at
   roughly seven thousand frames.
   ═════════════════════════════════════════════════════════════════════════*/
console.log("=== A. the ledger cannot be silently emptied");
{
  process.env.GITHUB_WRITE_TOKEN = "test-token";
  const keep = (await import("../api/keep.js")).default;
  const frame = PREFIX + JSON.stringify({ from: DID_A, market: MARKET, nonce: "n1", type: "tap", amount: "1000" });

  /* The exact shape GitHub returns for a file it will not send the body of. */
  const big = stubFetch((u) => {
    if (u.includes("technocore.chat")) return { body: { messages: [roomMsg({ from: DID_A, sig: "s", text: frame })] } };
    if (u.includes("/contents/")) return { body: { sha: "realsha", size: 2_000_000, encoding: "none", content: "" } };
    return { body: {} };
  });
  const res = await keep(new Request("https://x/api/keep", { method: "POST" }));
  const out = await res.json();
  const puts = big.calls.filter((c) => c.method === "PUT");
  big.done();

  ok("a ledger too big for the contents API is not rewritten", puts.length === 0,
    `${puts.length} PUTs`);
  ok("and the refusal says so rather than reporting success",
    out.ok === false && /refusing to rewrite/.test(out.reason ?? ""), out.reason);

  /* The other half: a file that really IS empty must still be written to, or
     the guard has traded a shredder for a keeper that never starts. */
  const fresh = stubFetch((u, init) => {
    if (u.includes("technocore.chat")) return { body: { messages: [roomMsg({ from: DID_A, sig: "s", text: frame })] } };
    /* 404 on the READ only — that is what "no ledger yet" looks like. The PUT
       that follows has the same path and must be allowed to succeed, or this
       would be testing a failed write rather than a first one. */
    if (u.includes("/contents/") && (init.method ?? "GET") === "GET") return new Response("{}", { status: 404 });
    return { body: {} };
  });
  const r2 = await keep(new Request("https://x/api/keep", { method: "POST" }));
  const o2 = await r2.json();
  const p2 = fresh.calls.filter((c) => c.method === "PUT");
  fresh.done();
  ok("a ledger that does not exist yet is still created", p2.length === 1 && o2.kept === 1,
    JSON.stringify(o2));

  /* And an append is an append: the existing bytes have to survive it. */
  const had = JSON.stringify({ seq: 9, ts: null, from: DID_B, signed: true, text: frame }) + "\n";
  const grow = stubFetch((u) => {
    if (u.includes("technocore.chat")) return { body: { messages: [roomMsg({ from: DID_A, sig: "s", text: frame })] } };
    if (u.includes("/contents/")) return { body: {
      sha: "realsha", size: had.length, encoding: "base64",
      content: Buffer.from(had, "utf8").toString("base64") } };
    return { body: {} };
  });
  await keep(new Request("https://x/api/keep", { method: "POST" }));
  const put = grow.calls.find((c) => c.method === "PUT");
  grow.done();
  const written = Buffer.from(JSON.parse(put.body).content, "base64").toString("utf8");
  ok("an append keeps every line that was already there",
    written.startsWith(had) && written.split("\n").filter(Boolean).length === 2,
    `${written.split("\n").filter(Boolean).length} lines`);
}

/* ══════════════════════════════════════════════════════════════════════════
   B. UNSIGNED FRAMES  (audit H1 — high)

   The keeper's stated reasoning was that everything in the room got there by
   being signed, "because that is the only way anything gets into it". Not
   true: Technocore accepts unsigned posts under a caller-chosen `from`, which
   is a nickname. /api/room splits the two apart; the keeper read the raw room
   and did not, took any non-empty string as an author, and dropped `sig` — so
   nothing downstream could tell the difference afterwards, and the fold
   counted unsigned frames as real calls.
   ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== B. an unsigned frame is not a call");
{
  const keep = (await import("../api/keep.js")).default;
  const frame = (from) => PREFIX + JSON.stringify({ from, market: MARKET, nonce: "n1", type: "tap", amount: "1000" });

  const s = stubFetch((u, init) => {
    if (u.includes("technocore.chat")) return { body: { messages: [
      /* A nickname. No key, no signature — and, in the worst case, a nickname
         chosen to LOOK like a key, which is exactly why the shape is checked
         rather than the presence of a string. */
      roomMsg({ seq: "1", from: "bob", text: frame("bob") }),
      roomMsg({ seq: "2", from: "did:key:z6Mknot-a-real-key", text: frame("did:key:z6Mknot-a-real-key") }),
      /* And a real one, so the test proves selectivity rather than refusal. */
      roomMsg({ seq: "3", from: DID_A, sig: "sig", text: frame(DID_A) }),
    ] } };
    if (u.includes("/contents/") && (init.method ?? "GET") === "GET") return new Response("{}", { status: 404 });
    return { body: {} };
  });
  await keep(new Request("https://x/api/keep", { method: "POST" }));
  const put = s.calls.find((c) => c.method === "PUT");
  s.done();
  const rows = Buffer.from(JSON.parse(put.body).content, "base64").toString("utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));

  ok("the keeper archives only frames from a real key", rows.length === 1, `${rows.length} rows`);
  ok("and it is the signed one", rows[0].from === DID_A);
  ok("and whether it was signed is recorded rather than thrown away",
    rows[0].signed === true, JSON.stringify(rows[0].signed));
}

console.log("\n=== B1b. and the OTHER writer of the ledger, and the reader in between");
{
  /* Two things write all.ndjson: /api/keep and the collector. Fixing one and
     not the other would have left half the path exactly as open as before —
     which is what nearly happened, because the collector records the raw
     `sig` and /api/calls was dropping it on the floor. */
  const arc = fs.readFileSync(new URL("../scripts/archive.mjs", import.meta.url), "utf8");
  ok("the collector will not put a nickname in the ledger",
    /function pushCall\(state, r\) \{[\s\S]{0,900}?DID_RE\.test\(r\.from\)/.test(arc));
  ok("and it still records the signature alongside the row",
    /sig: m\.sig \?\? null/.test(arc));

  /* The reader in between has to carry the answer through from EITHER writer:
     an explicit flag from the keeper, or the presence of a sig from the
     collector. Absent-and-absent stays absent, which is what protects the
     rows written before anybody looked. */
  const calls = fs.readFileSync(new URL("../api/calls.js", import.meta.url), "utf8");
  ok("the reader takes the keeper's flag when there is one",
    /typeof row\.signed === "boolean" \? \{ signed: row\.signed \}/.test(calls));
  ok("and reads the collector's signature as the flag when there is not",
    /"sig" in \(row \?\? \{\}\) \? \{ signed: typeof row\.sig === "string"/.test(calls));
  ok("and leaves it absent only when the row has neither",
    /: \{\}\),/.test(calls));
}

console.log("\n=== B2. and the fold refuses them too, whatever the reader did");
{
  /* Defence in depth, and the layer that matters: this is the file that
     decides what counts, so the rule belongs here rather than in whichever
     endpoint happened to fetch the row. */
  const m = (o) => ({ seq: 1, ts: new Date().toISOString(), at: Date.now(), ...o });
  const tap = (from) => tapFrame(from, "t1");

  const nick = foldMarket([m({ from: "bob", sig: "x", text: tap("bob") })]);
  ok("a nickname takes no paper", nick.tapped === 0, `${nick.tapped}`);

  const nosig = foldMarket([m({ from: DID_A, sig: null, text: tap(DID_A) })]);
  ok("a live frame the room reports as unsigned takes none either",
    nosig.tapped === 0, `${nosig.tapped}`);
  ok("and the reason is recorded rather than swallowed",
    nosig.refused.some((r) => /no signature/.test(r.why)), nosig.refused[0]?.why);

  const flagged = foldMarket([m({ from: DID_A, signed: false, text: tap(DID_A) })]);
  ok("an archived frame marked unsigned takes none either",
    flagged.tapped === 0, `${flagged.tapped}`);

  /* The compatibility half, and it is not a nicety. Every row written before
     the keeper recorded `signed` has no flag at all, and reading that absence
     as "unsigned" would erase the market's own history to fix a bug in how it
     is written from now on. */
  const old = foldMarket([m({ from: DID_A, text: tap(DID_A) })]);
  ok("a row from before anybody looked still counts", old.tapped === 1, `${old.tapped}`);

  const good = foldMarket([m({ from: DID_A, sig: "s", signed: true, text: tap(DID_A) })]);
  ok("and a signed frame counts normally", good.tapped === 1);

  /* The whole point, end to end: a forged position does not reach the board. */
  const forged = foldMarket([
    m({ seq: 1, from: DID_A, sig: "s", text: tapFrame(DID_A, "t1") }),
    m({ seq: 2, from: DID_A, sig: "s", text: callFrame(DID_A, "yes", 500, "c1") }),
    m({ seq: 3, from: "did:key:z6Mkfake", signed: false, text: tapFrame("did:key:z6Mkfake", "t2") }),
    m({ seq: 4, from: "did:key:z6Mkfake", signed: false, text: callFrame("did:key:z6Mkfake", "no", 900, "c2") }),
  ]);
  ok("so a forged call cannot move the board",
    forged.yes === 500 && forged.no === 0 && forged.people === 1,
    `yes ${forged.yes}, no ${forged.no}, people ${forged.people}`);
}

/* ══════════════════════════════════════════════════════════════════════════
   C. THE NOTE OVERWRITE  (audit H2 — high)

   The note branch validated `did` and then never used it. The write target
   came entirely from a caller-supplied `fingerprint`, and the DID-to-
   fingerprint mapping is public and deterministic — so anyone could pass
   their own DID to satisfy the check and somebody else's fingerprint to pick
   the victim, over a wildcard CORS header, and /api/note then cached the
   result for ten minutes.
   ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== C. a note write cannot be aimed at somebody else");
{
  const post = (await import("../api/post.js")).default;
  const fpOf = async (did) => {
    const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(did));
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  };
  const mine = await fpOf(DID_A), victim = await fpOf(DID_B);
  ok("the two identities really do shard differently", mine !== victim);

  const s = stubFetch(() => new Response("ok", { status: 200 }));
  await post(new Request("https://x/api/post", {
    method: "POST", headers: { "Content-Type": "application/json" },
    /* My DID, their fingerprint. This is the whole attack. */
    body: JSON.stringify({ kind: "note", did: DID_A, fingerprint: victim, value: "pwned" }),
  }));
  const url = s.calls[0]?.url ?? "";
  s.done();

  ok("the write lands on the shard of the DID in the request",
    url.includes(`/kv/did-${mine.slice(0, 2)}/${mine.slice(2)}/set/`), url.slice(0, 80));
  ok("and never on the one the caller asked for",
    !url.includes(`/kv/did-${victim.slice(0, 2)}/${victim.slice(2)}/`), url.slice(0, 80));
}

/* ══════════════════════════════════════════════════════════════════════════
   D. SHAPES ON ANYTHING FED TO A LOOP  (audit M5/M6 — medium)
   ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== D. values fed to a scan are shaped first");
{
  const src = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
  const orders = src("../api/orders.js");
  const calls = src("../api/calls.js");
  const accept = src("../api/accept.mjs");

  /* accept.mjs already had this rule and wrote down why. orders.js had the
     same scanning loop and not the rule. */
  ok("an offer id is shaped before it reaches indexOf",
    /const OFFER_ID = \/\^0x\[0-9a-f\]\{64\}\$\//.test(orders) &&
    /id: OFFER_ID\.test\(/.test(orders));
  ok("and both files spell an offer id the same way",
    /const OFFER_ID = (\/\^0x\[0-9a-f\]\{64\}\$\/)/.exec(orders)?.[1] ===
    /const OFFER_ID = (\/\^0x\[0-9a-f\]\{64\}\$\/)/.exec(accept)?.[1]);

  /* A shard name is interpolated straight into a URL that then gets fetched.
     It comes from the project's own _meta.json today, which is exactly the
     kind of trust boundary that moves without anyone noticing. */
  for (const [name, s] of [["orders", orders], ["calls", calls]]) {
    ok(`${name} validates a shard name before putting it in a URL`,
      /const DAY_RE = \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//.test(s) &&
      /\.filter\(\(d\) => typeof d === "string" && DAY_RE\.test\(d\)\)/.test(s));
    ok(`${name} gives its archive fetch a timeout`,
      /async function grabText[\s\S]{0,900}?AbortSignal\.timeout\(/.test(s));
  }

  /* MAX_ORDERS bounds a customer with many orders. It does nothing about a
     DID with NONE, which is the cheap case an attacker can mint forever. */
  ok("a read budget bounds a request for a DID with no orders",
    /const MAX_SCAN_BYTES = /.test(orders) && /if \(read >= MAX_SCAN_BYTES\)/.test(orders));
}

/* ══════════════════════════════════════════════════════════════════════════
   E. SIGN-OUT REACHES EVERY TAB  (audit S1 — medium)
   ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== E. signing out drops the key in every tab");
{
  const s = fs.readFileSync(new URL("../web/session.js", import.meta.url), "utf8");
  /* signOut() cleared liveKey in the tab it ran in. Every other open tab kept
     a live, usable CryptoKey handle for the identity that had just been
     signed out — repainted as signed-out, still holding the key. The stated
     threat model for sign-out is a shared machine. */
  ok("a storage-event sign-out clears the in-memory handle",
    /addEventListener\("storage",[\s\S]{0,700}?liveKey = null; livePub = null; keeping = null;/.test(s));
  ok("and it is registered at module load, not only via onSession",
    s.indexOf('addEventListener("storage", (e) => {') > s.indexOf("export function onSession"));
  ok("a sign-IN through the same event does not drop the key",
    /if \(getSession\(\)\) return;/.test(s));
  /* The invariants this file exists to keep. */
  ok("the key is still imported non-extractable",
    /importKey\("jwk", jwk, \{ name: "Ed25519" \}, false, \["sign"\]\)/.test(s));
  ok("and nothing exports a route to the key material",
    !/export .*(exportKey|\bjwk\b\s*\})/.test(s.replace(/\/\*[\s\S]*?\*\//g, "")));
}

/* ══════════════════════════════════════════════════════════════════════════
   F. THE POLICY THAT MAKES AN XSS LOCAL  (audit — config)
   ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== F. the headers that bound a compromise");
{
  const v = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  /* BY WHAT IT MATCHES, NOT BY WHERE IT SITS. This read headers[0] and broke
     the day a caching rule was added above the security one — eleven
     assertions failing at once because a list grew, not because anything got
     less safe. The rule that carries these is the one applying to every path;
     find it that way and the order stops mattering. */
  /* ── AND THE FILE ITSELF HAS TO BE DEPLOYABLE ─────────────────────────
     A build failed on this file. Not the code — the config: two `"//"` keys
     added as comments, which JSON does not have and Vercel's schema rejects
     outright ("should NOT have additional property"). The deploy errored, the
     previous build stayed live, and every fix in that patch sat on GitHub
     doing nothing while the meters kept climbing at the old rate.

     Nothing in the repo could have caught it, because every test here reads
     vercel.json with JSON.parse — which is perfectly happy with extra keys.
     So this checks what VERCEL will accept, not what JavaScript will parse. */
  const LEGAL = {
    headers: ["source", "headers", "has", "missing"],
    redirects: ["source", "destination", "permanent", "statusCode", "has", "missing"],
    rewrites: ["source", "destination", "has", "missing"],
  };
  const strays = [];
  for (const [section, allowed] of Object.entries(LEGAL)) {
    (v[section] ?? []).forEach((entry, i) => {
      for (const k of Object.keys(entry)) {
        if (!allowed.includes(k)) strays.push(`${section}[${i}].${k}`);
      }
    });
  }
  ok("vercel.json carries no key the deploy would refuse",
    strays.length === 0, strays.join(" ") || "headers, redirects and rewrites all clean");

  const rule = (v.headers ?? []).find((r) => r.source === "/(.*)");
  const h = Object.fromEntries((rule?.headers ?? []).map((x) => [x.key, x.value]));
  ok("the security headers apply to every path, not just some of them",
    !!rule, rule ? rule.source : "no catch-all rule found");
  const csp = h["Content-Security-Policy"] ?? "";
  /* `unsafe-inline` for scripts is a documented, accepted residual — a
     no-build static site cannot issue nonces. Which is precisely why the
     rest of the policy is not optional: an injected script that can run but
     cannot reach the network is an incident, not a theft. */
  ok("a signature cannot be posted off-origin", /connect-src 'self'/.test(csp));
  ok("nor smuggled out through an image", /img-src 'self' data: blob:/.test(csp));
  ok("no third-party script can load", /script-src 'self' 'unsafe-inline'/.test(csp));
  ok("nothing is inherited by accident", /default-src 'none'/.test(csp));
  ok("the page cannot be framed", /frame-ancestors 'none'/.test(csp));
  ok("a base tag cannot be injected", /base-uri 'none'/.test(csp));
  ok("a form cannot exfiltrate", /form-action 'none'/.test(csp));
  ok("and plugin content is refused", /object-src 'none'/.test(csp));
  ok("content types are not sniffed", h["X-Content-Type-Options"] === "nosniff");
  ok("a DID in a URL does not leak in a referer", h["Referrer-Policy"] === "no-referrer");
  ok("HSTS is set", /max-age=\d{7,}/.test(h["Strict-Transport-Security"] ?? ""));
}

/* ═════════════════════════════════════════════════════════════════════════
   G. A TYPED NAME IS NOT A KEY

   PROMPTED BY SOMEBODY ELSE'S INCIDENT. In 2026 a swarm of agents used a
   dormant German wiki as a message board, ~18,000 posts under self-chosen
   names. The part worth copying down is how they beat the sandbox that was
   meant to hold them: it trusted any hostname ENDING in a trusted domain, so
   they invented one that did. Check a fragment of a name and you have only
   told the attacker which fragment to supply.

   This site had the same bug in the same shape. `from` on a Technocore
   message is whatever the caller types — the network takes unsigned posts —
   and four places decided somebody was a real keyed identity by asking
   whether that string STARTED with "did:key:". The fold and the ledger were
   never fooled; they have always used the anchored pattern. But the roster,
   the live read, the snapshot writer and the archive's profile recorder were,
   which meant a made-up key could earn a profile page, a place in the
   identity list and an uncapped count feeding the cards.

   SHAPE IS STILL NOT PROOF, and no test here should suggest it is. Minting a
   real keypair costs nothing, and none of these messages carry a signature.
   This is the floor — it keeps typed junk out of the permanent record. The
   ceiling is section B: only a signature counts, and only the fold and the
   ledger enforce that.
   ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== G. a typed name is not a key");
{
  /* Every one of these is a string somebody can actually post under. */
  const FORGED = [
    "did:key:not-a-real-key-at-all",
    "did:key:z6Mk" + "a".repeat(45),          // one too long
    "did:key:z6Mk" + "a".repeat(43),          // one too short
    "did:key:" + "z6Mk" + "a".repeat(44) + " x",  // a real key with a tail
    "did:key:z6Mk" + "0".repeat(44),          // 0 is not in the base58 alphabet
    "did:key:",
    "did:key:z6MkO" + "a".repeat(43),         // O is not in the base58 alphabet
    "  " + DID_A,                             // leading space
    DID_A + "\n",                             // trailing newline
  ];

  const room = (msgs) => ({ body: { messages: msgs, first_seq: "1", last_seq: String(msgs.length) } });

  /* ── the live read ──────────────────────────────────────────────────── */
  const roomHandler = (await import("../api/room.js")).default;
  const s1 = stubFetch((u) => u.includes("technocore.chat")
    ? room([DID_A, ...FORGED].map((from, i) => roomMsg({ seq: String(i + 1), from, sig: null, text: "hi" })))
    : { body: {} });
  /* `t=` is the documented cache bypass, and it is also the only way to
     reach the mapping: a plain read delegates to this site's own canonical
     URL and passes through whatever that returned. The mapping runs once, at
     the canonical, which is the request this makes. */
  const r1 = await roomHandler(new Request("https://x/api/room?room=lobby&t=1"));
  const j1 = await r1.json();
  s1.done();

  const kept = j1.messages.filter((m) => m.from !== null).map((m) => m.from);
  ok("a live read puts only a whole, well-formed key in `from`",
    kept.length === 1 && kept[0] === DID_A, JSON.stringify(kept));
  ok("and moves every forgery to `nick`, where nothing is claimed for it",
    j1.messages.filter((m) => m.nick !== null).length === FORGED.length,
    `${j1.messages.filter((m) => m.nick !== null).length} of ${FORGED.length}`);
  /* The response labels itself. It used to promise only that TEXT was
     untrusted, while handing over a `from` the reader would reasonably take
     as identity. A live read carries sig:null on every line. */
  ok("and the response says a live read proves nobody",
    /no signature/.test(j1.untrusted ?? "") && /claim/.test(j1.untrusted ?? ""),
    j1.untrusted);

  /* ── the roster ─────────────────────────────────────────────────────── */
  const idsHandler = (await import("../api/identities.js")).default;
  const s2 = stubFetch((u) => {
    if (u.includes("/rooms?")) return { body: { rooms: [{ room: "lobby" }], total: 1 } };
    if (u.includes("/r/"))
      return { body: { messages: [DID_A, ...FORGED].map((from, i) =>
        roomMsg({ seq: String(i + 1), from, sig: null, text: "hi " + i })) } };
    return { body: {} };
  });
  const r2 = await idsHandler(new Request("https://x/api/identities"));
  const j2 = await r2.json();
  s2.done();
  const names = Object.keys(j2.identities ?? {});
  ok("the roster lists the one real key",
    names.length === 1 && names[0] === DID_A, `${names.length} listed`);
  ok("and not one of the forgeries",
    !FORGED.some((f) => names.includes(f)),
    names.filter((n) => n !== DID_A).join(" ") || "none");

  /* ── the two writers of durable state ───────────────────────────────── */
  const arc = fs.readFileSync(new URL("../scripts/archive.mjs", import.meta.url), "utf8");
  const snap = fs.readFileSync(new URL("../scripts/make-room-snapshots.mjs", import.meta.url), "utf8");
  /* Greps, and flagged as such — driving a full archive run needs a repo and
     a token. What makes them worth having is that they are NEGATIVE: they
     fail if the prefix check comes back anywhere in either file, which is
     the actual regression, rather than passing the moment somebody writes
     the fixed spelling somewhere unrelated. */
  /* CODE ONLY. A negative grep run over the whole file finds the fixed bug
     described in the comment ABOVE the fix and reports it as still present —
     which is what happened here, and what happened once before in
     test-market.mjs over the word `_meta.json`. Strip comments first, so the
     assertion is about what runs. */
  const codeOf = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
  ok("the archive records a profile for nothing but a whole key",
    /DID_RE\.test\(m\.from\)\) await recordProfile/.test(codeOf(arc)));
  ok("and no prefix check survives anywhere in the archive",
    !/startsWith\("did:key:"\)/.test(codeOf(arc)));
  ok("nor in the snapshot writer, which the city reads",
    !/startsWith\("did:key:"\)/.test(codeOf(snap)) && /DID_RE\.test\(raw\)/.test(codeOf(snap)));
  /* One rule, one spelling, everywhere it is a decision about trust. */
  const files = ["../web/call.js", "../api/keep.js", "../api/calls.js", "../api/room.js",
                 "../api/post.js", "../api/owner.js", "../api/identities.js",
                 "../api/profile.js", "../scripts/archive.mjs", "../scripts/make-room-snapshots.mjs"];
  const PAT = /did:key:z6Mk\[1-9A-HJ-NP-Za-km-z\]\{44\}/;
  const off = files.filter((f) => !PAT.test(fs.readFileSync(new URL(f, import.meta.url), "utf8")));
  ok("and every file that decides a key is a key spells the rule the same way",
    off.length === 0, off.join(" ") || `${files.length} files agree`);
}

/* ═════════════════════════════════════════════════════════════════════════
   H. THE LEDGER IS THE FRESHEST SOURCE, NOT THE WHOLE ONE

   FOUND IN PRODUCTION, on the morning a founder's quote-tweet pointed 45,000
   people at the page. /api/calls returned the moment `all.ndjson` could be
   read, on the stated grounds that the collector "keeps every call in one
   small file". It does not. A Technocore room is a 200-message ring buffer,
   and the ledger had rolled with it: 122 rows from seq 236, while the day
   shards held 332 rows from seq 1 and _meta.json agreed with the shards.

   So the page was serving a market of 53 callers when 140 had called. No
   error, no log line, nothing to notice — just a smaller number, on the one
   page whose whole claim is that the record is complete and checkable. The
   people missing were the earliest ones, which is the worst possible subset.

   This is the same shape as the ledger shredder in section A: a read that
   came back short was treated as a read that came back whole.
   ═════════════════════════════════════════════════════════════════════════*/
console.log("\n=== H. a short ledger does not become a short market");
{
  const calls = (await import("../api/calls.js")).default;
  const row = (seq, from, text) => JSON.stringify({ seq, ts: "2026-09-08T09:00:00Z", from, sig: "s", text });
  const frame = (from, n) => PREFIX + JSON.stringify(
    { amount: "1000", from, market: MARKET, nonce: "n" + n, type: "tap" });

  /* Ten calls exist. The ledger has rolled and holds only the last three. */
  const everyone = Array.from({ length: 10 }, (_, i) =>
    row(i + 1, "did:key:z6Mk" + String.fromCharCode(97 + i).repeat(44), frame("did:key:z6Mk" + String.fromCharCode(97 + i).repeat(44), i)));
  const rolled = everyone.slice(-3).join("\n");
  const shard = everyone.join("\n");
  const meta = JSON.stringify({ room: "overheard-calls", days: ["2026-09-08"], total: 10, gaps: [] });

  const serve = (table) => stubFetch((u) => {
    for (const [suffix, body] of Object.entries(table)) {
      if (u.endsWith(suffix)) return body === null
        ? new Response("", { status: 404 })
        : new Response(body, { status: 200 });
    }
    return new Response("", { status: 404 });
  });

  let s1 = serve({ "all.ndjson": rolled, "_meta.json": meta, "2026-09-08.ndjson": shard });
  let j = await (await calls(new Request("https://x/api/calls"))).json();
  s1.done();
  ok("a ledger shorter than the archive is topped up from the shards",
    j.frames.length === 10, `${j.frames.length} of 10, source ${j.source}`);
  ok("and the two roads to one record do not double-count it",
    new Set(j.frames.map((f) => f.seq)).size === j.frames.length);
  ok("the earliest callers are the ones it was losing, and they are back",
    j.frames.some((f) => f.seq === 1) && j.frames.some((f) => f.seq === 10));
  ok("it says which sources it actually used", j.source === "ledger+shards", j.source);

  /* THE FAST PATH SURVIVES. Reading every shard on every request when the
     ledger is genuinely complete would trade one bug for a slower endpoint. */
  const s2 = serve({ "all.ndjson": everyone.join("\n"), "_meta.json": meta, "2026-09-08.ndjson": shard });
  j = await (await calls(new Request("https://x/api/calls"))).json();
  const shardReads = s2.calls.filter((c) => /2026-09-08\.ndjson/.test(c.url)).length;
  s2.done();
  ok("a complete ledger still answers without touching a shard",
    j.frames.length === 10 && shardReads === 0 && j.source === "ledger",
    `${shardReads} shard reads, source ${j.source}`);

  /* And the ledger failing entirely must not take the market with it. */
  const s3 = serve({ "all.ndjson": null, "_meta.json": meta, "2026-09-08.ndjson": shard });
  j = await (await calls(new Request("https://x/api/calls"))).json();
  s3.done();
  ok("a ledger that cannot be read at all falls back to the shards",
    j.frames.length === 10 && j.source === "shards", `${j.frames.length}, ${j.source}`);

  /* A room nobody has collected yet is not a broken one. */
  const s4 = serve({ "all.ndjson": null, "_meta.json": null });
  j = await (await calls(new Request("https://x/api/calls"))).json();
  s4.done();
  ok("and a room with no archive yet says so, rather than erroring",
    j.archived === false && j.frames.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

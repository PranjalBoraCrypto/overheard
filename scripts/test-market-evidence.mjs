/** Offline integration tests for the two market archive handlers.
 * Real Ed25519 signatures, ephemeral test keys, mocked public/GitHub responses.
 * No network calls, real credentials, repository writes, or room posts.
 * Run from the repository root: node scripts/test-market-evidence.mjs
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ROOM, tapFrame, callFrame, foldMarket } from "../web/call.js";

const realFetch = globalThis.fetch;
const blockedFetch = async () => { throw new Error("unexpected network request in offline test"); };
globalThis.fetch = blockedFetch;
const oldToken = process.env.GITHUB_WRITE_TOKEN;
process.env.GITHUB_WRITE_TOKEN = "offline-test-only-not-a-credential";
const load = async (name) => {
  const src = await readFile(new URL(`../api/${name}`, import.meta.url), "utf8");
  return (await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"))).default;
};
const [calls, keep] = await Promise.all([load("calls.js"), load("keep.js")]);
if (oldToken === undefined) delete process.env.GITHUB_WRITE_TOKEN;
else process.env.GITHUB_WRITE_TOKEN = oldToken;

const pair = generateKeyPairSync("ed25519");
const pub = pair.publicKey.export({format: "der", type: "spki"}).subarray(-32);
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let n = BigInt("0x" + Buffer.concat([Buffer.from([0xed, 1]), pub]).toString("hex"));
let encoded = "";
while (n) { encoded = alphabet[Number(n % 58n)] + encoded; n /= 58n; }
const did = "did:key:z" + encoded;
const nonce = "1788257887160347588";
const make = (seq, text, signingNonce = nonce) => ({seq, ts: "2026-09-10T00:00:00Z", from: did, text,
  nonce: signingNonce, sig: sign(null, Buffer.from(`${ROOM}|${signingNonce}|${text}`), pair.privateKey).toString("base64url")});
const tap = make(1, tapFrame(did, "application-tap"), String(BigInt(nonce) - 1n));
const call = make(2, callFrame(did, "yes", 250, "application-call"));
const verifies = (m, room = ROOM) => typeof m.sig === "string" && typeof m.nonce === "string"
  && verify(null, Buffer.from(`${room}|${m.nonce}|${m.text}`), pair.publicKey, Buffer.from(m.sig, "base64url"));
const wire = (rows, bareNonce = false) => JSON.stringify({messages: rows})
  .replace(/"nonce":"([0-9]+)"/g, (match, value) => bareNonce ? `"nonce":${value}` : match);
const json = value => new Response(JSON.stringify(value), {headers: {"Content-Type": "application/json"}});

async function readArchive(ledger, shards = {}) {
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.method ?? "GET", "GET");
    const u = new URL(url);
    assert.equal(u.origin, "https://raw.githubusercontent.com");
    if (u.pathname.endsWith("/all.ndjson")) return new Response(ledger);
    if (u.pathname.endsWith("/_meta.json")) return json({total: 999, days: Object.keys(shards)});
    const day = u.pathname.split("/").at(-1).replace(".ndjson", "");
    assert.ok(Object.hasOwn(shards, day), `unexpected archive path ${u.pathname}`);
    return new Response(shards[day]);
  };
  try { return await (await calls()).json(); }
  finally { globalThis.fetch = blockedFetch; }
}

async function keepRows(roomBody, {existing = "", conflictOnce = false, encoding = "base64"} = {}) {
  let written = null, attempts = 0, reads = 0;
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url), method = options.method ?? "GET";
    if (u.origin === "https://technocore.chat") {
      assert.equal(method, "GET");
      assert.equal(u.pathname, `/r/${ROOM}`);
      return new Response(roomBody, {headers: {"Content-Type": "application/json"}});
    }
    assert.equal(u.origin, "https://api.github.com");
    assert.ok(u.pathname.endsWith(`/contents/web/data/${ROOM}/all.ndjson`));
    if (method === "GET") {
      reads++;
      return json({sha: `revision-${reads}`, encoding, size: Buffer.byteLength(existing),
        content: Buffer.from(existing).toString("base64")});
    }
    assert.equal(method, "PUT");
    attempts++;
    const request = JSON.parse(options.body);
    assert.equal(request.sha, `revision-${reads}`);
    assert.match(request.message, /\[skip ci\]/);
    if (conflictOnce && attempts === 1) return new Response("conflict", {status: 409});
    written = Buffer.from(request.content, "base64").toString("utf8");
    return json({content: {sha: "new-revision"}});
  };
  try {
    const response = await keep(new Request("https://example.invalid/api/keep", {method: "POST", body: "ignored"}));
    return {result: await response.json(), written, attempts, reads};
  } finally { globalThis.fetch = blockedFetch; }
}

try {
  await test("archive projection preserves signature and string nonce", async () => {
    const response = await readArchive(JSON.stringify(call));
    assert.equal(response.room, ROOM);
    assert.equal(response.frames[0].sig, call.sig);
    assert.equal(response.frames[0].nonce, nonce);
    assert.ok(verifies(response.frames[0]));
  });

  await test("archive projection preserves a bare 19-digit nonce before parsing", async () => {
    const raw = JSON.stringify(call).replace(`"nonce":"${nonce}"`, `"nonce":${nonce}`);
    assert.notEqual(String(JSON.parse(raw).nonce), nonce, "fixture must actually lose precision");
    const response = await readArchive(raw);
    assert.equal(response.frames[0].nonce, nonce);
    assert.ok(verifies(response.frames[0]));
  });

  await test("keeper persists a verifiable proof from numeric-nonce room JSON", async () => {
    const saved = await keepRows(wire([call], true));
    assert.equal(saved.result.kept, 1);
    const row = JSON.parse(saved.written.trim());
    assert.equal(row.sig, call.sig);
    assert.equal(row.nonce, nonce);
    assert.ok(verifies(row));
  });

  await test("room -> keeper -> archive -> independent verification preserves accounting", async () => {
    const saved = await keepRows(wire([tap, call]));
    const response = await readArchive(saved.written);
    assert.equal(response.frames.length, 2);
    assert.ok(response.frames.every(m => verifies(m)));
    assert.equal(foldMarket(response.frames).yes, 250);
    assert.equal(foldMarket(response.frames).calls, 1);
    assert.equal(foldMarket(response.frames).total, foldMarket([tap, call]).total);
  });

  await test("preserved signatures reject tampering and a different room", async () => {
    const response = await readArchive(JSON.stringify(call));
    const row = response.frames[0];
    assert.ok(verifies(row), "positive control");
    assert.equal(verifies({...row, text: row.text + " modified"}), false);
    assert.equal(verifies(row, "a-different-room"), false);
  });

  await test("legacy flag-only records stay distinguishable and do not change balances", async () => {
    const legacy = [tap, call].map(({sig, nonce, ...rest}) => ({...rest, signed: true}));
    const response = await readArchive(legacy.map(m => JSON.stringify(m)).join("\n"));
    assert.ok(response.frames.every(m => !Object.hasOwn(m, "sig") && !Object.hasOwn(m, "nonce")));
    assert.equal(foldMarket(response.frames).total, 250);
  });

  await test("a legacy record with no signed flag gains neither a flag nor a proof", async () => {
    const {sig, nonce, ...legacy} = call;
    const response = await readArchive(JSON.stringify(legacy));
    assert.equal(Object.hasOwn(response.frames[0], "signed"), false);
    assert.equal(Object.hasOwn(response.frames[0], "sig"), false);
  });

  await test("explicitly unsigned records remain excluded from the fold", async () => {
    const unsigned = {...call, sig: null};
    const saved = await keepRows(wire([tap, unsigned]));
    const response = await readArchive(saved.written);
    assert.equal(response.frames[1].signed, false);
    assert.equal(foldMarket(response.frames).total, 0);
  });

  await test("day-shard evidence survives projection too", async () => {
    const response = await readArchive("", {"2026-09-10": JSON.stringify(call)});
    assert.equal(response.days_scanned, 1);
    assert.ok(verifies(response.frames[0]));
  });

  await test("the exact message text survives, including an escaped nonce-like substring", async () => {
    const text = call.text + ' example: {"nonce":1788257887160347588} caf\u00e9';
    const fixture = make(3, text);
    const saved = await keepRows(wire([fixture], true));
    const response = await readArchive(saved.written);
    assert.equal(response.frames[0].text, text);
    assert.ok(verifies(response.frames[0]));
  });

  await test("idempotent calls do not rewrite existing ledger entries", async () => {
    const existing = JSON.stringify(call) + "\n";
    const saved = await keepRows(wire([call]), {existing});
    assert.equal(saved.result.kept, 0);
    assert.equal(saved.attempts, 0);
  });

  await test("concurrent-write retry retains evidence and refreshes the revision guard", async () => {
    const saved = await keepRows(wire([call], true), {conflictOnce: true});
    assert.equal(saved.attempts, 2);
    assert.equal(saved.reads, 2);
    assert.ok(verifies(JSON.parse(saved.written.trim())));
  });

  await test("signature bytes cannot push the completed ledger past its byte ceiling", async () => {
    // Existing content is below the cap; adding the signed row crosses it.
    const existing = JSON.stringify({seq: 0, text: "x".repeat(899800)}) + "\n";
    assert.ok(Buffer.byteLength(existing) < 900000);
    const saved = await keepRows(wire([call]), {existing});
    assert.equal(saved.result.kept, 0);
    assert.equal(saved.result.reason, "the ledger is full");
    assert.equal(saved.attempts, 0);
  });

  await test("a contents API response without base64 data never gets overwritten", async () => {
    const saved = await keepRows(wire([call]), {encoding: "none"});
    assert.equal(saved.result.ok, false);
    assert.equal(saved.attempts, 0);
  });
} finally {
  globalThis.fetch = realFetch;
}

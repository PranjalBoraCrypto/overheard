/**
 * POST /api/keep  —  the second copy, written by us.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 *
 * A call is a signed message in a public room, and that is the record. It is
 * also, on its own, a record with one keeper: a Technocore room is a
 * two-hundred-message ring buffer, and the only thing that copies it anywhere
 * durable is a GitHub Action that has ended early twice this week. The archive
 * is committed every five minutes WHILE THAT COLLECTOR IS RUNNING, and nothing
 * at all while it is not.
 *
 * For a river of public chat that is fine — it is an archive of a thing nobody
 * promised to keep. For a market it is somebody's position on a page that told
 * them it was kept, and "the archiver was down that afternoon" is not an
 * answer anybody should have to give in March.
 *
 * So the site keeps its own copy, immediately, at the moment of the call.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY IT TRUSTS NOTHING THE CALLER SENDS
 *
 * The obvious shape is "the page posts the frame here and we store it", and it
 * is wrong: this endpoint is public, so that shape lets anybody write anything
 * into the repository. The next thought is to verify the Ed25519 signature
 * here — correct, and it would mean reimplementing at the edge the exact check
 * Technocore already performed at the door.
 *
 * So this reads the ROOM. Whatever is in that room got there by being signed,
 * because that is the only way anything gets into it, and this endpoint stores
 * what it can see there and nothing else. The request body is not read at all.
 * The worst a stranger can do by calling this is ask us to copy the public
 * room into a file we already copy the public room into.
 *
 * It is idempotent, and that makes it a repair as well as a write: any call to
 * it syncs everything currently in the room. A frame the collector missed is
 * picked up by the next person's call, as long as it is still in the window.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE IT WRITES, AND WHY THAT AND NOT A DATABASE
 *
 * web/data/overheard-calls/all.ndjson — the same file the collector maintains
 * and the same file /api/calls already reads. A second store would be a second
 * place the truth lives, needing its own reader, its own backup and its own
 * reconciliation. Two writers converging on one file need none of that: the
 * collector merges this file with its own ledger before writing, so neither
 * can erase the other.
 *
 * THE COMMIT CARRIES [skip ci], and that is not decoration. These commits are
 * made with a personal token, and unlike GITHUB_TOKEN a personal token DOES
 * trigger workflows — so without it every call would fire deploy.yml and buy a
 * deployment. That is the mistake that put $102 on a $20 plan in August.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const config = { runtime: "edge" };

const OWNER = process.env.ARCHIVE_OWNER ?? process.env.VERCEL_GIT_REPO_OWNER ?? "PranjalBoraCrypto";
const REPO = process.env.ARCHIVE_REPO ?? process.env.VERCEL_GIT_REPO_SLUG ?? "overheard";
const BRANCH = "main";
const TOKEN = process.env.GITHUB_WRITE_TOKEN ?? "";

/* Must match web/call.js and api/calls.js. An edge function cannot import a
   browser module; scripts/test-market.mjs asserts all three spell it alike. */
const ROOM = "overheard-calls";
const PREFIX = "call1 ";
const PATH = `web/data/${ROOM}/all.ndjson`;

const TECHNOCORE = "https://technocore.chat";
/* The ledger's ceiling, the same number archive.mjs uses. A file with no bound
   is a small file waiting to stop being one. */
const MAX_LINES = 200_000;
/* A frame is ~150 bytes. Anything wildly longer is not one of ours and has no
   business being copied into the repository. */
const MAX_TEXT = 4096;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const gh = (path, init = {}) =>
  fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "overheard-keep/1.0",
      Authorization: `Bearer ${TOKEN}`,
      ...(init.headers ?? {}),
    },
  });

/** One line of the ledger, or null. The same shape /api/calls reads back. */
function frameFrom(row) {
  const text = String(row?.text ?? "");
  if (!text.startsWith(PREFIX) || text.length > MAX_TEXT) return null;
  if (typeof row.from !== "string" || !row.from) return null;
  const seq = String(row.seq ?? "");
  if (!/^[0-9]{1,19}$/.test(seq)) return null;      // the server's own number
  return { seq: Number(seq), ts: typeof row.ts === "string" ? row.ts : null, from: row.from, text };
}

/* Base64 both ways, without Buffer — the edge runtime has no Node globals, and
   the file is UTF-8 with nothing but ASCII JSON in it in practice. */
const enc = (s) => {
  const b = new TextEncoder().encode(s);
  let out = "";
  for (const x of b) out += String.fromCharCode(x);
  return btoa(out);
};
const dec = (b64) => {
  const bin = atob(b64.replace(/\s/g, ""));
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(b);
};

export default async function handler(request) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  /* NOT AN ERROR, AND THE PAGE MUST NOT TREAT IT AS ONE. With no token this
     endpoint is inert and the call is still on the network, still signed, and
     still picked up by the collector. The site is one keeper down, not
     broken. */
  if (!TOKEN) {
    return json({ ok: false, kept: 0, reason: "no GITHUB_WRITE_TOKEN — the call is on the network; this copy is not being made" }, 200);
  }

  /* ── WHAT IS ACTUALLY IN THE ROOM ──────────────────────────────────────
     The only input this endpoint has. Nothing from the request body is read. */
  let live;
  try {
    /* The same URL /api/room uses, and deliberately the same: one spelling of
       how this network is read, in two files that cannot import each other. */
    const r = await fetch(`${TECHNOCORE}/r/${ROOM}?format=json&since=0&limit=200`, {
      headers: { Accept: "application/json", "User-Agent": "overheard-keep/1.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return json({ ok: false, kept: 0, reason: `the room answered HTTP ${r.status}` }, 200);
    const j = await r.json();
    live = Array.isArray(j) ? j : (j.messages ?? []);
  } catch {
    return json({ ok: false, kept: 0, reason: "could not read the room" }, 200);
  }

  const want = new Map();
  for (const m of live) {
    const f = frameFrom(m);
    if (f) want.set(String(f.seq), f);
  }
  if (!want.size) return json({ ok: true, kept: 0, reason: "nothing in the room to keep" });

  /* ── APPEND, WITH THE FILE'S OWN SHA AS THE GUARD ──────────────────────
     Two people calling at the same moment both read the same sha and one of
     them is refused with a 409. That is the mechanism working, not failing:
     the loser reads the file again — which now contains the winner's line —
     and appends to that. Two tries is enough for the traffic this will ever
     see, and a third would be a queue pretending to be a retry. */
  for (let attempt = 0; attempt < 3; attempt++) {
    let sha = null, have = "";
    const cur = await gh(`/contents/${PATH}?ref=${BRANCH}`);
    if (cur.status === 200) {
      const j = await cur.json();
      sha = j.sha;
      have = j.content ? dec(j.content) : "";
    } else if (cur.status !== 404) {
      return json({ ok: false, kept: 0, reason: `GitHub answered HTTP ${cur.status} reading the ledger` }, 200);
    }

    const seen = new Set();
    let lines = 0;
    for (const line of have.split("\n")) {
      if (!line) continue;
      lines++;
      try { seen.add(String(JSON.parse(line).seq)); } catch { /* torn line: not a bound */ }
    }
    if (lines >= MAX_LINES) return json({ ok: true, kept: 0, reason: "the ledger is full" });

    const add = [...want.values()].filter((f) => !seen.has(String(f.seq)))
      .sort((a, b) => a.seq - b.seq);
    if (!add.length) return json({ ok: true, kept: 0, already: want.size });

    const body = have + (have && !have.endsWith("\n") ? "\n" : "")
      + add.map((f) => JSON.stringify(f)).join("\n") + "\n";

    const put = await gh(`/contents/${PATH}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        branch: BRANCH,
        /* [skip ci], because a personal token DOES trigger workflows and one
           deployment per call is the bill this project spent a day fixing. */
        message: `market: keep ${add.length} call frame(s) [skip ci]`,
        content: enc(body),
        ...(sha ? { sha } : {}),
      }),
    });
    if (put.ok) return json({ ok: true, kept: add.length, of: want.size });
    if (put.status !== 409 && put.status !== 422) {
      return json({ ok: false, kept: 0, reason: `GitHub answered HTTP ${put.status} writing the ledger` }, 200);
    }
    /* 409/422 is somebody else's line landing first. Read it and go again. */
  }
  return json({ ok: false, kept: 0, reason: "the ledger was being written by somebody else; the next call will pick this up" }, 200);
}

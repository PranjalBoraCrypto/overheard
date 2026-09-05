/* A scratch fixture server for the layout probes. Not a suite and not shipped:
   it serves the three deal views enough realistic traffic that a measurement
   is taken against a full page rather than an empty one.

   Deliberately separate from the fixtures in test-deals-page.mjs: those are
   built to be UGLY — malformed frames, hostile bodies, a reveal whose secret
   does not open its statement — because that file is checking behaviour. This
   one is built to be TYPICAL, with long names, long briefs and long ids,
   because a layout breaks on the longest plausible content and not on the
   nastiest. */
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { canon, dealRoom } from "../web/tclk.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../web");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

export const YOU  = "did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz";
export const SHOP = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const OTHER = "did:key:z6Mkt9W7ZFhqDUgVYA6hx6sCfAacc3x1sQhVnioh8KET2rAu";
const NOW = Date.now();
const frame = (o) => "tclk1 " + canon(o);
const SECRET = "0x" + "ab".repeat(32);

/* The longest brief anybody would plausibly type, and the shortest. Both are
   layout hazards in different directions. */
const BRIEFS = [
  "technocore@2026-09-03",
  "Everything did:key:z6Mkt9W7ZFhqDUgVYA6hx6sCfAacc3x1sQhVnioh8KET2rAu has done across every room we hold, with the exchanges it took part in and anything it settled, going back as far as the archive reaches",
  "lobby",
  "2026-09-01",
  "gpu-miners@2026-08-30",
];
const JOBS = ["overheard-archive-question", "overheard-agent-profile",
              "overheard-room-summary", "overheard-daily-digest"];

let n = 0;
const id = () => "0x" + sha("offer" + (++n)).slice(0, 64);

/* A spread of states, because a board where every row is the same state is a
   board whose widest row was never drawn. */
function offers() {
  const out = [];
  let seq = 90000;
  const push = (text, from) => out.push({
    seq: String(seq++), ts: new Date(NOW - (95000 - seq) * 900).toISOString(),
    from, nick: null, text, sig: "x", nonce: String(seq),
  });
  for (let i = 0; i < 26; i++) {
    const mine = i % 3 === 0;
    const from = mine ? YOU : (i % 3 === 1 ? OTHER : SHOP);
    const oid = id();
    const o = {
      type: "offer", from, id: oid,
      amount: String([250, 500, 1000, 12500, 1000000][i % 5]), asset: "FLOP",
      lock: "hash", paymentKey: "0x02" + "cd".repeat(16), rails: ["paper"],
      role: from === SHOP ? "payee" : "payer",
      job: { proto: "overheard", id: JOBS[i % 4], brief: BRIEFS[i % BRIEFS.length] },
      claimByMs: NOW + 3600000 + i * 1000,
      refundAfterMs: NOW + 7200000 + i * 1000,
      expiresMs: i % 5 === 4 ? NOW - 600000 : NOW + 1800000 + i * 1000,
      nonce: "9f2c81d04c9e1f" + (10 + i),
    };
    push(frame(o), from);
    /* Every second one is answered, and half of those are funded. */
    if (i % 2 === 0) {
      const contract = "0x" + sha("c" + oid).repeat(1).slice(0, 64);
      push(frame({ type: "accept", from: from === SHOP ? YOU : SHOP, offer: oid, contract }),
        from === SHOP ? YOU : SHOP);
      DEALS.set(dealRoom(contract), { contract, offer: o, deep: i % 4 === 0 });
    }
  }
  return out.reverse();
}

const DEALS = new Map();
const OFFERS = offers();

function dealFrames(room) {
  const d = DEALS.get(room);
  if (!d) return [];
  const out = [];
  let seq = 500;
  const push = (o) => out.push({ seq: String(seq++), ts: new Date(NOW - 60000).toISOString(),
    from: o.from, nick: null, text: frame(o), sig: "x", nonce: String(seq) });
  push({ type: "lock", from: YOU, contract: d.contract, rail: "paper", ref: "ab".repeat(8) });
  if (d.deep) {
    push({ type: "reveal", from: SHOP, contract: d.contract, secret: SECRET,
      result: { text: "The room held 1,204 messages that day across 38 identities." } });
  }
  return out;
}

export function serve(port = 8990) {
  return http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    let p = u.pathname === "/" ? "/index.html" : u.pathname;
    for (const nm of ["what", "city", "play", "v", "rooms", "create", "hire", "orders"])
      if (p === "/" + nm) p = "/" + nm + ".html";
    const J = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

    if (p === "/api/accept") return J({ ok: true, capacity: 50, open: 3, free: 47,
      full: false, working: 3, awaiting_payment: 0 });
    if (p === "/api/room") {
      const room = u.searchParams.get("room") || "";
      const msgs = room === "tclk-offers" ? OFFERS : dealFrames(room);
      return J({ room, source: "live", first_seq: msgs[msgs.length - 1]?.seq ?? "0",
        last_seq: msgs[0]?.seq ?? "0", count: msgs.length, messages: msgs });
    }
    if (p === "/api/orders") {
      const did = u.searchParams.get("did") || "";
      const mine = [];
      for (const m of OFFERS) {
        if (!m.text.startsWith("tclk1 ")) continue;
        let b; try { b = JSON.parse(m.text.slice(6)); } catch { continue; }
        if (b.type !== "offer" || b.from !== did) continue;
        const acc = OFFERS.find((x) => x.text.includes(`"offer":"${b.id}"`));
        let accept = null;
        if (acc) { const ab = JSON.parse(acc.text.slice(6)); accept = { contract: ab.contract, room: dealRoom(ab.contract) }; }
        mine.push({ id: b.id, ts: m.ts, job: b.job?.id, brief: b.job?.brief,
          amount: b.amount, asset: b.asset, expiresMs: b.expiresMs,
          claimByMs: b.claimByMs, refundAfterMs: b.refundAfterMs, accept });
      }
      return J({ ok: true, orders: mine, meta: { days_scanned: 8, days_available: 11,
        window_days: 8, truncated: false } });
    }
    if (p.startsWith("/data/") && p.endsWith("_meta.json"))
      return J({ days: ["2026-09-01", "2026-09-02", "2026-09-03"], updated: new Date().toISOString() });
    if (p.startsWith("/api/") || p.startsWith("/data/")) return J({});

    const f = path.join(ROOT, p);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      const t = p.endsWith(".js") ? "text/javascript" : p.endsWith(".css") ? "text/css"
        : p.endsWith(".svg") ? "image/svg+xml" : p.endsWith(".png") ? "image/png"
        : p.endsWith(".webp") ? "image/webp" : "text/html";
      res.writeHead(200, { "content-type": t });
      return res.end(fs.readFileSync(f));
    }
    res.writeHead(404); res.end("{}");
  }).listen(port);
}

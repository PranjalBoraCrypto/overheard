/**
 * The Export button, and the endpoint behind it.
 *
 * WHAT THIS IS GUARDING. The stream on rooms.html shows the newest 200
 * messages with no signatures on them, because that is all a live read
 * carries. The export is the other thing: the room's whole history from
 * seq 1, each line signed by whoever wrote it. The two failures worth having
 * a test for are (1) the bytes getting reparsed on the way through, which
 * would reorder keys and renumber nonces and quietly invalidate every
 * signature in the file while it still looked like a file, and (2) a failed
 * export navigating the tab to a JSON error and losing the room.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import handler from "../api/export.js";

const NDJSON = '{"seq":1,"ts":"2026-09-12T00:00:00Z","from":"did:key:z6Mk","text":"hi","sig":"a"}\n{"seq":2,"text":"two"}\n';
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

/* ── A. the endpoint ── */
console.log("A. /api/export");
{
  const r = await handler(new Request("https://x/api/export?room=../etc"));
  ok(r.status === 400, "rejects a room name that is not a room name");
  const r2 = await handler(new Request("https://x/api/export?room="));
  ok(r2.status === 400, "rejects an empty room");
}
{
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => {
    ok(String(u) === "https://technocore.chat/r/d-sonnet-2-team-alister/export",
       "asks technocore for the export route, one spelling");
    return new Response(NDJSON, { status: 200 });
  };
  const r = await handler(new Request("https://x/api/export?room=d-sonnet-2-team-alister"));
  ok(r.status === 200, "passes a good export through");
  const cd = r.headers.get("content-disposition") ?? "";
  ok(cd.startsWith("attachment; filename=\"d-sonnet-2-team-alister-"), "downloads rather than renders: " + cd);
  ok(r.headers.get("x-content-type-options") === "nosniff", "nosniff");
  ok((r.headers.get("content-type") ?? "").startsWith("application/x-ndjson"), "ndjson content type");
  const body = await r.text();
  ok(body === NDJSON, "BYTE FOR BYTE — nothing reparsed, so signatures still verify");

  for (const [code, want] of [[429, 429], [404, 404], [500, 502]]) {
    globalThis.fetch = async () => new Response("nope", { status: code });
    const rr = await handler(new Request("https://x/api/export?room=lobby"));
    ok(rr.status === want, `upstream ${code} becomes ${want}`);
    ok(rr.headers.get("cache-control") === "no-store", `  and a ${code} is never cached`);
    ok(!rr.headers.get("content-disposition"), `  and a ${code} is not offered as a file`);
  }
  globalThis.fetch = async () => { throw new Error("down"); };
  const rd = await handler(new Request("https://x/api/export?room=lobby"));
  ok(rd.status === 502, "technocore unreachable becomes 502");
  globalThis.fetch = real;
}

/* ── B. the button ── */
console.log("B. the Export button in rooms.html");
const html = readFileSync(new URL("../web/rooms.html", import.meta.url), "utf8");
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage();
let asked = null, mode = "good";
await page.route("**/api/room**", (r) =>
  r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ room: "lobby", source: "live", retrieved_at: new Date().toISOString(),
                           age_seconds: 0, first_seq: "1", last_seq: "1", count: 0, messages: [] }) }));
await page.route("**/api/export**", (r) => {
  asked = r.request().url();
  if (mode === "good")
    return r.fulfill({ status: 200, contentType: "application/x-ndjson",
                       headers: { "content-disposition": 'attachment; filename="lobby.ndjson"' }, body: NDJSON });
  if (mode === "empty") return r.fulfill({ status: 200, contentType: "application/x-ndjson", body: "" });
  return r.fulfill({ status: 429, contentType: "application/json",
                     body: JSON.stringify({ error: "rate limited upstream" }) });
});
const MIME={".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".json":"application/json",".svg":"image/svg+xml",".png":"image/png",".woff2":"font/woff2"};
await page.route("**/*", (r) => {
  const u = new URL(r.request().url());
  if (u.pathname.startsWith("/api/")) return r.fallback();
  if (u.pathname === "/" || u.pathname.endsWith("rooms.html"))
    return r.fulfill({ status: 200, contentType: "text/html", body: html });
  try{
    const f = readFileSync(new URL("../web" + u.pathname, import.meta.url));
    const ext = u.pathname.slice(u.pathname.lastIndexOf("."));
    return r.fulfill({ status: 200, contentType: MIME[ext] ?? "text/plain", body: f });
  }catch{ return r.fulfill({ status: 404, contentType: "text/plain", body: "" }); }
});
await page.goto("https://overheard.test/rooms.html?room=d-sonnet-2-team-alister");
await page.waitForTimeout(600);

const btn = page.locator("#rexp");
ok(await btn.count() === 1, "the button exists");
ok(await btn.isVisible(), "and is visible");

const dl = page.waitForEvent("download", { timeout: 8000 });
await btn.click();
const got = await dl;
ok(/d-sonnet-2-team-alister-\d{4}-\d{2}-\d{2}\.ndjson/.test(got.suggestedFilename()),
   "a click downloads a dated file named after the room: " + got.suggestedFilename());
ok((asked ?? "").includes("room=d-sonnet-2-team-alister"), "it exported the room being viewed, not the default");
await page.waitForTimeout(300);
ok(/Saved/.test(await page.locator("#m").textContent()), "and says so");
ok(await btn.isEnabled(), "the button comes back");

mode = "bad";
await btn.click();
await page.waitForTimeout(500);
const m = await page.locator("#m").textContent();
ok(/rate limited upstream/.test(m), "a failure lands on THIS page in plain words: " + m);
ok(await page.locator("#m").getAttribute("class") === "msgline err", "  marked as an error");
ok(page.url().includes("rooms.html"), "  and never navigates away");
ok(await btn.isEnabled(), "  and the button is usable again");

mode = "empty";
await btn.click();
await page.waitForTimeout(500);
ok(/no history/.test(await page.locator("#m").textContent()), "an empty room says so rather than saving 0 bytes");

/* no hover animation on touch; bounded on a pointer */
const css = html.slice(html.indexOf(".rexp{"), html.indexOf(".rexp{") + 1400);
ok(/@media \(hover:hover\)\{[\s\S]*\.rexp:hover/.test(css), "the hover state is behind (hover:hover) — phones cannot latch it");
ok(!/[;{]\s*transform\s*:/.test(css), "no transform on the button — nothing for a weak GPU to composite");

await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);

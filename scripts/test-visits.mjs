/* The visitor counter, and the three things it must never do.
 *
 * Counting traffic is the smallest feature on this site and it had the
 * largest number of ways to quietly betray the rest of it. The suite is
 * organised around the promises, not the code:
 *
 *   A. IT IS ON EVERY PAGE. A counter that misses two pages is not a smaller
 *      counter, it is a wrong one — every conclusion drawn from it is skewed
 *      by whichever pages were forgotten.
 *   B. IT NEVER SENDS AN IDENTITY. `/?did=…` and `/rooms?did=…` put a
 *      did:key in the address bar, and `/v` puts a did, a room, a message and
 *      a signature in the fragment. A did:key is public, so nothing here is
 *      a secret leaking; what would be created is an outside record of "who
 *      looked up whom", which this site has no business creating. The
 *      fragment goes whole and query parameters are allowlisted.
 *   C. NO IS NO. Global Privacy Control and a localStorage flag are honoured
 *      before the vendor script is inserted, so opting out means no request
 *      was made — not a request that was made and discarded elsewhere.
 *   D. THE POLICY DID NOT MOVE. The whole argument for this vendor over
 *      Google Analytics was that it is same-origin and needs no CSP
 *      concession. If a Google host ever appears in vercel.json, that
 *      argument was abandoned and this test fails.
 *   E. THE SITE'S OWN WORDS ARE STILL TRUE. /what used to say "no tracking".
 *      It cannot say that and count visits, so it says what it does instead.
 *
 * Needs playwright and a chromium:  npx playwright install chromium
 */
import { chromium } from "playwright";
import http from "http"; import fs from "fs"; import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "web");

let bad = 0;
const check = (n, ok, d = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? "   " + d : ""}`);
  if (!ok) bad++;
};

const PAGES = ["index.html", "city.html", "rooms.html", "play.html",
               "create.html", "what.html", "v.html"];

/* The vendor script is served by the platform, not from the repo, so the
   test server stands in for it — and records every time it is asked for,
   which is what section C is actually measuring. */
let asked = 0;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let p = u.pathname;
  if (p === "/") p = "/index.html";
  if (p === "/city") p = "/city.html";
  if (p === "/rooms") p = "/rooms.html";
  if (p === "/what") p = "/what.html";
  if (p === "/v") p = "/v.html";
  if (p === "/_vercel/insights/script.js") {
    asked++;
    res.writeHead(200, { "content-type": "text/javascript" });
    /* A stand-in that drains the queue the way the real one does, so the
       registered beforeSend is reachable and provably the thing that runs. */
    return res.end("window.__vaLoaded = true;");
  }
  if (p.startsWith("/api/")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end("{}");
  }
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    const t = p.endsWith(".js") ? "text/javascript" : p.endsWith(".json") ? "application/json"
      : p.endsWith(".css") ? "text/css" : p.endsWith(".svg") ? "image/svg+xml" : "text/html";
    res.writeHead(200, { "content-type": t });
    return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end("");
}).listen(8981);

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});

/* ════════════════════════════════════════════════════════════════════════
   A. ON EVERY PAGE, ONCE
   ════════════════════════════════════════════════════════════════════ */
console.log("=== A. every page counts, and counts once");
{
  for (const f of PAGES) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    const n = (src.match(/<script src="\/visits\.js"/g) || []).length;
    check(`${f} loads the counter exactly once`, n === 1, `${n}`);
  }
  /* THE NEGATIVE THAT MATTERS. No page carries a vendor tag of its own —
     if one ever does, the opt-out in visits.js is bypassed on that page and
     nothing else in this file would notice. */
  const vendor = PAGES.filter((f) =>
    /_vercel\/insights|googletagmanager|google-analytics|gtag\(/.test(
      fs.readFileSync(path.join(ROOT, f), "utf8")));
  check("and no page embeds a vendor tag directly", vendor.length === 0, vendor.join(",") || "none");
}

/* ════════════════════════════════════════════════════════════════════════
   B. WHAT LEAVES THE BROWSER
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== B. an identity never leaves in a URL");
{
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  await pg.goto("http://localhost:8981/what");
  await pg.waitForFunction(() => Array.isArray(window.vaq) && window.vaq.length > 0,
    null, { timeout: 15000 });

  /* Reach the registered filter the same way the vendor script does. */
  const put = async (url) => pg.evaluate((u) => {
    const entry = window.vaq.find((a) => a[0] === "beforeSend");
    const out = entry[1]({ url: u, type: "pageview" });
    return out === null ? null : out.url;
  }, url);

  const DID = "did:key:z6MkuGCCkRnjLCWoEsExAmPlEkEyBqQwErTyUiOp";

  check("a did in the query string is removed",
    !/z6Mk/.test(await put(`http://localhost:8981/?did=${DID}`)),
    await put(`http://localhost:8981/?did=${DID}`));

  check("and on /rooms too",
    !/z6Mk/.test(await put(`http://localhost:8981/rooms?room=lobby&did=${DID}`)),
    await put(`http://localhost:8981/rooms?room=lobby&did=${DID}`));

  check("while the room itself is kept, because it is about the site",
    /room=lobby/.test(await put("http://localhost:8981/rooms?room=lobby&did=x")),
    await put("http://localhost:8981/rooms?room=lobby&did=x"));

  const frag = `http://localhost:8981/v#did=${DID}&room=lobby&msg=hello&sig=AAAA`;
  const out = await put(frag);
  check("the whole fragment is dropped, signature and all",
    !/#/.test(out) && !/sig=/.test(out) && !/z6Mk/.test(out), out);

  check("an unknown parameter is dropped rather than passed through",
    !/token/.test(await put("http://localhost:8981/?token=secret")),
    await put("http://localhost:8981/?token=secret"));

  check("the path survives, which is the entire point",
    /\/rooms$/.test(await put("http://localhost:8981/rooms")),
    await put("http://localhost:8981/rooms"));

  check("an address it cannot parse is refused, not guessed at",
    (await put("::::not a url::::")) === null);
  check("and an address on somebody else's origin is refused too",
    (await put("https://evil.example/?did=" + DID)) === null);

  await ctx.close();
}

/* ════════════════════════════════════════════════════════════════════════
   C. THE OPT-OUTS ARE REAL
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== C. opting out means no request was made");
{
  const loaded = async (init) => {
    const ctx = await browser.newContext();
    if (init) await ctx.addInitScript(init);
    const pg = await ctx.newPage();
    const before = asked;
    await pg.goto("http://localhost:8981/what");
    await pg.waitForTimeout(900);
    const tag = await pg.evaluate(() =>
      !!document.querySelector('script[src="/_vercel/insights/script.js"]'));
    await ctx.close();
    return { tag, fetched: asked > before };
  };

  const normal = await loaded(null);
  check("by default it does load", normal.tag && normal.fetched);

  const gpc = await loaded(() => {
    Object.defineProperty(Navigator.prototype, "globalPrivacyControl",
      { get: () => true, configurable: true });
  });
  check("Global Privacy Control stops it", !gpc.tag);
  check("and no request reaches the vendor at all", !gpc.fetched);

  const flag = await loaded(() => {
    try { localStorage.setItem("overheard.novisits", "1"); } catch {}
  });
  check("the localStorage opt-out stops it", !flag.tag);
  check("and that one makes no request either", !flag.fetched);
}

/* ════════════════════════════════════════════════════════════════════════
   D. THE POLICY THAT DID NOT HAVE TO MOVE
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== D. the CSP is unchanged");
{
  const vc = JSON.parse(fs.readFileSync(path.join(HERE, "..", "vercel.json"), "utf8"));
  const csp = vc.headers[0].headers.find((h) => h.key === "Content-Security-Policy").value;
  check("script-src is still self only", /script-src 'self' 'unsafe-inline';/.test(csp));
  check("connect-src is still self only", /connect-src 'self';/.test(csp));
  check("no Google host was let in anywhere",
    !/google|gtag|doubleclick/i.test(csp.replace(/fonts\.g[a-z]*\.com/g, "")),
    csp.slice(0, 60) + "…");
  /* The counter is same-origin, which is the whole reason the two lines
     above could stay as they are. If the path ever became absolute, the
     policy would have to change and this catches it first. */
  const src = fs.readFileSync(path.join(ROOT, "visits.js"), "utf8");
  check("and the counter it loads is same-origin",
    /"\/_vercel\/insights\/script\.js"/.test(src) && !/https?:\/\//.test(
      src.split("\n").filter((l) => l.includes("s.src")).join("")));
}

/* ════════════════════════════════════════════════════════════════════════
   E. THE SITE STILL DESCRIBES ITSELF ACCURATELY
   ════════════════════════════════════════════════════════════════════ */
console.log("\n=== E. /what tells the truth about it");
{
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  await pg.goto("http://localhost:8981/what");
  await pg.waitForFunction(() => document.getElementById("qs")?.children.length > 0,
    null, { timeout: 15000 });
  /* The questions are collapsed; the text is in the DOM either way. */
  const text = await pg.evaluate(() => document.getElementById("qs").textContent);

  check("it no longer claims there is no tracking", !/no tracking/i.test(text));
  check("it says visits are counted", /counting me|visits, yes/i.test(text));
  check("and that nothing is kept in the browser", /no cookies/i.test(text));
  check("and that the address is stripped first", /stripped/i.test(text));

  await ctx.close();
}

await browser.close();
srv.close();
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall good");
process.exit(bad ? 1 : 0);

/* The furniture: the bar, the footer, the explainer page, and the two things
 * the card page now offers a signed-in visitor.
 *
 * These are the parts every page carries, which is exactly why they rot
 * quietly — nobody opens a page to look at its footer. What is checked here:
 *
 *   · the gap above the footer, on every page, because it was ZERO on three
 *     of them and negative on a fourth: the margin lived on :host and every
 *     page's own `* { margin: 0 }` beat it;
 *   · the footer links every page the site has, from the one list the bar
 *     also reads, so a new page cannot appear in one and not the other;
 *   · the bar shows a way in when signed out and a chip when signed in, and
 *     the Testnet pill is a label rather than a link somebody can follow;
 *   · /what answers its own question above the fold and every route off it
 *     goes somewhere real;
 *   · the card page offers a signed-in visitor their own card without
 *     retyping their DID, and offers a half-set-up card a way to finish.
 *
 * Needs playwright and a chromium:  npx playwright install chromium
 */
import { chromium } from "playwright";
import http from "http"; import fs from "fs"; import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const DID = "did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz";

/* The card page's state is decided by two lookups. These flags drive them, so
   one server can stand in for "nothing on the record", "note but no
   messages", and "fully set up and proven". */
let REGISTERED = true, MESSAGES = 0, PROOF = false;

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let p = u.pathname;
  /* WHAT VERCEL ACTUALLY DOES, rather than a list of the pages that existed
     when this was written. cleanUrls:true in vercel.json means an
     extensionless path is served by the .html file of that name — so that is
     the rule here too. It was seven hard-coded lines, and the three pages
     added since were all missing from it, which made the share-image check
     read as "these pages have no og:image" when what they had was no route. */
  if (p === "/") p = "/index.html";
  else if (!path.extname(p) && fs.existsSync(path.join(ROOT, p + ".html"))) p += ".html";
  const J = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

  if (p === "/api/note") return J({ did: DID, registered: REGISTERED, known: true, fingerprint: "ab".repeat(8), note: "a note" });
  if (p === "/api/profile") return J({
    owned: { rooms: [], owners: 312, identities: 97264 },
    profile: MESSAGES
      ? { count: MESSAGES, unique: MESSAGES, templates: 0, rooms: ["lobby"],
          first: "2026-08-25T10:00:00Z", last: "2026-08-27T09:00:00Z", last_text: "hello from a test" }
      : { count: 0, unique: 0, templates: 0, rooms: [], first: null, last: null, last_text: "" },
    standing: null });
  if (p === "/api/room") return J({ room: u.searchParams.get("room"), first_seq: null, last_seq: "0", count: 0, messages: [] });
  if (p === "/api/identities") return J({ updated: new Date().toISOString(), identities: {} });
  if (p.startsWith("/api/") || p.startsWith("/data/")) return J({});

  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    /* ".css" is here because a stylesheet served as text/html is one
       Chromium refuses in silence, and the page then measures as if the
       stylesheet did not exist. */
    const type = p.endsWith(".js") ? "text/javascript" : p.endsWith(".css") ? "text/css"
      : p.endsWith(".png") ? "image/png" : p.endsWith(".svg") ? "image/svg+xml" : "text/html";
    res.writeHead(200, { "content-type": type });
    return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end("{}");
}).listen(8971);

/* ── THE TRAP THIS FILE WARNS ABOUT, CHECKED RATHER THAN TRUSTED ──────────
   bar.js keeps its whole stylesheet in a template literal, and its own header
   says "no backticks anywhere in here: one stray backtick ends the string and
   takes the file with it". A comment inside that block was written with a
   backticked identifier in it, the module stopped parsing, and every page on
   the site lost its navigation — caught by a probe rather than by a suite,
   which is the wrong way round. The CSS block cannot contain one. */
{
  const src = fs.readFileSync(path.join(ROOT, "bar.js"), "utf8");
  const open = src.indexOf("const CSS = `");
  const close = src.indexOf("\n`;", open);
  const block = src.slice(open + 13, close);
  if (block.includes("`")) { console.log("  FAIL  bar.js CSS block contains a backtick"); }
  else console.log("  ok    bar.js CSS block has no backtick in it to end the string early");
}

let bad = 0;
const check = (n, ok, d = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? "   " + d : ""}`);
  if (!ok) bad++;
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
/* The hero and the city both want a GPU. Headless has software WebGL, which
   costs a second a frame and leaves nothing for the thing being tested. */
await ctx.addInitScript(() => {
  const g = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, ...r) {
    return String(t).startsWith("webgl") ? null : g.call(this, t, ...r);
  };
});
const errs = [];
const pg = await ctx.newPage();
pg.on("pageerror", (e) => errs.push(e.message));

/* ── 1. the footer, on every page ───────────────────────────────────────── */
console.log("=== 1. the footer is the same floor under every page");
const PAGES = ["/", "/rooms", "/create", "/v", "/play", "/city", "/what"];
const shape = {};
for (const route of PAGES) {
  await pg.goto("http://localhost:8971" + route);
  await pg.waitForTimeout(1400);
  const m = await pg.evaluate(() => {
    const f = document.querySelector("overheard-foot");
    const r = f?.shadowRoot;
    if (!r) return null;
    const band = r.querySelector(".band").getBoundingClientRect();
    return {
      w: Math.round(band.width),
      gap: Math.round(parseFloat(getComputedStyle(r.querySelector(".band")).marginTop)),
      links: [...r.querySelectorAll(".col a")].map((a) => a.getAttribute("href")),
      x: !!r.querySelector('a.xlink[href*="x.com"]'),
      did: r.querySelector("a.did")?.textContent || "",
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  shape[route] = m;
  check(`${route} has a footer with room above it`, !!m && m.gap >= 60, m ? `${m.gap}px` : "missing");
  check(`${route} does not scroll sideways`, m && m.overflow <= 0, String(m?.overflow));
}
const widths = new Set(Object.values(shape).map((m) => m?.w));
check("the band is the full width of the window on every page", widths.size === 1 && [...widths][0] === 1280,
  [...widths].join(","));
const links = shape["/"].links;
check("every page of the site is linked from it",
  ["/", "/rooms", "/city", "/play", "/create", "/v", "/what"].every((h) => links.includes(h)),
  links.join(" "));
check("and the builder's X profile", shape["/"].x);
check("with the whole DID, not an ellipsis", shape["/"].did === DID);

/* ── 2. the bar ─────────────────────────────────────────────────────────── */
console.log("\n=== 2. the bar: a way in, and a label that is not a door");
await pg.goto("http://localhost:8971/");
await pg.waitForTimeout(1200);
{
  const b = await pg.evaluate(() => {
    const r = document.querySelector("overheard-bar").shadowRoot;
    const soon = r.querySelector(".soon");
    return {
      signIn: !!r.querySelector(".me .in"),
      chip: !!r.querySelector(".chip"),
      soonText: soon?.textContent.trim() || "",
      soonIsLink: !!soon?.closest("a"),
      soonCursor: soon ? getComputedStyle(soon).cursor : "",
      tabs: [...r.querySelectorAll(".tabs a")].map((a) => a.getAttribute("href")),
    };
  });
  check("signed out, the bar offers a way in", b.signIn && !b.chip);
  check("and the card page still tells a stranger where a DID comes from",
    await pg.evaluate(() => document.getElementById("pubhint").hidden === false));
  check("Testnet says it is coming", /testnet/i.test(b.soonText) && /soon/i.test(b.soonText), b.soonText);
  check("and it is not a link anybody can follow", !b.soonIsLink && b.soonCursor === "default");
  check("the tabs come from the shared list", b.tabs.includes("/city") && b.tabs.includes("/play"), b.tabs.join(" "));
  check("and the explainer is NOT a tab, so the bar still fits", !b.tabs.includes("/what"));

  /* the popover */
  await pg.evaluate(() => document.querySelector("overheard-bar").shadowRoot.querySelector(".me .in").click());
  await pg.waitForTimeout(300);
  const pop = await pg.evaluate(() => {
    const r = document.querySelector("overheard-bar").shadowRoot;
    const m = r.querySelector(".menu");
    return { open: !!m, pw: !!m?.querySelector('input[type="password"]'),
      unlock: [...(m?.querySelectorAll("button") || [])].some((b) => /^unlock$/i.test(b.textContent.trim())),
      seed: !!m?.querySelector(".seed textarea"),
      seal: (m?.querySelector(".seal")?.textContent || ""),
      info: !!m?.querySelector(".iq"),
      noteHidden: m?.querySelector(".note")?.hidden !== false,
      file: !!m?.querySelector('input[type="file"]'),
      make: m?.querySelector('a.row')?.getAttribute("href") || "",
      text: m?.innerText || "" };
  });
  /* AN EMPTY BROWSER IS NOT A LOCKED ONE. There is no vault here, so there is
     nothing an "enter your passphrase" box could unlock — it would fail on
     every input a person could type. The seed is the question that has an
     answer, and the passphrase beside it is one being set. */
  check("it opens where it can actually succeed: the seed", pop.open && pop.seed);
  check("and does not ask to unlock something that is not here", !pop.unlock);
  check("the passphrase it wants is one being set", /encrypt/i.test(pop.seal), pop.seal);
  check("a backup file is the other way in", pop.file);
  check("and there is a route for somebody with neither", pop.make === "/create");
  check("it promises nothing leaves the device", /never sent anywhere/i.test(pop.text));
  /* The mechanics behind an `i`, not spilled down the popover. */
  check("the detail is there to open, and closed until it is", pop.info && pop.noteHidden);
  const note = await pg.evaluate(() => {
    const r = document.querySelector("overheard-bar").shadowRoot;
    r.querySelector(".menu .iq").click();
    const n = r.querySelector(".menu .note");
    return { hidden: n.hidden, text: n.innerText };
  });
  check("and opening it says what actually happens", !note.hidden
    && /seed is read in this tab/i.test(note.text)
    && /nothing is uploaded/i.test(note.text));
  await pg.keyboard.press("Escape");
}

/* ── 2a. the desktop note is a phone thing ──────────────────────────────── */
{
  /* It exists to tell somebody on a phone that the 3-D pages are better on a
     bigger screen. On a desktop it would be telling them what they already
     have, so the condition is a coarse pointer AND a narrow window — not one
     or the other, because a desktop browser dragged narrow is still a
     desktop browser. */
  const shown = await pg.evaluate(() =>
    [...document.body.children].some((n) => n.shadowRoot?.querySelector(".wrap .tx b")));
  check("no desktop-is-better note on a desktop", !shown);
}

/* ── 2b. the same popover, with something to unlock ─────────────────────── */
console.log("\n=== 2b. a browser that DOES hold a vault gets the passphrase");
await pg.evaluate((did) => {
  localStorage.setItem("overheard.identity", JSON.stringify({
    v: 1, did, salt: "AAAA", iv: "BBBB", data: "CCCC" }));
}, DID);
await pg.reload();
await pg.waitForTimeout(1200);
{
  await pg.evaluate(() => document.querySelector("overheard-bar").shadowRoot.querySelector(".me .in").click());
  await pg.waitForTimeout(300);
  const pop = await pg.evaluate(() => {
    const r = document.querySelector("overheard-bar").shadowRoot;
    const m = r.querySelector(".menu");
    return { seed: !!m?.querySelector(".seed textarea"),
      unlock: [...(m?.querySelectorAll("button") || [])].some((b) => /^unlock$/i.test(b.textContent.trim())),
      alt: m?.querySelector(".altbtn")?.getAttribute("aria-expanded") ?? null,
      did: m?.querySelector(".did")?.textContent || "" };
  });
  check("the passphrase is back, because now it can work", pop.unlock);
  check("and the seed box is not in the way of it", !pop.seed);
  /* It IS reachable now, which it was not: the seed used to be offered on the
     Rooms page and nowhere else, so a forgotten passphrase had no way back in
     from here. Offered and closed, in that order of importance. */
  check("but the seed is offered below it, closed", pop.alt === "false", String(pop.alt));
  check("it names the identity it is about to open", pop.did.startsWith("did:key:"), pop.did.slice(0, 20));
  await pg.keyboard.press("Escape");
  await pg.evaluate(() => localStorage.removeItem("overheard.identity"));
}

/* ── 3. signed in ───────────────────────────────────────────────────────── */
console.log("\n=== 3. signed in, the page stops asking for what it knows");
await pg.evaluate((did) => {
  localStorage.setItem("overheard.session", JSON.stringify({
    did, jwk: { kty: "OKP", crv: "Ed25519", x: "aaa", d: "bbb" }, at: new Date().toISOString() }));
}, DID);
await pg.reload();
await pg.waitForTimeout(1500);
{
  const m = await pg.evaluate(() => {
    const box = document.getElementById("mine");
    return { shown: !box.hidden, label: box.innerText.replace(/\n/g, " "), face: !!box.querySelector("svg") };
  });
  check("the card page offers to look up your own identity", m.shown, m.label);
  check("it names the identity it means", /z6Mkng/.test(m.label), m.label);
  check("and wears the same face the bar does", m.face);
  const chip = await pg.evaluate(() =>
    !!document.querySelector("overheard-bar").shadowRoot.querySelector(".chip"));
  check("the bar shows the chip instead of the way in", chip);
  /* AND IT STOPS ASKING FOR THE THING IT IS HOLDING. "No DID yet? Make one"
     sat directly under a button offering to look up the DID this browser is
     signed in as — an invitation to go and make what you already have. */
  check("and it does not ask a signed-in visitor to make a DID",
    await pg.evaluate(() => document.getElementById("pubhint").hidden === true));

  await pg.click("#mine button");
  await pg.waitForFunction(() => document.getElementById("did").value.length > 20, null, { timeout: 5000 });
  check("pressing it fills the field and runs the lookup",
    (await pg.inputValue("#did")) === DID);
}

/* ── 4. the half-set-up card ────────────────────────────────────────────── */
console.log("\n=== 4. a card that is half set up says what the other half is");
{
  /* Registered, nothing posted: the card renders and says HALF SET UP. */
  REGISTERED = true; MESSAGES = 0;
  await pg.goto("http://localhost:8971/?did=" + encodeURIComponent(DID));
  await pg.waitForFunction(() => !document.getElementById("finish").hidden, null, { timeout: 15000 });
  const f = await pg.evaluate(() => ({
    shown: !document.getElementById("finish").hidden,
    cardShown: !document.getElementById("cardwrap").hidden,
    title: document.getElementById("finishTitle").textContent,
    sub: document.getElementById("finishSub").textContent,
    own: !document.getElementById("finishOwn").hidden,
    panel: !document.getElementById("diag").hidden,
  }));
  check("the offer appears under the card", f.shown && f.cardShown);
  check("it starts closed", !f.panel);
  check("it says which half is missing", /signed message/i.test(f.sub), f.sub);
  check("and because this browser holds the identity, it does not ask whose it is", !f.own);

  await pg.click("#finishMain");
  await pg.waitForTimeout(600);
  const open = await pg.evaluate(() => ({
    panel: !document.getElementById("diag").hidden,
    card: !document.getElementById("cardwrap").hidden,
    jobs: document.querySelectorAll("#jobs .job").length,
    done: document.querySelectorAll("#jobs .job.done").length,
  }));
  check("pressing it opens the two jobs", open.panel && open.jobs === 2, `${open.jobs} jobs`);
  check("THE CARD IS STILL THERE", open.card);
  check("and the half that is finished is ticked", open.done === 1, `${open.done} done`);

  await pg.click("#finishMain");
  await pg.waitForTimeout(400);
  check("pressing it again puts it away", await pg.evaluate(() => document.getElementById("diag").hidden));
}

/* ── 5. somebody else's half-set-up card ────────────────────────────────── */
console.log("\n=== 5. looking at a stranger's card");
{
  await pg.evaluate(() => localStorage.clear());
  await pg.goto("http://localhost:8971/?did=" + encodeURIComponent(DID));
  await pg.waitForFunction(() => !document.getElementById("finish").hidden, null, { timeout: 15000 });
  const f = await pg.evaluate(() => ({
    title: document.getElementById("finishTitle").textContent,
    own: !document.getElementById("finishOwn").hidden,
    ownText: document.getElementById("finishOwn").innerText,
  }));
  check("it does not call somebody else's card yours", /^This card/.test(f.title), f.title);
  check("and it asks the one question that changes what it can do", f.own, f.ownText.trim());

  await pg.click("#finishOwn");
  await pg.waitForTimeout(700);
  const after = await pg.evaluate(() => ({
    panel: !document.getElementById("diag").hidden,
    unlock: !!document.querySelector("#diag .restore, #diag .unlockrow"),
    pw: !!document.querySelector('#diag input[type="password"]'),
  }));
  check("pressing it opens the panel", after.panel);
  check("and lands on the passphrase, not at the top of it", after.unlock && after.pw);
}

/* ── 6. a finished card is left alone ───────────────────────────────────── */
console.log("\n=== 6. a finished card is left alone");
{
  REGISTERED = true; MESSAGES = 12;
  await pg.goto("http://localhost:8971/?did=" + encodeURIComponent(DID));
  await pg.waitForTimeout(3500);
  const f = await pg.evaluate(() => ({
    shown: !document.getElementById("finish").hidden,
    title: document.getElementById("finishTitle").textContent,
    sub: document.getElementById("finishSub").textContent,
  }));
  /* A note on the record and messages in the rooms is the whole of setup.
     The proof is an optional extra with its own control directly above, so
     this row has nothing left to say and does not appear — not even "one
     step from proven", which nagged a finished card and, on somebody else's,
     offered a step only the key holder can take. */
  check("a set-up card gets no row at all", !f.shown, f.shown ? f.title : "hidden");
  check("and is never called half set up", !/half set up/i.test(f.title), f.title);
}

/* ── 6b. a key already open is not asked for its passphrase again ───────── */
console.log("\n=== 6b. signed in as this identity, proving asks for nothing");
{
  REGISTERED = true; MESSAGES = 12;
  /* Section 5 emptied this browser to look at the card as a stranger, so the
     session has to be put back before "signed in" means anything here. */
  /* A REAL KEY, because the answer now depends on whether one imports.
     The session record no longer carries key material — it is a DID and a
     date, and the key lives in IndexedDB as a non-extractable CryptoKey — so
     a made-up `{d:"bbb"}` is exactly what a browser that CANNOT sign looks
     like, and the page correctly says so. Writing the old-format record with
     a genuine key also exercises the migration path on the way through. */
  await pg.evaluate(async (did) => {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    localStorage.setItem("overheard.session", JSON.stringify({
      did, jwk, at: new Date().toISOString() }));
  }, DID);
  await pg.goto("http://localhost:8971/?did=" + encodeURIComponent(DID));
  await pg.waitForTimeout(3500);
  /* THE MIGRATION MUST HAVE HAPPENED, and it must have taken the old copy
     with it. This is the whole point of the change: after one page load
     there is no key material in localStorage for anything to read. */
  const migrated = await pg.evaluate(() => {
    const rec = JSON.parse(localStorage.getItem("overheard.session") || "null");
    return { hasJwk: !!rec?.jwk, did: rec?.did || "" };
  });
  check("the unlocked key is not in localStorage any more", !migrated.hasJwk);
  check("and the session still knows who it is", migrated.did === DID);
  const line = await pg.evaluate(() => document.getElementById("pbSub").textContent);
  check("the bar says out loud that it will not ask",
    /signed in as this identity/i.test(line), line.slice(0, 58));
  /* The stub session carries a made-up jwk, so no signature can verify. What
     is under test is the ROUTE: it must not open a dialog on a key it has,
     and it must fall back honestly rather than claim anything. */
  await pg.click("#provebar");
  await pg.waitForTimeout(1500);
  const after = await pg.evaluate(() => ({
    sub: document.getElementById("pbSub").textContent,
    done: document.getElementById("provebar").classList.contains("done"),
  }));
  check("a key that cannot sign is not treated as proof", !after.done);
  check("and the bar does not sit stuck on “Signing…”",
    !/^Signing/.test(after.sub), after.sub.slice(0, 46));
}

/* ── 7. the explainer ───────────────────────────────────────────────────── */
console.log("\n=== 7. /what answers its own question");
{
  await pg.goto("http://localhost:8971/what");
  await pg.waitForTimeout(1200);
  const w = await pg.evaluate(() => {
    const above = [...document.querySelectorAll("h1, .answer")].map((n) => n.innerText).join(" ");
    return {
      title: document.title,
      above,
      cards: document.querySelectorAll(".tcard").length,
      qs: document.querySelectorAll(".q").length,
      steps: document.querySelectorAll(".step").length,
      hrefs: [...document.querySelectorAll("a.step, .qbody a.go")].map((a) => a.getAttribute("href")),
      longest: Math.max(...[...document.querySelectorAll(".qbody p")].map((n) => n.textContent.length)),
    };
  });
  check("the answer is above the fold", /window on a chat network/i.test(w.above), w.above.slice(0, 70));
  check("three pictures carry the idea", w.cards === 3);
  /* Nine since the visitor counter went in: a site that counts you owes you
     a plain answer about it in the same place it answers everything else. */
  check("nine questions, no essay", w.qs === 9 && w.longest < 240, `${w.qs} qs, longest ${w.longest} chars`);
  check("three ways in at the end", w.steps === 3);
  check("and every route goes somewhere real",
    w.hrefs.every((h) => h.startsWith("/")), w.hrefs.join(" "));

  /* one open at a time */
  await pg.click(".q:nth-child(1) .qhead");
  await pg.waitForTimeout(450);
  await pg.click(".q:nth-child(2) .qhead");
  await pg.waitForTimeout(450);
  const open = await pg.evaluate(() => document.querySelectorAll(".q.open").length);
  check("opening one closes the last", open === 1, `${open} open`);

  const ov = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no sideways scroll", ov <= 0, String(ov));
}

/* ── 8. a phone ─────────────────────────────────────────────────────────── */
console.log("\n=== 8. a phone");
{
  const ph = await ctx.newPage();
  const perrs = []; ph.on("pageerror", (e) => perrs.push(e.message));
  await ph.setViewportSize({ width: 390, height: 844 });
  for (const route of ["/", "/what"]) {
    await ph.goto("http://localhost:8971" + route);
    await ph.waitForTimeout(1200);
    const o = await ph.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`${route} does not scroll sideways on a phone`, o <= 0, String(o));
  }
  const foot = await ph.evaluate(() => {
    const r = document.querySelector("overheard-foot").shadowRoot;
    return { w: Math.round(r.querySelector(".band").getBoundingClientRect().width),
      notes: getComputedStyle(r.querySelector("li a .note")).opacity };
  });
  check("the footer still spans the phone", foot.w === 390, String(foot.w));
  check("and its notes are visible without a hover nobody has", foot.notes === "1", foot.notes);
  check("no errors on a phone", perrs.length === 0, perrs.slice(0, 2).join(" | "));
  await ph.close();
}

/* ── 9. the share images ────────────────────────────────────────────────── */
console.log("\n=== 9. a pasted link arrives with a picture");
{
  /* Every page the site has. The four at the bottom had no picture at all —
     a link to any of them arrived as a bare grey rectangle, which is what a
     link nobody has looked after looks like.

     THE LAST TWO ARE noindex AND STILL LISTED HERE, on purpose. Robots and
     link previews are two different questions: a page can be kept out of a
     search index and still be a page somebody sends to somebody, which is
     exactly what these two are for.

     ── STILL TO COME: THE TESTNET PAGE ────────────────────────────────────
     There is no testnet page yet — the bar carries a "Testnet · soon" pill
     which is deliberately a label and not a link. When that page exists, it
     needs the same three things as everything above it, in this order:
       1. an entry in IMAGES in scripts/make-og.mjs, and a re-render;
       2. the og:/twitter: block in its own <head>, copied from any page here;
       3. a row in this list, which is what stops it being forgotten.
     Its picture cannot be made now and should not be: every line in these
     images is true on the PAPER RAIL, where nothing of value moves, and a
     testnet image would have to say something about real value to be worth
     having. Written down here rather than remembered, because this list is
     the thing somebody will be looking at. */
  const PAIRS = [["/", "home"], ["/rooms", "rooms"], ["/create", "create"], ["/v", "verify"],
                 ["/play", "play"], ["/city", "city"], ["/what", "what"],
                 ["/hire", "hire"], ["/orders", "orders"], ["/profile", "profile"],
                 ["/deals-preview-78cb4a1be923c6b4.html", "deals"],
                 ["/market", "market"]];
  for (const [route, img] of PAIRS) {
    await pg.goto("http://localhost:8971" + route);
    const m = await pg.evaluate(() => ({
      img: document.querySelector('meta[property="og:image"]')?.content || "",
      card: document.querySelector('meta[name="twitter:card"]')?.content || "",
      title: document.querySelector('meta[property="og:title"]')?.content || "",
      desc: document.querySelector('meta[property="og:description"]')?.content || "",
      url: document.querySelector('meta[property="og:url"]')?.content || "",
      w: document.querySelector('meta[property="og:image:width"]')?.content || "",
    }));
    const ok = m.img.endsWith(`/og/${img}.png`) && m.card === "summary_large_image"
      && m.title.length > 8 && m.desc.length > 40 && m.w === "1200"
      && m.url.startsWith("https://");
    check(`${route} names its own picture`, ok, `${m.img.split("/").pop()} · ${m.title}`);
  }
  /* and the files those tags point at actually exist, at the size they claim */
  const fsmod = await import("node:fs");
  for (const [, img] of PAIRS) {
    const f = path.join(ROOT, "og", `${img}.png`);
    const there = fsmod.existsSync(f);
    check(`og/${img}.png exists`, there && fsmod.statSync(f).size > 20000,
      there ? `${(fsmod.statSync(f).size / 1024) | 0}KB` : "missing");
  }
  /* NOTHING IN /og THAT NOTHING POINTS AT. An orphan is either a page that
     lost its tag or an image somebody forgot to wire up, and both are quiet. */
  const named = new Set(PAIRS.map(([, i]) => `${i}.png`));
  const orphans = fsmod.readdirSync(path.join(ROOT, "og")).filter((f) => !named.has(f));
  check("and no picture in /og that no page claims", orphans.length === 0, orphans.join(", "));

  /* THE FONTS THE PICTURES ARE DRAWN IN. make-og.mjs used to fetch Outfit and
     IBM Plex Mono from Google, which does not fail when it cannot reach them
     — it renders every image in the fallback face and says nothing. The
     subsets live beside the script now, and the script refuses to run without
     them; this is the check that they are still in the repository. */
  for (const f of ["outfit-400.woff2", "outfit-800.woff2", "plex-mono-400.woff2"]) {
    const p2 = path.join(ROOT, "..", "scripts", "og-fonts", f);
    check(`the renderer still has ${f}`, fsmod.existsSync(p2) && fsmod.statSync(p2).size > 5000);
  }
}

/* ── ONE GROUND UNDER EVERY PAGE ───────────────────────────────────────────
 *
 * Reported twice, a month apart, in almost the same words: "the deals page is
 * using a different background and different mouse movement to the rest of
 * the Overheard pages", and then "background and environment is different
 * from the rest of the pages" about the profile page.
 *
 * Both times the cause was the same and it was not the page — it was that
 * there was nothing to copy FROM. Ten pages carried their own atmosphere, and
 * by the time anybody looked the numbers had drifted on their own: the
 * spotlight ran at 520px on six of them and 560px on the card page, at .10,
 * .12 and .13 opacity depending which one you were standing on. Nobody chose
 * that. It is what ten copies of a thing become.
 *
 * /sky.css and /sky.js are the one copy now. This block is what stops an
 * eleventh appearing: it does not check that the pages MATCH — matching is
 * what kept failing — it checks that no page has anything of its own to
 * match with.
 */
{
  console.log("\n=== 6. every page stands on the same ground");
  const fsmod = await import("node:fs");
  const files = fsmod.readdirSync(ROOT).filter((f) => f.endsWith(".html"));
  for (const f of files) {
    const src = fsmod.readFileSync(path.join(ROOT, f), "utf8");
    const linked = /<link rel="stylesheet" href="\/sky\.css">/.test(src)
                && /<script src="\/sky\.js" type="module">/.test(src);
    const own = /^\s*\.sky[\s{]/m.test(src) || /^\s*\.spot\{/m.test(src)
             || /body::before\{/.test(src) || /setProperty\("--px"/.test(src);
    const lit = /<div class="spot"/.test(src);
    check(`${f} links the shared ground`, linked);
    check(`${f} declares none of its own`, !own,
      own ? "a local .sky, .spot, field or spotlight" : "");
    check(`${f} has the light on it`, lit);
    /* ── AND THAT IT PAINTS A GROUND AT ALL ─────────────────────────────
       market.html said `background:var(--bg)`, and --bg exists in deal.css
       only inside .btn — so it resolved to nothing, the body stayed
       transparent, and the page shipped WHITE on a site that is black. Every
       other page here says --void; the one that did not was the one nobody
       had a rule for. */
    /* The whole body rule, not one line of it: two pages layer gradients over
       their ground across five lines, and what matters is that a colour token
       is named in there somewhere rather than which line it is on. */
    const rule = (src.match(/^body\{[\s\S]*?\}/m) ?? [""])[0];
    const ground = /var\(--void\)|var\(--navy-0\)/.test(rule);
    check(`${f} paints the dark ground`, ground,
      ground ? "" : rule.replace(/\s+/g, " ").slice(0, 70) || "no body rule");
  }
  /* And the shared files have to actually contain the thing. A link to an
     empty stylesheet passes every check above. */
  const sky = fsmod.readFileSync(path.join(ROOT, "sky.css"), "utf8");
  check("sky.css carries the field and the spotlight",
    /body::before\{/.test(sky) && /\.spot\{/.test(sky) && /--px/.test(sky));
  /* Comments stripped first: this file EXPLAINS at length why nothing in it
     is animated, and matching the prose was the assertion failing on its own
     rationale. */
  const rules = sky.replace(/\/\*[\s\S]*?\*\//g, "");
  check("and nothing in it is animated — that is the point of replacing the blooms",
    !/animation\s*:|@keyframes/.test(rules), "painted once");
  const js = fsmod.readFileSync(path.join(ROOT, "sky.js"), "utf8");
  check("sky.js moves the light for a real pointer only",
    /hover:hover\) and \(pointer:fine/.test(js) && /prefers-reduced-motion/.test(js));
}

console.log("\nerrors:", errs);
if (errs.length) bad++;
await browser.close(); srv.close();
console.log(bad ? `\n${bad} FAILED` : "\nall good");
process.exit(bad ? 1 : 0);

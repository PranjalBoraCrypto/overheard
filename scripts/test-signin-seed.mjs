/* The way back in, when the passphrase is the thing that has been forgotten.
 *
 * The popover had three routes for a browser holding a vault — passphrase,
 * backup file, make a new one — and every one of them assumes you still have
 * something. The seed is the one thing every Technocore identity has however
 * it was made, and it was offered on the Rooms page and nowhere else.
 *
 * What is checked here, in rough order of what it would cost to get wrong:
 *
 *   · the passphrase stays the route the popover opens on. The seed is
 *     BELOW it and closed, so the common case is not pushed down the card to
 *     serve the rare one;
 *   · a seed pasted here never leaves the tab: no request carries it, no
 *     autofill or spell check can reach it, and it is cleared after use;
 *   · the encrypted backup lands on the person's own device, and a browser
 *     that refuses the download does not also refuse the sign-in;
 *   · the explanation answers to a finger and a keyboard, not only a mouse,
 *     because a hover-only tip does not exist on a phone;
 *   · none of it overflows a 360px screen, in either state.
 *
 * Needs playwright and a chromium:  npx playwright install chromium
 */
import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "web");
const DID = "did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz";
/* A real 32-byte seed, generated here. Never anybody's. */
const SEED = "9f".repeat(32);

let pass = 0, fail = 0;
const ok = (n, c, note = "") => {
  if (c) { pass++; console.log(`  ok    ${n}${note ? "   " + note : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${note ? "   " + note : ""}`); }
};

/* Every request the page makes, so "the seed is not sent anywhere" is a
   measurement rather than a promise. */
const SEEN = [];
const srv = http.createServer((req, res) => {
  SEEN.push(req.url + " " + (req.method || ""));
  const u = new URL(req.url, "http://x");
  let p = u.pathname;
  if (p === "/") p = "/index.html";
  if (p === "/what") p = "/what.html";
  if (p.startsWith("/api/")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, profile: null, standing: null, owned: { rooms: [] } }));
  }
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    const t = p.endsWith(".js") ? "text/javascript" : p.endsWith(".css") ? "text/css"
      : p.endsWith(".json") ? "application/json"
      : p.endsWith(".svg") ? "image/svg+xml" : "text/html";
    res.writeHead(200, { "content-type": t });
    return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end("");
}).listen(9241);

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium",
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });

const R = () => `document.querySelector("overheard-bar").shadowRoot`;
async function openBar(pg) {
  await pg.evaluate(() => document.querySelector("overheard-bar").shadowRoot.querySelector(".me .in").click());
  /* Long enough for the desktop pop and the phone's sheet to finish moving. */
  await pg.waitForTimeout(450);
}
async function withVault(width = 1280, height = 900, mobile = false) {
  const ctx = await b.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile,
    acceptDownloads: true });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on("pageerror", (e) => errs.push(e.message));
  await pg.goto("http://localhost:9241/");
  await pg.evaluate((did) => localStorage.setItem("overheard.identity", JSON.stringify({
    v: 1, did, salt: "AAAA", iv: "BBBB", data: "CCCC" })), DID);
  await pg.reload();
  await pg.waitForTimeout(900);
  await openBar(pg);
  return { ctx, pg, errs };
}

/* ── A. the passphrase is still the front door ───────────────────────────── */
console.log("\n=== A. what a browser holding a vault opens on");
{
  const { ctx, pg, errs } = await withVault();
  const state = await pg.evaluate(() => {
    const r = document.querySelector("overheard-bar").shadowRoot;
    const m = r.querySelector(".menu");
    const alt = m.querySelector(".altbtn");
    return {
      unlock: [...m.querySelectorAll("button")].some((x) => /^unlock$/i.test(x.textContent.trim())),
      pwFirst: !!m.querySelector(".pw input[type=password]"),
      altThere: !!alt,
      altClosed: alt?.getAttribute("aria-expanded") === "false",
      seedOpen: !!m.querySelector(".seed textarea"),
      order: [...m.children].map((c) => c.className).filter(Boolean),
    };
  });
  ok("the passphrase is still what it opens on", state.unlock && state.pwFirst);
  ok("the seed is offered", state.altThere);
  ok("but closed, so it is not in the way of the common case", state.altClosed && !state.seedOpen);
  ok("and it sits below the passphrase, not above it",
    state.order.indexOf("pw") < state.order.indexOf("alt"), state.order.join(" · "));
  ok("the focused field is the passphrase",
    await pg.evaluate(() => document.querySelector("overheard-bar").shadowRoot.activeElement?.type === "password"));
  ok("no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

/* ── B. the explanation, on every input a person has ─────────────────────── */
console.log("\n=== B. the i, for a mouse, a keyboard and a finger");
{
  const { ctx, pg, errs } = await withVault();
  const tipText = () => pg.evaluate(() => {
    const t = document.querySelector("overheard-bar").shadowRoot.querySelector(".tip");
    return { hidden: t.hidden, text: t.textContent };
  });
  ok("it starts hidden", (await tipText()).hidden);

  await pg.hover("overheard-bar .tipq");
  await pg.waitForTimeout(150);
  ok("hovering opens it", !(await tipText()).hidden);

  await pg.mouse.move(0, 0);
  await pg.waitForTimeout(150);
  ok("and leaving closes it again", (await tipText()).hidden);

  await pg.click("overheard-bar .tipq");
  await pg.waitForTimeout(150);
  const t = await tipText();
  ok("tapping opens it too, which is the only way in on a phone", !t.hidden);

  ok("it says the seed does not leave the tab", /not sent anywhere/i.test(t.text));
  ok("it says the key is worked out on the device", /on your own device/i.test(t.text));
  ok("it says the file is downloaded to them", /downloaded to your phone or computer/i.test(t.text));
  ok("it says there is no account that could hold a key", /no account here/i.test(t.text));
  ok("it is written without jargon",
    !/(AES|PBKDF2|Ed25519|310,000|ciphertext|derivation)/i.test(t.text), "plain words only");
  ok("the info button is a finger-sized target", await pg.evaluate(() => {
    const b = document.querySelector("overheard-bar").shadowRoot
      .querySelector(".tipq").getBoundingClientRect();
    return Math.min(b.width, b.height);
  }) >= 32);
  ok("the control says what it is for", await pg.evaluate(() =>
    /safe/i.test(document.querySelector("overheard-bar").shadowRoot
      .querySelector(".tipq").getAttribute("aria-label") || "")));
  ok("no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

/* ── C. opening the seed ─────────────────────────────────────────────────── */
console.log("\n=== C. what opening it gives you");
{
  const { ctx, pg, errs } = await withVault();
  await pg.click("overheard-bar .altbtn");
  await pg.waitForTimeout(250);
  const s = await pg.evaluate(() => {
    const r = document.querySelector("overheard-bar").shadowRoot;
    const ta = r.querySelector(".seed textarea");
    return {
      open: !!ta,
      expanded: r.querySelector(".altbtn").getAttribute("aria-expanded") === "true",
      spell: ta?.spellcheck, auto: ta?.getAttribute("autocomplete"),
      lp: ta?.getAttribute("data-lpignore"), op: ta?.getAttribute("data-1p-ignore"),
      focused: r.activeElement === ta,
      pwStill: !!r.querySelector(".pw input[type=password]"),
      two: r.querySelectorAll(".two input").length,
    };
  });
  ok("the seed box appears", s.open && s.expanded);
  ok("and it takes the focus, so a paste lands in it", s.focused);
  ok("the passphrase route is still there underneath", s.pwStill);
  ok("it asks for a new passphrase, twice", s.two === 2);
  ok("spell check is off — it would send the seed to a spelling service", s.spell === false);
  ok("autofill is off, and both password managers are told to keep out",
    s.auto === "off" && s.lp === "true" && s.op === "");
  ok("no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

/* ── D. a real seed, all the way through ─────────────────────────────────── */
console.log("\n=== D. pasting one");
{
  const { ctx, pg, errs } = await withVault();
  await pg.click("overheard-bar .altbtn");
  await pg.waitForTimeout(150);
  SEEN.length = 0;
  await pg.fill("overheard-bar .seed textarea", SEED);
  await pg.waitForTimeout(600);
  const shown = await pg.evaluate(() => document.querySelector("overheard-bar").shadowRoot
    .querySelector(".sdid")?.textContent || "");
  ok("the DID appears as soon as the paste can produce one",
    /^did:key:z6Mk/.test(shown), shown.slice(0, 26) + "…");
  ok("which is how somebody knows it is the seed they meant", shown !== DID);

  /* WATCHED RATHER THAN AWAITED. This headless build fires no download event
     even for a plain anchor, so waiting for one would test the sandbox and
     not the page. Instrumenting the two calls the save is made of proves the
     same thing and proves more: we get to read the bytes that would have
     landed on the person's disk. */
  await pg.evaluate(() => {
    window.__saved = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { window.__blob = blob; return orig(blob); };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) window.__saved.push({ name: this.download, inDoc: this.isConnected });
      return click.call(this);
    };
  });
  await pg.fill("overheard-bar .two input:nth-of-type(1)", "correct horse battery");
  await pg.fill("overheard-bar .two input:nth-of-type(2)", "correct horse battery");
  await pg.click("overheard-bar .seal");
  await pg.waitForTimeout(900);

  const saved = await pg.evaluate(() => window.__saved || []);
  ok("the encrypted backup is saved to the device", saved.length === 1, JSON.stringify(saved));
  ok("named the way the create page names one",
    /^overheard-identity-.{8}\.json$/.test(saved[0]?.name || ""), saved[0]?.name || "none");
  ok("and the link was in the document, which is the only way Chrome obeys it",
    saved[0]?.inDoc === true, "a detached anchor silently does nothing");

  const body = await pg.evaluate(() => window.__blob ? window.__blob.text() : "");
  const v = body ? JSON.parse(body) : {};
  ok("the file is the ENCRYPTED vault, not the key", !!(v.did && v.salt && v.iv && v.data));
  ok("the seed is not in it", !body.includes(SEED));
  ok("nor is a raw private key", !/"d"\s*:/.test(body), "a jwk `d` is the private half");

  await pg.waitForTimeout(600);
  ok("it signs in", await pg.evaluate(() => !!localStorage.getItem("overheard.session")));
  ok("the seed field is cleared after use",
    await pg.evaluate(() => {
      const ta = document.querySelector("overheard-bar").shadowRoot.querySelector(".seed textarea");
      return !ta || ta.value === "";
    }));

  /* The measurement the whole feature rests on. */
  const leaked = SEEN.filter((u) => u.includes(SEED) || u.includes(SEED.toUpperCase()));
  ok("no request carried the seed", leaked.length === 0, leaked.join(" | "));
  ok("and the stored vault holds no plaintext key",
    await pg.evaluate((seed) => {
      const raw = localStorage.getItem("overheard.identity") || "";
      return !raw.includes(seed);
    }, SEED));
  ok("no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

/* ── E. a blocked download is not a failed sign-in ───────────────────────── */
console.log("\n=== E. when the download will not go");
{
  const { ctx, pg, errs } = await withVault();
  await pg.click("overheard-bar .altbtn");
  await pg.waitForTimeout(150);
  /* The realistic shape of it: the browser refuses to make the object URL. */
  await pg.evaluate(() => { URL.createObjectURL = () => { throw new Error("blocked"); }; });
  await pg.fill("overheard-bar .seed textarea", "ab".repeat(32));
  await pg.fill("overheard-bar .two input:nth-of-type(1)", "another passphrase");
  await pg.fill("overheard-bar .two input:nth-of-type(2)", "another passphrase");
  await pg.click("overheard-bar .seal");
  await pg.waitForTimeout(900);
  ok("the sign-in still happens, because that is what was asked for",
    await pg.evaluate(() => !!localStorage.getItem("overheard.session")));
  ok("no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

/* ── F. refusals ─────────────────────────────────────────────────────────── */
console.log("\n=== F. what it will not accept");
{
  const { ctx, pg, errs } = await withVault();
  await pg.click("overheard-bar .altbtn");
  await pg.waitForTimeout(150);
  const say = () => pg.evaluate(() => document.querySelector("overheard-bar").shadowRoot
    .querySelector(".say")?.textContent || "");

  await pg.fill("overheard-bar .seed textarea", "nonsense");
  await pg.click("overheard-bar .seal");
  await pg.waitForTimeout(200);
  ok("half a seed is refused, and it says what a seed is", /64 hex/.test(await say()), await say());

  await pg.fill("overheard-bar .seed textarea", SEED);
  await pg.fill("overheard-bar .two input:nth-of-type(1)", "abc");
  await pg.fill("overheard-bar .two input:nth-of-type(2)", "abc");
  await pg.click("overheard-bar .seal");
  await pg.waitForTimeout(200);
  ok("a short passphrase is refused with the number in it", /at least \d/.test(await say()), await say());

  await pg.fill("overheard-bar .two input:nth-of-type(1)", "long enough one");
  await pg.fill("overheard-bar .two input:nth-of-type(2)", "long enough two");
  await pg.click("overheard-bar .seal");
  await pg.waitForTimeout(200);
  ok("two that do not match are refused", /do not match/.test(await say()), await say());
  ok("and none of that signed anybody in",
    await pg.evaluate(() => !localStorage.getItem("overheard.session")));
  /* Where the message appears decides whether it is read. One `say` serves
     both routes, so it has to follow whichever one is open. */
  ok("the message sits under the seed form, not up beside the passphrase",
    await pg.evaluate(() => {
      const r = document.querySelector("overheard-bar").shadowRoot;
      const say = r.querySelector(".say"), seal = r.querySelector(".seal");
      return say.compareDocumentPosition(seal) & Node.DOCUMENT_POSITION_PRECEDING;
    }) > 0);
  await pg.click("overheard-bar .altbtn");
  await pg.waitForTimeout(200);
  ok("and goes back above when the seed is closed again",
    await pg.evaluate(() => {
      const r = document.querySelector("overheard-bar").shadowRoot;
      const say = r.querySelector(".say"), pw = r.querySelector(".pw");
      return pw.compareDocumentPosition(say) & Node.DOCUMENT_POSITION_FOLLOWING;
    }) > 0);
  ok("no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

/* ── G. folded into I ─────────────────────────────────────────────────────
 * This section measured the popover on a phone: does it fit, does nothing
 * break out of the card, are the controls tappable. On a phone there is no
 * popover any more, so "does the dropdown fit" is not a question about this
 * page. What it was really protecting — no sideways scroll, nothing outside
 * the card, targets big enough for a thumb — moved into I, where it is asked
 * of the thing that actually renders.
 */

/* ── I. on a phone it is a sheet, not a shrunken dropdown ────────────────── */
console.log("\n=== I. the phone gets its own object");
{
  const { ctx, pg, errs } = await withVault(390, 780, true);
  const box = () => pg.evaluate(() => {
    const r = document.querySelector("overheard-bar").shadowRoot;
    const m = r.querySelector(".menu");
    const b = m.getBoundingClientRect();
    const cs = getComputedStyle(m);
    return { left: Math.round(b.left), right: Math.round(b.right), bottom: Math.round(b.bottom),
      pos: cs.position, radius: cs.borderTopLeftRadius + "/" + cs.borderBottomLeftRadius,
      vw: window.innerWidth, vh: window.innerHeight };
  });
  const b = await box();
  ok("it is pinned to the viewport, not hung off the button", b.pos === "fixed", b.pos);
  ok("it spans the full width", b.left <= 1 && b.right >= b.vw - 1, `${b.left}..${b.right} of ${b.vw}`);
  ok("and sits on the bottom edge, where a thumb is",
    Math.abs(b.bottom - b.vh) <= 1, `bottom ${b.bottom} vs ${b.vh}`);
  ok("rounded at the top only, so it reads as having come from below",
    b.radius.startsWith("22px") && b.radius.endsWith("0px"), b.radius);
  ok("there is a grab handle", await pg.evaluate(() => {
    const m = document.querySelector("overheard-bar").shadowRoot.querySelector(".menu");
    return getComputedStyle(m, "::after").content !== "none";
  }));
  ok("the page behind is dimmed", await pg.evaluate(() => {
    const m = document.querySelector("overheard-bar").shadowRoot.querySelector(".menu");
    const cs = getComputedStyle(m, "::before");
    return cs.position === "fixed" && /rgba?\(/.test(cs.backgroundColor);
  }));
  /* The dimmed area must not swallow the tap that closes it: the scrim is a
     child of .menu, and the click-away handler treats anything inside .me as
     a tap on the menu itself. */
  ok("but the dimmed area lets a tap through, so tapping away still closes",
    await pg.evaluate(() => {
      const m = document.querySelector("overheard-bar").shadowRoot.querySelector(".menu");
      return getComputedStyle(m, "::before").pointerEvents === "none";
    }));
  await pg.mouse.click(20, 60);
  await pg.waitForTimeout(250);
  ok("and it does close", await pg.evaluate(() =>
    !document.querySelector("overheard-bar").shadowRoot.querySelector(".menu")));

  /* Typing into a phone form means a 16px field, or iOS zooms the page. */
  await openBar(pg);
  /* The sheet rises over 300ms; clicking mid-animation is clicking a moving
     target and Playwright rightly refuses. */
  await pg.waitForTimeout(500);
  await pg.click("overheard-bar .altbtn");
  await pg.waitForTimeout(400);
  const fonts = await pg.evaluate(() => {
    const r = document.querySelector("overheard-bar").shadowRoot;
    return [...r.querySelectorAll(".pw input, .two input")]
      .map((i) => parseFloat(getComputedStyle(i).fontSize));
  });
  ok("every field is at least 16px, so iOS does not zoom on focus",
    fonts.length > 0 && fonts.every((f) => f >= 16), fonts.join(","));
  const after = await box();
  ok("opened, it is still inside the screen", after.left >= -1 && after.right <= after.vw + 1);

  /* What the old popover section was really protecting, asked of the sheet. */
  const fit = await pg.evaluate(() => {
    const r = document.querySelector("overheard-bar").shadowRoot;
    const m = r.querySelector(".menu").getBoundingClientRect();
    const inside = (el) => { const b = el.getBoundingClientRect(); return b.left >= m.left - 1 && b.right <= m.right + 1; };
    return {
      ta: inside(r.querySelector(".seed textarea")),
      two: [...r.querySelectorAll(".two input")].every(inside),
      seal: inside(r.querySelector(".seal")),
      tap: Math.min(r.querySelector(".altbtn").getBoundingClientRect().height,
                    r.querySelector(".tipq").getBoundingClientRect().height),
      scroll: document.documentElement.scrollWidth, vw: window.innerWidth,
    };
  });
  ok("nothing breaks out of the sheet", fit.ta && fit.two && fit.seal, JSON.stringify(fit));
  ok("the controls are big enough to hit", fit.tap >= 32, fit.tap + "px");
  ok("and the page never scrolls sideways", fit.scroll <= fit.vw + 1, `${fit.scroll} vs ${fit.vw}`);
  ok("no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

/* ── J. the laptop keeps the dropdown ────────────────────────────────────── */
console.log("\n=== J. and the desktop is left alone");
{
  const { ctx, pg, errs } = await withVault(1280, 900, false);
  const b = await pg.evaluate(() => {
    const m = document.querySelector("overheard-bar").shadowRoot.querySelector(".menu");
    const r = m.getBoundingClientRect();
    return { pos: getComputedStyle(m).position, w: Math.round(r.width),
      top: Math.round(r.top), vh: window.innerHeight };
  });
  ok("still hangs off the button it came from", b.pos === "absolute", b.pos);
  ok("still a card, not the width of the screen", b.w <= 400, b.w + "px");
  ok("and near the top, where the button is", b.top < b.vh / 2, `top ${b.top}`);
  ok("no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

/* ── H. the one behaviour that must not have changed ─────────────────────── */
console.log("\n=== H. a browser holding nothing still opens on the seed");
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on("pageerror", (e) => errs.push(e.message));
  await pg.goto("http://localhost:9241/");
  await pg.waitForTimeout(800);
  await openBar(pg);
  const s = await pg.evaluate(() => {
    const r = document.querySelector("overheard-bar").shadowRoot;
    const m = r.querySelector(".menu");
    return { seed: !!m.querySelector(".seed textarea"),
             two: m.querySelectorAll(".two input").length,
             seal: !!m.querySelector(".seal"),
             alt: !!m.querySelector(".altbtn"),
             focused: r.activeElement === m.querySelector(".seed textarea") };
  });
  ok("it opens straight on the seed, as it always did", s.seed && s.two === 2 && s.seal);
  ok("with no 'use your seed instead' row, because it is already there", !s.alt);
  ok("and the seed box is focused", s.focused);
  ok("no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

await b.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

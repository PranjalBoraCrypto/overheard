/* Shots of the rebuilt "What it proves" section and the footer credit, plus
   the checks that matter: the icons actually draw in, nothing overflows on a
   phone, and the whole DID is present rather than trimmed. */
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';

// Needs playwright and a chromium:  npx playwright install chromium
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const DID = "did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz";

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname; if (p === '/') p = '/index.html';
  const J = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (p === '/api/note') return J({ did: DID, registered: true, known: true, fingerprint: 'ab'.repeat(8), note: 'a note' });
  if (p === '/api/profile') return J({ owned: { rooms: [], owners: 312, identities: 97264 },
    profile: { count: 12, unique: 12, templates: 0, rooms: ['ca-floppy'], first: '2026-08-25T10:00:00Z', last: '2026-08-27T09:00:00Z', last_text: 'look again' }, standing: null });
  if (p === '/api/identities') return J({ identities: {} });
  if (p.startsWith('/api/') || p.startsWith('/data/')) return J({});
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(fs.readFileSync(f)); }
  else { res.writeHead(404); res.end('{}'); }
}).listen(8991);


/* The hero agent is a raymarcher. Headless Chromium renders it in software,
   where one frame costs about a second and the page has no main thread left
   for anything this file is actually testing. WebGL is switched off for these
   pages so the hero falls back to its flat drawing and the page behaves like
   one on a machine with a GPU. The hero itself has its own test — this is a
   deliberate split, not a gap. NO_WEBGL */
const killWebGL = (page) => page.addInitScript(() => {
  const g = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(t, ...r){
    return String(t).startsWith('webgl') ? null : g.call(this, t, ...r);
  };
});
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const pg = await b.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 }); await killWebGL(pg);
const errs = []; pg.on('pageerror', e => errs.push(e.message));

let bad = 0;
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${n}${d ? '   ' + d : ''}`); if (!ok) bad++; };

await pg.goto('http://localhost:8991/');
await pg.evaluate(() => document.fonts.ready);

console.log('=== the removed section is gone');
const body = await pg.evaluate(() => document.body.innerText);
check('no "Three seconds, no install"', !/Three seconds, no install/.test(body));
check('and no orphan #how section', await pg.locator('#how').count() === 0);

console.log('\n=== the ledger');
await pg.locator('#truth').scrollIntoViewIfNeeded();
await pg.waitForTimeout(1800);
check('eight claims, four a side', await pg.locator('#truth .claim').count() === 8,
  String(await pg.locator('#truth .claim').count()));
check('both columns revealed', await pg.evaluate(() =>
  [...document.querySelectorAll('#truth .col')].every(c => c.classList.contains('in'))));
const drawn = await pg.evaluate(() => {
  const el = document.querySelector('#truth .cic svg > *');
  return getComputedStyle(el).strokeDashoffset;
});
check('the icons finished drawing themselves in', parseFloat(drawn) < 0.02, `dashoffset ${drawn}`);
const opacity = await pg.evaluate(() => Math.min(...[...document.querySelectorAll('#truth .claim')].map(c => +getComputedStyle(c).opacity)));
check('every claim is fully visible', opacity > 0.99, String(opacity));

console.log('\n=== the two sides are told apart by more than words');
const colors = await pg.evaluate(() => ['yes', 'no'].map(s =>
  getComputedStyle(document.querySelector(`[data-side="${s}"] .cic svg`)).stroke));
console.log('  icon strokes:', colors.join('  |  '));
check('different accents per side', colors[0] !== colors[1]);

console.log('\n=== the footer credit');
/* One footer, in a shadow root, on every page — so it cannot drift the way
   four copies of it did. Read through the root rather than from the page. */
const readFoot = (page) => page.evaluate(() => {
  const r = document.querySelector('overheard-foot')?.shadowRoot;
  if (!r) return null;
  const did = r.querySelector('a.did');
  return { text: r.querySelector('footer').innerText,
           x: !!r.querySelector('a[href="https://x.com/Crypto_Pranjal"]'),
           didHref: did?.getAttribute('href') || '',
           box: (() => { const b = r.querySelector('footer').getBoundingClientRect();
                         return { l: Math.round(b.left), w: Math.round(b.width) }; })() };
});
await pg.locator('overheard-foot').scrollIntoViewIfNeeded(); await pg.waitForTimeout(400);
const F = await readFoot(pg);
check('names the builder', /Built by\s+Pranjal Bora/.test(F.text), JSON.stringify(F.text.slice(0, 120)));
check('links the X profile', F.x);
check('carries the WHOLE did, not an ellipsis', F.text.includes(DID), F.text.includes('…') ? 'trimmed' : 'full');
check('and the did opens its own card', F.didHref === `/?did=${encodeURIComponent(DID)}` || F.didHref === `/?did=${DID}`,
  F.didHref.slice(0, 40));
await pg.locator('#truth').screenshot({ path: '/tmp/truth.png' });
await pg.locator('overheard-foot').screenshot({ path: '/tmp/foot.png' });

console.log('\n=== phone');
const pg2 = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }); await killWebGL(pg2);
pg2.on('pageerror', e => errs.push(e.message));
await pg2.goto('http://localhost:8991/'); await pg2.waitForTimeout(500);
await pg2.locator('#truth').scrollIntoViewIfNeeded(); await pg2.waitForTimeout(1500);
const ov = await pg2.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
check('no horizontal scroll', ov[0] <= ov[1], ov.join('/'));
check('the ledger stacks to one column', await pg2.evaluate(() =>
  getComputedStyle(document.querySelector('.ledger')).gridTemplateColumns.split(' ').length === 1));
await pg2.locator('#truth').screenshot({ path: '/tmp/truth-phone.png' });
await pg2.locator('overheard-foot').scrollIntoViewIfNeeded(); await pg2.waitForTimeout(300);
await pg2.locator('overheard-foot').screenshot({ path: '/tmp/foot-phone.png' });

console.log('\n=== every page, the SAME footer');
/* The point of the component: not merely that each page has a credit, but
   that the credit is laid out identically on a 680px column and an 1180px
   one. Four hand-written copies could never manage that, and did not. */
const geo = { '/index.html': F.box };
for (const url of ['/create.html', '/rooms.html', '/v.html']) {
  await pg.goto('http://localhost:8991' + url); await pg.waitForTimeout(500);
  await pg.locator('overheard-foot').scrollIntoViewIfNeeded(); await pg.waitForTimeout(200);
  const f = await readFoot(pg);
  check(`${url} carries the credit`, !!f && /Pranjal Bora/.test(f.text) && f.text.includes(DID));
  geo[url] = f?.box;
}
const widths = Object.values(geo).map(b => b?.w);
const lefts = Object.values(geo).map(b => b?.l);
check('and every one of them is the same width', new Set(widths).size === 1, JSON.stringify(geo));
check('in the same place', new Set(lefts).size === 1, JSON.stringify(lefts));

/* ── one rule, every page ──────────────────────────────────────────────────
   THE DRIFT THIS EXISTS TO CATCH ACTUALLY HAPPENED. The passphrase floor was
   lowered to 6 on rooms and play and left at 12 on the card and create
   pages, so the same person could be refused a passphrase on one page and
   given it on another — with a different sentence explaining the rule
   depending on where they were standing. Nobody noticed for a while, because
   each page is right about itself.

   Read from the source rather than from a rendered page on purpose: the
   failure mode is a NUMBER WRITTEN TWICE, and the only way to catch that is
   to look at every place it is written. */
console.log('\n=== the passphrase floor is one number everywhere');
{
  const PAGES = ['index.html', 'create.html', 'rooms.html', 'play.html'];
  const mins = {};
  let hard = [];
  for (const f of PAGES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const m = /const PW_MIN\s*=\s*(\d+)/.exec(src);
    mins[f] = m ? Number(m[1]) : null;
    /* Any surviving hard-coded length rule, in a check or in a placeholder. */
    for (const re of [/length\s*<\s*(\d+)\)/g, /at least (\d+) characters/g, /(\d+)\+ characters/g]) {
      for (const hit of src.matchAll(re)) {
        if (!/PW_MIN/.test(hit[0])) hard.push(`${f}: ${hit[0].trim()}`);
      }
    }
  }
  check('every page that asks for a passphrase declares the floor',
    PAGES.every((f) => mins[f] != null), JSON.stringify(mins));
  check('and they all declare the SAME floor',
    new Set(Object.values(mins)).size === 1, JSON.stringify(mins));
  check('which is 6', Object.values(mins).every((v) => v === 6), JSON.stringify(mins));
  check('and no page still hard-codes a length of its own',
    hard.length === 0, hard.join(' | '));
}

console.log('\nerrors:', errs);
if (errs.length) bad++;
await b.close(); srv.close();
console.log(bad ? `\n${bad} FAILURE(S)` : '\nall good');
process.exit(bad ? 1 : 0);

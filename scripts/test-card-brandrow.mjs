/* The card now carries the Flop mark. The brief was blunt: "Make sure the
   signed and not signed, both card don't overlap text, elements etc, like the
   previous one. that looks unprofessional."

   So this does not look at a screenshot and nod. It renders every card state,
   samples the brand row of the canvas column by column, and asserts the three
   groups in it — Overheard on the left, the Flop plaque in the middle, the
   status badge on the right — are separated by real runs of empty pixels. An
   overlap shows up as a group count of 2 instead of 3.                     */
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';

// Needs playwright and a chromium:  npx playwright install chromium
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
let REG = true, ARCHIVE = true;

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname; if (p === '/') p = '/index.html';
  const J = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const did = u.searchParams.get('did') || '';
  if (p === '/api/note') return J(REG
    ? { did, registered: true, known: true, fingerprint: 'ab'.repeat(8), path: '/kv/did-7f/8984c465299fd4', note: 'a note' }
    : { did, registered: false, known: true, fingerprint: 'ab'.repeat(8), path: '/kv/did-7f/8984c465299fd4', note: null });
  if (p === '/api/profile') return J(Object.assign({ owned: { rooms: [], owners: 312, claimed: 483, identities: 97264 } }, ARCHIVE
    ? { profile: { count: 40, unique: 40, templates: 0, rooms: ['technocore', 'lobby'], first: '2026-08-20T10:00:00Z', last: '2026-08-27T09:00:00Z', last_text: 'a real archived message' }, standing: null }
    : { profile: null, standing: null }));
  if (p === '/api/identities') return J({ identities: {} });
  if (p.startsWith('/api/') || p.startsWith('/data/')) return J({});
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(fs.readFileSync(f)); }
  else { res.writeHead(404); res.end('{}'); }
}).listen(8994);


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
const bctx = await b.newContext({ viewport: { width: 1240, height: 1000 }, deviceScaleFactor: 2 });
const pg = await bctx.newPage(); await killWebGL(pg); const errs = []; pg.on('pageerror', e => errs.push(e.message));
await pg.goto('http://localhost:8994/');

const ID = await pg.evaluate(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const by = new Uint8Array(34); by[0] = 0xed; by[1] = 0x01; by.set(raw, 2);
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n; for (const x of by) n = n * 256n + BigInt(x);
  let o = ''; while (n > 0n) { o = A[Number(n % 58n)] + o; n /= 58n; }
  return { did: 'did:key:z' + o, jwk: JSON.stringify(jwk) };
});

await pg.evaluate(async ({ did, jwkStr, pass }) => {
  const enc = new TextEncoder();
  const b64u = x => btoa(String.fromCharCode(...new Uint8Array(x))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  const aes = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode(jwkStr));
  localStorage.setItem('overheard.identity', JSON.stringify({ v: 1, did, salt: b64u(salt), iv: b64u(iv), data: b64u(ct) }));
}, { did: ID.did, jwkStr: ID.jwk, pass: 'hunter2' });

const look = async () => {
  await pg.goto('http://localhost:8994/'); await pg.evaluate(() => document.fonts.ready);
  await pg.fill('#did', ID.did); await pg.click('.field button');
  await pg.waitForFunction(() => {
    const d = document.getElementById('diag'), a = document.querySelector('.actions');
    return (d && !d.hidden) || (a && !a.hidden);
  }, null, { timeout: 25000 });
  await pg.waitForTimeout(800);
};

/* Column occupancy across a band of the card, in card pixels — the canvas is
   1200x630 with no scaling, so getImageData reads them directly. "Ink" is
   anything meaningfully brighter than the ground, so the faint wafer grid and
   the plaque's own 3% fill do not read as content. */
const bandsIn = (y0, y1, thresh) => pg.evaluate(([y0, y1, thresh]) => {
  const c = document.getElementById('card'), g = c.getContext('2d');
  const W = c.width, d = g.getImageData(0, y0, W, y1 - y0).data;
  const cols = [];
  for (let x = 0; x < W; x++) {
    let hit = 0;
    for (let y = 0; y < y1 - y0; y++) {
      const i = (y * W + x) * 4;
      if (d[i] + d[i + 1] + d[i + 2] > thresh) { hit = 1; break; }
    }
    cols.push(hit);
  }
  const out = []; let s = -1;
  cols.forEach((v, i) => { if (v && s < 0) s = i; if (!v && s >= 0) { out.push([s, i - 1]); s = -1; } });
  if (s >= 0) out.push([s, cols.length - 1]);
  return out.filter(([a, b]) => b - a >= 1);
}, [y0, y1, thresh]);

let bad = 0;
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${n}${d ? '   ' + d : ''}`); if (!ok) bad++; };

const row = async (label, file) => {
  // The card's own 3px frame runs the full height and is brighter on a proven
  // card, so it clears the threshold at x 0..2 and 1197..1199. It is the
  // border, not content — drop it before grouping.
  const raw = (await bandsIn(24, 78, 190)).filter(([a, e]) => a > 6 && e < 1193);
  const groups = [];
  for (const [a, e] of raw) {
    const last = groups[groups.length - 1];
    if (last && a - last[1] < 20) last[1] = e; else groups.push([a, e]);
  }
  console.log('  brand-row groups:', JSON.stringify(groups));
  check('three separate groups in the brand row', groups.length === 3, `got ${groups.length}`);
  if (groups.length === 3) {
    const g1 = groups[1][0] - groups[0][1], g2 = groups[2][0] - groups[1][1];
    check('the plaque clears "Overheard" by 40px+', g1 >= 40, `${g1}px`);
    check('the plaque clears the status badge by 40px+', g2 >= 40, `${g2}px`);
    const mid = (groups[1][0] + groups[1][1]) / 2;
    check('the plaque is centred on the card', Math.abs(mid - 600) <= 8, `centre ${mid}`);
  }
  // The brief gave a size in the pixels of the rendered card as it is looked
  // at, which is 1.6x the 1200x630 canvas: 440-480 wide, 100-115 tall.
  const box = await pg.evaluate(() => window.__flopBox);
  const S = 1920 / 1200;
  console.log('  plaque box (canvas px):', JSON.stringify(box),
              '-> rendered', Math.round(box[2] * S) + 'x' + Math.round(box[3] * S));
  check('440-480 wide as rendered', box[2] * S >= 435 && box[2] * S <= 485, `${Math.round(box[2] * S)}`);
  check('100-115 tall as rendered', box[3] * S >= 98 && box[3] * S <= 117, `${Math.round(box[3] * S)}`);
  check('the plaque clears the card frame at the top', box[1] >= 10, `top ${box[1]}`);
  check('and stops well above the divider row', box[1] + box[3] <= 96, `bottom ${box[1] + box[3]}`);
  await pg.locator('#card').screenshot({ path: file });
};

console.log('=== VERIFIED (note + messages, unproven)');
REG = true; ARCHIVE = true; await look();
await row('verified', '/home/claude/flop-verified.png');

console.log('\n=== REGISTERED (a note and nothing else — the note-only card)');
REG = true; ARCHIVE = false; await look();
await row('registered', '/home/claude/flop-registered.png');

console.log('\n=== UNREGISTERED (messages, no note)');
REG = false; ARCHIVE = true; await look();
await row('unregistered', '/home/claude/flop-unregistered.png');

console.log('\n=== PROVEN (signed — the state the last overlap was found in)');
REG = true; ARCHIVE = true; await look();
await pg.click('#provebar'); await pg.waitForTimeout(500);
await pg.fill('#ppw', 'hunter2'); await pg.click('#proveGo'); await pg.waitForTimeout(3200);
check('actually proven', (await pg.locator('#provebar').getAttribute('class')).includes('done'));
await pg.waitForTimeout(400);
await row('proven', '/home/claude/flop-proven.png');

console.log('\n=== the mark is punched through, not a filled blob');
const ink = await pg.evaluate(() => {
  const c = document.getElementById('card'), g = c.getContext('2d');
  const d = g.getImageData(500, 30, 200, 44).data;
  let bright = 0, dark = 0;
  for (let i = 0; i < d.length; i += 4) {
    const s = d[i] + d[i + 1] + d[i + 2];
    if (s > 380) bright++; else if (s < 80) dark++;
  }
  return { bright, dark };
});
check('the mark and wordmark have bright ink', ink.bright > 250, JSON.stringify(ink));
check('and holes punched through the middle of it', ink.dark > 150, JSON.stringify(ink));

console.log('\n=== nothing else on the card moved: the plate still clears the key');
const plate = await bandsIn(120, 500, 150);
console.log('  (left column ink rows checked separately by t-note/hero)');

console.log('\n=== phone: the page must still not scroll sideways');
const pg2 = await bctx.newPage(); await killWebGL(pg2); await pg2.setViewportSize({ width: 390, height: 844 });
pg2.on('pageerror', e => errs.push(e.message));
await pg2.goto('http://localhost:8994/'); await pg2.waitForTimeout(300);
await pg2.fill('#did', ID.did); await pg2.click('.field button');
await pg2.waitForSelector('.actions:not([hidden])', { timeout: 25000 }); await pg2.waitForTimeout(500);
const ov = await pg2.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
check('no horizontal scroll on a phone', ov[0] <= ov[1], ov.join('/'));

console.log('\nerrors:', errs);
if (errs.length) bad++;
await b.close(); srv.close();
console.log(bad ? `\n${bad} FAILURE(S)` : '\nall good');
process.exit(bad ? 1 : 0);

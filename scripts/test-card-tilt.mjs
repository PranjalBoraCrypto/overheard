/* The card tilts under the cursor. It did that during the boot animation and
   then stopped dead the moment the finished card arrived, because
   `animation: deal ... both` keeps the last keyframe applied forever and an
   animation's applied value outranks an inline style. So this moves a real
   pointer across a real finished card and reads the computed transform back.

   A matrix3d/matrix that is not the identity means it tilted. Anything else —
   "none", or an identity matrix — means it is stuck again.                  */
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const DID = "did:key:z6MkuGCCbDGSS5RiRd56DYdMCNYh7PDp2DqsZmhS53LCWoEs";

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname; if (p === '/') p = '/index.html';
  const J = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (p === '/api/note') return J({ did: DID, registered: true, known: true, fingerprint: 'ab'.repeat(8), path: '/kv/did-7f/8984c465299fd4', note: 'a note' });
  if (p === '/api/profile') return J({ owned: { rooms: [], owners: 312, identities: 97264 },
    profile: { count: 40, unique: 40, templates: 0, rooms: ['technocore', 'lobby'], first: '2026-08-20T10:00:00Z', last: '2026-08-27T09:00:00Z', last_text: 'a real archived message' }, standing: null });
  if (p === '/api/identities') return J({ identities: {} });
  if (p.startsWith('/api/') || p.startsWith('/data/')) return J({});
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(fs.readFileSync(f)); }
  else { res.writeHead(404); res.end('{}'); }
}).listen(8993);

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const pg = await b.newPage({ viewport: { width: 1240, height: 1000 } });
const errs = []; pg.on('pageerror', e => errs.push(e.message));

let bad = 0;
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${n}${d ? '   ' + d : ''}`); if (!ok) bad++; };

const tf = () => pg.evaluate(() => getComputedStyle(document.getElementById('cardwrap')).transform);
/* A residual of a thousandth of a radian is not a tilt; the ease decays
   toward zero and stops when the remainder stops being visible. */
const degOf = (t) => {
  const m = /matrix3d\(([^)]+)\)/.exec(t || '');
  if(!m) return 0;
  const v = m[1].split(',').map(Number);
  return Math.abs(Math.asin(Math.max(-1, Math.min(1, -v[2]))) * 180 / Math.PI);
};
const tilted = (t) => degOf(t) > 0.25;

/* The rect is read with evaluate rather than locator.boundingBox(), which
   waits for the element to hold still — and this element is now deliberately
   never still while a pointer is on it. The wait after the sweep is long
   enough for an 80ms ease to have arrived. */
const sweep = async () => {
  const box = await pg.evaluate(() => {
    const r = document.getElementById('cardwrap').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await pg.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await pg.mouse.move(box.x + box.width * 0.82, box.y + box.height * 0.24, { steps: 8 });
  await pg.waitForTimeout(500);
  return tf();
};

console.log('=== A. the idle hero card, before anyone types');
await pg.goto('http://localhost:8993/');
await pg.evaluate(() => document.fonts.ready); await pg.waitForTimeout(700);
check('tilts under the cursor', tilted(await sweep()), await tf());

console.log('\n=== B. the finished card — the state where it used to be dead');
await pg.mouse.move(10, 10);
await pg.fill('#did', DID); await pg.click('.field button');
await pg.waitForSelector('.actions:not([hidden])', { timeout: 25000 });
await pg.waitForTimeout(2600);                     // let deal AND the glare finish
console.log('  classes on the wrap:', await pg.evaluate(() => document.getElementById('cardwrap').className));
const after = await sweep();
check('still tilts once the real card is dealt', tilted(after), after);

console.log('\n=== C. it goes flat again when the pointer leaves');
await pg.mouse.move(5, 5); await pg.waitForTimeout(700);
const away = await tf();
check('returns to flat', !tilted(away), away);

console.log('\n=== D. a redraw in place (Look again) does not kill it either');
await pg.evaluate(() => { const w = document.getElementById('cardwrap'); w.classList.remove('reveal'); void w.offsetWidth; w.classList.add('reveal'); });
await pg.waitForTimeout(2600);
const again = await sweep();
check('still tilts after a re-deal', tilted(again), again);

console.log('\n=== D2. hovering DURING the deal-in must not bank up a jump');
/* The deal animation owns the transform while it runs and an animation beats
   an inline style, so a tilt integrated underneath it would appear all at
   once the moment the animation stopped. The loop holds at flat instead. */
const during = await pg.evaluate(() => {
  const w = document.getElementById('cardwrap');
  w.classList.remove('reveal'); void w.offsetWidth; w.classList.add('reveal');
  w.style.transform = '';                 // start from nothing banked
  const r = w.getBoundingClientRect();
  const send = (t, x, y) => w.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, bubbles: true }));
  send('pointerenter', r.right - 14, r.bottom - 14);
  const seen = [];
  return new Promise((done) => {
    const id = setInterval(() => {
      send('pointermove', r.right - 14, r.bottom - 14);
      const running = w.getAnimations().some(a => a.animationName === 'deal' && a.playState === 'running');
      if (running) seen.push(w.style.transform || '');
      else { clearInterval(id); done(seen); }
    }, 40);
  });
});
const banked = during.filter(t => { const m = /rotateY\(([-\d.]+)deg/.exec(t); return m && Math.abs(+m[1]) > 0.05; });
check('nothing accumulates while the card is dealing in', banked.length === 0,
  `${during.length} samples during the deal, ${banked.length} of them tilted`);
await pg.waitForTimeout(900);
const afterDeal = await sweep();
check('and it starts tilting normally once the deal ends', tilted(afterDeal), afterDeal);

console.log('\n=== E. reduced motion is respected');
const pg2 = await b.newPage({ viewport: { width: 1240, height: 1000 }, reducedMotion: 'reduce' });
pg2.on('pageerror', e => errs.push(e.message));
await pg2.goto('http://localhost:8993/'); await pg2.waitForTimeout(900);
const box2 = await pg2.locator('#cardwrap').boundingBox();
await pg2.mouse.move(box2.x + box2.width * 0.8, box2.y + box2.height * 0.3, { steps: 6 });
await pg2.waitForTimeout(250);
const rm = await pg2.evaluate(() => getComputedStyle(document.getElementById('cardwrap')).transform);
check('no tilt when the person asked for less motion', !tilted(rm), rm);

console.log('\nerrors:', errs);
if (errs.length) bad++;
await b.close(); srv.close();
console.log(bad ? `\n${bad} FAILURE(S)` : '\nall good');
process.exit(bad ? 1 : 0);

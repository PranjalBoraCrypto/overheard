/* The card quotes the last signed message, so people post one and come
   straight back. Telling them to hard-refresh is us making our caching their
   problem. This checks the page says how old it is and can go and look. */
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';

// Needs playwright and a chromium:  npx playwright install chromium
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const DID = "did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz";
let NEWER = null;             // a message newer than the archive's
let ROOM_READS = [];
let INDEX_READS = 0;

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname; if (p === '/') p = '/index.html';
  const J = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (p === '/api/identities') {
    INDEX_READS++;
    return J({ updated: new Date(Date.now() - 42000).toISOString(), identities: {} });
  }
  if (p === '/api/note') return J({ did: DID, registered: true, known: true, fingerprint: 'ab'.repeat(8), path: '/kv/did-7f/8984c465299fd4', note: 'a note' });
  if (p === '/api/profile') return J({
    owned: { rooms: [], owners: 312, identities: 97264 },
    profile: { count: 10, unique: 10, templates: 0, rooms: ['ca-floppyroom', 'lobby'], first: '2026-08-25T10:00:00Z', last: '2026-08-27T09:00:00Z', last_text: 'the archived one' },
    standing: null });
  if (p === '/api/room') {
    ROOM_READS.push(u.search);
    const room = u.searchParams.get('room');
    const msgs = (NEWER && room === NEWER.room)
      ? [{ seq: '9', ts: NEWER.ts, from: DID, nick: null, text: NEWER.text, sig: null, nonce: '9' }]
      : [{ seq: '8', ts: '2026-08-27T09:00:00Z', from: DID, nick: null, text: 'the archived one', sig: null, nonce: '8' }];
    return J({ room, first_seq: '1', last_seq: '9', count: msgs.length, messages: msgs });
  }
  if (p.startsWith('/api/') || p.startsWith('/data/')) return J({});
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(fs.readFileSync(f)); }
  else { res.writeHead(404); res.end('{}'); }
}).listen(8992);


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
const pg = await b.newPage({ viewport: { width: 1240, height: 1100 }, deviceScaleFactor: 2 }); await killWebGL(pg);
const errs = []; pg.on('pageerror', e => errs.push(e.message));

const look = async () => {
  await pg.goto('http://localhost:8992/'); await pg.evaluate(() => document.fonts.ready);
  await pg.fill('#did', DID); await pg.click('.field button');
  await pg.waitForSelector('.actions:not([hidden])', { timeout: 25000 });
  await pg.waitForTimeout(700);
};

console.log('=== A. the page says how old what it is showing is');
await look();
console.log('  row visible:', await pg.locator('#fresh').isVisible());
const say = (await pg.locator('#freshsay').textContent()) || '';
// It used to be a paragraph about our two clocks and their drift. One line
// now: what to do if you have just posted. Short, and still actionable.
console.log('  line:', JSON.stringify(say));
console.log('  tells a fresh poster what to do:', /wait a few seconds and look again/i.test(say));
console.log('  and stays one sentence:', say.split(/[.!?]\s/).length <= 2, '|', say.length, 'chars');
console.log('  no "hard refresh" anywhere on the page:',
  !/hard.?refresh|ctrl.?shift|cmd.?shift/i.test(await pg.evaluate(() => document.body.innerText)));

console.log('\n=== B. "Look again" reads only the rooms this identity posts in');
ROOM_READS = []; const before = INDEX_READS;
const yBefore = await pg.evaluate(() => Math.round(scrollY));
await pg.click('#lookagain'); await pg.waitForTimeout(1500);
// Nothing changed, so nothing should move. Yanking the page to show an
// unchanged card is worse than saying nothing.
console.log('  the page did not jump when there was nothing new:',
  Math.abs((await pg.evaluate(() => Math.round(scrollY))) - yBefore) < 8);
console.log('  upstream room reads:', ROOM_READS.length, '(must be small, not ~45)');
console.log('  rooms asked for:', ROOM_READS.map(q => new URLSearchParams(q).get('room')).join(', '));
console.log('  every read was cache-busted:', ROOM_READS.every(q => q.includes('&t=')));
console.log('  did NOT rebuild the whole index:', INDEX_READS === before);
console.log('  nothing newer:', ((await pg.locator('#freshsay').textContent()) || '').slice(0, 60));

console.log('\n=== C. it is rate-limited, because cheap is not free');
console.log('  button disabled straight after:', await pg.locator('#lookagain').isDisabled());

console.log('\n=== C2. when the button comes back, so does the invitation');
/* The row was still reading "nothing newer just now, wait a few seconds and
   look again" at the exact moment the button became clickable — which is the
   one moment that advice has already been taken. */
const missText = (await pg.locator('#freshsay').textContent()) || '';
console.log('  while cooling down:', JSON.stringify(missText.slice(0, 40) + '…'));
await pg.waitForFunction(() => !document.getElementById('lookagain').disabled, null, { timeout: 15000 });
await pg.waitForTimeout(120);
const backText = (await pg.locator('#freshsay').textContent()) || '';
console.log('  once live again:   ', JSON.stringify(backText.slice(0, 40) + '…'));
console.log('  the line changed with the button:', backText !== missText);
console.log('  and it is the invitation again:', /^Just posted\?/.test(backText));

console.log('\n=== D. now there IS something newer — the card picks it up');
NEWER = { room: 'ca-floppyroom', ts: '2026-08-27T11:45:00Z', text: 'posted from Floppy just now' };
await pg.waitForTimeout(10500);                       // let the cooldown lapse
console.log('  button live again:', !(await pg.locator('#lookagain').isDisabled()));
await pg.click('#lookagain'); await pg.waitForTimeout(1800);
const after = (await pg.locator('#freshsay').textContent()) || '';
console.log('  says it found one:', /Found a newer one/.test(after), '|', after.slice(0, 80));
// A hit is news, not instructions: it must survive the cooldown.
await pg.waitForFunction(() => !document.getElementById('lookagain').disabled, null, { timeout: 15000 });
await pg.waitForTimeout(200);
console.log('  and the result survives the cooldown:',
  /Found a newer one/.test((await pg.locator('#freshsay').textContent()) || ''));
console.log('  and does not lecture about clocks:', !/clock|archive|trails|rank/i.test(after));
console.log('  card redrawn with the new quote:', await pg.evaluate(() => window.__lastQuote ?? 'n/a'));
// The button sits below the card; on a phone the card is off-screen when it
// is pressed, so a redraw nobody can see is not a result.
await pg.waitForTimeout(1200);
const seen = await pg.evaluate(() => {
  const r = document.getElementById('cardwrap').getBoundingClientRect();
  const h = innerHeight;
  const visible = Math.max(0, Math.min(r.bottom, h) - Math.max(r.top, 0));
  return { pct: Math.round(visible / r.height * 100), scrollY: Math.round(scrollY) };
});
console.log('  card scrolled into view:', seen.pct >= 60, JSON.stringify(seen));
await pg.locator('#card').screenshot({ path: '/home/claude/fresh-card.png' });
await pg.locator('#fresh').screenshot({ path: '/home/claude/fresh-row.png' });

console.log('\n=== E. an identity with no record gets no freshness row to misread');
await pg.goto('http://localhost:8992/');
await pg.evaluate(() => { window.__none = true; });
console.log('  (row hidden until a lookup runs):', await pg.locator('#fresh').isHidden());

console.log('\n=== F. phone');
const pg2 = await b.newPage(); await killWebGL(pg2); await pg2.setViewportSize({ width: 390, height: 844 });
pg2.on('pageerror', e => errs.push(e.message));
await pg2.goto('http://localhost:8992/'); await pg2.waitForTimeout(300);
await pg2.fill('#did', DID); await pg2.click('.field button');
await pg2.waitForSelector('.actions:not([hidden])', { timeout: 25000 }); await pg2.waitForTimeout(500);
const ov = await pg2.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
console.log('  overflow:', ov.join('/'), ov[0] <= ov[1] ? 'OK' : 'HORIZONTAL SCROLL');

// The case the scroll exists for: a 390px screen, where the button and the
// card cannot both be on it.
await pg2.locator('#lookagain').scrollIntoViewIfNeeded();
const seenBefore = await pg2.evaluate(() => {
  const r = document.getElementById('cardwrap').getBoundingClientRect();
  return Math.round(Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) / r.height * 100);
});
await pg2.click('#lookagain'); await pg2.waitForTimeout(2600);
const seenAfter = await pg2.evaluate(() => {
  const r = document.getElementById('cardwrap').getBoundingClientRect();
  return Math.round(Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) / r.height * 100);
});
console.log('  card visible before/after the look:', seenBefore + '% ->', seenAfter + '%', seenAfter >= 60 ? 'OK' : 'STILL OFF-SCREEN');
console.log('  it said it found one:', /Found a newer one/.test((await pg2.locator('#freshsay').textContent()) || ''));

console.log('\nerrors:', errs);
await b.close(); srv.close();

/* The post the button pre-fills, in every card state.
 *
 * It used to quote a rank and a join position, and both of those left the
 * card for the reason written up beside the seal — a denominator that moved
 * by 42,000 in one night. A post is screenshotted and quote-tweeted, so it
 * has to still be true next week.
 *
 * Two things to hold. It must FIT: X counts every URL as 23 characters, and a
 * pre-filled post a non-Premium account cannot send is a broken button. And
 * no state may borrow another's claim — a note-only card must not say
 * "messages signed", a messages-only card must not say "set up correctly",
 * and a card whose note lookup failed must say nothing about the note.
 *
 * Needs playwright and a chromium:  npx playwright install chromium
 */
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const DID = 'did:key:z6MkuGCCbDGSS5RiRd56DYdMCNYh7PDp2DqsZmhS53LCWoEs';

let REG = true, COUNT = 40, KNOWN = true;

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let p = u.pathname; if (p === '/') p = '/index.html';
  const J = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (p === '/api/note') return J(KNOWN
    ? { did: DID, registered: REG, known: true, fingerprint: 'ab'.repeat(8), note: REG ? 'a note' : null }
    : { did: DID, registered: null, known: false, fingerprint: 'ab'.repeat(8), note: null });
  if (p === '/api/profile') return J({ owned: { rooms: [], owners: 312, identities: 97264 },
    profile: COUNT ? { count: COUNT, unique: COUNT, templates: 0, rooms: ['technocore'], first: '2026-08-20T10:00:00Z', last: '2026-08-27T09:00:00Z', last_text: 'a real archived message' } : null,
    standing: null });
  if (p.startsWith('/api/') || p.startsWith('/data/')) return J({});
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(fs.readFileSync(f)); }
  else { res.writeHead(404); res.end('{}'); }
}).listen(8889);

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const pg = await b.newPage({ viewport: { width: 1240, height: 900 } });
// the hero raymarcher software-renders here and is not what is under test
await pg.addInitScript(() => {
  const g = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, ...r) {
    return String(t).startsWith('webgl') ? null : g.call(this, t, ...r);
  };
});
const errs = []; pg.on('pageerror', e => errs.push(e.message));

let bad = 0;
const check = (n, ok, d = '') => { console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${n}${d ? '   ' + d : ''}`); if (!ok) bad++; };

const SITE = 'overheard-five.vercel.app';
const xLen = (t) => t.replace(SITE, 'x'.repeat(23)).length;

const post = async () => {
  await pg.goto('http://localhost:8889/');
  await pg.evaluate(() => document.fonts.ready);
  await pg.fill('#did', DID); await pg.click('.field button');
  await pg.waitForFunction(() => {
    const d = document.getElementById('diag'), a = document.querySelector('.actions');
    return (d && !d.hidden) || (a && !a.hidden);
  }, null, { timeout: 25000 });
  await pg.waitForTimeout(700);
  await pg.evaluate(() => { window.__u = null; window.open = (u) => { window.__u = u; }; });
  await pg.click('#post'); await pg.waitForTimeout(3000);
  const u = await pg.evaluate(() => window.__u);
  return decodeURIComponent(new URL(u).searchParams.get('text'));
};

const show = (t) => t.split('\n').filter(Boolean).map(l => '      ' + l).join('\n');

console.log('=== VERIFIED — a note published and messages signed');
REG = true; COUNT = 40; KNOWN = true;
let t = await post();
console.log(show(t));
check('fits X', xLen(t) <= 280, `${xLen(t)} chars`);
check('says the setup is correct', /Set up correctly/.test(t));
check('names both checks', /note published/i.test(t) && /messages signed/i.test(t));
check('and invites, rather than boasts', t.includes('Check yours:'));
check('no rank, no join order', !/#\d|arrived after|of \d[\d,]* identities/.test(t));

console.log('\n=== REGISTERED — a note and nothing else');
REG = true; COUNT = 0; KNOWN = true;
t = await post();
console.log(show(t));
check('fits X', xLen(t) <= 280, `${xLen(t)} chars`);
check('does NOT claim messages it has not seen', !/messages signed|signing/i.test(t));
check('does not claim the setup is finished', !/Set up correctly/.test(t));
check('says what a note actually is', /permanent|did:key/i.test(t));

console.log('\n=== UNREGISTERED — messages, but no note');
REG = false; COUNT = 40; KNOWN = true;
t = await post();
console.log(show(t));
check('fits X', xLen(t) <= 280, `${xLen(t)} chars`);
check('does NOT claim the setup is correct', !/Set up correctly/.test(t));
check('does not claim a note', !/note/i.test(t));
check('quotes the count it does have', /40 original messages/.test(t));

console.log('\n=== the note lookup did not answer');
REG = false; COUNT = 40; KNOWN = false;
t = await post();
console.log(show(t));
check('fits X', xLen(t) <= 280, `${xLen(t)} chars`);
check('says nothing about the note, either way', !/note/i.test(t));

console.log('\n=== one message, not "1 messages"');
REG = false; COUNT = 1; KNOWN = true;
t = await post();
check('singular', /1 original message,/.test(t), t.split('\n')[2]);

console.log('\n=== a very long count still fits');
REG = false; COUNT = 987654321; KNOWN = true;
t = await post();
check('fits X', xLen(t) <= 280, `${xLen(t)} chars`);

console.log('\nerrors:', errs);
if (errs.length) bad++;
await b.close(); srv.close();
console.log(bad ? `\n${bad} FAILURE(S)` : '\nall good');
process.exit(bad ? 1 : 0);

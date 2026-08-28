/* The Verify page, as a person meets it.
 *
 * It answers one question — "did they really say it?" — and it used to answer
 * it only for somebody who arrived by clicking a link. Anybody holding one in
 * a chat window had nowhere to put it, and what they got when they did arrive
 * was four rows of cryptography with no sentence in plain English at the top.
 *
 * So this drives the real page: paste a link, get a verdict a person can
 * read, and check that the technical half is still there one click down —
 * plus every way the check can fail, because a verifier that only ever says
 * yes is not a verifier.
 *
 * Needs playwright and a chromium:  npx playwright install chromium
 */
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
import { webcrypto as wc } from 'node:crypto';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname; if (p === '/' || p === '/v') p = p === '/v' ? '/v.html' : '/index.html';
  if (p.startsWith('/api/') || p.startsWith('/data/')) {
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}');
  }
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    res.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : 'text/html' });
    return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end('{}');
}).listen(8905);

/* ── a real proof, made the way the site makes them ───────────────────── */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (bytes) => { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let o = ''; while (n > 0n) { o = B58[Number(n % 58n)] + o; n /= 58n; } return o; };
const b64u = (b) => Buffer.from(b).toString('base64url');

async function proof({ kind = 'msg', room = 'lobby', text = 'A line worth keeping.', tamper = null } = {}) {
  const kp = await wc.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await wc.subtle.exportKey('raw', kp.publicKey));
  const did = 'did:key:z' + b58([0xed, 0x01, ...raw]);
  const nonce = (BigInt(Date.now()) * 1000000n).toString();
  const sig = new Uint8Array(await wc.subtle.sign({ name: 'Ed25519' }, kp.privateKey,
    new TextEncoder().encode(`${room}|${nonce}|${text}`)));
  const bundle = { v: 1, kind, did, room, nonce, sig: b64u(sig), text, ...(tamper || {}) };
  return { did, room, text, nonce, link: `#b=${b64u(Buffer.from(JSON.stringify(bundle)))}` };
}

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const pg = await b.newPage({ viewport: { width: 1100, height: 1000 } });
const errs = []; pg.on('pageerror', e => errs.push(e.message));

let bad = 0;
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${n}${d ? '   ' + d : ''}`); if (!ok) bad++; };
const open = async (hash = '') => {
  await pg.goto('http://localhost:8905/v.html' + hash);
  await pg.waitForTimeout(700);
};

console.log('=== A. arriving with nothing');
await open();
const lede = (await pg.locator('#lede').textContent()) || '';
check('it says what the page is for, without a word of cryptography',
  !/signature|Ed25519|base64|nonce|did:key/i.test(lede), JSON.stringify(lede.slice(0, 90)));
check('and it asks the question a person actually has',
  /really say it|genuine|real/i.test(await pg.locator('#title').textContent()));
check('there is somewhere to put a link', await pg.locator('#pasteIn').isVisible());
check('and it explains itself in three steps', (await pg.locator('.step').count()) === 3);
check('no verdict is shown for a proof nobody has checked', await pg.locator('#verdict').isHidden());

console.log('\n=== B. pasting rubbish');
await pg.fill('#pasteIn', 'hello, is this the right box?');
await pg.click('#checkBtn'); await pg.waitForTimeout(300);
check('it says so in words, and does not pretend to check it',
  /does not look like a proof link/.test(await pg.locator('#pasteSay').textContent()));
check('and still no verdict', await pg.locator('#verdict').isHidden());

console.log('\n=== C. pasting a real one');
const good = await proof({ text: 'Present and signed. The agentic economy is picking up.' });
for (const [what, value] of [
  ['the whole link', 'https://overheard-five.vercel.app/v' + good.link],
  ['just the fragment', good.link],
  ['the payload on its own', good.link.slice(3)],
]) {
  await open();
  await pg.fill('#pasteIn', value);
  await pg.click('#checkBtn');
  await pg.waitForFunction(() => document.getElementById('verdict')?.className.includes('pass'), null, { timeout: 15000 });
  check(`${what} works`, (await pg.locator('#headline').textContent()) === 'This message is real');
}

const detail = (await pg.locator('#detail').textContent()) || '';
console.log('   ', detail.slice(0, 100));
check('the verdict is a sentence, not a spec', /signed these exact words/.test(detail));
check('it names the room and the day', /lobby/.test(detail) && /\d{4}/.test(detail));
check('it quotes what was actually said',
  (await pg.locator('#quote').textContent()).includes('agentic economy is picking up'));
check('and shows the identity in full', (await pg.locator('#didline').textContent()) === good.did);

console.log('\n=== D. what it proves, and what it does not');
const yes = await pg.evaluate(() => [...document.querySelectorAll('#provesYes li')].map(x => x.textContent));
const no = await pg.evaluate(() => [...document.querySelectorAll('#provesNo li')].map(x => x.textContent));
console.log('   ', JSON.stringify({ yes: yes.length, no: no.length }));
check('both sides are shown, side by side', yes.length >= 3 && no.length >= 3);
check('and the limits are the ones that matter',
  no.some(t => /who that person is/i.test(t)) && no.some(t => /true/i.test(t)),
  JSON.stringify(no));

console.log('\n=== E. the cryptography is one click down, not in your face');
check('the steps are collapsed by default',
  await pg.evaluate(() => !document.getElementById('techWrap').open));
check('but they are there', await pg.locator('#techWrap').isVisible());
await pg.click('#techWrap summary'); await pg.waitForTimeout(400);
const steps = await pg.evaluate(() => [...document.querySelectorAll('.check .what')].map(x => x.firstChild.textContent));
console.log('   ', JSON.stringify(steps));
check('all four checks are recorded', steps.length === 4, String(steps.length));
check('and every one of them passed', (await pg.locator('.check.no').count()) === 0);

console.log('\n=== F. the ways it can fail, each said plainly');
const cases = [
  ['a truncated link', '#b=' + good.link.slice(3, 40), /broken/i],
  ['a made-up identity', await proof({ tamper: { did: 'did:key:z6MkNOTAREALKEY' } }).then(p => p.link), /no real identity/i],
  ['a signature of the wrong shape', await proof({ tamper: { sig: 'AAAA' } }).then(p => p.link), /wrong shape/i],
  ['words changed after signing', await proof({ tamper: { text: 'Something else entirely.' } }).then(p => p.link), /not genuine/i],
];
for (const [what, hash, want] of cases) {
  await open(hash);
  await pg.waitForFunction(() => document.getElementById('verdict')?.className.includes('fail'), null, { timeout: 15000 });
  const head = (await pg.locator('#headline').textContent()) || '';
  check(`${what} is refused`, want.test(head), head);
}
/* The one that matters most: altered words must never read as a pass. */
await open(cases[3][1]);
await pg.waitForTimeout(600);
check('a tampered proof is never shown as verified',
  !(await pg.evaluate(() => document.getElementById('verdict').className.includes('pass'))));
check('and it says which step failed', await pg.evaluate(() =>
  [...document.querySelectorAll('.check.no .what')].some(x => /does not match/.test(x.textContent))));
check('with the way back to try another', await pg.locator('#another').isVisible());

console.log('\n=== G. a stale verdict is worse than none');
/* Only the fragment changes when a new link is pasted into the address bar,
   and that does not reload the page. */
await open(good.link);
await pg.waitForFunction(() => document.getElementById('verdict')?.className.includes('pass'), null, { timeout: 15000 });
await pg.evaluate((h) => { location.hash = h; }, cases[3][1].slice(1));
await pg.waitForTimeout(900);
check('changing the link re-runs the check',
  await pg.evaluate(() => document.getElementById('verdict').className.includes('fail')));

console.log('\n=== H. the example it can make for itself');
await open();
await pg.click('#tryDemo');
await pg.waitForFunction(() => /Made one/.test(document.getElementById('pasteSay').textContent), null, { timeout: 15000 });
check('it fills the box with a real link', /#b=/.test(await pg.inputValue('#pasteIn')));
await pg.click('#checkBtn');
await pg.waitForFunction(() => document.getElementById('verdict')?.className.includes('pass'), null, { timeout: 15000 });
check('and that link verifies, because it is a real signature',
  (await pg.locator('#headline').textContent()) === 'This message is real');

console.log('\n=== I. nothing about the proof leaves the browser');
/* The whole claim of the page. The proof rides in the fragment, which is
   never sent — so no request may carry it. */
const sent = [];
pg.on('request', r => sent.push(r.url() + '|' + (r.postData() || '')));
await open(good.link);
await pg.waitForTimeout(1500);
const leaked = sent.filter(u => u.includes(good.link.slice(3, 30)));
check('no request carries the proof', leaked.length === 0, JSON.stringify(leaked.slice(0, 2)));

console.log('\n=== J. phone');
const ph = await b.newPage({ viewport: { width: 390, height: 844 } });
ph.on('pageerror', e => errs.push(e.message));
await ph.goto('http://localhost:8905/v.html' + good.link); await ph.waitForTimeout(1200);
const ov = await ph.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
check('no horizontal scroll', ov[0] <= ov[1], ov.join('/'));
check('the two lists stack rather than squeeze', await ph.evaluate(() =>
  getComputedStyle(document.querySelector('.proves')).gridTemplateColumns.split(' ').length === 1));
await ph.screenshot({ path: '/tmp/v-phone.png', fullPage: true }).catch(() => {});
await ph.close();

await pg.screenshot({ path: '/tmp/v-pass.png', fullPage: true }).catch(() => {});
await open();
await pg.screenshot({ path: '/tmp/v-empty.png', fullPage: true }).catch(() => {});

console.log('\nerrors:', errs);
if (errs.length) bad++;
await b.close(); srv.close();
console.log(bad ? `\n${bad} FAILURE(S)` : '\nall good');
process.exit(bad ? 1 : 0);

/* Proof of Learning, played.
 *
 * A learning game has two ways to fail that a normal page does not. It can
 * TEACH SOMETHING FALSE — worse than teaching nothing, because people repeat
 * it — and it can hand out a score that means nothing, which is what every
 * shareable quiz result on the internet is.
 *
 * So this plays a perfect run and a terrible one, checks the arithmetic of the
 * scoring, checks that a wrong answer still leaves somebody knowing the right
 * one, and checks the signed card: with a key it produces a proof link the
 * Verify page accepts, and without one it says out loud that the picture
 * proves nothing.
 *
 * Needs playwright and a chromium:  npx playwright install chromium
 */
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const srv = http.createServer((req, res) => {
  let p = new URL(req.url, 'http://x').pathname;
  if (p === '/') p = '/index.html';
  if (p === '/play') p = '/play.html';
  if (p === '/v') p = '/v.html';
  if (p.startsWith('/api/') || p.startsWith('/data/')) {
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}');
  }
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    res.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : 'text/html' });
    return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end('{}');
}).listen(8909);

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ viewport: { width: 1100, height: 1000 } });
const pg = await ctx.newPage();
const errs = []; pg.on('pageerror', e => errs.push(e.message));

let bad = 0;
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${n}${d ? '   ' + d : ''}`); if (!ok) bad++; };
const go = async () => { await pg.goto('http://localhost:8909/play'); await pg.waitForTimeout(500); };

/** The answer key, read out of the page's own source rather than duplicated
 *  here — a copy would drift and the test would grade the wrong paper. The
 *  page does not publish the key to the browser, so the grader parses it the
 *  way a marker reads the mark scheme. */
const src = fs.readFileSync(path.join(ROOT, 'play.html'), 'utf8');
const ANSWERS = [...src.matchAll(/\bright:(\d)/g)].map(m => Number(m[1]));
if (ANSWERS.length !== 12) { console.log('  FAIL  the answer key did not parse', ANSWERS.length); process.exit(1); }

const clearLevelCard = async () => {
  if (await pg.locator('.levelup').count()) {
    await pg.click('.levelup');
    await pg.waitForTimeout(200);
  }
};

console.log('=== A. the start');
await go();
check('it opens as a run, not a lecture', /agent/i.test(await pg.locator('h1').textContent()));
check('it says how long it takes', /3 min|three min/i.test(await pg.locator('.facts').textContent()));
/* The project has not launched and its own document says so. A learning page
   that repeats provisional numbers as settled is how a draft becomes a rumour. */
const prov = (await pg.locator('.prov').first().textContent()) || '';
check('it says up front that the numbers are provisional',
  /provisional/i.test(prov) && /0\.1|draft/i.test(prov), prov.slice(0, 70));
check('and links the source it is drawn from',
  (await pg.locator('a[href*="flop.finance/teaser"]').count()) >= 1);
check('nothing is graded before it starts', await pg.locator('#run').isHidden());

console.log('\n=== B. a perfect run');
await pg.click('#begin');
await pg.waitForTimeout(400);
/* Each level is announced before its first gate — the breath between rounds
   that stops twelve questions being a form. It is skippable, which is what
   makes it a flourish rather than a wait. */
check('the level is announced before its first gate', await pg.locator('.levelup').isVisible());
check('and names what is coming', /Boot/.test(await pg.locator('.levelup h3').textContent()));
await pg.click('.levelup'); await pg.waitForTimeout(250);
check('one tap skips it', (await pg.locator('.levelup').count()) === 0);
check('the first gate is on screen', await pg.locator('.opt').first().isVisible());
check('with a clock that shows the speed bonus draining', await pg.locator('.clock').isVisible());

/* A game is played with hands on the keyboard, and the letter is printed on
   every answer so the shortcut is discoverable rather than a secret. */
await pg.keyboard.press(String(ANSWERS[0] + 1));
await pg.waitForSelector('.after', { timeout: 8000 });
check('the number keys answer', /Right/.test(await pg.locator('.after .head').textContent()));
await pg.keyboard.press('Enter');
await pg.waitForTimeout(350);
await clearLevelCard();
check('and Enter moves on', (await pg.locator('#gateNo').textContent()) === '2');
/* Back to the top, so the run below starts clean. */
await go(); await pg.click('#begin'); await pg.waitForTimeout(400);

/* Every gate teaches before it asks. That is the whole difference between a
   game and an exam, so it is checked at every single gate rather than once. */
const play = async (pickRight) => {
  const seen = [];
  for (let i = 0; i < 12; i++) {
    await clearLevelCard();
    await pg.waitForSelector('.opt:not([disabled])', { timeout: 10000 });
    const gate = await pg.evaluate(() => ({
      beat: document.querySelector('.beat')?.textContent || '',
      q: document.querySelector('.q')?.textContent || '',
      n: document.getElementById('gateNo').textContent,
      opts: [...document.querySelectorAll('.opt')].map(o => o.textContent),
    }));
    seen.push(gate);
    const right = ANSWERS[i];
    const idx = pickRight ? right : (right + 1) % 4;
    await pg.locator('.opt').nth(idx).click();
    await pg.waitForSelector('.after', { timeout: 10000 });
    await pg.click('#stage .nextrow .go');
    await pg.waitForTimeout(180);
  }
  return seen;
};

const seen = await play(true);
check('twelve gates, and every one of them taught first',
  seen.length === 12 && seen.every(g => g.beat.length > 80),
  `shortest lesson: ${Math.min(...seen.map(g => g.beat.length))} chars`);
check('every gate offers four answers', seen.every(g => g.opts.length === 4));
check('the gate counter walked 1 to 12', seen[0].n === '1' && seen[11].n === '12');

await pg.waitForSelector('#end:not([hidden])', { timeout: 10000 });
const perfect = await pg.evaluate(() => ({
  rank: document.getElementById('endTitle').textContent,
  tally: document.getElementById('tally').textContent,
  ...window.__run,
}));
console.log('   ', JSON.stringify(perfect));
check('twelve out of twelve', perfect.correct === 12, perfect.tally);
check('and the top rank for it', /Foundation/.test(perfect.rank), perfect.rank);
check('knowing the answers is worth more than the clock',
  perfect.score >= 12 * 100, `${perfect.score} points`);
check('nothing is left to look at again', await pg.locator('#missed').isHidden());

console.log('\n=== C. the card');
const card = await pg.evaluate(() => {
  const c = document.getElementById('card');
  const x = c.getContext('2d');
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 240) lit++;
  return { w: c.width, h: c.height, lit };
});
check('it is drawn, not blank', card.lit > 4000, JSON.stringify(card));
check('at a size X will not crop badly', card.w === 1200 && card.h === 630);

/* The card is the artefact somebody posts, so it is checked as one: a hero
   that carries the result, and a look that differs by rank — two people with
   different runs must not get the same picture with a different word in it. */
const shape = await pg.evaluate(() => {
  const c = document.getElementById('card'), x = c.getContext('2d');
  // Average ink over the seal's square, against an equally sized square of
  // background on the same row. A hero is a region, not a pixel.
  // Bright ink per 10,000 pixels — the arc, the notches and the number are
  // bright; the ground beside them is not. A hero is a region, not a pixel.
  const ink = (X, Y, S) => {
    const d = x.getImageData(X, Y, S, S).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 420) n++;
    return Math.round(n / (d.length / 4) * 10000);
  };
  const whole = (() => {
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 420) n++;
    return Math.round(n / (d.length / 4) * 10000);
  })();
  return { seal: ink(742, 125, 352), whole };
});
check('the right-hand third carries a hero, not empty ground',
  shape.seal >= 600 && shape.seal > shape.whole * 2, JSON.stringify(shape));

const skins = await pg.evaluate(() => {
  // Re-draw at each rank and fingerprint the accent, without replaying.
  const c = document.getElementById('card'), x = c.getContext('2d');
  const grab = () => { const d = x.getImageData(1080, 470, 1, 1).data; return `${d[0]},${d[1]},${d[2]}`; };
  const out = [];
  for (const n of [12, 10, 8, 5, 1]) {
    window.__setCorrect(n);
    out.push(grab());
  }
  window.__setCorrect(12);
  return out;
});
console.log('   ', JSON.stringify(skins));
check('and every rank has its own colour', new Set(skins).size === skins.length, JSON.stringify(skins));

/* The ladder has to climb the way people read colour. It ran the other way
   once — green at 8/12, gold at 12 — so a good run looked like a warning and
   a perfect one looked like a different category rather than the best one. */
const ladder = await pg.evaluate(() => {
  const c = document.getElementById('card'), x = c.getContext('2d');
  const arc = () => { const d = x.getImageData(918, 137, 1, 1).data; return [d[0], d[1], d[2]]; };
  const out = {};
  for (const n of [12, 6]) { window.__setCorrect(n); out[n] = arc(); }
  window.__setCorrect(12);
  return out;
});
console.log('   ', JSON.stringify(ladder));
check('a perfect run is the green one', ladder[12][1] > ladder[12][0] + 40 && ladder[12][1] > 150,
  `12/12 rim rgb ${ladder[12]}`);
check('and a middling run is not', ladder[6][1] < ladder[12][1] || ladder[6][0] > ladder[12][0],
  `6/12 rim rgb ${ladder[6]}`);

console.log('\n=== D. an unsigned run says so');
const unsignedNote = (await pg.locator('#signedBox').textContent()) || '';
check('it admits a picture proves nothing',
  /Unsigned/.test(unsignedNote) && /edit a score/i.test(unsignedNote), unsignedNote.slice(0, 60));
check('and offers the way to fix that', (await pg.locator('#signedBox a').count()) === 1);

console.log('\n=== E. a bad run still teaches');
await go();
await pg.click('#begin');
await pg.waitForTimeout(300);
const wrongSeen = [];
for (let i = 0; i < 12; i++) {
  await clearLevelCard();
  await pg.waitForSelector('.opt:not([disabled])', { timeout: 10000 });
  await pg.locator('.opt').nth((ANSWERS[i] + 1) % 4).click();
  await pg.waitForSelector('.after.wrong', { timeout: 10000 });
  wrongSeen.push(await pg.locator('.after').textContent());
  await pg.click('#stage .nextrow .go');
  await pg.waitForTimeout(150);
}
check('every wrong answer is told which one was right',
  wrongSeen.every(t => /The answer is [A-D]:/.test(t)));
check('and told WHY, not just what', wrongSeen.every(t => t.length > 160));
check('with the source named on every gate', wrongSeen.every(t => /source:/.test(t)));

await pg.waitForSelector('#end:not([hidden])', { timeout: 10000 });
const worst = await pg.evaluate(() => ({
  rank: document.getElementById('endTitle').textContent,
  ...window.__run,
  missedShown: document.querySelectorAll('#missed li').length,
}));
console.log('   ', JSON.stringify(worst));
check('zero out of twelve scores zero', worst.correct === 0 && worst.score === 0);
check('the rank does not flatter it', /Freshly booted/.test(worst.rank), worst.rank);
/* The point of the whole thing: a run that went badly must still leave
   somebody knowing more than when they started. */
check('and all twelve come back with their answers', worst.missedShown === 12, String(worst.missedShown));
check('no confetti for a run that went badly', (await pg.locator('canvas.confetti').count()) === 0);

console.log('\n=== F. a signed run makes a checkable claim');
await pg.evaluate(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n; for (const x of [0xed, 0x01, ...raw]) n = n * 256n + BigInt(x);
  let out = ''; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  localStorage.setItem('overheard.session', JSON.stringify({ did: 'did:key:z' + out, jwk }));
});
await go();
await pg.click('#begin');
await pg.waitForTimeout(300);
await play(true);
await pg.waitForSelector('#end:not([hidden])', { timeout: 10000 });
const link = await pg.evaluate(() => document.querySelector('#signedBox a')?.href || '');
check('the card carries a proof link', /\/v#b=/.test(link), link.slice(0, 48) + '…');

/* The claim has to survive the page that checks claims. Anything less and the
   "signed" badge is decoration. */
const vp = await ctx.newPage();
vp.on('pageerror', e => errs.push(e.message));
await vp.goto(link.replace('http://localhost:8909/v', 'http://localhost:8909/v.html'));
await vp.waitForFunction(() => document.getElementById('verdict')?.className.includes('pass'), null, { timeout: 15000 });
check('and the Verify page accepts it',
  (await vp.locator('#headline').textContent()) === 'This message is real');
const quoted = (await vp.locator('#quote').textContent()) || '';
check('quoting the score that was signed', /Proof of Learning: 12\/12/.test(quoted), quoted.slice(0, 60));
check('so it cannot be edited into a better one', /rank Foundation grade/.test(quoted));
await vp.close();

console.log('\n=== G. the share post');
const post = await pg.evaluate(() => {
  let u = null; window.open = (x) => { u = x; };
  document.getElementById('post').click();
  return decodeURIComponent(new URL(u).searchParams.get('text'));
});
console.log(post.split('\n').filter(Boolean).map(l => '    ' + l).join('\n'));
check('it says what was actually done', /12\/12/.test(post) && /Foundation grade/.test(post));
check('and a signed run posts the proof, not a screenshot', /\/v#b=/.test(post));
check('it fits in a post', post.replace(/https?:\/\/\S+/, 'x'.repeat(23)).length <= 280,
  `${post.replace(/https?:\/\/\S+/, 'x'.repeat(23)).length} chars`);

console.log('\n=== H. phone');
const ph = await ctx.newPage(); ph.on('pageerror', e => errs.push(e.message));
await ph.setViewportSize({ width: 390, height: 844 });
await ph.goto('http://localhost:8909/play'); await ph.waitForTimeout(700);
const ov = await ph.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
check('no horizontal scroll', ov[0] <= ov[1], ov.join('/'));
await ph.click('#begin'); await ph.waitForTimeout(500);
check('the answers are thumb-sized', await ph.evaluate(() =>
  [...document.querySelectorAll('.opt')].every(o => o.getBoundingClientRect().height >= 44)));
await ph.screenshot({ path: '/tmp/play-phone.png', fullPage: false }).catch(() => {});
await ph.close();

await pg.screenshot({ path: '/tmp/play-end.png', fullPage: true }).catch(() => {});
await go();
await pg.screenshot({ path: '/tmp/play-start.png', fullPage: true }).catch(() => {});

console.log('\nerrors:', errs);
if (errs.length) bad++;
await b.close(); srv.close();
console.log(bad ? `\n${bad} FAILURE(S)` : '\nall good');
process.exit(bad ? 1 : 0);

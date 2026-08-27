/* The Rooms page: signing in, staying signed in, and opening a room.
 *
 * Five things were reported at once and they share one root — the page knew
 * who you were for exactly as long as you did not touch it:
 *
 *   - the compose box asked for a passphrase with no answer for "I have not
 *     made one", and the only way out was a link to another page
 *   - a refresh threw the unlock away
 *   - nothing anywhere else on the site showed who was signed in
 *   - Enter did not send
 *   - a claim refused by a network-wide cap read like a mistake in the name
 *
 * So this drives the real page against a stub network: unlock, reload, send
 * with Enter, sign out, and both walls a claim can hit.
 *
 * Needs playwright and a chromium:  npx playwright install chromium
 */
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

let POSTS = [];
let CLAIM = { ok: true };            // what /api/post says to a claim
let OWNER = 'free';

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname; if (p === '/' || p === '/rooms') p = '/rooms.html';
  const J = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (p === '/api/post') {
    let body = ''; req.on('data', d => body += d);
    return req.on('end', () => {
      const d = JSON.parse(body || '{}');
      POSTS.push(d);
      if (d.kind === 'claim') return J(CLAIM);
      return J({ ok: true });
    });
  }
  if (p === '/api/room') {
    const room = u.searchParams.get('room') || '';
    return J({ room, first_seq: '1', last_seq: '4', count: 1, messages: [
      { seq: '4', ts: new Date().toISOString(), from: null, nick: 'someone', text: 'a line from a stranger', sig: null, nonce: null },
    ] });
  }
  if (p === '/api/owner') return J({ room: u.searchParams.get('room'), status: OWNER, owner: null });
  if (p === '/data/roster.json') return J({ rooms: [{ room: 'lobby', score: .9 }, { room: 'technocore', score: .8 }] });
  if (p.startsWith('/api/') || p.startsWith('/data/')) return J({});

  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    res.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : 'text/html' });
    return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end('{}');
}).listen(8895);

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const pg = await ctx.newPage();
const errs = []; pg.on('pageerror', e => errs.push(e.message));

let bad = 0;
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${n}${d ? '   ' + d : ''}`); if (!ok) bad++; };
const go = async () => { await pg.goto('http://localhost:8895/rooms.html'); await pg.waitForTimeout(600); };

const PASS = 'a-good-long-passphrase';

console.log('=== A. a browser with nobody in it');
await go();
check('the compose box is locked', await pg.locator('#locked').isVisible());
check('and there is no "no identity yet" button pushing you off the page',
  !(await pg.locator('#locked a[href*="create"]').count()));
check('the way to a passphrase is offered here instead', await pg.locator('#noPass').isVisible());
check('and the reason for having a key at all is its own section', await pg.locator('#idbar').isVisible());
const why = (await pg.locator('#idbar').textContent()) || '';
check('which says what a key buys you, in one line', /signed/i.test(why) && /Create an identity/.test(why));
check('with the create button on the edge of the bar',
  await pg.locator('#idbar a.go[href="/create.html"]').isVisible());

console.log('\n=== B. the pop-up makes one, and then asks for the passphrase');
await pg.click('#noPass');
check('it opens in the middle of the screen', await pg.locator('#scrim').isVisible());
check('on the "make a new one" side', (await pg.locator('#tabNew').getAttribute('class')).includes('on'));
check('and the other way in is one tab away', await pg.locator('#tabHave').isVisible());

await pg.fill('#np1', 'short');
await pg.click('#doNew');
await pg.waitForTimeout(200);
check('a weak passphrase is refused before any key is made',
  /at least 12/.test(await pg.locator('#newSay').textContent()));

await pg.fill('#np1', PASS); await pg.fill('#np2', PASS + 'x');
await pg.click('#doNew'); await pg.waitForTimeout(200);
check('and a mistyped one is caught too', /do not match/.test(await pg.locator('#newSay').textContent()));

await pg.fill('#np2', PASS);
const dl = pg.waitForEvent('download').catch(() => null);
await pg.click('#doNew');
await pg.waitForFunction(() => document.getElementById('scrim').hidden, null, { timeout: 15000 });
const file = await dl;
check('the backup file comes out with it', !!file, file ? file.suggestedFilename() : 'no download');
check('the pop-up closes once the passphrase is set', await pg.locator('#scrim').isHidden());
/* Asked for explicitly: you type the passphrase once, straight away, on the
   box that will ask for it every time. There is no reset. */
check('and it asks you to use the passphrase you just chose',
  /Enter the passphrase you just chose/.test(await pg.locator('#lockWho').textContent()));
check('nobody is signed in yet', await pg.evaluate(() => !localStorage.getItem('overheard.session')));
check('but the identity is stored', await pg.evaluate(() => !!localStorage.getItem('overheard.identity')));

console.log('\n=== C. Enter unlocks');
await pg.fill('#pw', PASS);
await pg.press('#pw', 'Enter');
await pg.waitForFunction(() => !document.getElementById('open').hidden, null, { timeout: 15000 });
check('the compose box opens', await pg.locator('#open').isVisible());
check('and the invitation to make one is gone', await pg.locator('#idbar').isHidden());
const meLine = (await pg.locator('#me').textContent()) || '';
check('it names who is posting', /Posting as/.test(meLine), meLine.trim().slice(0, 46));
check('with the face from the card beside it', await pg.locator('#me svg.face').isVisible());
check('and a sign out that is not shouting', await pg.locator('#me #signout').isVisible());

console.log('\n=== D. the bar carries it, on every page');
check('a chip appears in the top bar', await pg.evaluate(() =>
  !document.querySelector('overheard-bar').shadowRoot.querySelector('.me').hidden));
const chipText = await pg.evaluate(() =>
  document.querySelector('overheard-bar').shadowRoot.querySelector('.chip .nm').textContent);
check('showing both ends of the DID', /…/.test(chipText), chipText);
await pg.evaluate(() => document.querySelector('overheard-bar').shadowRoot.querySelector('.chip').click());
await pg.waitForTimeout(300);
const menu = await pg.evaluate(() => {
  const r = document.querySelector('overheard-bar').shadowRoot;
  return { did: r.querySelector('.menu .did')?.textContent || '',
           rows: [...r.querySelectorAll('.menu .row')].map(x => x.textContent.trim()) };
});
check('the menu holds the whole DID', /^did:key:z6Mk/.test(menu.did));
check('with a copy and a sign out', menu.rows.some(r => /Copy/.test(r)) && menu.rows.some(r => /Sign out/.test(r)),
  JSON.stringify(menu.rows));
await pg.keyboard.press('Escape');

console.log('\n=== E. a refresh does not throw it away');
await go();
check('still signed in after a reload', await pg.locator('#open').isVisible());
check('and the passphrase box is not back', await pg.locator('#locked').isHidden());
const pg2 = await ctx.newPage();                    // a second tab, same browser
pg2.on('pageerror', e => errs.push(e.message));
await pg2.goto('http://localhost:8895/rooms.html'); await pg2.waitForTimeout(700);
check('a new tab is signed in too', await pg2.locator('#open').isVisible());
await pg2.close();

console.log('\n=== F. Enter sends');
POSTS = [];
await pg.fill('#say', 'hello from a test');
await pg.press('#say', 'Enter');
await pg.waitForTimeout(900);
check('the message went', POSTS.some(p => p.kind === 'message' && p.text === 'hello from a test'),
  JSON.stringify(POSTS.map(p => p.kind)));
check('and the box emptied', (await pg.inputValue('#say')) === '');
await pg.fill('#say', 'line one');
await pg.press('#say', 'Shift+Enter');
await pg.waitForTimeout(200);
check('Shift+Enter still makes a new line', (await pg.inputValue('#say')).includes('\n'));
await pg.fill('#say', '');

console.log('\n=== G. the room field, and the prefix question');
check('an open room gets no d- prefix', await pg.locator('#rpre').isHidden());
const openHint = (await pg.locator('#ownhint').textContent()) || '';
check('and the page says WHY, rather than leaving it to be noticed',
  /never be|could claim/.test(openHint), openHint.trim().slice(0, 70) + '…');
await pg.click('#kOwned');
await pg.waitForTimeout(150);
check('a claimed room gets it, as furniture', await pg.locator('#rpre').isVisible());
check('and the line changes with the choice', (await pg.locator('#ownhint').textContent()) !== openHint);

console.log('\n=== H. a wall that is not your fault does not read like one');
await pg.fill('#rn', 'my-own-room');
await pg.waitForFunction(() => !document.getElementById('claim').disabled, null, { timeout: 8000 });
CLAIM = { ok: false, status: 400, error: '400 note limit reached (50960 is the cap, and this would be a new one).' };
await pg.click('#claim');
await pg.waitForFunction(() => !document.getElementById('ownCap').hidden, null, { timeout: 8000 });
const cap = (await pg.locator('#ownCap').textContent()) || '';
console.log('   ', cap.replace(/\s+/g, ' ').slice(0, 120), '…');
check('it leads with the plain fact', /run out of space for new rooms/.test(cap));
check('and says it is not about your name', /not about your name/.test(cap));
check('and gives a time to come back', /tomorrow|hour|minute/.test(cap));
check('in a grey notice, not a red error line', (await pg.locator('#ownsay').textContent()).trim() === '');

CLAIM = { ok: false, status: 429, error: 'too many new rooms per day for this ip' };
await pg.fill('#rn', 'another-room');
await pg.waitForFunction(() => !document.getElementById('claim').disabled, null, { timeout: 8000 });
await pg.click('#claim');
await pg.waitForTimeout(900);
const cap2 = (await pg.locator('#ownCap').textContent()) || '';
console.log('   ', cap2.replace(/\s+/g, ' ').slice(0, 110), '…');
check('the daily allowance is told apart from the register being full',
  /today/.test(cap2) && /midnight UTC/.test(cap2));
check('and that one can quote a real time', /Try again in about/.test(cap2));

console.log('\n=== I. signing out');
await pg.click('#me #signout');
await pg.waitForFunction(() => !document.getElementById('locked').hidden, null, { timeout: 8000 });
check('the compose box locks again', await pg.locator('#locked').isVisible());
check('the invitation comes back', await pg.locator('#idbar').isVisible());
check('the bar chip goes with it', await pg.evaluate(() =>
  document.querySelector('overheard-bar').shadowRoot.querySelector('.me').hidden));
check('the session is gone', await pg.evaluate(() => !localStorage.getItem('overheard.session')));
check('but the identity is NOT deleted', await pg.evaluate(() => !!localStorage.getItem('overheard.identity')));
check('and the passphrase brings it straight back', await pg.locator('#pw').isEnabled());

console.log('\n=== J. bringing in an identity that already exists');
const vault = await pg.evaluate(() => localStorage.getItem('overheard.identity'));
const did = JSON.parse(vault).did;
await pg.evaluate(() => { localStorage.removeItem('overheard.identity'); localStorage.setItem('overheard.lastdid', 'x'); });
await pg.evaluate((d) => localStorage.setItem('overheard.lastdid', d), did);
await go();
await pg.click('#noPass');
check('a browser with nothing in it opens on "make a new one"',
  (await pg.locator('#tabNew').getAttribute('class')).includes('on'));
await pg.click('#tabHave');
check('the DID is filled in from the card last looked up',
  (await pg.inputValue('#hDid')) === did, (await pg.inputValue('#hDid')).slice(0, 24) + '…');
await pg.fill('#hFile', did);
await pg.fill('#hPw', PASS);
await pg.click('#doHave'); await pg.waitForTimeout(300);
check('pasting the DID instead of the file is explained, not just refused',
  /cannot turn a DID back into the key/.test(await pg.locator('#haveSay').textContent()));
await pg.fill('#hFile', vault);
await pg.fill('#hPw', 'the wrong one');
await pg.click('#doHave'); await pg.waitForTimeout(1500);
check('a wrong passphrase says so', /Wrong passphrase/.test(await pg.locator('#haveSay').textContent()));
await pg.fill('#hPw', PASS);
await pg.click('#doHave');
await pg.waitForFunction(() => !document.getElementById('open').hidden, null, { timeout: 20000 });
check('and the right one signs you in', await pg.locator('#open').isVisible());
check('with the identity stored for next time', await pg.evaluate(() => !!localStorage.getItem('overheard.identity')));

console.log('\n=== K. phone');
const ph = await ctx.newPage(); ph.on('pageerror', e => errs.push(e.message));
await ph.setViewportSize({ width: 390, height: 844 });
await ph.goto('http://localhost:8895/rooms.html'); await ph.waitForTimeout(700);
const ov = await ph.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
check('no horizontal scroll', ov[0] <= ov[1], ov.join('/'));
await ph.evaluate(() => document.getElementById('noPass').click());
await ph.waitForTimeout(400);
const fits = await ph.evaluate(() => {
  const m = document.querySelector('.modal').getBoundingClientRect();
  return { left: Math.round(m.left), right: Math.round(innerWidth - m.right) };
});
check('the pop-up fits the screen', fits.left >= 0 && fits.right >= 0, JSON.stringify(fits));
await ph.screenshot({ path: '/tmp/rooms-phone.png', fullPage: false }).catch(() => {});
await ph.close();

console.log('\n=== L. nothing touches its own border');
await go();
const pad = await pg.evaluate(() => {
  const s = getComputedStyle(document.getElementById('own'));
  const h = document.querySelector('#own .ownlede').getBoundingClientRect();
  const box = document.getElementById('own').getBoundingClientRect();
  return { padding: s.paddingLeft, gap: Math.round(h.left - box.left) };
});
check('the claim panel has real padding', parseInt(pad.padding, 10) >= 18, JSON.stringify(pad));

await pg.screenshot({ path: '/tmp/rooms-full.png', fullPage: true }).catch(() => {});

console.log('\nerrors:', errs);
if (errs.length) bad++;
await b.close(); srv.close();
console.log(bad ? `\n${bad} FAILURE(S)` : '\nall good');
process.exit(bad ? 1 : 0);

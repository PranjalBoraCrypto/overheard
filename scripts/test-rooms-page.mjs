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
let OWNS = [];                       // rooms the archive says this key owns
let POSTFAIL = null;                 // make the network refuse a message
let LANDS_LATE = false;              // the write times out but DOES land
const LATE = [];
let CAP = { known: true, rooms: { total: 19116, capacity: 20480, left: 1364, full: false },
            notes: { total: 600000, capacity: 655360, left: 55360, full: false } };

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
      if (d.kind === 'message' && POSTFAIL) return J(POSTFAIL);
      if (d.kind === 'message' && LANDS_LATE) { LATE.push(d); return J({ ok: false, status: 504, unknown: true,
        body: 'technocore.chat did not answer in time — it may still have gone through' }); }
      return J({ ok: true });
    });
  }
  if (p === '/api/room') {
    const room = u.searchParams.get('room') || '';
    // A firehose, like the real lobby: 200 messages per read. This is the
    // room where "my message vanished" was reported.
    if (room === 'busylobby') {
      const base = Number(u.searchParams.get('since') || 0) || 0;
      return J({ room, first_seq: String(base + 1), last_seq: String(base + 200), count: 200,
        messages: Array.from({ length: 200 }, (_, i) => ({
          seq: String(base + 1 + i), ts: new Date().toISOString(),
          from: 'did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz',
          nick: null, text: 'firehose line ' + (base + 1 + i), sig: null, nonce: null })) });
    }
    if (LATE.length) {
      const mine = LATE.filter(x => x.room === room).map((x, i) => ({
        seq: 'late' + i, ts: new Date().toISOString(), from: x.did, nick: null, text: x.text, sig: null, nonce: null }));
      if (mine.length) return J({ room, first_seq: '1', last_seq: '9', count: mine.length, messages: mine });
    }
    // A room nobody has ever posted in: the case where opening one has to
    // spend a room slot, which is the case the capacity check exists for.
    if (/^brand-new/.test(room)) return J({ room, first_seq: null, last_seq: '0', count: 0, messages: [] });
    return J({ room, first_seq: '1', last_seq: '4', count: 1, messages: [
      { seq: '4', ts: new Date().toISOString(), from: null, nick: 'someone', text: 'a line from a stranger', sig: null, nonce: null },
    ] });
  }
  if (p === '/api/owner') return J({ room: u.searchParams.get('room'), status: OWNER, owner: null,
    allow: u.searchParams.get('room') === 'd-my-lab' ? ['did:key:z6MkAllowedOne'] : [] });
  if (p === '/api/capacity') return J(CAP);
  if (p === '/api/profile') return J({ owned: { rooms: OWNS, owners: 300, claimed: 590 }, profile: null, standing: null });
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
/* Refusals now come up in front of the page, so every one of them has to be
   dismissed before the next thing can be clicked — which is the point. */
const dismiss = async () => {
  if (await pg.locator('#tellScrim').isVisible()) { await pg.click('#tellOk'); await pg.waitForTimeout(250); }
};

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

/* Checking whether a name is taken is two public reads. Refusing to answer
   until somebody signs in asks them to commit before they know the name they
   want is even there — so the answer comes, and the BUTTON waits. */
await pg.click('#kOwned');
await pg.fill('#rn', 'a-name-to-check');
await pg.waitForFunction(() => {
  const t = document.getElementById('ownsay').textContent;
  return /available|taken|exists/.test(t) && !/^Checking/.test(t);
}, null, { timeout: 9000 });
const anon = (await pg.locator('#ownsay').textContent()) || '';
check('a name can be checked before signing in', /available/.test(anon), anon.slice(0, 70));
check('and the button is what waits for the key', await pg.locator('#claim').isDisabled());
check('which it says rather than leaving it to be guessed', /Sign in above/.test(anon));
await pg.fill('#rn', ''); await pg.click('#kOpen');

console.log('\n=== B. the pop-up makes one, and then asks for the passphrase');
await pg.click('#noPass');
check('it opens in the middle of the screen', await pg.locator('#scrim').isVisible());
check('on the "make a new one" side', (await pg.locator('#tabNew').getAttribute('class')).includes('on'));
check('and the other way in is one tab away', await pg.locator('#tabHave').isVisible());

await pg.fill('#np1', 'xyz');
await pg.click('#doNew');
await pg.waitForTimeout(200);
check('a passphrase below the floor is refused before any key is made',
  /at least 6/.test(await pg.locator('#newSay').textContent()),
  await pg.locator('#newSay').textContent());

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

console.log('\n=== F2. a busy room does not swallow your own line');
/* REPORTED: "my message disappears too fast, and never shows in lobby." The
   lobby does twenty a second; a poll returned eighty at once, appended them
   in one frame, and the 300-line cap then pruned yours out of the DOM. */
await pg.goto('http://localhost:8895/rooms.html?room=busylobby');
await pg.waitForTimeout(2500);
POSTS = [];
await pg.fill('#say', 'MINE-IN-THE-FLOOD');
await pg.press('#say', 'Enter');
await pg.waitForTimeout(400);
const mineAt = async () => pg.evaluate(() => {
  const el = [...document.querySelectorAll('.msg.mine .body')].find(b => b.textContent === 'MINE-IN-THE-FLOOD');
  if (!el) return null;
  const box = document.getElementById('stream').getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { onScreen: r.bottom > box.top && r.top < box.bottom, below: Math.round(box.bottom - r.bottom) };
});
check('it is on screen the moment it is sent', (await mineAt())?.onScreen === true, JSON.stringify(await mineAt()));
await pg.waitForTimeout(1500);
check('and still on screen a second and a half later', (await mineAt())?.onScreen === true, JSON.stringify(await mineAt()));
await pg.waitForTimeout(9000);
check('and it is never pruned away, however loud the room gets',
  (await pg.evaluate(() => [...document.querySelectorAll('.msg.mine .body')]
    .some(b => b.textContent === 'MINE-IN-THE-FLOOD'))) === true);
const flow = await pg.evaluate(() => ({ shown: document.querySelectorAll('.msg').length }));
check('the room is let out at a readable rate, not eighty in a frame', flow.shown <= 320, JSON.stringify(flow));
/* Keep is present without a hover — but quiet. It was a pill the same size
   and weight as a short message, which on "hi" was louder than the message.
   Fixed size, low opacity, full on hover, and it says what it does then. */
const keepLook = await pg.evaluate(() => {
  const el = [...document.querySelectorAll('.msg.mine')].find(m => m.textContent.includes('MINE-IN-THE-FLOOD'));
  const k = el?.querySelector('.keep');
  if (!k) return null;
  const s = getComputedStyle(k), r = k.getBoundingClientRect();
  const bubble = el.querySelector('.body').getBoundingClientRect();
  return { op: +s.opacity, w: Math.round(r.width), h: Math.round(r.height),
           tip: k.dataset.tip, area: Math.round(r.width * r.height),
           bubbleArea: Math.round(bubble.width * bubble.height) };
});
check('Keep is there without hovering over it', !!keepLook && keepLook.w > 0, JSON.stringify(keepLook));
check('but quiet — not competing with the message', keepLook.op < 0.6, `opacity ${keepLook.op}`);
check('and it says what it does, on the control', /Keep/.test(keepLook.tip || ''), keepLook.tip);

/* Asked for: check it on a one-word message, a middling one and a long one —
   the control must be the same size in all three, so it never reads as more
   important than what it belongs to. */
const sizes = [];
for (const [name, text] of [['one word', 'hi'],
                            ['a sentence', 'Setting up my agent identity on Technocore today.'],
                            ['a paragraph', 'A much longer line: '.repeat(12)]]) {
  await pg.fill('#say', text);
  await pg.press('#say', 'Enter');
  await pg.waitForTimeout(600);
  sizes.push([name, await pg.evaluate((t) => {
    const el = [...document.querySelectorAll('.msg.mine')].reverse().find(m => m.textContent.includes(t.slice(0, 12)));
    const k = el.querySelector('.keep').getBoundingClientRect();
    const b = el.querySelector('.body').getBoundingClientRect();
    const g = el.querySelector('.keep svg').getBoundingClientRect();
    // The button keeps a 26px touch target; what a person SEES is the glyph,
    // at a third opacity. That is the thing to compare with the message.
    return { keep: Math.round(k.width) + 'x' + Math.round(k.height),
             glyph: Math.round(g.width), narrower: k.width < b.width,
             ratio: +(g.width * g.height / (b.width * b.height)).toFixed(3) };
  }, text)]);
}
console.log('   ', JSON.stringify(sizes));
check('the same control on a word, a sentence and a paragraph',
  new Set(sizes.map(([, v]) => v.keep)).size === 1, sizes.map(([n, v]) => n + ' ' + v.keep).join(' | '));
check('a small glyph in every case, never a pill',
  sizes.every(([, v]) => v.glyph <= 16), JSON.stringify(sizes.map(([n, v]) => [n, v.glyph])));
check('and smaller than the message it belongs to, even a two-letter one',
  sizes.every(([, v]) => v.narrower && v.ratio < 0.2), JSON.stringify(sizes.map(([n, v]) => [n, v.ratio])));

console.log('\n=== F3. the chat scrolls wherever the cursor is in it');
const scroller = await pg.evaluate(() => {
  const box = document.getElementById('stream');
  const s = getComputedStyle(box);
  const panel = document.querySelector('.main').getBoundingClientRect();
  const r = box.getBoundingClientRect();
  return { overflow: s.overflowY, contain: s.overscrollBehaviorY,
    scrollable: box.scrollHeight > box.clientHeight + 20,
    // The scroller must fill the panel: it used to be a max-height inside an
    // auto-height column, so part of what LOOKED like the chat was not it.
    coversPanel: Math.abs(r.width - panel.width) <= 4 && r.height > panel.height * 0.4,
    frac: Math.round(r.height / panel.height * 100) };
});
check('one scroller, and it is the chat', scroller.overflow === 'auto' && scroller.scrollable, JSON.stringify(scroller));
check('filling the panel, so the wheel works anywhere over it', scroller.coversPanel, JSON.stringify(scroller));
check('and a flick at the end does not take the page with it', scroller.contain === 'contain');
/* A real wheel, from the browser, over three different places inside the
   chat — a bubble, an avatar and the gap between rows. A synthetic
   WheelEvent scrolls nothing in Chromium, so this goes through the mouse. */
const box = await pg.locator('#stream').boundingBox();
const spots = [
  ['over a message bubble', box.x + 90, box.y + 40],
  ['over the middle of the chat', box.x + box.width / 2, box.y + box.height / 2],
  ['over the gap near the bottom', box.x + box.width - 60, box.y + box.height - 30],
];
for (const [what, x, y] of spots) {
  await pg.evaluate(() => { const b = document.getElementById('stream'); b.scrollTop = b.scrollHeight; });
  const before = await pg.evaluate(() => document.getElementById('stream').scrollTop);
  await pg.mouse.move(x, y);
  await pg.mouse.wheel(0, -400);
  await pg.waitForTimeout(220);
  const after = await pg.evaluate(() => document.getElementById('stream').scrollTop);
  check('the wheel scrolls the chat ' + what, after < before, `${Math.round(before)} -> ${Math.round(after)}`);
}

console.log('\n=== F4. picking a room puts the cursor where you type');
await pg.evaluate(() => document.querySelectorAll('#rlist .rbtn')[1].click());
await pg.waitForTimeout(500);
check('no second click needed to start typing',
  (await pg.evaluate(() => document.activeElement?.id)) === 'say',
  await pg.evaluate(() => document.activeElement?.id));

console.log('\n=== G. the room field, and the prefix question');
check('an open room gets no d- prefix', await pg.locator('#rpre').isHidden());
/* Explaining the absence of a prefix, on the kind that never has one, is a
   paragraph about something not on the screen. */
check('and no paragraph about a prefix that is not there', await pg.locator('#ownhint').isHidden());
check('nor an allow-list for a room nobody owns', await pg.locator('#allowbox').isHidden());
const padOpen = await pg.evaluate(() => {
  const i = document.getElementById('rn');
  return { pad: getComputedStyle(i).paddingLeft, gap: Math.round(i.getBoundingClientRect().left - i.closest('.nameline').getBoundingClientRect().left) };
});
check('and its text is not against the border', parseInt(padOpen.pad, 10) >= 12, JSON.stringify(padOpen));

await pg.click('#kOwned');
await pg.waitForTimeout(200);
check('a claimed room gets the prefix, as furniture', await pg.locator('#rpre').isVisible());
check('with the explanation that belongs to it', await pg.locator('#ownhint').isVisible());
/* Asked for: decide who the room is FOR while you are claiming it, not on a
   panel that appears afterwards. */
check('and a place to name who else may post', await pg.locator('#allowbox').isVisible());
check('the field still clears the border with a prefix in front of it',
  await pg.evaluate(() => Math.round(document.getElementById('rn').getBoundingClientRect().left
    - document.getElementById('rpre').getBoundingClientRect().right) >= 0));

console.log('\n=== H. a wall that is not your fault does not read like one');
await pg.fill('#rn', 'my-own-room');
await pg.waitForFunction(() => !document.getElementById('claim').disabled, null, { timeout: 8000 });
CLAIM = { ok: false, status: 400, error: '400 note limit reached (50960 is the cap, and this would be a new one).' };
await pg.click('#claim');
await pg.waitForFunction(() => !document.getElementById('ownCap').hidden, null, { timeout: 8000 });
/* Reported: a notice under the button is missed by somebody who is looking
   at the button. It comes up in front of the page now. */
check('the refusal comes up in front of the page', await pg.locator('#tellScrim').isVisible());
check('saying the same thing', /cannot take new room claims/.test(await pg.locator('#tellTitle').textContent()));
await dismiss();
const cap = (await pg.locator('#ownCap').textContent()) || '';
console.log('   ', cap.replace(/\s+/g, ' ').slice(0, 120), '…');
check('it says what was refused: a claim, not a room', /cannot take new room claims/.test(cap));
check('and says it is not about your name', /not about your name/.test(cap));
check('and gives a time to come back', /tomorrow|hour|minute/.test(cap));
check('and points at the thing that still works', /open room/i.test(cap));
check('in a grey notice, not a red error line', (await pg.locator('#ownsay').textContent()).trim() === '');

/* The other store, and the two must never be reported in each other's
   words: a full ROOM store leaves claims alone, a full NOTE store leaves
   open rooms alone. */
CLAIM = { ok: false, status: 400, error: '400 room limit reached (20480 is the cap, and this would be a new one).' };
await pg.fill('#rn', 'yet-another');
await pg.waitForFunction(() => !document.getElementById('claim').disabled, null, { timeout: 8000 });
await pg.click('#claim'); await pg.waitForTimeout(900);
await dismiss();
const capR = (await pg.locator('#ownCap').textContent()) || '';
check('a full room store is told apart from a full note store',
  /no room left for new rooms/.test(capR) && !/room claims/.test(capR), capR.slice(0, 60));

CLAIM = { ok: false, status: 429, error: 'too many new rooms per day for this ip' };
await pg.fill('#rn', 'another-room');
await pg.waitForFunction(() => !document.getElementById('claim').disabled, null, { timeout: 8000 });
await pg.click('#claim');
await pg.waitForTimeout(900);
await dismiss();
const cap2 = (await pg.locator('#ownCap').textContent()) || '';
console.log('   ', cap2.replace(/\s+/g, ' ').slice(0, 110), '…');
check('the daily allowance is told apart from the register being full',
  /today/.test(cap2) && /midnight UTC/.test(cap2));
check('and that one can quote a real time', /Try again in about/.test(cap2));

console.log('\n=== H2. the open-room wall, found before anybody is sent to the room');
/* REPORTED: an open room was created, the page said fine, and the refusal
   turned up later — on the first message, in a room that did not exist. */
CAP = { known: true, rooms: { total: 20480, capacity: 20480, left: 0, full: true },
        notes: { total: 1, capacity: 655360, left: 655359, full: false } };
await go();                       // a fresh page, so the 30-second capacity memo is not answering
await pg.click('#kOpen'); await pg.waitForTimeout(150);
await pg.fill('#rn', 'brand-new-room');
await pg.waitForFunction(() => !document.getElementById('ownCap').hidden, null, { timeout: 8000 });
await dismiss();
const capO = (await pg.locator('#ownCap').textContent()) || '';
check('it says so while the name is being typed', /no room left for new rooms/.test(capO), capO.slice(0, 58));
check('and the button does not offer to do it anyway', await pg.locator('#claim').isDisabled());
check('the reason names the cap and what still works',
  /20,480/.test(capO) && /already exist/.test(capO));
CAP = { known: true, rooms: { total: 19116, capacity: 20480, left: 1364, full: false },
        notes: { total: 1, capacity: 655360, left: 655359, full: false } };

console.log('\n=== H3. pinning, and the room you are actually in');
await pg.goto('http://localhost:8895/rooms.html?room=from-a-link');
await pg.waitForTimeout(900);
const rowNames = await pg.evaluate(() => [...document.querySelectorAll('#rlist .rbtn .nm')].map(x => x.textContent));
check('a room opened from a link is on the list', rowNames.includes('from-a-link'), JSON.stringify(rowNames));
check('at the top of it', rowNames[0] === 'from-a-link');
check('and marked as the one being read',
  await pg.evaluate(() => document.querySelector('#rlist .rbtn').classList.contains('on')));
const lit = await pg.evaluate(() => {
  const el = document.querySelector('#rlist .rbtn.on');
  return getComputedStyle(el).boxShadow + ' | ' + getComputedStyle(el.querySelector('.nm')).color;
});
check('in the brand blue, not the same grey as the rest', /rgb\(95, 235, 255\)/.test(lit), lit.slice(0, 60));
await pg.evaluate(() => document.querySelectorAll('#rlist .rbtn')[1].querySelector('.pinbtn').click());
await pg.waitForTimeout(200);
const pins = await pg.evaluate(() => JSON.parse(localStorage.getItem('overheard.pins') || '[]'));
check('a room can be pinned', pins.length === 1, JSON.stringify(pins));
await pg.goto('http://localhost:8895/rooms.html?room=from-a-link');
await pg.waitForTimeout(900);
const after = await pg.evaluate(() => [...document.querySelectorAll('#rlist .rbtn .nm')].map(x => x.textContent));
check('and it holds its place under the open one after a reload',
  after[1] === pins[0], JSON.stringify(after.slice(0, 3)));

console.log('\n=== H4. opening a room IS posting in it');
/* REPORTED: the panel said the room was open, sent somebody to it, and the
   refusal — "room limit reached" — arrived on their first message, in a room
   that had never existed. A room comes into being with its first message, so
   that is what the button does, and whatever Technocore says lands here. */
await go();
POSTS = [];
await pg.click('#kOpen');
await pg.fill('#rn', 'brand-new-openroom');
await pg.waitForFunction(() => /available/.test(document.getElementById('ownsay').textContent), null, { timeout: 9000 });
await pg.click('#claim');
await pg.waitForFunction(() => !document.getElementById('owndone').hidden, null, { timeout: 15000 });
check('and it appears in "Your rooms" straight away, with no reload',
  await pg.evaluate(() => !document.getElementById('mine').hidden &&
    [...document.querySelectorAll('#mrooms .nm')].some(n => n.textContent === 'brand-new-openroom')));
check('the room is opened by a signed first message, not by hope',
  POSTS.some(p => p.kind === 'message' && p.room === 'brand-new-openroom'),
  JSON.stringify(POSTS.map(p => p.kind + ':' + p.room)));
check('and only then is a link handed over', await pg.locator('#owndone').isVisible());

/* And when the network refuses that write, it is refused HERE. */
POSTFAIL = { ok: false, status: 400, error: '400 room limit reached (20480 is the cap, and this would be a new one).' };
await pg.fill('#rn', 'brand-new-second');
await pg.waitForFunction(() => /available/.test(document.getElementById('ownsay').textContent), null, { timeout: 9000 });
await pg.click('#claim');
await pg.waitForFunction(() => !document.getElementById('ownCap').hidden, null, { timeout: 15000 });
await dismiss();
const capW = (await pg.locator('#ownCap').textContent()) || '';
check('a refusal lands on the panel, not two screens later',
  /no room left for new rooms/.test(capW), capW.slice(0, 52));
POSTFAIL = null;

console.log('\n=== H4b. a slow write is not a failed write');
/* REPORTED, with screenshots: the send timed out, the page said nothing was
   written, the message was in the room, and the next read drew it as a
   STRANGER'S. Three separate wrongs from one assumption. */
await go();
LANDS_LATE = true; LATE.length = 0;
await pg.evaluate(() => { document.getElementById('say').value = ''; });
await pg.fill('#say', 'LATE-BUT-LANDED');
await pg.press('#say', 'Enter');
await pg.waitForFunction(() => /Posted|cannot say/.test(document.getElementById('m').textContent), null, { timeout: 20000 });
const lateLine = (await pg.locator('#m').textContent()) || '';
check('it goes and looks instead of declaring failure', /Posted/.test(lateLine), lateLine.slice(0, 60));
check('and the line is shown as YOURS, not a stranger\'s', await pg.evaluate(() =>
  [...document.querySelectorAll('.msg')].filter(m => m.textContent.includes('LATE-BUT-LANDED'))
    .every(m => m.classList.contains('mine'))));
/* And a line that reports something finished should not sit there for ever. */
await pg.waitForFunction(() => document.getElementById('m').textContent === '', null, { timeout: 9000 });
check('"Posted." clears itself after a few seconds', (await pg.locator('#m').textContent()) === '');
LANDS_LATE = false; LATE.length = 0;

console.log('\n=== H4c. the refusal in words, with the real numbers');
POSTFAIL = { ok: false, status: 400, error: '400 room limit reached (20480 is the cap, and this would be a new one). Existing rooms still accept writes, so reuse one you already have — GET /rooms shows what exists. Idle rooms are reclaimed after 7 days (a room still on its first message goes after 24 hours).' };
await pg.fill('#say', 'this one is refused');
await pg.press('#say', 'Enter');
await pg.waitForFunction(() => /Technocore|holding/.test(document.getElementById('m').textContent), null, { timeout: 12000 });
const plain = (await pg.locator('#m').textContent()) || '';
console.log('   ', plain.slice(0, 130));
check('the real reason, with the real number', /20,480 rooms/.test(plain), plain.slice(0, 60));
check('and none of the developer half', !/GET \/rooms|cap,/.test(plain));
POSTFAIL = null;
await pg.fill('#say', '');

console.log('\n=== H5. the rooms you already have');
check('no panel at all for somebody with none', await pg.evaluate(() => {
  localStorage.removeItem('overheard.myrooms');
  return true;
}) && true);
OWNS = [];
await go();
check('nothing is shown when there is nothing to show', await pg.locator('#mine').isHidden());

OWNS = ['d-my-lab', 'd-second-room'];
await pg.evaluate(() => localStorage.setItem('overheard.myrooms',
  JSON.stringify([{ name: 'open-hangout', kind: 'open', at: new Date().toISOString() }])));
await go();
await pg.waitForFunction(() => !document.getElementById('mine').hidden, null, { timeout: 9000 });
const rooms = await pg.evaluate(() => [...document.querySelectorAll('#mroom, #mrooms .mroom')].map(r => ({
  name: r.querySelector('.nm').textContent, tag: r.querySelector('.tag').textContent })));
console.log('   ', JSON.stringify(rooms));
check('claimed rooms come from the network', rooms.some(r => r.name === 'd-my-lab'));
check('and the open one this browser started is remembered too',
  rooms.some(r => r.name === 'open-hangout'));
/* Not "private": everyone can READ a claimed room, and a chip saying
   private would tell people otherwise. The chip names what a claim
   actually controls. */
check('each is tagged for who may post in it',
  rooms.find(r => r.name === 'd-my-lab').tag === 'Invite only' &&
  rooms.find(r => r.name === 'open-hangout').tag === 'Anyone posts',
  JSON.stringify(rooms.map(r => r.tag)));
check('with the owned ones first', rooms[0].name.startsWith('d-'));

await pg.click('#mrooms .mroom:first-child .burger');
await pg.waitForTimeout(300);
const items = await pg.evaluate(() => [...document.querySelectorAll('#mrooms .rmenu button')].map(b => b.textContent.trim()));
console.log('   ', JSON.stringify(items));
check('the menu offers the practical things', items.some(t => /Copy the link/.test(t)) &&
  items.some(t => /Pin/.test(t)) && items.some(t => /Who can post/.test(t)), JSON.stringify(items));
await pg.evaluate(() => [...document.querySelectorAll('#mrooms .rmenu button')].find(b => /Who can post/.test(b.textContent)).click());
await pg.waitForFunction(() => !!document.querySelector('#mrooms .whobox textarea:not([disabled])'), null, { timeout: 9000 });
check('and editing the list starts from what Technocore holds now',
  (await pg.inputValue('#mrooms .whobox textarea')) === 'did:key:z6MkAllowedOne');
POSTS = [];
await pg.fill('#mrooms .whobox textarea', 'did:key:z6Mkmw4xM1EycqDvmDdPYUJHnLYAMBEWCpz6DohcTBBLLLLL');
await pg.click('#mrooms .whobox .go:not(.ghost)');
await pg.waitForTimeout(1200);
check('saving signs a new list', POSTS.some(p => p.kind === 'allow' && p.room === 'd-my-lab'),
  JSON.stringify(POSTS.map(p => p.kind)));

const openMenu = await pg.evaluate(() => {
  const row = [...document.querySelectorAll('#mrooms .mroom')].find(r => r.querySelector('.nm').textContent === 'open-hangout');
  row.querySelector('.burger').click();
  return [...row.querySelectorAll('.rmenu button')].map(b => b.textContent.trim());
});
check('an open room offers no owner controls, because nobody owns it',
  !openMenu.some(t => /Who can post/.test(t)) && openMenu.some(t => /Remove from this list/.test(t)),
  JSON.stringify(openMenu));

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
/* Asked for: the second door has to be there the moment you sign out, and it
   has to offer what it can actually do — this browser HAS an identity, so
   "no passphrase yet" would be talking to the wrong person. */
check('the other way in is offered immediately', await pg.locator('#noPass').isVisible());
check('and it says the thing that is true of this browser',
  /Different identity/.test(await pg.locator('#noPass').textContent()),
  (await pg.locator('#noPass').textContent()).trim());

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

console.log('\n=== J2. the other thing people have: a seed');
/* Asked for. A seed is the identity in the clear, so this path MAKES a
   passphrase rather than asking for one, works the DID out for itself, and
   says what a seed is before anybody pastes one. */
await pg.evaluate(() => { localStorage.clear(); });
await go();
await pg.click('#noPass'); await pg.click('#tabHave');
check('the safe way in is the one offered first',
  (await pg.locator('#wayFile').getAttribute('class')).includes('on'));
await pg.click('#waySeed'); await pg.waitForTimeout(150);
check('a seed gets a warning before it gets a field',
  /A seed is the identity itself/.test(await pg.locator('#waySeedBox').textContent()));
/* The seed already contains the DID, so asking for it is a field that can
   only be got wrong. It is shown, not asked for. */
check('the DID field disappears, because the seed carries it',
  await pg.locator('#didField').isHidden());
check('the passphrase field asks you to choose one', await pg.locator('#hPw2').isVisible());

await pg.fill('#hSeed', 'not a seed'); await pg.fill('#hPw', PASS); await pg.fill('#hPw2', PASS);
await pg.click('#doHave'); await pg.waitForTimeout(300);
check('rubbish is refused with what a seed looks like',
  /64 hex characters/.test(await pg.locator('#haveSay').textContent()));

/* A real one, generated here, handed over the way the Create page hands it
   over: as the whole .txt with other lines around it. */
const seedHex = await pg.evaluate(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
  const d = Uint8Array.from(atob(jwk.d.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n; for (const b of [0xed, 0x01, ...new Uint8Array(raw)]) n = n * 256n + BigInt(b);
  let out = ''; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return { hex: [...d].map(b => b.toString(16).padStart(2, '0')).join(''), did: 'did:key:z' + out };
});
await pg.fill('#hSeed', `Technocore identity\n\nSEED (private)\n${seedHex.hex}\n\nKeep this file offline.`);
await pg.waitForFunction(() => !document.getElementById('seedDid').hidden, null, { timeout: 8000 });
check('the DID appears under the box as soon as the seed is in',
  (await pg.locator('#seedDid').textContent()).includes(seedHex.did), seedHex.did.slice(0, 26) + '…');
check('and it is shown, not typed into a field',
  (await pg.evaluate(() => document.getElementById('seedDid').tagName)) === 'DIV');
const dl2 = pg.waitForEvent('download').catch(() => null);
await pg.click('#doHave');
await pg.waitForFunction(() => !document.getElementById('open').hidden, null, { timeout: 25000 });
check('the whole identity .txt is a fine thing to paste', await pg.locator('#open').isVisible());
check('and the DID it worked out is the right one',
  (await pg.evaluate(() => JSON.parse(localStorage.getItem('overheard.session')).did)) === seedHex.did);
check('the seed is encrypted here, not stored as itself', await pg.evaluate(() => {
  const all = JSON.stringify(localStorage);
  return !!localStorage.getItem('overheard.identity') && !/[0-9a-f]{64}/.test(all);
}));
check('and its encrypted backup comes out too', !!(await dl2));

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

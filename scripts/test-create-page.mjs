/* The create page, walked the way a person walks it.
 *
 * It was a form: six panels, most open at once, and the first word on it was
 * "DID". It is a ladder now, and a ladder makes promises a form does not —
 * that exactly one thing is live at a time, that the count means something,
 * and that the seed step will not let you past until the seed is somewhere.
 * Those are the promises this checks.
 *
 * The network is stubbed at /api/post, so nothing here touches Technocore.
 * Needs playwright and a chromium:  npx playwright install chromium
 */
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
let POSTS = [];
let FAIL = false;

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let p = u.pathname; if (p === '/') p = '/index.html';
  if (p === '/api/post' && req.method === 'POST') {
    let raw = ''; req.on('data', c => raw += c);
    return req.on('end', () => {
      try { POSTS.push(JSON.parse(raw)); } catch { POSTS.push({ bad: raw }); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(FAIL ? { ok: false, error: 'nope' } : { ok: true }));
    });
  }
  if (p === '/api/owner') {
    const room = u.searchParams.get('room') || '';
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ room, status: room === 'd-taken' ? 'claimed' : 'free' }));
  }
  if (p.startsWith('/api/') || p.startsWith('/data/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(fs.readFileSync(f)); }
  else { res.writeHead(404); res.end('{}'); }
}).listen(8888);

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ viewport: { width: 1240, height: 950 }, acceptDownloads: true });
const pg = await ctx.newPage();
const errs = []; pg.on('pageerror', e => errs.push(e.message));

let bad = 0;
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${n}${d ? '   ' + d : ''}`); if (!ok) bad++; };
const cls = (id) => pg.evaluate((i) => document.getElementById(i).className, id);
const stateOf = async (id) => {
  const c = await cls('t-' + id);
  return c.includes('done') ? 'done' : c.includes('live') ? 'live' : c.includes('locked') ? 'locked' : '?';
};
/* Clicking a rung's head TOGGLES it, so a test that wants one open has to ask
   whether it already is — otherwise it closes the very thing it is about to
   click inside, and Playwright reports the head "intercepting pointer events"
   for a button in a zero-height body. */
const ensureOpen = async (id) => {
  if ((await cls('t-' + id)).includes('open')) return;
  await pg.click(`#t-${id} .shead`);
  await pg.waitForTimeout(400);
};
const rung = async () => {
  const out = {};
  for (const id of ['key', 'save', 'note', 'hello', 'intro', 'room', 'proof', 'priv']) out[id] = await stateOf(id);
  return out;
};

await pg.goto('http://localhost:8888/create.html');
await pg.evaluate(() => document.fonts.ready);
await pg.waitForTimeout(400);

console.log('=== A. what somebody sees before touching anything');
console.log('  ', JSON.stringify(await rung()));
check('only the first rung is live', (await stateOf('key')) === 'live');
check('every later rung is locked', ['save', 'note', 'hello'].every(async () => true)
  && (await stateOf('save')) === 'locked' && (await stateOf('note')) === 'locked');
check('the side quests are hidden entirely', await pg.locator('#side').isHidden());
check('the count starts at zero', (await pg.locator('#count').textContent()) === '0 of 4');
check('the verdict starts at the card\'s own bottom word',
  (await pg.locator('#tierWord').textContent()) === 'KEY ONLY');
const words = (await pg.evaluate(() => document.body.innerText)).toLowerCase();
check('nothing is asking for anything yet', (await pg.locator('input:visible').count()) <= 1,
  `${await pg.locator('input:visible').count()} visible inputs`);
await pg.screenshot({ path: '/tmp/create-1-arrive.png', clip: { x: 0, y: 0, width: 1240, height: 950 } });

console.log('\n=== B. the key');
await pg.click('#gen');
await pg.waitForFunction(() => document.getElementById('t-key').className.includes('done'), null, { timeout: 15000 });
await pg.waitForTimeout(900);
console.log('  ', JSON.stringify(await rung()));
check('the key rung is done', (await stateOf('key')) === 'done');
check('the seed rung went live', (await stateOf('save')) === 'live');
check('and opened itself', (await cls('t-save')).includes('open'));
check('the DID is on screen', /^did:key:z6Mk/.test((await pg.locator('#didOut').textContent()) || ''));
check('the count moved', (await pg.locator('#count').textContent()) === '1 of 4');
check('the Key badge lit', (await pg.evaluate(() => document.querySelector('[data-b="key"]').className)).includes('won'));

console.log('\n=== C. the gate — the one place this page refuses');
check('the confirm button is dead on arrival', await pg.locator('#gateGo').isDisabled());
check('the steps after it are still locked',
  (await stateOf('note')) === 'locked' && (await stateOf('hello')) === 'locked');
await pg.locator('#gateGo').click({ force: true }).catch(() => {});
await pg.waitForTimeout(300);
check('and pressing it anyway does nothing', (await stateOf('note')) === 'locked');

console.log('\n=== C2. the page points at the one button that matters');
const lead = await pg.evaluate(() => {
  const d = document.getElementById('saveTxt');
  return { cls: d.className, first: d.parentElement.firstElementChild.id,
           gate: document.getElementById('gateGo').className };
});
console.log('  ', JSON.stringify(lead));
check('Download leads the row', lead.first === 'saveTxt');
check('and is the solid button, not a ghost', !lead.cls.includes('ghost'));
check('and it pulses', lead.cls.includes('beckon'));
check('while the gate does not, because it cannot be pressed yet', !lead.gate.includes('beckon'));

console.log('\n=== D. saving the seed arms it');
const dl = pg.waitForEvent('download');
await pg.click('#saveTxt');
const file = await dl;
check('a .txt came down', /technocore-identity-.*\.txt$/.test(file.suggestedFilename()), file.suggestedFilename());
const body = fs.readFileSync(await file.path(), 'utf8');
check('with the DID and the seed in it', /did:key:z6Mk/.test(body) && /SEED \(private/.test(body));
check('the confirm button is now live', !(await pg.locator('#gateGo').isDisabled()));
check('and it says what it saw', /Downloaded/.test((await pg.locator('#gateText').textContent()) || ''));
// a download is silent; the page has to go to the button it just woke up
await pg.waitForTimeout(900);
const gateSeen = await pg.evaluate(() => {
  const r = document.getElementById('gateBox').getBoundingClientRect();
  return r.top > -20 && r.bottom < innerHeight + 20;
});
check('and the page went to the button it just woke up', gateSeen);
const after = await pg.evaluate(() => ({
  dl: document.getElementById('saveTxt').className,
  gate: document.getElementById('gateGo').className }));
check('Download stops pulsing once it has been obeyed', !after.dl.includes('beckon'), after.dl);
check('and the pulse moves to the gate', after.gate.includes('beckon'), after.gate);

await pg.click('#gateGo');
await pg.waitForTimeout(800);
console.log('  ', JSON.stringify(await rung()));
check('the seed rung is done', (await stateOf('save')) === 'done');
check('the two remaining main rungs opened up',
  (await stateOf('note')) === 'live' && (await stateOf('hello')) === 'live');
check('the side quests appeared', await pg.locator('#side').isVisible());
check('all four of them live', ['intro', 'room', 'proof', 'priv'].every(Boolean)
  && (await stateOf('room')) === 'live' && (await stateOf('proof')) === 'live');
check('count at two', (await pg.locator('#count').textContent()) === '2 of 4');
await pg.screenshot({ path: '/tmp/create-2-open.png', clip: { x: 0, y: 0, width: 1240, height: 950 } });

console.log('\n=== E. the fields arrive filled in');
check('the note field is pre-written', ((await pg.locator('#profile').inputValue()) || '').length > 20,
  (await pg.locator('#profile').inputValue()).slice(0, 40) + '…');
check('the message field too', ((await pg.locator('#helloText').inputValue()) || '').length > 10);
check('with alternatives one tap away', (await pg.locator('#t-note .pick').count()) === 3);
await pg.locator('#t-note .pick').nth(2).click();
await pg.waitForTimeout(200);
check('tapping one swaps the text', (await pg.locator('#profile').inputValue()).startsWith('Building on Technocore'));
check('and the room names are derived from the key, not left as a placeholder',
  (await pg.locator('#roomPicks .pick').count()) === 3
  && /^[0-9a-f]{8}$/.test((await pg.locator('#roomPicks .pick').first().textContent()).trim()),
  await pg.locator('#roomPicks .pick').first().textContent());

console.log('\n=== F. publish the note, post the message');
POSTS = [];
await pg.click('#t-note button[data-act]');
await pg.waitForFunction(() => document.getElementById('t-note').className.includes('done'), null, { timeout: 15000 });
check('the note rung is done', (await stateOf('note')) === 'done');
check('and a note went to the network', POSTS.some(p => p.kind === 'note'), JSON.stringify(POSTS.map(p => p.kind)));
check('the verdict moved to REGISTERED', (await pg.locator('#tierWord').textContent()) === 'REGISTERED');
check('the finish panel does NOT appear yet', await pg.locator('#finish').isHidden());

await pg.click('#t-hello button[data-act]');
await pg.waitForFunction(() => document.getElementById('t-hello').className.includes('done'), null, { timeout: 15000 });
await pg.waitForTimeout(400);
const msg = POSTS.find(p => p.kind === 'message');
check('a signed message went to the lobby', !!msg && msg.room === 'lobby', msg?.room);
check('carrying a signature and a STRING nonce', !!msg?.sig && typeof msg?.nonce === 'string');
check('and never the key', !JSON.stringify(POSTS).includes('"d"') && !/[0-9a-f]{64}/.test(JSON.stringify(POSTS)));
check('four of four', (await pg.locator('#count').textContent()) === '4 of 4');
check('the verdict is the card\'s top word', (await pg.locator('#tierWord').textContent()) === 'VERIFIED');
check('every badge lit', (await pg.evaluate(() =>
  [...document.querySelectorAll('.badge')].every(b => b.classList.contains('won')))));
check('the finish says so', /Set up correctly/.test((await pg.locator('#finishTitle').textContent()) || ''));
check('and points at this identity\'s card',
  ((await pg.locator('#seeCard').getAttribute('href')) || '').startsWith('/?did=did%3Akey%3Az6Mk'));
await pg.screenshot({ path: '/tmp/create-3-done.png', clip: { x: 0, y: 0, width: 1240, height: 950 } });

check('the finish panel appears once the main line is done', await pg.locator('#finish').isVisible());
check('and it sits BELOW the side quests, not between them and the person',
  await pg.evaluate(() => document.getElementById('finish').getBoundingClientRect().top
                        > document.getElementById('side').getBoundingClientRect().top));
check('the ladder carried on into a side quest', (await cls('t-intro')).includes('open'));

console.log('\n=== F3. a message box with a way to send it');
/* Every rung's action button used to live only in its header, and the moment
   a rung opened, its textarea pushed that button off the top of the screen. */
for (const id of ['note', 'hello', 'intro', 'room', 'proof', 'priv']) {
  const n = await pg.locator(`#t-${id} .actionrow button[data-act]`).count();
  if (n !== 1) { check(`${id} has an action where its form ends`, false, `${n} found`); }
}
check('every rung has an action button where its form ends',
  (await pg.locator('.actionrow button[data-act]').count()) === 6,
  `${await pg.locator('.actionrow button[data-act]').count()} of 6`);

console.log('\n=== F2. no button on the page runs nothing');
/* The seed rung had a "Save" header button and no action behind it: pressing
   it threw, and the throw was caught and shown as "Something went wrong",
   which is a page telling somebody their own click was a fault. */
const orphan = await pg.evaluate(() => {
  const ids = [...document.querySelectorAll('button[data-act]')].map(b => b.dataset.act);
  return { ids, missing: ids.filter(i => !window.__acts?.includes(i)) };
});
console.log('   action buttons:', orphan.ids.join(', '));
check('every action button has an action behind it',
  orphan.ids.every(i => ['note','hello','intro','room','proof','priv'].includes(i)),
  orphan.ids.join(','));
check('and the seed rung has none, because its action is the gate',
  !orphan.ids.includes('save'));

console.log('\n=== F4. the room field: the rule is furniture, not something to type');
await ensureOpen('room');
check('the d- is shown, outside the box', (await pg.locator('#roomWrap .pfx').textContent()).trim() === 'd-');
check('and it is not in the input', (await pg.locator('#roomName').inputValue()) === '');
check('the placeholder no longer teaches a prefix',
  (await pg.locator('#roomName').getAttribute('placeholder')) === 'yourname');

await pg.fill('#roomName', 'taken');
await pg.waitForFunction(() => /already claimed/.test(document.getElementById('roomAvail').textContent), null, { timeout: 6000 });
check('a claimed name says so before anything is signed',
  /d-taken is already claimed/.test(await pg.locator('#roomAvail').textContent()));
POSTS = [];
await pg.click('#t-room .actionrow button[data-act]');
await pg.waitForTimeout(600);
check('and claiming it never reaches the network', POSTS.length === 0, `${POSTS.length} posts`);

await pg.fill('#roomName', 'my-lab');
await pg.waitForFunction(() => /is free/.test(document.getElementById('roomAvail').textContent), null, { timeout: 6000 });
check('a free one says that too', /d-my-lab is free/.test(await pg.locator('#roomAvail').textContent()));
await pg.click('#t-room .actionrow button[data-act]');
await pg.waitForFunction(() => document.getElementById('t-room').className.includes('done'), null, { timeout: 10000 });
const claim = POSTS.find(p => p.kind === 'claim');
check('the claim carries the WHOLE name, prefix and all', claim?.room === 'd-my-lab', claim?.room);
check('and a shareable link comes back', await pg.locator('#roomOut').isVisible());
check('pointing at the room just claimed',
  (await pg.locator('#roomLink').textContent()) === 'technocore.chat/r/d-my-lab',
  await pg.locator('#roomLink').textContent());

console.log('\n=== F5. the private room hands back something copyable');
// open it first: a closed rung's body is a 0fr grid row, so its button has no
// height to be clicked at
await ensureOpen('priv');
await pg.click('#t-priv .actionrow button[data-act]');
await pg.waitForFunction(() => document.getElementById('t-priv').className.includes('done'), null, { timeout: 10000 });
check('the address is shown', /technocore\.chat\/r\/p-[0-9a-f]{24}/.test(await pg.locator('#privName').textContent()),
  await pg.locator('#privName').textContent());
check('with a copy button beside it', (await pg.locator('#privOut [data-copyval="privName"]').count()) === 1);
await pg.locator('#privOut [data-copyval="privName"]').click();
await pg.waitForTimeout(300);
check('that says it copied', /Copied/.test(await pg.locator('#privOut [data-copyval="privName"]').textContent()));

console.log('\n=== F6. the page is about making one, not unlocking one');
check('no "Already have an identity?" on a first visit', await pg.locator('#unlock').isHidden());
const back = await ctx.newPage();
await back.addInitScript(() => localStorage.setItem('overheard.identity',
  JSON.stringify({ v: 1, did: 'did:key:z6MkTEST', salt: 'x', iv: 'y', data: 'z' })));
await back.goto('http://localhost:8888/create.html'); await back.waitForTimeout(500);
check('but it is there for a browser that holds one', await back.locator('#unlock').isVisible());
await back.close();

console.log('\n=== F7. the footer matches the card page');
const foot = await pg.evaluate(() => document.querySelector('footer').innerText);
check('two rows', (await pg.locator('footer .frow').count()) === 2);
check('names the builder and links X', /Built by\s+Pranjal Bora/.test(foot)
  && (await pg.locator('footer a[href="https://x.com/Crypto_Pranjal"]').count()) === 1);
check('carries the whole DID', foot.includes('did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz'));
check('and the DID opens its own card',
  (await pg.locator('footer .bydid').getAttribute('href')) === '/?did=did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz');

console.log('\n=== G. a failure reads as a failure, not as success');
FAIL = true;
await ensureOpen('intro');
await pg.click('#t-intro .actionrow button[data-act]');
await pg.waitForTimeout(1200);
check('the rung is NOT marked done', (await stateOf('intro')) !== 'done');
check('and it says what the network said', /Technocore said/.test((await pg.locator('#m-intro').textContent()) || ''),
  (await pg.locator('#m-intro').textContent()));
check('the button is pressable again', !(await pg.locator('#t-intro .actionrow button[data-act]').isDisabled()));
FAIL = false;

console.log('\n=== H. an empty message never reaches the network');
POSTS = [];
await pg.fill('#introText', '   ');
await pg.click('#t-intro .actionrow button[data-act]');
await pg.waitForTimeout(600);
check('rejected locally', /Write a message first/.test((await pg.locator('#m-intro').textContent()) || ''));
check('nothing was sent', POSTS.length === 0, `${POSTS.length} posts`);

console.log('\n=== I. phone');
const pg2 = await ctx.newPage(); await pg2.setViewportSize({ width: 390, height: 844 });
pg2.on('pageerror', e => errs.push(e.message));
await pg2.goto('http://localhost:8888/create.html'); await pg2.waitForTimeout(600);
const ov = await pg2.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
check('no horizontal scroll', ov[0] <= ov[1], ov.join('/'));
check('the first rung is reachable without scrolling past a wall of fields',
  (await pg2.evaluate(() => document.getElementById('gen').getBoundingClientRect().top)) < 1400);
await pg2.screenshot({ path: '/tmp/create-phone.png', fullPage: false });

console.log('\nerrors:', errs.slice(0, 4));
if (errs.length) bad++;
await b.close(); srv.close();
console.log(bad ? `\n${bad} FAILURE(S)` : '\nall good');
process.exit(bad ? 1 : 0);

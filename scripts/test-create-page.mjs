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
let FULL = false;      // Technocore answering "note limit reached"

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let p = u.pathname; if (p === '/') p = '/index.html';
  if (p === '/api/post' && req.method === 'POST') {
    let raw = ''; req.on('data', c => raw += c);
    return req.on('end', () => {
      try { POSTS.push(JSON.parse(raw)); } catch { POSTS.push({ bad: raw }); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(
        FULL ? { ok: false, status: 400, error: '400 note limit reached (50960 is the cap, and this would be a new one). Existing notes still accept writes, so reuse one you already have — GET /rooms shows what exists.' }
        : FAIL ? { ok: false, error: 'nope' }
        : { ok: true }));
    });
  }
  if (p === '/api/room') {
    const room = u.searchParams.get('room') || '';
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ room, count: room === 'd-busy' ? 200 : room === 'twinny' ? 104 : 0, messages: [] }));
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

console.log('\n=== C2. exactly one thing on the page is glowing, and it is the next thing');
const beacon = async () => pg.evaluate(() => {
  const l = [...document.querySelectorAll('.beckon')];
  return { n: l.length, at: l[0] ? (l[0].id || l[0].dataset.act || l[0].dataset.copyval || l[0].textContent.trim()) : null };
});
let bc = await beacon();
console.log('  ', JSON.stringify(bc));
check('one beacon, not several', bc.n === 1, String(bc.n));
check('and it is Download', bc.at === 'saveTxt', String(bc.at));
check('Download leads the row',
  await pg.evaluate(() => document.getElementById('saveTxt').parentElement.firstElementChild.id === 'saveTxt'));
check('and is the solid button, not a ghost',
  !(await pg.evaluate(() => document.getElementById('saveTxt').className)).includes('ghost'));

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
bc = await beacon();
check('the beacon moved to the gate', bc.n === 1 && bc.at === 'gateGo', JSON.stringify(bc));

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
/* The scroll has to wait out the collapse of the rung being left behind:
   started before that settles, it aims at a position the page no longer has
   by the time it gets there. */
await pg.waitForTimeout(1100);
check('and the page went to "Publish your note"', await pg.evaluate(() => {
  const r = document.getElementById('t-note').getBoundingClientRect();
  return r.top > -30 && r.top < innerHeight * 0.85;
}), await pg.evaluate(() => Math.round(document.getElementById('t-note').getBoundingClientRect().top) + 'px from the top'));
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

console.log('\n=== D2. and it keeps moving, one at a time');
bc = await beacon();
check('one beacon after the gate', bc.n === 1, String(bc.n));
check('on the rung that is now live', bc.at === 'note', String(bc.at));

console.log('\n=== E2. the button sits with the field it acts on');
const gap = await pg.evaluate(() => {
  const out = {};
  for (const id of ['note', 'hello', 'intro']) {
    const step = document.getElementById('t-' + id);
    const last = step.querySelector('.picks') || step.querySelector('textarea');
    const btn = step.querySelector('.actionrow button[data-act]');
    out[id] = Math.round(btn.getBoundingClientRect().top - last.getBoundingClientRect().bottom);
  }
  return out;
});
console.log('   px between the field and its button:', JSON.stringify(gap));
check('nothing is pushed more than a line away from its own button',
  Object.values(gap).every(v => v < 60), JSON.stringify(gap));

console.log('\n=== F. publish the note, post the message');
POSTS = [];
await pg.click('#t-note .actionrow button[data-act]');
await pg.waitForFunction(() => document.getElementById('t-note').className.includes('done'), null, { timeout: 15000 });
check('the note rung is done', (await stateOf('note')) === 'done');
check('and a note went to the network', POSTS.some(p => p.kind === 'note'), JSON.stringify(POSTS.map(p => p.kind)));
check('the verdict moved to REGISTERED', (await pg.locator('#tierWord').textContent()) === 'REGISTERED');
check('the finish panel does NOT appear yet', await pg.locator('#finish').isHidden());

await pg.click('#t-hello .actionrow button[data-act]');
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
check('and points at this identity\'s card',
  ((await pg.locator('#seeCard').getAttribute('href')) || '').startsWith('/?did=did%3Akey%3Az6Mk'));
await pg.screenshot({ path: '/tmp/create-3-done.png', clip: { x: 0, y: 0, width: 1240, height: 950 } });

check('the finish STILL does not appear at four of eight', await pg.locator('#finish').isHidden());
check('it sits BELOW the side quests in the document',
  await pg.evaluate(() => document.getElementById('finish').compareDocumentPosition(
    document.getElementById('side')) & Node.DOCUMENT_POSITION_PRECEDING));
check('the ladder carried on into a side quest', (await cls('t-intro')).includes('open'));
check('and the page scrolled to it', await pg.evaluate(() => {
  const r = document.getElementById('t-intro').getBoundingClientRect();
  return r.top > -40 && r.top < innerHeight; }));

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

console.log('\n=== F4. the room field: the rule is furniture, not something to type');
await ensureOpen('room');
check('the d- is shown, outside the box', (await pg.locator('#roomWrap .pfx').textContent()).trim() === 'd-');
check('and it is not in the input', (await pg.locator('#roomName').inputValue()) === '');
check('the placeholder no longer teaches a prefix',
  (await pg.locator('#roomName').getAttribute('placeholder')) === 'yourname');

await pg.fill('#roomName', 'taken');
await pg.waitForFunction(() => /is taken/.test(document.getElementById('roomAvail').textContent), null, { timeout: 6000 });
check('a claimed name says so before anything is signed',
  /d-taken is taken/.test(await pg.locator('#roomAvail').textContent()),
  await pg.locator('#roomAvail').textContent());
check('in red', (await pg.locator('#roomAvail').getAttribute('class')).includes('bad'));
POSTS = [];
await pg.click('#t-room .actionrow button[data-act]');
await pg.waitForTimeout(600);
check('and claiming it never reaches the network', POSTS.length === 0, `${POSTS.length} posts`);

console.log('\n=== F4a. when the network itself refuses, it must not read as your mistake');
/* Technocore caps notes at 50,960 PER NAMESPACE, and a room claim is one key
   in `room-owners`. When that namespace is full no client anywhere can claim
   a new room — so "try a different name", which is what the raw error invites,
   cannot work. */
FULL = true;
await pg.fill('#roomName', 'another-name');
await pg.waitForFunction(() => /is available/.test(document.getElementById('roomAvail').textContent), null, { timeout: 6000 });
await pg.click('#t-room .actionrow button[data-act]');
await pg.waitForTimeout(1000);
const capMsg = (await pg.locator('#roomCap').innerText()) || '';
console.log('   ', capMsg.slice(0, 120) + '…');
check('it does not pass the raw error through',
  !/Technocore said/.test(await pg.evaluate(() => document.body.innerText)));
check('it names the limit', /50,960 ownership records/.test(capMsg));
check('and says it is not this name', /not about your name/.test(capMsg));
check('and says it is not just this site', /on any site/.test(capMsg));
check('and says when it clears', /about a week/.test(capMsg) && /7 days/.test(capMsg));
check('and it does not repeat Technocore\'s own wording at anyone',
  !/note limit reached/.test(await pg.evaluate(() => document.body.innerText)));
check('the rung is marked blocked, not failed', (await cls('t-room')).includes('blocked'));
check('and it is not marked done', (await stateOf('room')) !== 'done');
check('the notice is a box, not a red line', await pg.locator('#roomCap').isVisible());
check('and it leads with plain words',
  /run out of space for new rooms/.test((await pg.locator('#roomCap b').textContent()) || ''));
check('it says nobody can, not just you', /nobody<\/em>? can|nobody/i.test(await pg.locator('#roomCap').innerText()));
check('it says you can come back', /come back/.test(await pg.locator('#roomCap').innerText()));
check('the suggested names are hidden — every one of them is equally refused',
  await pg.locator('#t-room .picks').isHidden());
check('and so is the availability line', await pg.locator('#roomAvail').isHidden());
FULL = false;

await pg.fill('#roomName', 'my-lab');
await pg.waitForFunction(() => /d-my-lab is available/.test(document.getElementById('roomAvail').textContent), null, { timeout: 8000 });
check('a free one says available', /d-my-lab is available/.test(await pg.locator('#roomAvail').textContent()),
  JSON.stringify(await pg.locator('#roomAvail').textContent()));
check('in green', (await pg.locator('#roomAvail').getAttribute('class')).includes('free'));
POSTS = [];   // the refused claim above is still in there
await pg.click('#t-room .actionrow button[data-act]');
await pg.waitForFunction(() => document.getElementById('t-room').className.includes('done'), null, { timeout: 10000 });
const claim = POSTS.find(p => p.kind === 'claim');
check('the claim carries the WHOLE name, prefix and all', claim?.room === 'd-my-lab', claim?.room);
check('and a shareable link comes back', await pg.locator('#roomOut').isVisible());
check('pointing at the room just claimed',
  (await pg.locator('#roomLink').textContent()) === 'technocore.chat/r/d-my-lab',
  await pg.locator('#roomLink').textContent());

console.log('\n=== F4a2. unowned is not the same as unused');
await pg.fill('#roomName', 'busy');
await pg.waitForFunction(() => /already exists/.test(document.getElementById('roomAvail').textContent), null, { timeout: 6000 });
const busy = await pg.locator('#roomAvail').textContent();
console.log('   ', busy);
check('an unclaimed room with other people in it is not just "available"',
  /unclaimed/.test(busy) && /200 messages/.test(busy));
check('and it is amber, not green', (await pg.locator('#roomAvail').getAttribute('class')).includes('warn'));

console.log('\n=== F4a3. the room people picture, and the room they would get');
/* "test says available — surely that is taken?" It is: the room called `test`
   is busy. `d-test` is a different room and it is empty, and saying only
   "available" leaves somebody arguing with the page. */
await pg.fill('#roomName', 'twinny');
await pg.waitForFunction(() => !document.getElementById('roomTwin').hidden, null, { timeout: 8000 });
const twin = (await pg.locator('#roomTwin').textContent()).replace(/\s+/g, ' ');
console.log('   ', twin);
check('the green line says WHY it is free', /no owner, and no messages/.test(await pg.locator('#roomAvail').textContent()),
  await pg.locator('#roomAvail').textContent());
check('and the un-prefixed room of the same name is named and counted',
  /separate room called/.test(twin) && /104 messages/.test(twin));
check('with the claim scoped to the prefixed one', /does not touch it/.test(twin));
await pg.fill('#roomName', 'my-lab');
await pg.waitForFunction(() => document.getElementById('roomTwin').hidden, null, { timeout: 8000 });
check('and no note at all when there is no twin', await pg.locator('#roomTwin').isHidden());

console.log('\n=== F4b. a name too short to be worth a permanent slot');
POSTS = [];
await pg.fill('#roomName', '11');
await pg.waitForTimeout(700);
check('says so while typing, not after signing', /Too short/.test(await pg.locator('#roomAvail').textContent()),
  await pg.locator('#roomAvail').textContent());

console.log('\n=== F4c. the proof rung: generate, then copy, and nothing else');
await ensureOpen('proof');
const pbtns = await pg.evaluate(() => [...document.querySelectorAll('#t-proof button, #t-proof a.go')]
  .filter(b => b.offsetParent !== null).map(b => b.textContent.trim()));
console.log('   visible controls:', JSON.stringify(pbtns));
check('two, before it runs: the action and the skip', pbtns.length === 2, JSON.stringify(pbtns));
check('and the action says Generate', pbtns[0] === 'Generate');
check('no duplicate action in the head of an open rung',
  await pg.locator('#t-proof .shead button[data-act]').isHidden());
await pg.click('#t-proof .actionrow button[data-act]');
await pg.waitForFunction(() => document.getElementById('t-proof').className.includes('done'), null, { timeout: 15000 });
await pg.waitForTimeout(400);
check('a link came out', /\/v#b=/.test((await pg.locator('#proofLink').textContent()) || ''));
check('with one Copy beside it', (await pg.locator('#proofOut [data-copyval]').count()) === 1);
check('and the beacon is on that Copy, because it is what you do next',
  (await beacon()).at === 'proofLink', JSON.stringify(await beacon()));
await pg.click('#proofOut [data-copyval]');
await pg.waitForTimeout(400);
check('copying moves the beacon on', (await beacon()).at !== 'proofLink', JSON.stringify(await beacon()));

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

console.log('\n=== F6. the page is about making one, full stop');
check('no unlock panel at all', (await pg.locator('#unlock').count()) === 0);
const back = await ctx.newPage();
await back.addInitScript(() => localStorage.setItem('overheard.identity',
  JSON.stringify({ v: 1, did: 'did:key:z6MkTEST', salt: 'x', iv: 'y', data: 'z' })));
await back.goto('http://localhost:8888/create.html'); await back.waitForTimeout(600);
check('not even for a browser that holds an identity', (await back.locator('#unlock').count()) === 0);
check('the only passphrase fields left are the backup file\'s own two',
  (await back.locator('input[type=password]').count()) === 2,
  `${await back.locator('input[type=password]').count()}`);
await back.close();

console.log('\n=== F6b. the end of the ladder, and the party');
// skip what is left, which is what somebody does when the network refuses one
for (const id of ['intro', 'proof', 'priv']) {
  if ((await stateOf(id)) === 'done') continue;
  await ensureOpen(id);
  await pg.click(`#t-${id} [data-skip]`);
  await pg.waitForTimeout(600);
}
console.log('   (and a skipped rung can be re-entered)');
check('a skipped rung offers a way back',
  (await pg.locator('#t-intro .shead button[data-act]').textContent()) === 'Try again',
  await pg.locator('#t-intro .shead button[data-act]').textContent());
await pg.click('#t-intro .shead button[data-act]');
await pg.waitForTimeout(800);
check('which un-skips it', !(await cls('t-intro')).includes('skipped'));
check('and makes it live and open again',
  (await cls('t-intro')).includes('live') && (await cls('t-intro')).includes('open'));
check('with its real action back', (await pg.locator('#t-intro .actionrow button[data-act]').textContent()) === 'Post');
await pg.click('#t-intro [data-skip]');
await pg.waitForTimeout(600);

check('every rung is settled', await pg.evaluate(() =>
  [...document.querySelectorAll('.step')].every(s =>
    s.classList.contains('done') || s.classList.contains('skipped'))));
check('NOW the finish appears', await pg.locator('#finish').isVisible());
check('it says the setup is correct', /Set up correctly/.test((await pg.locator('#finishTitle').textContent()) || ''));
/* The reported confusion: this page says VERIFIED, the card says REGISTERED,
   and nothing tells you the second one is simply a few minutes behind. */
const fin = await pg.locator('#finishBody').textContent();
check('and it says the card lags rather than letting it look like a failure',
  /REGISTERED/.test(fin) && /archive/.test(fin), fin.slice(0, 80) + '…');
check('the verdict is marked as a forecast, not the card as it stands',
  await pg.locator('#tierLag').isVisible());

/* Both pages leave the same record, so the card can say which message and
   how long ago rather than a generic "just posted?". */
const wit = await pg.evaluate(() => {
  const k = Object.keys(localStorage).find(x => x.startsWith('overheard.posted.'));
  return k ? JSON.parse(localStorage.getItem(k)) : null;
});
check('and this browser left the card page a record of the signed message',
  !!wit && wit.room === 'lobby' && !!wit.sig && !!wit.ts, JSON.stringify(wit && wit.room));

check('it arrives rather than appearing', (await pg.locator('#finish').getAttribute('class')).includes('arrive'));
await pg.waitForTimeout(700);
check('and there is confetti', (await pg.locator('canvas.confetti').count()) === 1);
await pg.screenshot({ path: '/tmp/create-4-party.png' });
await pg.waitForTimeout(4200);
check('which cleans itself up', (await pg.locator('canvas.confetti').count()) === 0);

console.log('\n=== F6c. reduced motion gets the result without the party');
const calm = await ctx.newPage(); await calm.emulateMedia({ reducedMotion: 'reduce' });
await calm.goto('http://localhost:8888/create.html'); await calm.waitForTimeout(400);
await calm.click('#gen'); await calm.waitForTimeout(1500);
await calm.click('#saveTxt').catch(() => {});
await calm.waitForTimeout(600);
await calm.click('#gateGo'); await calm.waitForTimeout(700);
for (const id of ['note', 'hello']) {
  await calm.click(`#t-${id} .actionrow button[data-act]`).catch(() => {});
  await calm.waitForTimeout(900);
}
for (const id of ['intro', 'room', 'proof', 'priv']) {
  const open = await calm.evaluate((i) => document.getElementById('t-' + i).className.includes('open'), id);
  if (!open) { await calm.click(`#t-${id} .shead`); await calm.waitForTimeout(300); }
  await calm.click(`#t-${id} [data-skip]`).catch(() => {});
  await calm.waitForTimeout(400);
}
check('the finish still arrives', await calm.locator('#finish').isVisible());
check('but no confetti for anyone who asked for less motion',
  (await calm.locator('canvas.confetti').count()) === 0);
await calm.close();

console.log('\n=== F7. the footer matches the card page');
const foot = await pg.evaluate(() => document.querySelector('footer').innerText);
check('two rows', (await pg.locator('footer .frow').count()) === 2);
const fw = await pg.evaluate(() => {
  const f = document.querySelector('footer').getBoundingClientRect();
  const s = document.querySelector('.shell').getBoundingClientRect();
  return { footer: Math.round(f.width), column: Math.round(s.width), doc: document.documentElement.clientWidth };
});
console.log('   ', JSON.stringify(fw));
check('a full-bleed footer does not give the page a sideways scrollbar',
  await pg.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  await pg.evaluate(() => `${document.documentElement.scrollWidth}/${document.documentElement.clientWidth}`));
check('and it is the page width, not the column width', fw.footer > fw.column + 200 && fw.footer <= fw.doc,
  `${fw.footer} vs a ${fw.column} column`);
check('names the builder and links X', /Built by\s+Pranjal Bora/.test(foot)
  && (await pg.locator('footer a[href="https://x.com/Crypto_Pranjal"]').count()) === 1);
check('carries the whole DID', foot.includes('did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz'));
check('and the DID opens its own card',
  (await pg.locator('footer .bydid').getAttribute('href')) === '/?did=did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz');

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

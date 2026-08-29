/* Proof of Learning, played.
 *
 * A learning game has two ways to fail that a normal page does not. It can
 * TEACH SOMETHING FALSE — worse than teaching nothing, because people repeat
 * it — and it can hand out a score that means nothing, which is what every
 * shareable quiz result on the internet is.
 *
 * So this reads the briefing, plays a perfect run and a terrible one, checks
 * the arithmetic of the scoring, checks that a wrong answer still leaves
 * somebody knowing the right one, and checks the signed card: with a key it
 * produces a proof link the Verify page accepts, and without one it says out
 * loud that the picture proves nothing.
 *
 * Two things here are regression tests for complaints, not inventions:
 *   · the page must not MOVE while it is played — the stage reserves its
 *     height, so answering a gate cannot pull the footer up the screen;
 *   · nothing may be labelled as $FLOP earned. This game hands out POINTS.
 *     No token is distributed by it, and the card is the most screenshotted
 *     surface on the site.
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
const ctx = await b.newContext({
  viewport: { width: 1100, height: 1000 },
  permissions: ['clipboard-read', 'clipboard-write'],       // the copy button is measured, not assumed
});
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
/* Anchored on the `], right:N,` that closes every gate's option list — a bare
   `right:` also lives in the stylesheet, and grading the paper against a CSS
   offset is exactly the kind of silent wrong the rest of this file exists to
   catch. */
const ANSWERS = [...src.matchAll(/\],\s*right:(\d),/g)].map(m => Number(m[1]));
if (ANSWERS.length !== 12) { console.log('  FAIL  the answer key did not parse', ANSWERS.length); process.exit(1); }

const clearLevelCard = async () => {
  if (await pg.locator('.levelup:not(.out)').count()) {
    await pg.click('.levelup:not(.out)');
    await pg.waitForTimeout(500);
  }
};

console.log('=== A. the start');
await go();
check('it opens as a run, not a lecture', /agent/i.test(await pg.locator('h1').first().textContent()));
check('it says how long it takes', /3 min|three min/i.test(await pg.locator('.facts').textContent()));
/* The project has not launched and its own document says so. A learning page
   that repeats provisional numbers as settled is how a draft becomes a rumour. */
const prov = (await pg.locator('.prov').first().textContent()) || '';
check('it says up front that the numbers are provisional',
  /provisional/i.test(prov) && /0\.1|draft/i.test(prov), prov.slice(0, 70));
check('and links the source it is drawn from',
  (await pg.locator('a[href*="flop.finance/teaser"]').count()) >= 1);
check('nothing is graded before it starts', await pg.locator('#run').isHidden());
/* The reading happens HERE. An off-site whitepaper is a source to cite, never
   the place a reader is sent before being asked twelve questions. */
const offsiteButtons = await pg.evaluate(() =>
  [...document.querySelectorAll('#intro .go')].filter(a => /^https?:/.test(a.getAttribute('href') || '')).length);
check('the way to read is our own page, not somebody else\'s site', offsiteButtons === 0);

console.log('\n=== A2. the toy');
/* A physics toy is the one thing on a page that cannot be checked by reading
   the markup: it either behaves or it does not. Everything here is measured
   off the running simulation. */
/* Wait for it to go quiet rather than guessing a number: the claim is that a
   heap SETTLES, and a deadline is the honest way to state it. */
await pg.waitForFunction(() =>
  window.__toy && window.__toy.coins.length >= 20
  && window.__toy.coins.every(c => Math.hypot(c.vx, c.vy) < 1), null, { timeout: 14000 });
/* The sleep flag is decided on a third-of-a-second displacement window, so it
   trails the moment everything stops by up to that much. Give the last window
   time to close before counting sleepers. */
await pg.waitForTimeout(700);
const toy = () => pg.evaluate(() => {
  const t = window.__toy;
  return {
    n: t.coins.length, fed: t.fed, floor: t.FLOOR, wall: t.WALL, w: t.WORLD,
    asleep: t.coins.filter(c => c.sleeping).length,
    below: t.coins.filter(c => c.y + c.r > t.FLOOR + 1.5).length,
    outside: t.coins.filter(c => c.x - c.r < t.WALL - 2 || c.x + c.r > t.WORLD - t.WALL + 2).length,
    stacked: t.coins.filter(c => c.sleeping && c.y + c.r < t.FLOOR - 6).length,
    head: { dx: t.HEAD.dx, dy: t.HEAD.dy },
  };
});
const t0 = await toy();
console.log('   ', JSON.stringify(t0));
check('the tokens arrived', t0.n >= 15, `${t0.n} on the field`);
/* Nothing may sink through the floor or squeeze through a wall — the two
   failures that make a solver look broken at a glance. */
check('none of them fell through the floor', t0.below === 0);
check('and none squeezed out of the well', t0.outside === 0);
/* A heap is the proof the contact solver holds: tokens resting ON tokens,
   asleep, rather than buzzing or sinking into each other. */
check('they settle into a heap that holds', t0.stacked >= 5, `${t0.stacked} resting off the floor`);
/* The strong claim is above, in the waitForFunction: not one token is moving.
   This is the cheaper one — that the solver has actually PARKED them rather
   than holding them still frame by frame. */
check('and the heap goes to sleep rather than being held still',
  t0.asleep === t0.n, `${t0.asleep} of ${t0.n} asleep`);

/* THROWING. Velocity comes from the last few pointer samples, so a flick has
   to actually throw — a drop is the bug this replaces. */
const tbox = await pg.locator('#toy').boundingBox();
const dims = await pg.evaluate(() => ({ w: window.__toy.WORLD, h: window.__toy.WH }));
const w2s = (wx, wy) => ({ x: tbox.x + wx / dims.w * tbox.width, y: tbox.y + wy / dims.h * tbox.height });
/* Tagged, not indexed: eating splices the array, and an index into a list
   that shifts under you measures the wrong token. */
await pg.evaluate(() => {
  const c = window.__toy.coins.find(k => k.sleeping) || window.__toy.coins[0];
  /* Parked and asleep, so it is still where the test last saw it when the
     grab lands — a falling token has moved on by the time a round trip
     through the browser gets back. */
  c.__tag = 1; c.x = 80; c.y = 210; c.vx = 0; c.vy = 0; c.still = 9;
});
const tagged = () => pg.evaluate(() => window.__toy.coins.find(k => k.__tag) || null);
await pg.waitForTimeout(40);
let g = await tagged();
let sp = w2s(g.x, g.y);
await pg.mouse.move(sp.x, sp.y); await pg.mouse.down();
for (let i = 1; i <= 12; i++) { const q = w2s(g.x + 26 * i, g.y - 8 * i); await pg.mouse.move(q.x, q.y); }
const at = await tagged();
await pg.mouse.up();
const flung = await pg.evaluate(() => { const c = window.__toy.coins.find(k => k.__tag);
  return c ? Math.round(Math.hypot(c.vx, c.vy)) : -1; });
check('a flick throws it', flung > 300, `${flung} px/s off the hand`);
/* Speed on release is only half the claim — the other half is that it keeps
   going. A number in a variable that the next frame eats is not a throw. */
await pg.waitForTimeout(260);
const went = await pg.evaluate((from) => { const c = window.__toy.coins.find(k => k.__tag);
  return c ? Math.round(Math.hypot(c.x - from.x, c.y - from.y)) : -1; }, { x: at.x, y: at.y });
check('and it carries', went > 60, `${went}px travelled after release`);

/* THE HEAD. It resists — pull it a long way and it barely moves, because the
   restoring force grows with the cube of the displacement. */
const pulled = await pg.evaluate(() => {
  window.__toy.pull(300, -160);
  return { d: Math.round(Math.hypot(window.__toy.HEAD.dx, window.__toy.HEAD.dy)), max: window.__toy.MAXPULL };
});
check('the head resists being pulled', pulled.d <= pulled.max + 1 && pulled.d > 10,
  `300px of pull moved it ${pulled.d}px, limit ${pulled.max}`);
await pg.evaluate(() => window.__toy.drop());
await pg.waitForTimeout(240);
const landed = await pg.evaluate(() => ({ shake: window.__toy.shake, cap: document.getElementById('toyCap').textContent }));
check('and letting go lands it with an impact', landed.shake > 0.02, `shake ${landed.shake.toFixed(2)}`);
check('which the page says out loud', /felt that/i.test(landed.cap), landed.cap);
await pg.waitForTimeout(900);
const rested = await pg.evaluate(() => Math.round(Math.hypot(window.__toy.HEAD.dx, window.__toy.HEAD.dy) * 10) / 10);
check('then it settles back', rested < 2, `${rested}px off centre`);

/* FEEDING — the point of the whole object. */
const fedBefore = (await toy()).fed;
await pg.evaluate(() => window.__toy.feed());
await pg.waitForTimeout(1400);
const fedAfter = await toy();
check('a token dropped down the slot is eaten', fedAfter.fed === fedBefore + 1, `${fedBefore} → ${fedAfter.fed}`);
check('and the caption says so', /Fed|ate that/i.test(await pg.locator('#toyCap').textContent()));
await pg.waitForTimeout(900);
check('and another one arrives to replace it', (await toy()).n >= t0.n - 1);

/* Two buttons side by side are one row, so they are one height — different
   label sizes plus vertical padding will not deliver that on its own. */
const heights = async () => pg.evaluate(() => [...document.querySelectorAll('.hero .nextrow .go')]
  .map(b => Math.round(b.getBoundingClientRect().height)));
for (const w of [1400, 1180, 900, 420]) {
  await pg.setViewportSize({ width: w, height: 1000 });
  await pg.waitForTimeout(220);
  const hs = await heights();
  check(`the two buttons are the same height at ${w}px`,
    hs.length === 2 && hs[0] === hs[1], hs.join(' vs '));
}
await pg.setViewportSize({ width: 1100, height: 1000 });
await pg.waitForTimeout(200);

console.log('\n=== B. the briefing');
await pg.click('#toBrief');
await pg.waitForTimeout(400);
check('it opens in place', await pg.locator('#brief').isVisible() && await pg.locator('#intro').isHidden());
const blocks = await pg.locator('.blk').count();
check('broken into blocks, not a wall of text', blocks === 8, `${blocks} blocks`);
const longest = await pg.evaluate(() =>
  Math.max(...[...document.querySelectorAll('.blk')].map(b => b.textContent.trim().length)));
check('no block is a wall on its own', longest < 1000, `longest block ${longest} chars`);
check('every block leads with an icon', await pg.locator('.blk .badge svg').count() === blocks);
check('the numbers are drawn, not just listed',
  (await pg.locator('.alloc i').count()) === 6 && (await pg.locator('.splitbar i').count()) === 2
  && (await pg.locator('.tl li').count()) === 3);
/* The whole point of the rewrite: the reader is never stranded at the bottom
   of the reading with no way into the run. */
check('the way into the run follows you down the page',
  await pg.locator('#beginFromBrief').isVisible());
await pg.evaluate(() => scrollTo(0, document.body.scrollHeight));
await pg.waitForTimeout(900);
check('and is still there at the bottom', await pg.locator('#beginFromBrief').isVisible());
const readTxt = (await pg.locator('#readbar .txt').textContent()) || '';
check('reading progress is shown', /\d of 8 read|Briefing read/.test(readTxt), readTxt.slice(0, 40));
/* Scrolling to the end IS reading it, so the spine should be full and the way
   into the run should be the loud thing on the page. */
check('reaching the end counts as read', /Briefing read/.test(readTxt), readTxt.slice(0, 30));
check('and the spine filled in behind you',
  (await pg.evaluate(() => document.getElementById('spineFill').style.height)) === '100%');
check('the button says so too', await pg.locator('#readbar.ready').count() === 1);

/* Three ways forward, and all three have to work. Reload for a clean slate. */
await go(); await pg.click('#toBrief'); await pg.waitForTimeout(500);
check('every block has its own way to be marked read', (await pg.locator('.gotit').count()) === 8);
await pg.locator('.gotit').first().click();
await pg.waitForTimeout(700);
check('tapping Got it marks the block read', await pg.locator('.blk').first().evaluate(e => e.classList.contains('done')));
check('and says so on the button', /Read/.test(await pg.locator('.gotit').first().textContent()));
check('the next block becomes the live one',
  await pg.locator('.blk').nth(1).evaluate(e => e.classList.contains('cur')));
const oneRead = await pg.evaluate(() => document.getElementById('spineFill').style.height);
check('one of eight lights the spine', oneRead === '13%', oneRead);
/* A swipe left is the same gesture as a thumb flicking a card away. */
const swiped = await pg.evaluate(() => {
  const b = document.querySelectorAll('.blk')[1];
  const r = b.getBoundingClientRect();
  const at = (t, x) => b.dispatchEvent(new PointerEvent(t, {
    clientX: x, clientY: r.top + 40, bubbles: true, button: 0, pointerId: 1,
  }));
  at('pointerdown', r.left + 260); at('pointermove', r.left + 120); at('pointerup', r.left + 60);
  return b.classList.contains('done');
});
check('and a swipe left does the same', swiped);
/* Everything the run asks about must be somewhere in the briefing. Spot-check
   the load-bearing figures rather than every word. */
const briefText = (await pg.locator('#brief').textContent()) || '';
for (const bit of ['85%', '16', '1,000', '17.2 billion', '51.2%', 'Q4 2026', 'Q1 2027', '0.1'])
  check(`the briefing covers ${bit}`, briefText.includes(bit));

console.log('\n=== C. a perfect run');
await pg.click('#beginFromBrief');
await pg.waitForTimeout(400);
/* Each level is announced before its first gate — the breath between rounds
   that stops twelve questions being a form. It is skippable, which is what
   makes it a flourish rather than a wait. */
check('the level is announced before its first gate', await pg.locator('.levelup').first().isVisible());
check('and names what is coming', /Boot/.test(await pg.locator('.levelup h3').first().textContent()));
/* It used to move on by itself after 1.6s while telling people to tap, so the
   tap was a race nobody knew they were in. It waits. */
await pg.waitForTimeout(2600);
check('and it WAITS rather than moving on by itself', await pg.locator('.levelup').first().isVisible());
check('with a button, not only a hint', await pg.locator('.levelup .go').isVisible());
await clearLevelCard();
check('one tap skips it', (await pg.locator('.levelup').count()) === 0);
check('the first gate is on screen', await pg.locator('.opt').first().isVisible());
check('with a clock that shows the speed bonus draining', await pg.locator('.clock').first().isVisible());
check('and a pip per gate in the head', (await pg.locator('#pips i').count()) === 12);

/* ── THE PAGE MUST NOT MOVE ───────────────────────────────────────────────
   The complaint that started this rewrite: answering a gate grew the stage
   and the next gate shrank it, so the footer visibly jumped up the page
   between every question. The stage now reserves its height, which is only
   worth anything if it is measured. */
const footTop = () => pg.evaluate(() =>
  Math.round(document.querySelector('overheard-foot').getBoundingClientRect().top));
const before = await footTop();
await pg.locator('.opt').nth(ANSWERS[0]).click();
await pg.waitForSelector('.cleared', { timeout: 10000 });
await pg.waitForTimeout(500);
const afterAnswer = await footTop();
check('answering does not move the page', Math.abs(afterAnswer - before) <= 1,
  `footer ${before} → ${afterAnswer}`);
check('the gate-cleared screen is its own moment',
  await pg.locator('.cleared .stamp.ok').isVisible()
  && /cleared|in a row|fire/i.test(await pg.locator('.verdict').textContent()));
const plus = (await pg.locator('.plus').textContent()) || '';
check('scored in POINTS, never in $FLOP', /\+\d+ points/.test(plus) && !/FLOP/.test(plus), plus.trim());
await pg.keyboard.press('Enter');
await pg.waitForTimeout(500);
await clearLevelCard();
const afterNext = await footTop();
check('and moving on does not move it back', Math.abs(afterNext - before) <= 1,
  `footer ${before} → ${afterNext}`);
check('Enter moves on', (await pg.locator('#gateNo').textContent()) === '2');

/* Back to the top, so the run below starts clean. */
await go(); await pg.click('#begin'); await pg.waitForTimeout(400);

const play = async (pickRight) => {
  const seen = [];
  for (let i = 0; i < 12; i++) {
    await clearLevelCard();
    await pg.waitForSelector('.opt:not([disabled])', { timeout: 10000 });
    const gate = await pg.evaluate(() => ({
      beat: document.querySelector('.beat')?.textContent || '',
      q: document.querySelector('.q')?.textContent || '',
      n: document.getElementById('gateNo').textContent,
      chips: document.querySelectorAll('#stage .chip').length,
      opts: [...document.querySelectorAll('.opt:not([disabled])')].map(o => o.textContent),
    }));
    seen.push(gate);
    const right = ANSWERS[i];
    const idx = pickRight ? right : (right + 1) % 4;
    await pg.locator('.opt:not([disabled])').nth(idx).click();
    await pg.waitForSelector('.cleared', { timeout: 10000 });
    await pg.click('#stage .nextrow .go');
    await pg.waitForTimeout(400);
  }
  return seen;
};

const seen = await play(true);
/* Every gate sets its ground before it asks. That is the difference between a
   game and an exam, so it is checked at every gate rather than once. */
check('twelve gates, and every one of them set up first',
  seen.length === 12 && seen.every(g => g.beat.length > 40),
  `shortest set-up: ${Math.min(...seen.map(g => g.beat.length))} chars`);
check('with the key words shown, not buried in prose', seen.every(g => g.chips >= 1));
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
check('the tally counts points', /points/.test(perfect.tally) && !/FLOP/.test(perfect.tally), perfect.tally);
check('nothing is left to look at again', await pg.locator('#missed').isHidden());

console.log('\n=== D. the card');
const card = await pg.evaluate(() => {
  const c = document.getElementById('card');
  const x = c.getContext('2d');
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 240) lit++;
  return { w: c.width, h: c.height, lit };
});
check('it is drawn, not blank', card.lit > 4000, JSON.stringify(card));
check('and it deals itself in', await pg.locator('#cardwrap.reveal').count() === 1);

/* THE TILT. On the credential card this silently stopped working twice — once
   to a CSS transition that put the card most of a second behind the cursor,
   once to an animation with fill:both whose last keyframe outranked the inline
   style for good. Both were invisible by eye and obvious to a measurement, so
   it gets measured: move over the card, read the matrix, leave, read it back. */
await pg.waitForTimeout(1300);                    // let the deal finish
const box = await pg.locator('#cardwrap').boundingBox();
await pg.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.2);
await pg.waitForTimeout(450);
const tilted = await pg.evaluate(() => getComputedStyle(document.getElementById('cardwrap')).transform);
check('the card tilts toward the cursor', tilted !== 'none' && tilted !== 'matrix(1, 0, 0, 1, 0, 0)', tilted.slice(0, 46));
await pg.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.8);
await pg.waitForTimeout(450);
const other = await pg.evaluate(() => getComputedStyle(document.getElementById('cardwrap')).transform);
check('and tilts the other way at the other corner', other !== tilted, other.slice(0, 46));
await pg.mouse.move(10, 10);
await pg.waitForTimeout(800);
const flat = await pg.evaluate(() => document.getElementById('cardwrap').style.transform);
check('and settles flat when the cursor leaves', flat === '', `"${flat}"`);
check('at a size X will not crop badly', card.w === 1200 && card.h === 630);
/* The one place a wrong word would travel furthest. */
check('the card says POINTS, not $FLOP EARNED',
  /stat\("POINTS"/.test(src) && !/\$FLOP EARNED/.test(src));

/* The card is the artefact somebody posts, so it is checked as one: a hero
   that carries the result, and a look that differs by rank — two people with
   different runs must not get the same picture with a different word in it. */
const shape = await pg.evaluate(() => {
  const c = document.getElementById('card'), x = c.getContext('2d');
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
  for (const n of [12, 10, 8, 5, 1]) { window.__setCorrect(n); out.push(grab()); }
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

console.log('\n=== E. an unsigned run says so, and offers both ways in');
const unsignedNote = (await pg.locator('#signedBox').textContent()) || '';
check('it admits a picture proves nothing',
  /Unsigned/.test(unsignedNote) && /edit a score/i.test(unsignedNote), unsignedNote.slice(0, 60));
check('it names both ways forward', /Sign in with your identity, or make one/.test(unsignedNote));
check('signing in is a button, not a trip to another page',
  (await pg.locator('#signedBox button.go').count()) === 1);
check('and making one is the second, quieter offer',
  (await pg.locator('#signedBox a[href="/create.html"]').count()) === 1);
/* With no key in this browser there is nothing to type a passphrase INTO, so
   the box must not be there. */
check('no passphrase box, because there is no key here', (await pg.locator('#quickPw').count()) === 0);
await pg.locator('#signedBox button.go').click();
await pg.waitForTimeout(400);
check('Sign in opens the pop-up rather than navigating away', await pg.locator('#scrim').isVisible());
check('with the safe way offered first', await pg.locator('#wayFile.on').count() === 1);
await pg.click('#waySeed'); await pg.waitForTimeout(250);
check('a seed is the other way, and it warns what a seed is',
  /identity itself/i.test(await pg.locator('.warnbox').textContent()));
check('and it asks you to CHOOSE a passphrase for a seed, not recall one',
  /Choose a passphrase/i.test(await pg.locator('#hPwLabel').textContent())
  && await pg.locator('#hPw2').isVisible());
await pg.click('#wayFile'); await pg.waitForTimeout(200);
await pg.fill('#hDid', 'did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz');
await pg.fill('#hFile', 'did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz');
await pg.fill('#hPw', 'whatever');
await pg.click('#doHave'); await pg.waitForTimeout(400);
/* The commonest wrong paste by a long way, and it deserves the reason. */
check('pasting the DID where the file goes is explained, not just refused',
  /public half/i.test(await pg.locator('#haveSay').textContent()));
await pg.keyboard.press('Escape'); await pg.waitForTimeout(300);
check('Escape closes it', await pg.locator('#scrim').isHidden());

console.log('\n=== E2. a browser that already holds a key is just asked for the passphrase');
/* Build a real vault in the page — same PBKDF2/AES-GCM the Create page writes
   — then reload and unlock it through the UI. This is the whole path somebody
   returning to the site takes, so it gets walked rather than assumed. */
await pg.evaluate(async () => {
  const enc = new TextEncoder();
  const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n; for (const x of [0xed, 0x01, ...raw]) n = n * 256n + BigInt(x);
  let out = ''; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  const did = 'did:key:z' + out;
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', enc.encode('open sesame'), 'PBKDF2', false, ['deriveKey']);
  const aes = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode(JSON.stringify(jwk)));
  localStorage.setItem('overheard.identity', JSON.stringify(
    { v: 1, did, salt: b64u(salt), iv: b64u(iv), data: b64u(ct), created: new Date().toISOString() }));
  localStorage.removeItem('overheard.session');
});
await go(); await pg.click('#begin'); await pg.waitForTimeout(300);
await play(true);
await pg.waitForSelector('#end:not([hidden])', { timeout: 10000 });
check('the passphrase box is right there, not behind a pop-up', await pg.locator('#quickPw').isVisible());
check('and it says whose key this browser is holding',
  /This browser holds/.test(await pg.locator('#signedBox').textContent()));
await pg.fill('#quickPw', 'not the passphrase');
await pg.click('#signedBox .pwrow .go');
await pg.waitForTimeout(1200);
check('a wrong passphrase says so and stays put',
  /Wrong passphrase/i.test(await pg.locator('#signedBox').textContent()));
await pg.fill('#quickPw', 'open sesame');
await pg.click('#signedBox .pwrow .go');
await pg.waitForSelector('#signedBox a.lk', { timeout: 15000 });
/* The point of doing it here rather than sending somebody to another page:
   the run they just finished becomes the signed one. */
check('unlocking signs THIS run, without replaying it',
  /Signed by/.test(await pg.locator('#signedBox').textContent()));
check('and the card is redrawn as signed', await pg.evaluate(() => {
  const c = document.getElementById('card'), x = c.getContext('2d');
  const d = x.getImageData(72, 512, 300, 44).data;   // the footing, left side
  let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 300) lit++;
  return lit > 200;
}));
await pg.evaluate(() => { localStorage.removeItem('overheard.identity'); localStorage.removeItem('overheard.session'); });

console.log('\n=== F. a bad run still teaches');
await go();
await pg.click('#begin');
await pg.waitForTimeout(300);
const wrongSeen = [];
for (let i = 0; i < 12; i++) {
  await clearLevelCard();
  await pg.waitForSelector('.opt:not([disabled])', { timeout: 10000 });
  await pg.locator('.opt:not([disabled])').nth((ANSWERS[i] + 1) % 4).click();
  await pg.waitForSelector('.cleared .stamp.no', { timeout: 10000 });
  wrongSeen.push(await pg.locator('.cleared').first().textContent());
  await pg.click('#stage .nextrow .go');
  await pg.waitForTimeout(400);
}
check('every wrong answer is told which one was right',
  wrongSeen.every(t => /The answer was [A-D]:/.test(t)));
check('and told WHY, not just what', wrongSeen.every(t => t.length > 160));
check('with the source named on every gate', wrongSeen.every(t => /source ·/.test(t)));
check('and no points pretended', wrongSeen.every(t => /no points this gate/.test(t)));

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
check('the run is shown as twelve marks before a word about it',
  (await pg.locator('#endPips i').count()) === 12
  && (await pg.locator('#endPips i.hit').count()) === 0);
check('and each missed gate carries its answer as a chip',
  (await pg.locator('#missed .ans').count()) === 12);
check('and the briefing is offered again', await pg.locator('#reread').isVisible());

console.log('\n=== G. a signed run makes a checkable claim');
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
/* The proof link is one unbroken 700-character string. It broke out of its
   panel and gave the whole page a sideways scrollbar, because a flex item is
   as wide as its content unless it is told min-width:0. */
const wide = await pg.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
check('and does not push the page sideways', wide[0] <= wide[1], wide.join('/'));
check('it is kept to one line inside its box', await pg.evaluate(() => {
  const a = document.querySelector('#signedBox a'), p = document.querySelector('.done');
  return a.getBoundingClientRect().right <= p.getBoundingClientRect().right + 1;
}));
/* A gap, so the signature reads as a note about the card rather than part of it. */
check('with air between it and the card', await pg.evaluate(() => {
  const c = document.querySelector('.stagewrap').getBoundingClientRect();
  const s = document.querySelector('#signedBox').getBoundingClientRect();
  return Math.round(s.top - c.bottom);
}) >= 18);
/* A link nobody can carry away is a link nobody uses. */
check('there is a copy button on it', await pg.locator('#signedBox .copy').isVisible());
await pg.click('#signedBox .copy');
await pg.waitForTimeout(500);
const clip = await pg.evaluate(() => navigator.clipboard.readText());
check('and it copies the whole proof link', clip === link, clip.slice(0, 44) + '…');
check('and says it did', /Copied/.test(await pg.locator('#signedBox .copy').textContent()));

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
check('in points', /points/.test(quoted) && !/FLOP/.test(quoted), quoted.slice(0, 70));
check('so it cannot be edited into a better one', /rank Foundation grade/.test(quoted));
await vp.close();

console.log('\n=== H. the share post');
const post = await pg.evaluate(() => {
  let u = null; window.open = (x) => { u = x; };
  document.getElementById('post').click();
  return decodeURIComponent(new URL(u).searchParams.get('text'));
});
console.log(post.split('\n').filter(Boolean).map(l => '    ' + l).join('\n'));
check('it says what was actually done', /Score: 12\/12/.test(post) && /Foundation grade/.test(post));
check('it claims points, not tokens', /Points: [\d,]+/.test(post) && !/FLOP/.test(post));
check('it tags the project it is about', /@flop_labs/.test(post));
check('it invites somebody to try it', /Try yourself: http/.test(post));
check('and a signed run posts the proof, not a screenshot', /\/v#b=/.test(post));
/* X's own arithmetic, not the string length: every URL counts 23 whatever its
   real length, and most emoji count two. The signed version lands within a
   few characters of the limit, so it is measured rather than eyeballed. */
const xLen = (t) => [...t.replace(/https?:\/\/\S+/g, 'x'.repeat(23))]
  .reduce((n, ch) => n + (ch.codePointAt(0) > 0x2000 && !'—–…‘’“”·'.includes(ch) ? 2 : 1), 0);
check('it fits in a post', xLen(post) <= 280, `${xLen(post)} of 280`);

console.log('\n=== I. your runs');
/* Runs belong to an identity, not to a browser. Somebody signed out sees
   nothing — including, and especially, somebody else's runs sitting in the
   same localStorage on a shared machine. */
await pg.evaluate(() => {
  localStorage.removeItem('overheard.session');
  localStorage.setItem('overheard.pol.runs', JSON.stringify({
    'did:key:z6MkngD8RZKCgJQCkJvHfGyYoCcNCG5rz9Tc7yRmWrMZExaz': [{
      id: 'x', at: new Date().toISOString(), correct: 9, total: 12, score: 999, best: 4,
      marks: Array(12).fill(true), rank: 'Verified miner', proof: null,
    }],
  }));
});
await go();
/* The bar is there for everybody — "sign in to keep your runs" is worth
   saying to somebody who has never seen it — but it must not leak the runs
   sitting in the same storage under a different key. */
check('the bar is there even signed out', await pg.locator('#histIntro .histtoggle').isVisible());
check('but somebody else\'s runs are not shown', (await pg.locator('#histIntro .hrow').count()) === 0);
check('it says why there is nothing',
  /Sign in to see your runs/.test(await pg.locator('#histIntro').textContent()));
/* The title and the subtitle are two lines. They ran together into one when
   the rules that make them stack were scoped to the open panel only. */
check('the bar label is not one run-on line', await pg.evaluate(() => {
  const g = document.querySelector('#histIntro .histtoggle .grow');
  return Math.round(g.querySelector('.hsub').getBoundingClientRect().top
                  - g.querySelector('b').getBoundingClientRect().top) >= 14;
}));
check('with a way to do it', (await pg.locator('#histIntro .histempty .go').count()) === 1);
/* Signed out, the foot of a result is where the offer lands best — the run
   just happened, and it is the only moment somebody can see what they are
   about to lose. It used to show nothing here at all. */
check('the offer is at the foot of a result too', await pg.locator('#histEnd .histempty').count() === 1);
check('worded for the run that just happened',
  /This run was not kept/.test(await pg.locator('#histEnd').textContent()));

/* CLOSED by default. A table of past scores above the start button is a
   question nobody has asked yet — the complaint that produced this drawer. */
check('and it starts closed', (await pg.locator('#histIntro .histpanel.open').count()) === 0);
const drawerH = async () => pg.evaluate(() =>
  Math.round(document.querySelector('#histIntro .histwrap').getBoundingClientRect().height));
check('so it takes up no room', (await drawerH()) === 0, `${await drawerH()}px`);
await pg.click('#histIntro .histtoggle');
await pg.waitForTimeout(700);
check('one tap opens it', (await drawerH()) > 40, `${await drawerH()}px`);
check('and the sign-in offer is what is inside',
  await pg.locator('#histIntro .histempty .go').isVisible());
await pg.locator('#histIntro .histempty .go').click();
await pg.waitForTimeout(400);
check('which opens the same pop-up as everywhere else', await pg.locator('#scrim').isVisible());
await pg.keyboard.press('Escape'); await pg.waitForTimeout(300);
/* The key on the Sign in button is dark on a bright button, not cyan on cyan:
   the rule that tints the panel's leading mark used to hit this one too. */
check('the key on the button is legible against it', await pg.evaluate(() => {
  const b = document.querySelector('#histIntro .emptyrow .go');
  return getComputedStyle(b.querySelector('.i')).color;
}) === 'rgb(0, 16, 22)');
/* And the button sits on its own row, not inline in the sentence. */
check('the button is under the words, not beside them', await pg.evaluate(() => {
  const e = document.querySelector('#histIntro .histempty');
  const b = document.querySelector('#histIntro .emptyrow .go');
  const t = e.querySelector('b');
  return b.getBoundingClientRect().top > t.getBoundingClientRect().bottom + 20;
}));
/* CLOSED on every visit. A drawer that reopens itself is not a drawer. */
await go();
check('and it is closed again after a reload', (await drawerH()) === 0, `${await drawerH()}px`);

/* Sign back in, play twice, and the history should describe both runs — from
   the intro as well as from the result. */
await pg.evaluate(async () => {
  localStorage.removeItem('overheard.pol.runs');
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n; for (const x of [0xed, 0x01, ...raw]) n = n * 256n + BigInt(x);
  let out = ''; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  localStorage.setItem('overheard.session', JSON.stringify({ did: 'did:key:z' + out, jwk }));
});
const hist = async () => pg.evaluate(() => {
  const h = document.getElementById('histEnd');
  return {
    shown: !h.hidden,
    rows: [...h.querySelectorAll('.hrow')].map(r => r.textContent.replace(/\s+/g, ' ').trim()),
    stats: [...h.querySelectorAll('.hstat')].map(r => r.textContent.replace(/\s+/g, ' ').trim()),
    signed: h.querySelectorAll('.hsign').length,
  };
});
await go();
await pg.click('#begin'); await pg.waitForTimeout(300);
await play(true);
await pg.waitForSelector('#end:not([hidden])', { timeout: 10000 });
const h1 = await hist();
check('a signed run is kept', h1.shown && h1.rows.length === 1, JSON.stringify(h1.rows));
check('and marked as signed', h1.signed === 1);
check('the summary and the run are open at the foot of a result, not folded away',
  (await pg.locator('#histEnd .histwrap').count()) === 0 && await pg.locator('#histEnd .hstat').first().isVisible());
await pg.click('#again'); await pg.waitForTimeout(400);
for (let i = 0; i < 12; i++) {
  await clearLevelCard();
  await pg.waitForSelector('.opt:not([disabled])', { timeout: 10000 });
  await pg.locator('.opt:not([disabled])').nth(i < 4 ? ANSWERS[i] : (ANSWERS[i] + 1) % 4).click();
  await pg.waitForSelector('.cleared', { timeout: 10000 });
  await pg.click('#stage .nextrow .go'); await pg.waitForTimeout(400);
}
await pg.waitForSelector('#end:not([hidden])', { timeout: 10000 });
const h2 = await hist();
console.log('   ', JSON.stringify(h2.rows));
check('a second run joins it, newest first',
  h2.rows.length === 2 && /^4of 12Freshly booted/.test(h2.rows[0]), h2.rows[0].slice(0, 40));
check('the summary is of the best, not the last',
  h2.stats.some(t => /^12\/12best run$/.test(t)) && h2.stats.some(t => /^Foundation gradebest rank$/.test(t)),
  JSON.stringify(h2.stats));
check('and it says where the runs actually live',
  /kept in this browser only/.test(await pg.locator('#histEnd .hsub').textContent()));
/* The same panel belongs on the way IN — that is where somebody decides to
   beat their own score. */
await go();
check('it is on the start page too', await pg.locator('#histIntro .hrow').count() === 2);
check('and it is below the start card, not above it', await pg.evaluate(() => {
  const a = document.querySelector('.hero').getBoundingClientRect();
  const b = document.getElementById('histIntro').getBoundingClientRect();
  return b.top > a.top;
}));

/* Signed in with nothing played yet is its own sentence, not the signed-out
   one with the button removed. */
const keptRuns = await pg.evaluate(() => {
  const r = localStorage.getItem('overheard.pol.runs');
  localStorage.removeItem('overheard.pol.runs');
  return r;
});
await go();
check('a signed-in browser with no runs says so',
  /No runs yet/.test(await pg.locator('#histIntro').textContent()));
check('and does not ask you to sign in again',
  (await pg.locator('#histIntro .histempty .go').count()) === 0);
await pg.evaluate((r) => localStorage.setItem('overheard.pol.runs', r), keptRuns);
await go();

console.log('\n=== I2. opening a past run');
// the drawer is closed on every load now, so it has to be opened first
await pg.click('#histIntro .histtoggle'); await pg.waitForTimeout(700);
await pg.locator('#histIntro .hrow').first().click();
await pg.waitForTimeout(600);
check('it opens', await pg.locator('#rscrim').isVisible());
check('titled with the run it is', /4 of 12/.test(await pg.locator('#rTitle').textContent()),
  await pg.locator('#rTitle').textContent());
/* The card is REDRAWN from the numbers — the history keeps no images — so
   the pixels are the proof that it survived the round trip. */
const past = await pg.evaluate(() => {
  const c = document.getElementById('hcard'), x = c.getContext('2d');
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 240) lit++;
  return lit;
});
check('and the card is rebuilt, not stored', past > 4000, `${past} lit pixels`);
/* The same object in the hand as the one on the result page. */
await pg.waitForTimeout(1300);
const hbox = await pg.locator('#hwrap').boundingBox();
await pg.mouse.move(hbox.x + hbox.width * 0.88, hbox.y + hbox.height * 0.25);
await pg.waitForTimeout(450);
const hTilted = await pg.evaluate(() => getComputedStyle(document.getElementById('hwrap')).transform);
check('and it tilts to the cursor here too',
  hTilted !== 'none' && hTilted !== 'matrix(1, 0, 0, 1, 0, 0)', hTilted.slice(0, 44));
check('with air between it and the buttons', await pg.evaluate(() => {
  const c = document.querySelector('.rstage').getBoundingClientRect();
  const m = document.getElementById('rMeta').getBoundingClientRect();
  return Math.round(m.top - c.bottom);
}) >= 20);
check('with the things anybody would want to do with it',
  (await pg.locator('#rRow button, #rRow a').count()) === 5,
  (await pg.locator('#rRow').textContent()).replace(/\s+/g, ' ').trim());
check('including the proof, because that run was signed',
  (await pg.locator('#rRow a[href*="/v#b="]').count()) === 1);
/* Deleting takes two taps, and the first one says what the second will do. */
const del = pg.locator('#rRow button.danger');
await del.click(); await pg.waitForTimeout(250);
check('delete asks once', /Really delete/.test(await del.textContent()));
await del.click(); await pg.waitForTimeout(500);
await pg.waitForTimeout(400);
check('and then does it', await pg.locator('#rscrim').isHidden()
  && (await pg.locator('#histIntro .hrow').count()) === 1,
  `${await pg.locator('#histIntro .hrow').count()} left`);
// deleting repaints, and the drawer stays open through it
check('and the drawer did not slam shut on the way',
  (await pg.locator('#histIntro .histpanel.open').count()) === 1);
await pg.evaluate(() => {
  localStorage.removeItem('overheard.pol.runs');
  localStorage.removeItem('overheard.identity');
  localStorage.removeItem('overheard.session');
});

console.log('\n=== I3. paging');
/* Forty runs is four screens of ten, not one long scroll inside a drawer. */
await pg.evaluate(async () => {
  /* Its own identity: the section before this one signs out on its way past,
     and reading a DID off a session that is gone is how a test starts lying
     about the thing it is meant to be checking. */
  if (!localStorage.getItem('overheard.session')) {
    const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = 0n; for (const x of [0xed, 0x01, ...raw]) n = n * 256n + BigInt(x);
    let out = ''; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
    localStorage.setItem('overheard.session', JSON.stringify({ did: 'did:key:z' + out, jwk }));
  }
  const did = JSON.parse(localStorage.getItem('overheard.session')).did;
  const marks = Array(12).fill(true);
  const rows = Array.from({ length: 23 }, (_, i) => ({
    id: 'p' + i, at: new Date(Date.now() - i * 3600e3).toISOString(),
    correct: 12 - (i % 12), total: 12, score: 2000 - i * 37, best: 3,
    marks, rank: 'Validator', proof: null,
  }));
  localStorage.setItem('overheard.pol.runs', JSON.stringify({ [did]: rows }));
});
await go();
await pg.click('#histIntro .histtoggle'); await pg.waitForTimeout(650);
check('a page holds ten', (await pg.locator('#histIntro .hrow').count()) === 10);
check('and it says which ten', /1–10 of 23/.test(await pg.locator('#histIntro .pgof').textContent()),
  await pg.locator('#histIntro .pgof').textContent());
check('with a numbered page each', (await pg.locator('#histIntro .pg.on').count()) === 1
  && (await pg.locator('#histIntro .pages .pg').count()) === 5, 'prev + 3 pages + next');
const firstOn = await pg.locator('#histIntro .hrow').first().textContent();
await pg.locator('#histIntro .pages .pg').nth(3).click();     // page 2
await pg.waitForTimeout(500);
check('the next page is a different ten',
  (await pg.locator('#histIntro .hrow').first().textContent()) !== firstOn);
check('and the drawer stays open while paging', (await drawerH()) > 40, `${await drawerH()}px`);
check('the tail page is short', await pg.evaluate(async () => {
  const pgs = document.querySelectorAll('#histIntro .pages .pg');
  pgs[pgs.length - 2].click();                                 // last numbered page
  await new Promise(r => setTimeout(r, 400));
  return document.querySelectorAll('#histIntro .hrow').length;
}) === 3);
await pg.evaluate(() => {
  localStorage.removeItem('overheard.pol.runs');
  localStorage.removeItem('overheard.session');
});

console.log('\n=== J. the sources are named, not alluded to');
const srcs = await pg.evaluate(() => [...document.querySelectorAll('.srccard')].map(a => ({
  href: a.getAttribute('href'), text: a.textContent.replace(/\s+/g, ' ').trim(),
})));
console.log('   ', JSON.stringify(srcs.map(x => x.href)));
check('both documents are linked, not buried in a sentence', srcs.length === 2);
check('the teaser is one of them', srcs.some(x => /flop\.finance\/teaser/.test(x.href)));
check('and technocore the other', srcs.some(x => /technocore\.chat/.test(x.href)));
check('each says what it is', srcs.every(x => x.text.length > 60));
check('the draft status travels with the link', /0\.1|draft/i.test(srcs.map(x => x.text).join(' ')));
check('and the page still says the score goes nowhere',
  /never leaves this browser/i.test(await pg.locator('.srcnote').textContent()));

console.log('\n=== K. nowhere on the page is a token handed out');
const pageText = await pg.evaluate(() => document.body.innerText);
check('no "$FLOP earned" anywhere in the run or the end',
  !/\$?FLOP\s+earned/i.test(pageText) && !/earned.{0,12}\$FLOP/i.test(pageText));

console.log('\n=== L. phone');
const ph = await ctx.newPage(); ph.on('pageerror', e => errs.push(e.message));
await ph.setViewportSize({ width: 390, height: 844 });
await ph.goto('http://localhost:8909/play'); await ph.waitForTimeout(700);
const ov = await ph.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
check('no horizontal scroll', ov[0] <= ov[1], ov.join('/'));
await ph.click('#toBrief'); await ph.waitForTimeout(600);
const ov2 = await ph.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
check('nor in the briefing', ov2[0] <= ov2[1], ov2.join('/'));
await ph.screenshot({ path: '/tmp/play-brief-phone.png', fullPage: false }).catch(() => {});
await ph.click('#beginFromBrief'); await ph.waitForTimeout(900);
if (await ph.locator('.levelup:not(.out)').count()) { await ph.click('.levelup:not(.out)'); await ph.waitForTimeout(500); }
check('the answers are thumb-sized', await ph.evaluate(() =>
  [...document.querySelectorAll('.opt')].every(o => o.getBoundingClientRect().height >= 44)));
await ph.screenshot({ path: '/tmp/play-phone.png', fullPage: false }).catch(() => {});
await ph.close();

await pg.screenshot({ path: '/tmp/play-end.png', fullPage: true }).catch(() => {});
await go();
await pg.screenshot({ path: '/tmp/play-start.png', fullPage: true }).catch(() => {});
await pg.click('#toBrief'); await pg.waitForTimeout(700);
await pg.screenshot({ path: '/tmp/play-brief.png', fullPage: true }).catch(() => {});

console.log('\nerrors:', errs);
if (errs.length) bad++;
await b.close(); srv.close();
console.log(bad ? `\n${bad} FAILURE(S)` : '\nall good');
process.exit(bad ? 1 : 0);

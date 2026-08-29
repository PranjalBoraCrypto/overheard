/* "Prove this card is yours" as one line above the buttons, opening a dialog.
   Two routes: the passphrase for an identity this browser holds, or the seed
   for one it does not — and the seed route hands back an encrypted file. */
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';

// Needs playwright and a chromium:  npx playwright install chromium
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname; if (p === '/') p = '/index.html';
  const J = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const did = u.searchParams.get('did') || '';
  if (p === '/api/note') return J({ did, registered: true, known: true, fingerprint: 'ab'.repeat(8), path: '/kv/did-7f/8984c465299fd4', note: 'a note' });
  if (p === '/api/profile') return J({ owned: { rooms: [], owners: 1, identities: 2 },
    profile: { count: 12, unique: 12, templates: 0, rooms: ['lobby'], first: '2026-08-25T10:00:00Z', last: '2026-08-27T09:00:00Z', last_text: 'hello there' }, standing: null });
  if (p.startsWith('/api/') || p.startsWith('/data/')) return J({});
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(fs.readFileSync(f)); }
  else { res.writeHead(404); res.end('{}'); }
}).listen(8990);


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
const ctx = await b.newContext({ viewport: { width: 1240, height: 1000 }, deviceScaleFactor: 2, acceptDownloads: true });
const pg = await ctx.newPage(); await killWebGL(pg); const errs = []; pg.on('pageerror', e => errs.push(e.message));
await pg.goto('http://localhost:8990/');

// A real Ed25519 identity, plus its raw seed — the two ways in.
const ID = await pg.evaluate(async () => {
  const b64u = x => btoa(String.fromCharCode(...new Uint8Array(x))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const by = new Uint8Array(34); by[0] = 0xed; by[1] = 0x01; by.set(raw, 2);
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n; for (const x of by) n = n * 256n + BigInt(x);
  let o = ''; while (n > 0n) { o = A[Number(n % 58n)] + o; n /= 58n; }
  const d = Uint8Array.from(atob(jwk.d.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  return { did: 'did:key:z' + o, seedHex: [...d].map(x => x.toString(16).padStart(2, '0')).join(''), jwk: JSON.stringify(jwk) };
});

const vaultInto = async (page, did, jwkStr, pass) => page.evaluate(async ({ did, jwkStr, pass }) => {
  const enc = new TextEncoder();
  const b64u = x => btoa(String.fromCharCode(...new Uint8Array(x))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  const aes = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode(jwkStr));
  localStorage.setItem('overheard.identity', JSON.stringify({ v: 1, did, salt: b64u(salt), iv: b64u(iv), data: b64u(ct) }));
  /* A LOCKED vault is the state being set up here, so the open key has to go
     with it. Proving earlier in this run signs the browser in, these pages
     share one context, and the prove bar now signs straight off a key it is
     already holding — so leaving the session behind meant every "this
     browser has a vault to unlock" case was really "this browser is already
     unlocked", and the passphrase route below was never being reached. */
  localStorage.removeItem('overheard.session');
}, { did, jwkStr, pass });

const look = async (page, did) => {
  await page.goto('http://localhost:8990/'); await page.evaluate(() => document.fonts.ready);
  await page.fill('#did', did); await page.click('.field button');
  await page.waitForSelector('.actions:not([hidden])', { timeout: 25000 }); await page.waitForTimeout(600);
};

let bad = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${n}${d ? '   ' + d : ''}`); if (!c) bad++; };

console.log('=== A. it is one line above the buttons, and no field is on the page');
await vaultInto(pg, ID.did, ID.jwk, 'hunter2');
await look(pg, ID.did);
check('the bar is visible', await pg.locator('#provebar').isVisible());
check('it sits ABOVE the action buttons', await pg.evaluate(() => {
  const bar = document.getElementById('provebar').getBoundingClientRect();
  const acts = document.querySelector('.actions').getBoundingClientRect();
  return bar.bottom <= acts.top + 2;
}));
check('no passphrase box sitting open on the page', await pg.evaluate(() =>
  ![...document.querySelectorAll('input[type=password]')].some(i => i.offsetParent !== null)));
check('the dialog is closed', !(await pg.locator('#pmodal').isVisible()));
await pg.locator('#provebar').screenshot({ path: '/tmp/prove-bar.png' });

console.log('\n=== B. clicking opens it, on the tab that can actually work');
await pg.click('#provebar'); await pg.waitForTimeout(500);
check('dialog open', await pg.locator('#pmodal').isVisible());
check('passphrase tab selected (this browser holds the key)', await pg.locator('#tabPass').getAttribute('aria-selected') === 'true');
check('seed tab offered too', await pg.locator('#tabSeed').isVisible());
await pg.screenshot({ path: '/tmp/prove-modal.png' });

console.log('\n=== C. a wrong passphrase says so and changes nothing');
await pg.fill('#ppw', 'nope'); await pg.click('#proveGo'); await pg.waitForTimeout(2600);
check('rejected', /Wrong passphrase/.test(await pg.locator('#pmsg').textContent()));
check('still not proven', !(await pg.locator('#provebar').getAttribute('class')).includes('done'));

console.log('\n=== D. the right one proves it and the card redraws');
await pg.fill('#ppw', 'hunter2'); await pg.click('#proveGo'); await pg.waitForTimeout(3000);
check('bar marked proven', (await pg.locator('#provebar').getAttribute('class')).includes('done'));
check('proof link button appeared', await pg.locator('#proofBtn').isVisible());
check('dialog closed itself', !(await pg.locator('#pmodal').isVisible()));
const link = await pg.evaluate(() => window.__p ?? null);
await pg.locator('#card').screenshot({ path: '/tmp/prove-card.png' });

console.log('\n=== D2. and then it stops being a button');
/* A control that still lifts, still shows a hand cursor and still opens a
   passphrase box after the key has signed is telling somebody their signature
   did not take. */
const bar = await pg.evaluate(() => {
  const b = document.getElementById('provebar');
  return { disabled: b.disabled, cursor: getComputedStyle(b).cursor,
           arrow: getComputedStyle(b.querySelector('.pb-go')).display,
           tick: getComputedStyle(b.querySelector('.pb-ok')).display,
           sub: document.getElementById('pbSub').textContent };
});
console.log('  ', JSON.stringify(bar));
check('the button is disabled', bar.disabled === true);
check('no hand cursor', bar.cursor === 'default', bar.cursor);
check('the arrow is gone', bar.arrow === 'none');
check('a tick is in its place', bar.tick !== 'none');
check('and the line underneath says what happened', /Signed with your key/.test(bar.sub), bar.sub.slice(0, 46));
await pg.locator('#provebar').click({ force: true, timeout: 3000 }).catch(() => {});
await pg.waitForTimeout(500);
check('clicking it does not reopen the dialog', !(await pg.locator('#pmodal').isVisible()));
await pg.locator('#provebar').screenshot({ path: '/tmp/prove-bar-done.png' });

console.log('\n=== D2b. the post says the card was signed, since it was');
/* The only state the share-text test cannot reach on its own: proving needs a
   real private key, and this file already has one. */
await pg.evaluate(() => { window.__u = null; window.open = (u) => { window.__u = u; }; });
await pg.click('#post'); await pg.waitForTimeout(3000);
const tweet = decodeURIComponent(new URL(await pg.evaluate(() => window.__u)).searchParams.get('text'));
console.log(tweet.split('\n').filter(Boolean).map(l => '     ' + l).join('\n'));
check('claims the signature', /I signed this card|key is mine to prove/.test(tweet));
check('and still fits X', tweet.replace('overheard-five.vercel.app', 'x'.repeat(23)).length <= 280,
  `${tweet.replace('overheard-five.vercel.app', 'x'.repeat(23)).length} chars`);
check('no rank, no join order', !/#\d|arrived after/.test(tweet));

console.log('\n=== D3. the tilt: no snap on arrival, no lag while following');
/* Two failures, one after the other, so this checks for both at once.

   `transition: transform .5s` plus a transform set on every move restarted
   the ease on every move: the card sat most of a second behind the cursor —
   4.94 degrees asked for, 0.74 on screen. Turning the transition off while
   the pointer was on the card fixed that and produced the opposite fault:
   arriving applied the whole tilt on a single frame, which at the edges of
   the card is a visible bump.

   So: on the frame after the pointer arrives at a corner the card must have
   moved only slightly, and a fifth of a second later it must be exactly
   where the cursor put it. */
const feel = await pg.evaluate(() => {
  const w = document.getElementById('cardwrap'), r = w.getBoundingClientRect();
  const yaw = () => {
    const m = new DOMMatrix(getComputedStyle(w).transform);
    return Math.asin(Math.max(-1, Math.min(1, -m.m13))) * 180 / Math.PI;
  };
  const send = (type, x, y) => w.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true }));
  const raf = () => new Promise((r2) => requestAnimationFrame(() => r2()));
  return (async () => {
    // start flat and at rest
    send('pointerleave', 0, 0);
    await new Promise((r2) => setTimeout(r2, 700));
    const atRest = yaw();
    // arrive hard, in the far corner
    send('pointerenter', r.right - 14, r.bottom - 14);
    send('pointermove',  r.right - 14, r.bottom - 14);
    const t0 = performance.now();
    await raf(); await raf();
    const firstFrames = yaw(), elapsed = performance.now() - t0;
    await new Promise((r2) => setTimeout(r2, 320));
    const settled = yaw();
    const asked = +(/rotateY\(([-\d.]+)deg/.exec(w.style.transform)?.[1] ?? 0);
    send('pointerleave', 0, 0);
    await new Promise((r2) => setTimeout(r2, 700));
    const back = yaw();
    return { atRest, firstFrames, elapsed, settled, asked, back,
             transition: getComputedStyle(w).transitionDuration };
  })();
});
console.log('  at rest', feel.atRest.toFixed(2), '· two frames after arriving', feel.firstFrames.toFixed(2),
            '· settled', feel.settled.toFixed(2), '· after leaving', feel.back.toFixed(2), 'deg');
check('it starts flat', Math.abs(feel.atRest) < 0.2, feel.atRest.toFixed(2));
/* Bounded in TIME, not in frames. Headless runs at about 15fps and a real
   browser at 60, so "two frames in" is a different amount of ease each time;
   what must hold either way is that the card never moves FASTER than an
   exponential would. The bound uses a 55ms time constant against the code's
   80ms, which leaves room for timing noise and still fails a snap — a snap
   arrives complete at whatever the elapsed time happens to be. */
const bound = Math.abs(feel.settled) * (1 - Math.exp(-feel.elapsed / 55));
check('arriving RAMPS rather than snapping',
  Math.abs(feel.firstFrames) <= bound + 0.15,
  `${feel.firstFrames.toFixed(2)} deg after ${feel.elapsed.toFixed(0)}ms, ceiling ${bound.toFixed(2)}`);
check('but it does get there', Math.abs(feel.settled) > 4.4, feel.settled.toFixed(2));
check('and lands exactly where the cursor put it', Math.abs(feel.settled - feel.asked) < 0.25,
  `asked ${feel.asked} · showing ${feel.settled.toFixed(2)}`);
check('leaving decays back to flat', Math.abs(feel.back) < 0.2, feel.back.toFixed(2));
check('none of it is a CSS transition', parseFloat(feel.transition) === 0, feel.transition);

console.log('\n=== E. a DIFFERENT browser, no identity — the seed route, and a file back');
const pg2 = await ctx.newPage(); await killWebGL(pg2); pg2.on('pageerror', e => errs.push(e.message));
await pg2.goto('http://localhost:8990/');
/* BOTH keys, not just the vault. These pages share one browser context, and
   proving on the earlier one signs this browser in — that is the point of it
   — so clearing only the vault left "a different browser with no identity"
   actually holding an OPEN key for this very DID. The prove bar now notices
   that and signs without asking, which is correct and which would have made
   this section test something else entirely. */
await pg2.evaluate(() => {
  localStorage.removeItem('overheard.identity');
  localStorage.removeItem('overheard.session');
});
await look(pg2, ID.did);
await pg2.click('#provebar'); await pg2.waitForTimeout(500);
check('opens on the passphrase tab', await pg2.locator('#tabPass').getAttribute('aria-selected') === 'true');
check('and asks for the backup file', await pg2.locator('#pfileRow').isVisible());
check('hint says what to do', /Choose your backup file/.test(await pg2.locator('#passHint').textContent()));
await pg2.click('#tabSeed'); await pg2.waitForTimeout(300);
check('the passphrase tab is NOT disabled', !(await pg2.locator('#tabPass').isDisabled()));

await pg2.fill('#pseed', 'deadbeef'.repeat(8));
await pg2.fill('#pnp1', 'longenough'); await pg2.fill('#pnp2', 'longenough');
await pg2.click('#seedGo'); await pg2.waitForTimeout(2500);
check('a seed for another identity is refused', /does not belong to this identity/.test(await pg2.locator('#smsg').textContent()),
  (await pg2.locator('#smsg').textContent()).slice(0, 50));

await pg2.fill('#pseed', ID.seedHex);
await pg2.fill('#pnp1', 'short'); await pg2.fill('#pnp2', 'short');
await pg2.click('#seedGo'); await pg2.waitForTimeout(500);
check('a weak passphrase is refused', /at least 8/.test(await pg2.locator('#smsg').textContent()));
await pg2.fill('#pnp1', 'longenough'); await pg2.fill('#pnp2', 'mismatched');
await pg2.click('#seedGo'); await pg2.waitForTimeout(400);
check('a mismatch is refused', /do not match/.test(await pg2.locator('#smsg').textContent()));

await pg2.fill('#pnp2', 'longenough');
const dl = pg2.waitForEvent('download', { timeout: 20000 });
await pg2.click('#seedGo');
const file = await dl;
await pg2.waitForTimeout(3000);
check('an encrypted backup was downloaded', /^overheard-identity-.*\.json$/.test(file.suggestedFilename()), file.suggestedFilename());
const body = JSON.parse(fs.readFileSync(await file.path(), 'utf8'));
check('the file is a vault, not a seed', !!(body.salt && body.iv && body.data) && !JSON.stringify(body).includes(ID.seedHex),
  Object.keys(body).join(','));
check('it names the identity it belongs to', body.did === ID.did);
check('proven from the seed', (await pg2.locator('#provebar').getAttribute('class')).includes('done'));
check('the seed box was cleared', (await pg2.locator('#pseed').inputValue()) === '');
check('the browser can now sign without it', await pg2.evaluate(() => !!localStorage.getItem('overheard.identity')));

console.log('\n=== E2. the dialog is centred, not pinned to a corner');
await pg.goto('http://localhost:8990/');
await vaultInto(pg, ID.did, ID.jwk, 'hunter2');
await look(pg, ID.did);
await pg.click('#provebar'); await pg.waitForTimeout(600);
const geo = await pg.evaluate(() => {
  const r = document.getElementById('pmodal').getBoundingClientRect();
  return { left: Math.round(r.left), right: Math.round(innerWidth - r.right),
           top: Math.round(r.top), bottom: Math.round(innerHeight - r.bottom) };
});
check('horizontally centred', Math.abs(geo.left - geo.right) <= 2, JSON.stringify(geo));
check('vertically centred', Math.abs(geo.top - geo.bottom) <= 2);

console.log('\n=== E3. the backup-file route: the case that was locked out');
const pg4 = await ctx.newPage(); await killWebGL(pg4); pg4.on('pageerror', e => errs.push(e.message));
await pg4.goto('http://localhost:8990/');
/* Empty means empty — the session too, or this browser is not the stranger
   with only a backup file that the section is about. */
await pg4.evaluate(() => {
  localStorage.removeItem('overheard.identity');
  localStorage.removeItem('overheard.session');
});
await look(pg4, ID.did);
await pg4.click('#provebar'); await pg4.waitForTimeout(400);
// the file the seed route handed out earlier in this run
await pg4.setInputFiles('#pfile', await file.path()); await pg4.waitForTimeout(700);
check('file accepted', /File loaded/.test(await pg4.locator('#pmsg').textContent()),
  (await pg4.locator('#pmsg').textContent()).slice(0, 40));
await pg4.fill('#ppw', 'wrongone'); await pg4.click('#proveGo'); await pg4.waitForTimeout(2600);
check('wrong passphrase refused', /Wrong passphrase/.test(await pg4.locator('#pmsg').textContent()));
await pg4.fill('#ppw', 'longenough'); await pg4.click('#proveGo'); await pg4.waitForTimeout(3000);
check('proven from the backup file', (await pg4.locator('#provebar').getAttribute('class')).includes('done'));
await pg4.locator('#pmodal').screenshot({ path: '/tmp/prove-file.png' }).catch(()=>{});

/* ── E3b. SIGNED IN IS ALREADY UNLOCKED ───────────────────────────────────
   The bar used to open the passphrase dialog no matter what — including for
   somebody signed in as the very identity on the card, whose key is sitting
   decrypted in the session because they typed a passphrase minutes ago.
   Asking twice is not extra care, it is the page not looking. So: a real
   key in the session, and one press has to be the whole interaction. */
console.log('\n=== E3b. a key already open is not asked for its passphrase');
const pg5 = await ctx.newPage(); await killWebGL(pg5); pg5.on('pageerror', e => errs.push(e.message));
await pg5.goto('http://localhost:8990/');
await pg5.evaluate(({ did, jwkStr }) => {
  localStorage.removeItem('overheard.identity');        // no vault: the session alone
  localStorage.setItem('overheard.session',
    JSON.stringify({ did, jwk: JSON.parse(jwkStr), at: new Date().toISOString() }));
}, { did: ID.did, jwkStr: ID.jwk });
await look(pg5, ID.did);
check('the bar says it will not ask',
  /signed in as this identity/i.test(await pg5.locator('#pbSub').textContent()),
  (await pg5.locator('#pbSub').textContent()).slice(0, 52));
await pg5.click('#provebar');
await pg5.waitForFunction(() => document.getElementById('provebar').classList.contains('done'),
  null, { timeout: 8000 }).catch(() => {});
check('one press proves it', (await pg5.locator('#provebar').getAttribute('class')).includes('done'));
check('and no dialog was ever opened', !(await pg5.evaluate(() => document.getElementById('pmodal').open)));
check('the proof link is offered', await pg5.locator('#proofBtn').isVisible());
/* Not a cosmetic class: the page verifies its OWN signature with the public
   key out of the DID before it marks anything proven, and bails if that
   fails. So `done` here means the maths ran and passed, and the line under
   the bar is the page saying which key did it. */
check('and the bar now says what happened',
  /Signed with your key/.test(await pg5.locator('#pbSub').textContent()),
  (await pg5.locator('#pbSub').textContent()).slice(0, 46));

console.log('\n=== E4. nothing on the proven card overlaps anything else');
// Measured off the canvas itself: sample the pixels each element occupies and
// check the gaps, rather than trusting the eye on a screenshot.
const gaps = await pg4.evaluate(() => {
  const c = document.getElementById('card');
  const x = c.getContext('2d');
  const W = c.width, H = c.height;
  // Column through the middle of the identity plate: find every horizontal
  // band that has ink in it, left of the divider.
  const rowHasInk = (y, x0, x1) => {
    const d = x.getImageData(x0, y, x1 - x0, 1).data;
    for (let i = 0; i < d.length; i += 4) {
      // anything brighter than the card's own background wash
      if (d[i] + d[i + 1] + d[i + 2] > 150) return true;
    }
    return false;
  };
  const bands = []; let start = null;
  for (let y = 100; y < 520; y++) {
    const ink = rowHasInk(y, 70, 400);
    if (ink && start === null) start = y;
    if (!ink && start !== null) { bands.push([start, y - 1]); start = null; }
  }
  if (start !== null) bands.push([start, 519]);
  return bands.filter(([a, b]) => b - a >= 2);
});
/* The plate should read as: label · portrait+ring · DID · facts · facts —
   separated, never fused into one run. The bands are MERGED first, because
   the portrait is drawn from the key and its colours change with every run:
   on some hues a row through the visor drops under the ink threshold and
   splits the portrait into three bands. The checks below index by position,
   so an unmerged split silently moved them onto the wrong pair and reported
   6px of clearance where there were 26 — passing, while measuring nothing.
   Anything closer than 8px apart is one element. */
const merged = [];
for (const [a0, b0] of gaps) {
  const last = merged[merged.length - 1];
  if (last && a0 - last[1] < 8) last[1] = b0; else merged.push([a0, b0]);
}
console.log('   ink bands in the identity plate:', JSON.stringify(merged),
            merged.length === gaps.length ? '' : `(merged from ${JSON.stringify(gaps)})`);
check('the label is clear of the ring', merged.length >= 2 && merged[0][1] < merged[1][0], JSON.stringify(merged.slice(0, 2)));
check('a real gap under the label', merged.length >= 2 && (merged[1][0] - merged[0][1]) >= 6,
  merged.length >= 2 ? `${merged[1][0] - merged[0][1]}px` : 'n/a');
check('the DID is clear of the ring', merged.length >= 3 && (merged[2][0] - merged[1][1]) >= 6,
  merged.length >= 3 ? `${merged[2][0] - merged[1][1]}px` : 'n/a');
await pg4.locator('#card').screenshot({ path: '/tmp/proven-card.png' });

console.log('\n=== F. phone');
const pg3 = await ctx.newPage(); await killWebGL(pg3); await pg3.setViewportSize({ width: 390, height: 844 });
pg3.on('pageerror', e => errs.push(e.message));
await pg3.goto('http://localhost:8990/');
await vaultInto(pg3, ID.did, ID.jwk, 'hunter2');
await look(pg3, ID.did);
await pg3.click('#provebar'); await pg3.waitForTimeout(500);
const ov = await pg3.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
check('no horizontal scroll', ov[0] <= ov[1], ov.join('/'));
await pg3.screenshot({ path: '/tmp/prove-phone.png' });

console.log('\nerrors:', errs);
console.log(bad ? `${bad} FAILURE(S)` : 'all good');
await b.close(); srv.close();

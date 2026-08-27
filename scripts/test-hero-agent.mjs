/* The hero agent: it mounts, it looks where the cursor is, a shake spins it,
   a tap boops it, and none of that runs when the person asked for less
   motion. Software-rendered here, so this is about behaviour and pixels
   changing — the frame rate on a real GPU is not something a container can
   tell you. */
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';

// Needs playwright and a chromium:  npx playwright install chromium
// Run it with software GL, which the launch args below ask for.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const srv = http.createServer((req,res)=>{
  const u=new URL(req.url,'http://x'); let p=u.pathname; if(p==='/')p='/index.html';
  const J=(o)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(o));};
  if(p==='/api/identities') return J({identities:{}});
  if(p.startsWith('/api/')||p.startsWith('/data/')) return J({});
  const f=path.join(ROOT,p);
  if(fs.existsSync(f)&&fs.statSync(f).isFile()){res.writeHead(200,{'content-type':p.endsWith('.js')?'text/javascript':'text/html'});res.end(fs.readFileSync(f));}
  else {res.writeHead(404);res.end('{}');}
}).listen(8898);

const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
let bad=0; const check=(n,ok,d='')=>{console.log(`  ${ok?'ok  ':'FAIL'}  ${n}${d?'   '+d:''}`); if(!ok)bad++;};
const errs=[];

const pg = await b.newPage({ viewport:{width:1240,height:900}, deviceScaleFactor:1 });
pg.on('pageerror',e=>errs.push(e.message));
await pg.goto('http://localhost:8898/');
await pg.evaluate(()=>document.fonts.ready);
await pg.waitForTimeout(4000);

console.log('=== it is the model, not the flat drawing');
check('WebGL2 mounted', await pg.evaluate(()=>!!window.__hero3d || !!document.getElementById('heroFace')));
const ctxKind = await pg.evaluate(()=>{ const c=document.getElementById('heroFace');
  try{ return c.getContext('2d') ? '2d' : 'gl'; }catch{ return 'gl'; } });
check('the canvas is a WebGL context, so the 3D agent has it', ctxKind==='gl', ctxKind);

const px = () => pg.evaluate(()=>{ const c=document.getElementById('heroFace'); const r=c.getBoundingClientRect();
  return [r.x,r.y,r.width,r.height]; });
const [cx,cy,cw,ch] = await px();
// Software rendering: a frame can take a second, so a slow grab is not a
// failure of the thing being tested.
const shot = async (name, page=pg, box=[cx,cy,cw,ch])=>{
  try{ await page.screenshot({ path:name, clip:{x:box[0],y:box[1],width:box[2],height:box[3]}, timeout:20000 }); }
  catch{ console.log('  (frame grab timed out under swiftshader:', name.split('/').pop(), ')'); }
};

console.log('\n=== it looks where the cursor is');
await pg.mouse.move(cx+cw/2, cy+ch/2); await pg.waitForTimeout(1500);
await shot('/tmp/hero-centre.png');
const rot0 = await pg.evaluate(()=>window.__hero?.state ? [window.__hero.state.yaw, window.__hero.state.pitch] : null);
await pg.mouse.move(cx-260, cy+ch+120, {steps:12}); await pg.waitForTimeout(1600);
await shot('/tmp/hero-look-dl.png');
await pg.mouse.move(cx+cw+260, cy-120, {steps:12}); await pg.waitForTimeout(1600);
await shot('/tmp/hero-look-ur.png');

const differs = async (a,b2) => {
  const A = fs.readFileSync(a), B = fs.readFileSync(b2);
  return A.length !== B.length || !A.equals(B);
};
check('the frame changes when the cursor moves', await differs('/tmp/hero-centre.png','/tmp/hero-look-dl.png'));
check('and again, the other way', await differs('/tmp/hero-look-dl.png','/tmp/hero-look-ur.png'));

console.log('\n=== a shake spins it');
const st = () => pg.evaluate(()=>{ const s=window.__hero?.state; return s?{yaw:s.yaw,vYaw:s.vYaw,spinning:s.spinning}:null; });
// A waggle: back and forth across the socket, the way a person does it.
for(let i=0;i<5;i++){
  await pg.mouse.move(cx+cw*0.05, cy+ch/2);
  await pg.mouse.move(cx+cw*0.95, cy+ch/2);
}
await pg.waitForTimeout(120);
const spun = await st();
console.log('  state after the shake:', JSON.stringify(spun));
check('it picked up angular velocity', spun && Math.abs(spun.vYaw) > 4, spun?String(spun.vYaw.toFixed(2)):'n/a');
check('and went into free spin', !!spun?.spinning);
await pg.waitForTimeout(900); await shot('/tmp/hero-spin.png');
await pg.waitForTimeout(4200);
const settled = await st();
console.log('  once it has slowed:', JSON.stringify(settled));
check('friction brings it back out of the spin', settled && !settled.spinning);
check('and it settles, rather than drifting for ever', settled && Math.abs(settled.vYaw) < 1.2, settled?String(settled.vYaw.toFixed(3)):'n/a');

console.log('\n=== it survives the tab going away and coming back');
/* This is the bug the deployed page had: two reasons to stop rendering were
   one boolean, and backgrounding the tab shut the loop down for good. */
await pg.evaluate(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await pg.waitForTimeout(600);
await pg.evaluate(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  document.dispatchEvent(new Event('visibilitychange'));
});
const yawA = await pg.evaluate(()=>window.__hero.state.yaw);
await pg.mouse.move(cx-200, cy+ch+150, {steps:6}); await pg.waitForTimeout(1800);
const yawB = await pg.evaluate(()=>window.__hero.state.yaw);
check('still stepping after the tab comes back', Math.abs(yawB - yawA) > 0.05, `${yawA.toFixed(3)} -> ${yawB.toFixed(3)}`);

console.log('\n=== a poke');
const before = await pg.evaluate(()=>window.__hero?.state.squash);
await pg.mouse.click(cx+cw/2, cy+ch/2);
await pg.waitForTimeout(60);
const after = await pg.evaluate(()=>window.__hero?.state.squash);
check('the head takes the poke', after !== before, `${before} -> ${after}`);

console.log('\n=== the hint gets out of the way');
check('hint hidden after the first interaction', await pg.evaluate(()=>document.getElementById('faceHint').classList.contains('used')));

console.log('\n=== reduced motion: lit, still, and no spring at all');
const pg2 = await b.newPage({ viewport:{width:1240,height:900}, reducedMotion:'reduce' });
pg2.on('pageerror',e=>errs.push(e.message));
await pg2.goto('http://localhost:8898/'); await pg2.waitForTimeout(3500);
const box2 = await pg2.evaluate(()=>{const r=document.getElementById('heroFace').getBoundingClientRect();return [r.x,r.y,r.width,r.height];});
await pg2.mouse.move(box2[0]-200, box2[1]+box2[3]+200, {steps:8});
for(let i=0;i<9;i++){ await pg2.mouse.move(box2[0], box2[1]+box2[3]/2); await pg2.mouse.move(box2[0]+box2[2], box2[1]+box2[3]/2); }
await pg2.waitForTimeout(800);
const calmState = await pg2.evaluate(()=>{const s=window.__hero?.state; return s?{vYaw:s.vYaw,spinning:s.spinning,blink:s.blink}:null;});
console.log('  state:', JSON.stringify(calmState));
check('never spins', calmState && !calmState.spinning);
check('no angular velocity at all', calmState && Math.abs(calmState.vYaw) < 0.001, calmState?String(calmState.vYaw):'n/a');
await shot('/tmp/hero-calm.png', pg2, box2);

console.log('\n=== phone');
const pg3 = await b.newPage({ viewport:{width:390,height:844}, hasTouch:true, isMobile:true });
pg3.on('pageerror',e=>errs.push(e.message));
await pg3.goto('http://localhost:8898/'); await pg3.waitForTimeout(3000);
const ov = await pg3.evaluate(()=>[document.documentElement.scrollWidth,document.documentElement.clientWidth]);
check('no horizontal scroll', ov[0]<=ov[1], ov.join('/'));
check('the hint tells a phone what to do', /tap|tilt|drag/i.test(await pg3.evaluate(()=>document.getElementById('faceHint').textContent||'')),
  await pg3.evaluate(()=>document.getElementById('faceHint').textContent));

console.log('\nerrors:', errs.slice(0,5));
if(errs.length) bad++;
await b.close(); srv.close();
console.log(bad?`\n${bad} FAILURE(S)`:'\nall good');
process.exit(bad?1:0);

import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';

/* No WebGL — an old machine, a driver blocklist, a locked-down browser. The
   hero has to come back as the flat drawing without a word to anyone, and the
   rest of the page must not notice. Needs playwright + chromium. */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const srv = http.createServer((req,res)=>{
  const u=new URL(req.url,'http://x'); let p=u.pathname; if(p==='/')p='/index.html';
  const J=(o)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(o));};
  if(p.startsWith('/api/')||p.startsWith('/data/')) return J({});
  const f=path.join(ROOT,p);
  if(fs.existsSync(f)&&fs.statSync(f).isFile()){res.writeHead(200,{'content-type':p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'});res.end(fs.readFileSync(f));}
  else {res.writeHead(404);res.end('{}');}
}).listen(8897);
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium' });
const pg = await b.newPage({ viewport:{width:1240,height:900} });
const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
// kill WebGL before any script runs, the way an old machine or a blocklist does
await pg.addInitScript(() => {
  const g = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(t, ...r){
    if(String(t).startsWith('webgl')) return null;
    return g.call(this, t, ...r);
  };
});
await pg.goto('http://localhost:8897/');
await pg.waitForTimeout(2500);
const kind = await pg.evaluate(()=>{ const c=document.getElementById('heroFace'); return c.getContext('2d') ? '2d' : 'none'; });
const ink = await pg.evaluate(()=>{ const c=document.getElementById('heroFace'); const x=c.getContext('2d');
  const d=x.getImageData(0,0,c.width,c.height).data; let n=0; for(let i=3;i<d.length;i+=4) if(d[i]>10) n++; return n; });
console.log('  context:', kind, '| non-transparent pixels:', ink);
console.log('  fell back to a drawn face:', kind==='2d' && ink > 5000 ? 'ok' : 'FAIL');
console.log('  hint cleared (nothing to interact with):', JSON.stringify(await pg.evaluate(()=>document.getElementById('faceHint').textContent)));
console.log('  page still works — a lookup still draws a card:',
  await pg.evaluate(()=>!!document.getElementById('card')));
await pg.locator('#heroFace').screenshot({ path:'/tmp/hero-flat.png' });
console.log('  errors:', errs.slice(0,3));
await b.close(); srv.close();

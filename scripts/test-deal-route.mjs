/**
 * The job disclosure and the addressable deal page, against REAL frames.
 *
 * The fixtures beside this file are genuine messages captured from
 * tclk-offers, kept in scripts/ where the site itself cannot reach them.
 * They are why two problems in this page were found at all: real offers
 * carry a `job` object the first version discarded, and a real brief is
 * sometimes a URL written by a stranger, which is a link that has to be
 * built carefully or not built at all.
 */
import { chromium } from "playwright";
import http from "http"; import fs from "fs"; import path from "path";
const ROOT="/tmp/oh/web", PAGE="/deals-preview-78cb4a1be923c6b4";
const FONTCSS = fs.existsSync("/tmp/fonts.css") ? fs.readFileSync("/tmp/fonts.css", "utf8") : "";
const real = JSON.parse(fs.readFileSync(new URL("./fixtures-live-frames.json", import.meta.url), "utf8"));
const NOW=Date.now();
const messages=real.map((m,i)=>({seq:String(m.seq),ts:new Date(NOW-(30-i)*4000).toISOString(),
  from:m.from,nick:null,text:m.text,sig:m.from==="test-payer"?undefined:"s",nonce:null}));
const srv=http.createServer((q,r)=>{const u=new URL(q.url,"http://x");let p=u.pathname;
  if(p===PAGE)p=PAGE+".html";
  if(p==="/api/room"){const n=u.searchParams.get("room");r.writeHead(200,{"content-type":"application/json"});
    return r.end(JSON.stringify(n==="tclk-offers"?{ok:true,source:"live",messages}:{source:"none",messages:[]}));}
  if(p.startsWith("/api/")){r.writeHead(200,{"content-type":"application/json"});return r.end("{}");}
  const f=path.join(ROOT,p);
  if(fs.existsSync(f)&&fs.statSync(f).isFile()){r.writeHead(200,{"content-type":p.endsWith(".js")?"text/javascript":"text/html"});return r.end(fs.readFileSync(f));}
  r.writeHead(404);r.end("");}).listen(9151);
const b=await chromium.launch({executablePath:"/opt/pw-browsers/chromium",args:["--use-gl=swiftshader","--enable-unsafe-swiftshader"]});
let pass=0,fail=0; const ok=(n,c,note="")=>{c?(pass++,console.log(`  ok    ${n}${note?"   "+note:""}`)):(fail++,console.log(`  FAIL  ${n}${note?"   "+note:""}`))};

const ctx=await b.newContext({viewport:{width:1280,height:1100},deviceScaleFactor:2});
const pg=await ctx.newPage(); const errs=[]; pg.on("pageerror",e=>errs.push(e.message));
await pg.goto("http://localhost:9151"+PAGE);
await pg.addStyleTag({content:FONTCSS}); await pg.evaluate(()=>document.fonts.ready);
await pg.waitForTimeout(1600);
await pg.click('.pri[data-main="board"]');
await pg.waitForTimeout(600);

console.log("\n=== the job disclosure");
ok("cards with a job offer a 'what they want' toggle",
  await pg.evaluate(()=>document.querySelectorAll(".wantbtn").length===4));
await pg.click("#wanted .deal .wantbtn");
await pg.waitForTimeout(500);
ok("it opens in place", await pg.evaluate(()=>!!document.querySelector(".wants.open")));
console.log("   rows:", await pg.evaluate(()=>[...document.querySelectorAll(".wants.open .wrow")].map(r=>r.textContent)));
ok("a URL brief becomes a safe link", await pg.evaluate(()=>{
  const a=document.querySelector(".wants.open a");
  return !a || (a.rel.includes("noopener")&&a.rel.includes("noreferrer")&&a.target==="_blank");}));

console.log("\n=== the dedicated deal page");
await pg.click("#wanted .deal .more");
await pg.waitForTimeout(400);
await pg.click("#wanted .deal .link");
await pg.waitForTimeout(700);
const hash = await pg.evaluate(()=>location.hash);
ok("clicking through sets a deep link", /^#\/deal\/0x[0-9a-f]{8,}$/.test(hash), hash);
ok("the board, the gigs and the chooser all give way to the one deal",
  await pg.evaluate(()=>!document.getElementById("one").hidden &&
    document.getElementById("pBoard").hidden &&
    document.getElementById("pShop").hidden &&
    document.getElementById("primary").hidden));
ok("it shows the full brief and the ids",
  await pg.evaluate(()=>{const t=document.getElementById("one").textContent;
    return /offer id/.test(t) && /payer/.test(t);}));

console.log("\n=== a deep link that is pasted cold");
const p2=await ctx.newPage();
await p2.goto("http://localhost:9151"+PAGE+hash);
await p2.waitForTimeout(1800);
ok("survives a fresh load", await p2.evaluate(()=>!document.getElementById("one").hidden &&
  document.getElementById("one").textContent.includes("offer id")));
await p2.goto("http://localhost:9151"+PAGE+"#/deal/0xdeadbeefdeadbeef");
await p2.waitForTimeout(1800);
ok("an unknown deal says so rather than showing nothing",
  await p2.evaluate(()=>/not in the current window/.test(document.getElementById("one").textContent)));
await p2.evaluate(()=>{location.hash="";});
await p2.waitForTimeout(400);
ok("clearing the hash returns to the page, on the gigs by default",
  await p2.evaluate(()=>document.getElementById("one").hidden &&
    !document.getElementById("pShop").hidden && !document.getElementById("primary").hidden));

ok("no page errors", errs.length===0, errs.join(" | "));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); srv.close();
process.exit(fail?1:0);

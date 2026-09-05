/**
 * THE ROBOT, AND THE KEY IT IS DRAWN FROM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An identity on this network is a key and nothing else. No name is stored
 * for it anywhere, no avatar is uploaded, no profile picture exists — by
 * construction, since a nickname can only ever be attached to an UNSIGNED
 * sender (see api/room.js). So the face has to come out of the key itself,
 * and it does: six bytes of the Ed25519 public key pick the visor, the
 * antenna, the mouth, the plating, the pupils and the hue.
 *
 * That makes it deterministic and unforgeable in the only sense that matters
 * here — the same identity is the same face on the card, in the stream, in
 * the bar and on its profile, on every machine, with nothing stored.
 *
 * WHY THIS FILE EXISTS. All of it lived inside index.html, which is 296 KB
 * and the only page that had a robot. The profile page needs the same face
 * for the same identity, and a second copy of ninety-seven lines of canvas
 * is a second copy to keep in step — which on this project has already cost
 * a blank copy button and two colliding CSS classes. One definition.
 *
 * NOTHING HERE TOUCHES THE DOM OR THE NETWORK. It takes a string or a
 * context and returns bytes or pixels, so it can be imported by a page that
 * has not decided yet whether it is going to draw anything.
 */

/** Bitcoin's alphabet, which is what multibase `z` means. */
export const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58decode(s) {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error(`"${ch}" isn't a valid character in a DID`);
    n = n * 58n + BigInt(i);
  }
  const o = [];
  while (n > 0n) { o.unshift(Number(n & 0xffn)); n >>= 8n; }
  /* Leading "1"s are leading zero bytes, and base58 cannot carry them in the
     number. Every did:key:z6Mk has the 0xed 0x01 multicodec prefix so this
     never fires here, but a decoder that silently shortens its output is a
     decoder that will one day hand back a 31-byte key. */
  for (const ch of s) { if (ch !== "1") break; o.unshift(0); }
  return new Uint8Array(o);
}

/**
 * A did:key string to the 32 raw public key bytes, or an error a person can
 * act on. Every message is written for somebody who pasted the wrong thing
 * into a box, not for a log.
 */
export function parseDid(raw) {
  const did = String(raw ?? "").trim();
  if (!did) throw new Error("Paste your DID to begin");
  if (!did.startsWith("did:key:")) throw new Error("A DID starts with did:key:");
  const mb = did.slice(8);
  if (!mb.startsWith("z6Mk")) throw new Error("That isn't an Ed25519 key — it should start did:key:z6Mk");
  if (mb.length !== 48) throw new Error(`Wrong length — expected 48 characters after did:key:, got ${mb.length}`);
  const b = b58decode(mb.slice(1));
  if (b.length !== 34 || b[0] !== 0xed || b[1] !== 0x01) throw new Error("This decodes, but not to an Ed25519 key");
  return { did, pub: b.slice(2) };
}

/**
 * The same thing for a caller that would rather have null than a throw —
 * a page drawing a face for a DID it was handed does not want an exception
 * to be the difference between a profile and a blank screen.
 */
export function pubOf(did) {
  try { return parseDid(did).pub; } catch { return null; }
}

/** A rounded rectangle path. Not begun for you — several callers want to add
    to the path before filling it. */
export const rr = (ctx, x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };

/*  ── THE FACE ───────────────────────────────────────────────────────────────
 *  A small robot, drawn rather than loaded: a rounded head with a dark visor,
 *  two lit eyes behind glass, an antenna, a plated jaw and a specular streak
 *  across the lens — the same four tricks that make a rendered object look
 *  rendered, done in 2D so a card stays a single canvas with no assets.
 *
 *  Six bytes drive it, giving 4x4x3x3 visible combinations across 90 hues:
 *    0 hue      1 visor      2 antenna      3 mouth      4 plating   5 pupils
 */
export function agent(ctx,x,y,size,pub){
  const u=size/100, U=(n)=>n*u, P=(i)=>pub[i%pub.length];
  const hue=189+((P(0)/255)*84-42);
  const visor=P(1)%4, ant=P(2)%4, mouth=P(3)%3, plating=P(4)%3, glow=P(5)%2;
  const skin =(l,s=78,a=1)=>`hsla(${hue} ${s}% ${l}% / ${a})`;
  const lens =(l,a=1)=>`hsla(${hue+ (glow?14:-10)} 100% ${l}% / ${a})`;
  const px=(n)=>x+U(n), py=(n)=>y+U(n);

  ctx.save();

  // contact shadow — the thing that stops a drawing floating
  const sh=ctx.createRadialGradient(px(50),py(97),0,px(50),py(97),U(40));
  sh.addColorStop(0,"rgba(0,0,0,.55)"); sh.addColorStop(1,"rgba(0,0,0,0)");
  ctx.fillStyle=sh;
  ctx.beginPath(); ctx.ellipse(px(50),py(97),U(40),U(9),0,0,Math.PI*2); ctx.fill();

  // ears / side pads, behind the head
  ctx.fillStyle=skin(30);
  rr(ctx,px(2),py(44),U(11),U(22),U(5)); ctx.fill();
  rr(ctx,px(87),py(44),U(11),U(22),U(5)); ctx.fill();

  // antenna, behind the head so the stalk tucks under the crown
  const stalk=(cx,h)=>{
    ctx.strokeStyle=skin(46); ctx.lineWidth=U(3.4); ctx.lineCap="round";
    ctx.beginPath(); ctx.moveTo(px(cx),py(20)); ctx.lineTo(px(cx),py(20-h)); ctx.stroke();
    const g=ctx.createRadialGradient(px(cx)-U(1.5),py(20-h)-U(1.5),0,px(cx),py(20-h),U(6));
    g.addColorStop(0,lens(86)); g.addColorStop(1,lens(46));
    ctx.fillStyle=g; ctx.beginPath(); ctx.arc(px(cx),py(20-h),U(5.4),0,Math.PI*2); ctx.fill();
  };
  if(ant===1) stalk(50,14);
  if(ant===2){ stalk(31,11); stalk(69,11); }
  if(ant===3){
    ctx.strokeStyle=lens(60,.9); ctx.lineWidth=U(3);
    ctx.beginPath(); ctx.ellipse(px(50),py(9),U(26),U(7),0,0,Math.PI*2); ctx.stroke();
  }

  // head
  const head=ctx.createLinearGradient(px(20),py(14),px(76),py(94));
  head.addColorStop(0,skin(66)); head.addColorStop(.52,skin(48)); head.addColorStop(1,skin(24));
  rr(ctx,px(10),py(16),U(80),U(78),U(24));
  ctx.fillStyle=head; ctx.fill();

  // rim light along the top edge, shadow along the bottom — the whole illusion
  ctx.save(); rr(ctx,px(10),py(16),U(80),U(78),U(24)); ctx.clip();
  const rim=ctx.createLinearGradient(0,py(16),0,py(40));
  rim.addColorStop(0,"rgba(255,255,255,.42)"); rim.addColorStop(1,"rgba(255,255,255,0)");
  ctx.fillStyle=rim; ctx.fillRect(px(10),py(16),U(80),U(26));
  const occ=ctx.createLinearGradient(0,py(72),0,py(94));
  occ.addColorStop(0,"rgba(0,10,16,0)"); occ.addColorStop(1,"rgba(0,10,16,.5)");
  ctx.fillStyle=occ; ctx.fillRect(px(10),py(72),U(80),U(22));

  // plating: a seam, a vent, or nothing — small, and different per key
  ctx.strokeStyle="rgba(0,12,18,.28)"; ctx.lineWidth=U(1.6);
  if(plating===0){ ctx.beginPath(); ctx.moveTo(px(10),py(66)); ctx.lineTo(px(90),py(66)); ctx.stroke(); }
  if(plating===1){ for(let i=0;i<3;i++){ ctx.beginPath();
    ctx.moveTo(px(66),py(76+i*5)); ctx.lineTo(px(82),py(76+i*5)); ctx.stroke(); } }
  ctx.restore();

  ctx.strokeStyle=skin(82,90,.5); ctx.lineWidth=U(1.6);
  rr(ctx,px(10.8),py(16.8),U(78.4),U(76.4),U(23)); ctx.stroke();

  // visor
  rr(ctx,px(20),py(32),U(60),U(30),U(14));
  const glass=ctx.createLinearGradient(0,py(32),0,py(62));
  glass.addColorStop(0,"#020C12"); glass.addColorStop(1,"#06202B");
  ctx.fillStyle=glass; ctx.fill();
  ctx.strokeStyle="rgba(0,0,0,.55)"; ctx.lineWidth=U(1.4); ctx.stroke();

  ctx.save(); rr(ctx,px(20),py(32),U(60),U(30),U(14)); ctx.clip();
  const eye=(cx,cy,w,h,r)=>{
    ctx.shadowColor=lens(60,.95); ctx.shadowBlur=U(9);
    rr(ctx,px(cx-w/2),py(cy-h/2),U(w),U(h),U(r));
    ctx.fillStyle=lens(72); ctx.fill();
    ctx.shadowBlur=0;
  };
  if(visor===0) eye(50,47,40,7,3.5);                       // one wide band
  else if(visor===1){ eye(38,47,11,11,5.5); eye(62,47,11,11,5.5); }   // two eyes
  else if(visor===2) eye(50,47,18,18,9);                   // a single lens
  else { eye(36,47,7,7,3.5); eye(50,47,7,7,3.5); eye(64,47,7,7,3.5); } // three dots

  // specular streak across the glass — the give-away that it is glass
  ctx.save();
  ctx.translate(px(50),py(47)); ctx.rotate(-0.42);
  const sp=ctx.createLinearGradient(-U(40),0,U(40),0);
  sp.addColorStop(0,"rgba(255,255,255,0)"); sp.addColorStop(.5,"rgba(255,255,255,.2)");
  sp.addColorStop(1,"rgba(255,255,255,0)");
  ctx.fillStyle=sp; ctx.fillRect(-U(42),-U(26),U(84),U(11));
  ctx.restore();
  ctx.restore();

  // mouth
  ctx.fillStyle=skin(20,60,.85);
  if(mouth===0){ for(let i=0;i<4;i++){ rr(ctx,px(38+i*6.5),py(72),U(4),U(7),U(1.6)); ctx.fill(); } }
  if(mouth===1){ rr(ctx,px(41),py(73),U(18),U(4.5),U(2.2)); ctx.fill(); }

  ctx.restore();
}

/* Hilfe-Wizard (Prototyp): Coach-Marks, ein Ding im Fokus.
   Wiz.run(id, steps, opts)  – kurzer Rundgang, immer überspringbar
   Wiz.tip(id, sel, text)    – einmaliger Mikro-Tipp
   Wiz.offer(id, opts)       – freundliches Angebot für Newcomer
   Fortschritt lokal unter sm_chat_wiz. Keine Netzwerkzugriffe. */
(function(){
  var KEY='sm_chat_wiz';
  function st(){try{return JSON.parse(localStorage.getItem(KEY)||'{}')||{}}catch(e){return {}}}
  function put(id,v){var o=st();o[id]=v;try{localStorage.setItem(KEY,JSON.stringify(o))}catch(e){}}
  function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
  var css='.wz{position:fixed;inset:0;z-index:9990;pointer-events:none;font-family:var(--sans,system-ui,sans-serif)}'+
  '.wz-spot{position:fixed;border:2px solid #22d3ee;box-shadow:0 0 0 9999px rgba(4,6,15,.74),0 0 22px rgba(34,211,238,.45);pointer-events:none;display:none}'+
  '.wz.mv .wz-spot,.wz.mv .wz-card{transition:all .35s ease}'+
  '.wz-card,.wz-tip,.wz-offer{background:#0d1426;border:1px solid rgba(255,255,255,.14);border-radius:16px;color:#e8edf5;box-shadow:0 14px 36px rgba(0,0,0,.6)}'+
  '.wz-card{position:fixed;width:min(92vw,340px);padding:.8rem .95rem;pointer-events:auto;font-size:.95rem;line-height:1.45}'+
  '.wz-card:focus{outline:none}'+
  '.wz-n{font-size:.72rem;letter-spacing:.1em;color:#8793ab;font-weight:700}'+
  '.wz-t{display:block;font-size:1.05rem;margin:.1rem 0 .2rem}'+
  '.wz-p{margin:0 0 .3rem}'+
  '.wz-f{margin:0 0 .4rem;font-size:.82rem;color:#8793ab}'+
  '.wz-f.hint{color:#22d3ee}'+
  '.wz-b{display:flex;gap:.5rem;justify-content:space-between;align-items:center;margin-top:.5rem}'+
  '.wz button{font:inherit;font-size:.9rem;font-weight:700;border-radius:12px;padding:.5rem .9rem;border:1px solid rgba(255,255,255,.14);background:#131d36;color:#e8edf5;min-height:44px}'+
  '.wz button.go{background:#0e7490;border-color:#22d3ee}'+
  '.wz button.sk{background:transparent;border-color:transparent;color:#8793ab;font-weight:600}'+
  '.wz button:focus-visible{outline:2px solid #ffd45a;outline-offset:2px}'+
  '.wz-tip{position:fixed;z-index:9991;width:min(88vw,290px);padding:.6rem .8rem;font-size:.9rem;line-height:1.4;display:flex;gap:.6rem;align-items:center}'+
  '.wz-tip button{flex:none;font:inherit;font-size:.85rem;font-weight:700;border-radius:10px;padding:.4rem .7rem;min-height:44px;border:1px solid #22d3ee;background:#0e7490;color:#fff}'+
  '.wz-tip button:focus-visible{outline:2px solid #ffd45a;outline-offset:2px}'+
  '.wz-offer{margin:.8rem 0;padding:.75rem .9rem;border-color:rgba(34,211,238,.45)}'+
  '.wz-offer p{margin:0 0 .5rem;font-size:.92rem}'+
  '.wz-offer .r{display:flex;gap:.5rem;flex-wrap:wrap}'+
  '.wz-offer button{font:inherit;font-size:.9rem;font-weight:700;border-radius:12px;padding:.5rem .9rem;min-height:44px;border:1px solid rgba(255,255,255,.14);background:#131d36;color:#e8edf5}'+
  '.wz-offer button.go{background:#0e7490;border-color:#22d3ee}'+
  '.wz-offer button:focus-visible{outline:2px solid #ffd45a;outline-offset:2px}';
  var sty=el('style');sty.textContent=css;document.head.appendChild(sty);

  var Wiz={cur:null,tipEl:null};
  Wiz.rm=function(){try{return !!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)}catch(e){return false}};
  Wiz.done=function(id){return !!st()[id]};
  Wiz.reset=function(){try{localStorage.removeItem(KEY)}catch(e){}};
  function resolve(s){try{var t=typeof s==='function'?s():s&&document.querySelector(s);return t&&t.getBoundingClientRect?t:null}catch(e){return null}}
  function place(card,r,gap){
    var vw=innerWidth,vh=innerHeight,cw=card.offsetWidth,ch=card.offsetHeight,l,t;
    if(!r){l=(vw-cw)/2;t=vh-ch-16}
    else{l=r.left+r.width/2-cw/2;
      if(vh-r.bottom>=ch+gap+8)t=r.bottom+gap;
      else if(r.top>=ch+gap+8)t=r.top-ch-gap;
      else t=Math.max(8,vh-ch-12)}
    l=Math.max(8,Math.min(vw-cw-8,l));t=Math.max(8,Math.min(vh-ch-8,t));
    card.style.left=l+'px';card.style.top=t+'px'}

  Wiz.run=function(id,steps,o){
    o=o||{};if(Wiz.cur)Wiz.cur.end('skip');if(Wiz.tipEl){var tb=Wiz.tipEl.querySelector('button');if(tb)tb.click()}
    var i=-1,alive=true,raf=0,poll=0,adv=0,box=el('div','wz'+(Wiz.rm()?'':' mv')),spot=el('div','wz-spot'),
      card=el('div','wz-card'),n=el('span','wz-n'),t=el('b','wz-t'),live=el('div'),p=el('p','wz-p'),f=el('p','wz-f'),
      b=el('div','wz-b'),sk=el('button','sk','Überspringen'),go=el('button','go','Weiter'),S=null,target=null;
    card.setAttribute('role','dialog');card.setAttribute('aria-label','Rundgang');card.tabIndex=-1;
    live.setAttribute('aria-live','polite');live.appendChild(t);live.appendChild(p);
    sk.type='button';go.type='button';b.appendChild(sk);b.appendChild(go);
    card.appendChild(n);card.appendChild(live);card.appendChild(f);card.appendChild(b);box.appendChild(spot);box.appendChild(card);document.body.appendChild(box);
    function end(why){if(!alive)return;alive=false;cancelAnimationFrame(raf);clearInterval(poll);clearTimeout(adv);document.removeEventListener('keydown',key,true);box.remove();Wiz.cur=null;put(id,why==='done'?'done':'skip');if(o.onEnd)o.onEnd(why)}
    function key(e){if(e.key==='Escape'){e.preventDefault();e.stopPropagation();end('skip')}}
    function show(k){
      i=k;S=steps[i];clearTimeout(adv);if(S.pre)S.pre();
      n.textContent=(i+1)+' / '+steps.length;t.textContent=S.title||'';p.textContent=S.text||'';
      f.className='wz-f'+(S.wait?' hint':'');f.textContent=S.wait?(S.hint||'Probier es aus – ich warte.'):(S.note||'');f.style.display=f.textContent?'':'none';
      go.textContent=i===steps.length-1?'Fertig':'Weiter';sk.style.display=i===steps.length-1?'none':'';
      if(!Wiz.rm()){box.classList.add('mv')}
      target=resolve(S.sel);
      if(target){var r=target.getBoundingClientRect();if(r.top<70||r.bottom>innerHeight-40){try{target.scrollIntoView({block:r.height>innerHeight*.55?'start':'center',behavior:'auto'})}catch(e){}}}
      Wiz.cur.i=i;frame();
    }
    function frame(){
      if(!alive)return;
      target=resolve(S.sel);var r=target&&target.getBoundingClientRect();
      if(r&&(r.width||r.height)){var pd=S.pad==null?8:S.pad;
        spot.style.display='block';spot.style.left=(r.left-pd)+'px';spot.style.top=(r.top-pd)+'px';spot.style.width=(r.width+pd*2)+'px';spot.style.height=(r.height+pd*2)+'px';
        spot.style.borderRadius=(r.width<90&&Math.abs(r.width-r.height)<14)?'50%':'14px'}
      else{spot.style.display='none';r=null}
      place(card,r,r?(S.pad==null?8:S.pad)+10:0);
      raf=requestAnimationFrame(frame)}
    function next(){if(i>=steps.length-1)end('done');else show(i+1)}
    go.onclick=next;sk.onclick=function(){end('skip')};
    document.addEventListener('keydown',key,true);
    Wiz.cur={id:id,i:0,end:end,next:next};
    poll=setInterval(function(){if(!alive||!S||!S.wait||adv)return;var ok=false;try{ok=S.wait()}catch(e){}
      if(ok){f.textContent='✓ Gut.';adv=setTimeout(function(){adv=0;if(alive)next()},Wiz.rm()?150:700)}},250);
    show(0);try{card.focus({preventScroll:true})}catch(e){}
    return Wiz.cur};

  Wiz.tip=function(id,sel,text){
    if(Wiz.done(id)||Wiz.cur||Wiz.tipEl)return false;
    var tg=resolve(sel);if(!tg)return false;
    var tip=el('div','wz-tip'),tx=el('span',null,text),bt=el('button',null,'Okay'),raf=0;
    tip.setAttribute('role','status');bt.type='button';tip.appendChild(tx);tip.appendChild(bt);document.body.appendChild(tip);Wiz.tipEl=tip;put(id,'tip');
    function frame(){var t2=resolve(sel);place(tip,t2&&t2.getBoundingClientRect(),10);raf=requestAnimationFrame(frame)}
    function close(){cancelAnimationFrame(raf);document.removeEventListener('keydown',kd,true);tip.remove();Wiz.tipEl=null}
    function kd(e){if(e.key==='Escape')close()}
    bt.onclick=close;document.addEventListener('keydown',kd,true);frame();return true};

  Wiz.offer=function(id,o){
    if(Wiz.done(id))return null;
    var b=el('div','wz-offer'),p=el('p',null,o.text),r=el('div','r'),a=el('button','go',o.start||'Rundgang starten'),c=el('button',null,o.no||'Nein danke');
    b.setAttribute('role','region');b.setAttribute('aria-label','Neu hier?');a.type='button';c.type='button';
    r.appendChild(a);r.appendChild(c);b.appendChild(p);b.appendChild(r);
    o.before.parentNode.insertBefore(b,o.before);
    a.onclick=function(){b.remove();if(o.onStart)o.onStart()};
    c.onclick=function(){b.remove();put(id,'no')};
    return b};
  window.Wiz=Wiz;
})();

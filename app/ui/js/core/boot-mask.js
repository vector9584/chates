/* 启动就绪蒙版：网关 8742 未就绪前挡住输入区，就绪后自动淡出。
 * 来源：index.html 内联块，2026-11-13 原样外移。 */

/* 启动就绪蒙版：网关 8742 没起来前挡住发消息（这期间发必超时），就绪后自动淡出。
   实测依据：12:18:56 进程起 → 12:20:05 :8742 才监听，中间 70 秒全在 MCP 探测。
   ?bootdemo=1 只看启动态，?bootdemo=2 直接演就绪态，都只用于验证。 */
/* 输入框蒙版：网关 8742 没起来前挡住发送区（这期间发消息必超时），就绪后自己消失。
   实测依据 11-04：进程 12:18:56 起 → 12:20:05 :8742 才监听，中间 70 秒卡在 MCP 探测。
   ?bootdemo=1 停在启动态，?bootdemo=2 演一遍就绪淡出——只用于验证，别写进链接。 */
/* 输入框启动面板：网关 8742 没起来前锁住输入区（这期间发消息必超时），就绪后自己消失。
   实测依据 11-04：进程 12:18:56 起 → 12:20:05 :8742 才监听，中间 70 秒卡在 MCP 探测。
   ?bootdemo=1 停在启动态，?bootdemo=2 演一遍就绪淡出——只用于验证，别写进链接。 */
(function(){
  var DEMO=(/[?&]bootdemo=([12])/.exec(location.search)||[])[1]||null;
  var T_READY='可以开始对话了';
  var t0=Date.now(), timer=null, done=false, showing=false, panels=[];
  /* 启动探测遇到断网时，在原输入区的启动面板里换文案。 */
  var notice='';
  var NOTICE_TEXT={offline:'连不上服务，正在重试…'};
  /* 五格进度（2026-11-13 用户第 41 条）：面板 / 网关 / 渠道会话 / 会话队列 / 草稿箱。
     后两格以前不在蒙版里 —— 蒙版一撤它们才慢慢长出来，画面就一闪一闪。
     现在由 panel-durable 的 init 调 window.bootMaskMark('queue'|'draft') 报到。 */
  var ORDER=['panel','gw','sess','queue','draft'], readyK={};
  function sec(){ return Math.round((Date.now()-t0)/1000); }
  function fmtSec(s){
    if(s<60) return s+'s';
    var m=Math.floor(s/60), r=s%60;
    return m+'m'+(r<10?'0':'')+r+'s';
  }
  /* 秒数锚定到服务的启动时刻，而不是页面打开的时刻：
     刷新页面看到的是「服务已经起了多久」，不会从 0s 重数一遍。 */
  function anchor(){
    if(!window.apiGet) return;
    apiGet('/api/status').then(function(d){
      if(d && typeof d.uptimeMs==='number' && d.uptimeMs>=0){ t0=Date.now()-d.uptimeMs; }
    }).catch(function(){});
  }
  /* ── 输入区面板组件：启动和重启共用同一块 DOM、同一套样式（css/base.css 的 .boot-panel）。
     以后嫌丑只改这一处。调用方只填内容：标题、步骤、正文、按钮。 ── */
  var STEPS=[['panel','面板服务'],['gw','消息网关'],['sess','渠道会话'],['queue','消息队列'],['draft','草稿箱']];
  function makePanel(){
    var el=document.createElement('div');
    el.className='boot-panel';
    el.setAttribute('aria-live','polite');
    el.innerHTML=
      '<div class="bp-head"><span class="bp-spin" aria-hidden="true"></span>'
      +'<span class="bp-title"></span><span class="bp-sec"></span></div>'
      +'<ul class="bp-steps">'+STEPS.map(function(s){return '<li data-k="'+s[0]+'"><i></i>'+s[1]+'</li>';}).join('')+'</ul>'
      +'<p class="bp-msg"></p>'
      +'<div class="bp-acts"></div>'
      +'<div class="bp-bar"><i></i></div>';
    return el;
  }
  /* 顶替输入区：插在同一位置、量好高度对齐，再把原输入区整个撤走。
     只有真要显示时才由调用方加 .show + .bp-swapped（探测前插入绝不能留孤儿隐身输入区）。 */
  function swapIn(id){
    var ta=document.getElementById(id); if(!ta) return null;
    var wrap=ta.closest('.input-wrap'); if(!wrap) return null;
    var outer=wrap.closest('.input-outer')||wrap;
    var host=outer.parentNode; if(!host) return null;
    if(host.querySelector('.boot-panel')) return null;
    var hpx=Math.round(outer.getBoundingClientRect().height)||0;
    var el=makePanel();
    if(hpx>0) el.style.minHeight=hpx+'px';
    host.insertBefore(el,outer);
    return {el:el,outer:outer,hpx:hpx};
  }
  function ensure(){
    if(done) return;
    ['chatInput','roomCompose'].forEach(function(id){
      var s=swapIn(id); if(!s) return;
      s.el.querySelector('.bp-title').textContent='正在启动 Hermes';
      s.el.querySelector('.bp-sec').textContent='0s';
      panels.push(s);
      if(showing){
        s.el.classList.add('show');
        s.outer.classList.add('bp-swapped');
        fit(s.el,s.hpx);
      }
    });
  }
  /* 放不下就简化：蒙版高度按原输入框定死，内容更高就砍步骤、缩提示，
     但「标题 + 秒数 + 进度条」三样永远留着（用户 2026-11-12：进度条是需要的） */
  function fit(el,hpx){
    el.classList.remove('compact');
    if(!hpx) return;
    /* 允许比原输入区高 40px 再简化：多出一点点不挤聊天区，砍掉步骤反而信息更少 */
    if(el.scrollHeight > hpx+40) el.classList.add('compact');
  }
  function applyNotice(){
    if(done) return;
    panels.forEach(function(o){
      var el=o.el, t=el.querySelector('.bp-title');
      if(t) t.textContent = NOTICE_TEXT[notice] || '正在启动 Hermes';
      el.classList.toggle('warn', !!notice);
      /* 连不上时别继续转圈：转圈的意思是「在推进」，断网时并没有在推进 */
      el.classList.toggle('stalled', notice==='offline');
    });
  }
  /* 应用重启/重连：同一个面板组件，只是换成「标题+一句正文+按钮」，步骤和进度条收起来。
     锁的永远是输入区（用户 2026-11-20 两次纠正：蒙版一直是输入框的蒙版）。 */
  var rt=null;
  function rtUnmount(){
    window.__bootMaskHold=false;
    if(!rt) return;
    var o=rt;
    rt=null;
    o.el.classList.remove('show');
    o.outer.classList.remove('bp-swapped');
    setTimeout(function(){ if(o.el.parentNode) o.el.parentNode.removeChild(o.el); },200);
  }
  window.bootMaskRuntime=function(kind,title,message,actions){
    if(!kind){ rtUnmount(); return; }
    if(!rt){
      if(showing) return;                       /* 启动面板在位时它已经顶着输入区 */
      var s=swapIn('chatInput'); if(!s) return;
      rt={el:s.el,outer:s.outer,actKey:''};
      rt.el.classList.add('show');
      rt.el.querySelector('.bp-steps').hidden=true;
      rt.el.querySelector('.bp-bar').hidden=true;
      rt.el.querySelector('.bp-sec').hidden=true;
      s.outer.classList.add('bp-swapped');
      window.__bootMaskHold=true;               /* 锁着输入的时候顶栏别亮绿 */
    }
    rt.el.dataset.state=kind;
    var t=rt.el.querySelector('.bp-title'), p=rt.el.querySelector('.bp-msg'), box=rt.el.querySelector('.bp-acts');
    if(t&&t.textContent!==(title||''))t.textContent=title||'';
    if(p&&p.textContent!==(message||''))p.textContent=message||'';
    var list=actions||[], key=list.map(function(a){return a.label;}).join('|');
    if(box&&rt.actKey!==key){
      rt.actKey=key; box.replaceChildren();
      list.forEach(function(a){var b=document.createElement('button');b.type='button';b.textContent=a.label;box.appendChild(b);});
    }
    if(box)Array.from(box.children).forEach(function(b,i){b.onclick=list[i]&&list[i].run;});
  };
  function stepOf(el,k){ return el.querySelector('[data-k="'+k+'"]'); }
  function stage(el,n){
    var bar=el.querySelector('.bp-bar i');
    if(bar) bar.style.width=Math.round(n/ORDER.length*100)+'%';
  }
  function setStep(el,k,cls){
    var li=stepOf(el,k); if(!li) return;
    li.classList.remove('active','done'); if(cls) li.classList.add(cls);
  }
  function stageAll(){
    var n=0; ORDER.forEach(function(k){ if(readyK[k]) n++; });
    panels.forEach(function(o){ stage(o.el,n); });
  }
  function allDone(){
    for(var i=0;i<ORDER.length;i++) if(!readyK[ORDER[i]]) return false;
    return true;
  }
  /* 唯一的「这一格好了」入口。五格全绿才收蒙版，少一格就一直挂着——
     挂死的风险由 probe() 里的 6s 兜底定时器兜住。 */
  function mark(k){
    if(done||readyK[k]||ORDER.indexOf(k)<0) return;
    readyK[k]=true;
    panels.forEach(function(o){ setStep(o.el,k,'done'); });
    stageAll();
    if(allDone()) ready();
  }
  window.bootMaskMark=mark;
  function tick(){
    var s=sec();
    panels.forEach(function(o){
      var el=o.el;
      if(el.classList.contains('ready')) return;
      var secEl=el.querySelector('.bp-sec'); if(secEl) secEl.textContent=fmtSec(s);
    });
  }
  /* 2026-11-13 第 50 条（用户原话）：「我重新打开页面的时候，顶上的那个字母已经是橙色了，
     相当于是它正在重新连，但是你那个蒙版居然还没有出现……蒙版至少要和顶上那一道一致。」
     根因：顶栏的橙是 index.html 静态类 connecting，第一帧就有；蒙版却要等 probeBoot 探完
     （失败还要 600→1200→2000ms 三次退避，最长 3.8 秒）才创建。这段时间「顶上橙着、输入区能打字」。
     改法：页面一进来就 show('pending') —— 蒙版第一帧在位，徽标保持橙色，两边同一个起点；
     之后由 1.2s 主循环探测，探测通过才 mark 五格、才 ready()、才把徽标转绿。
     mode: undefined=冷启动（已知网关不通，立刻把徽标打橙）｜'pending'=刚打开、结果未知（徽标本来就是橙的，不重复上报） */
  function show(mode){
    if(done) return;
    var pend=(mode==='pending');
    showing=true;
    /* 端口没验证过就不许亮绿：pending 也一样——「还没探到」不等于「通」。
       这样 overview 的 /api/status 轮询（它只看进程在不在）永远没法抢在蒙版前面点亮绿色。 */
    window.__gwPortOk=false;
    /* 给别的模块一个判据：蒙版在位时，底部的连接横条让位，别同一个断线说两遍 */
    window.__bootMaskActive=true;
    /* 「还没 ready」：顶栏绿只能由 ready() 点亮，overview 的 /api/status 轮询期间一律降成橙。
       否则会撞出「点已经绿了、输入区还被挡着」——正是用户 2026-11-13 说的两套自相矛盾。 */
    window.__bootMaskHold=true;
    ensure();
    if(!pend) anchor();
    document.body.classList.add('bp-restoring');
    panels.forEach(function(o){
      o.el.classList.add('show');
      o.outer.classList.add('bp-swapped');   /* 顶替，不是覆盖 */
      fit(o.el,o.hpx);
      /* 这里必须走 mark 而不是裸 setStep：mark 才会把 readyK.panel 记上，
         否则五格里永远差第一格，allDone() 假到底，蒙版只能靠 6s 兜底才撤
         （2026-11-13 实测：健康的机器每次刷新都要被挡 6.7 秒）。 */
      mark('panel');
      setStep(o.el,'gw','active');
      stage(o.el,1);
    });
    /* 出现时机与顶栏同一套：蒙版在位 ⇔ 点不是绿的 */
    /* pending 不动徽标：静态 HTML 里本来就是 connecting/橙，这里再写一遍只是同一状态重复上报 */
    if(!pend && window.setBrandConnection) window.setBrandConnection('connecting','连接中');
    applyNotice();
    tick();
    if(DEMO==='1') return;
    if(DEMO==='2'){ setTimeout(ready,1400); return; }
    timer=setInterval(function(){
      tick();
      ensure();
      /* 2026-11-13 第 48 条（用户原话）：「要是网关那一道过不去的话，蒙版就得一直留着，
         因为网关启动不起来，字发出去也没有意义」。所以不再有「等太久先放你进来」——
         没就绪就一直挡着，用户自己刷新页面是唯一出口。 */
      probe();
    },1200);
    probe();
  }
  function finishSessions(n){
    mark('sess');
  }
  function probeSessions(){
    if(!window.apiGet){ finishSessions(); return; }
    apiGet('/api/channel-sessions').then(function(d){
      var n=0;
      if(d&&d.groups){ for(var k in d.groups){ if(d.groups[k]&&d.groups[k].length) n+=d.groups[k].length; } }
      finishSessions(n);
    }).catch(function(){ finishSessions(); });
  }
  var probeMiss=0;
  function probe(){
    if(done||!window.apiGet) return;
    apiGet('/api/gateway/health').then(function(d){
      if(done) return;
      if(!(d&&d.ok)){
        /* 刚打开页面时空一两次是常态（会话恢复、代理重连），别急着把秒数跳到「服务已运行 3 天」；
           连续 3 次（≈3.6s）都空才认定「网关真没起来」，这时秒数才有意义。 */
        if(++probeMiss>=3){ anchor(); notice='offline'; applyNotice(); }
        return;
      }
      probeMiss=0;
      /* 这里只管理输入区的启动面板；全屏重启蒙版由应用重启回执解锁。 */
      if(notice==='offline'){ notice=''; applyNotice(); }
      window.__gwPortOk=true;
      mark('gw');
      /* 已经报到的格子别再刷回「进行中」——每 1.2s 探测一次，之前这里把
         兜底补上的 sess 反复涂回 active，看着像卡在第三格。 */
      panels.forEach(function(o){ if(!readyK.sess) setStep(o.el,'sess','active'); });
      /* 兜底：panel-durable 若没加载/报错，队列与草稿这两格永远报不到，
         蒙版就会一直挂着。6s 之后还没报的格子直接算过，宁可少盖一会儿也不能卡住。 */
      setTimeout(function(){ if(!done){ mark('sess'); mark('queue'); mark('draft'); } }, 6000);
      probeSessions();
    }).catch(function(){ if(++probeMiss>=3) anchor(); });
  }
  function ready(){
    if(done) return; done=true;
    notice='';
    try{ sessionStorage.setItem('hermesReadyAt', String(Date.now())); }catch(e){}
    if(timer){ clearInterval(timer); timer=null; }
    panels.forEach(function(o){
      var el=o.el;
      el.classList.add('ready');
      ORDER.forEach(function(k){ setStep(el,k,'done'); });
      stage(el,ORDER.length);
      var t=el.querySelector('.bp-title'); if(t) t.textContent=T_READY;
      var secEl=el.querySelector('.bp-sec'); if(secEl) secEl.textContent='';
    });
    window.__gwPortOk=true;
    window.__bootMaskHold=false;   /* 从这一行起才允许亮绿：绿 = 真的能发消息 */
    /* 蒙版收走的那一帧，顶栏就该是绿的——两边同一套状态，不许一个绿一个橙 */
    if(window.setBrandConnection) window.setBrandConnection('online','已连接');
    /* 聊天区在蒙版撤走后 200ms 才显影：历史重绘正好落在这一段里，用户看不到「先出一半」 */
    setTimeout(function(){ document.body.classList.remove('bp-restoring'); },200);
    setTimeout(function(){
      panels.forEach(function(o){
        if(o.el.parentNode) o.el.parentNode.removeChild(o.el);
        o.outer.classList.remove('bp-swapped');   /* 输入框+工具栏回位 */
      });
      panels=[]; showing=false;
      window.__bootMaskActive=false;
    },900);
  }
  /* ── 会话读取门（2026-11-20 用户）：会话没读完不许打字 ──
     以前只有启动时挡输入，切到一个大会话时正文还在路上，输入区已经能敲了；
     敲完发出去接的是旧状态。这里复用同一套「顶替输入区」的做法：
     快于 180ms 的加载不弹（缓存命中本来就一瞬），超过才挡住，读完自己撤。 */
  var busyEl=null, busyOuter=null, busyTimer=null, busyText='正在读取会话…';
  function busyHost(){
    var ta=document.getElementById('chatInput'); if(!ta) return null;
    var wrap=ta.closest('.input-wrap'); if(!wrap) return null;
    var outer=wrap.closest('.input-outer')||wrap;
    return outer.parentNode ? {outer:outer, host:outer.parentNode} : null;
  }
  function showBusy(){
    if(showing) return;              /* 启动蒙版在位时不用再来一层；启动完成后这里才是主战场 */
    var h=busyHost(); if(!h) return;
    if(!busyEl){
      /* 高度必须和原输入区一样：输入区高矮一变，上面的聊天区可用高度就变，
         贴底的内容会跟着上下挪一格——为了挡一下输入反而制造一次跳动不值得。 */
      var hpx=Math.round(h.outer.getBoundingClientRect().height)||0;
      busyEl=document.createElement('div');
      busyEl.className='boot-panel bp-busy show';
      busyEl.setAttribute('role','status');
      busyEl.innerHTML='<span class="bp-spin"></span><span class="bp-title"></span>';
      if(hpx>0) busyEl.style.minHeight=hpx+'px';
      h.host.insertBefore(busyEl,h.outer);
      busyOuter=h.outer;
      busyOuter.classList.add('bp-swapped');
    }
    var t=busyEl.querySelector('.bp-title'); if(t) t.textContent=busyText;
  }
  function hideBusy(){
    clearTimeout(busyTimer);
    if(!busyEl) return;
    var el=busyEl, o=busyOuter;
    busyEl=null; busyOuter=null;
    el.classList.remove('show');
    if(o) o.classList.remove('bp-swapped');
    setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); },240);
  }
  window.bootMaskBusy=function(text){
    if(showing) return;
    if(text) busyText=text;
    clearTimeout(busyTimer);
    busyTimer=setTimeout(showBusy,180);
  };
  window.bootMaskBusyEnd=hideBusy;
  /* 防御：健康就绪时清掉任何历史孤儿锁（老版本可能在探测前上过锁） */
  function unlockAll(){
    var ls=document.querySelectorAll('.bp-locked,.bp-swapped');
    for(var i=0;i<ls.length;i++) ls[i].classList.remove('bp-locked','bp-swapped');
    window.__gwPortOk=true;
  }
  /* 心跳：就绪后每 15s 探一次。服务停了就重新亮面板——在面板「概览 → 运行服务」
     点重启也能看到进度，恢复后自己淡出，不用手动刷新页面。页面隐藏时跳过省电。 */
  function restart(){
    if(timer){ clearInterval(timer); timer=null; }
    unlockAll();
    done=false; showing=false; panels=[]; t0=Date.now();
    var old=document.querySelectorAll('.boot-panel');
    for(var i=0;i<old.length;i++){ if(old[i].parentNode) old[i].parentNode.removeChild(old[i]); }
    var hid=document.querySelectorAll('.bp-swapped');
    for(var j=0;j<hid.length;j++) hid[j].classList.remove('bp-swapped');
    show();
  }
  var wdMisses=0;
  function watchdog(){
    setInterval(function(){
      if(document.hidden||!window.apiGet) return;
      if(showing&&!done) return;              /* 面板亮着，主循环在探 */
      apiGet('/api/gateway/health').then(function(d){
        var ok=!!(d&&d.ok);
        if(ok){
          wdMisses=0;
          var recovered = (window.__gwPortOk === false);   /* 之前被抖动失败打成 false，这次探到了 */
          window.__gwPortOk=true;
          if(showing&&!done){ ready(); return; }
          /* 就绪后的心跳：探到健康就恢复绿。若上次失败把标记打成 false（顶栏因此一直橙），
             这里即时拉回，不用干等 overview 的 3s 轮询。 */
          if(recovered && !window.__bootMaskHold && window.setBrandConnection) window.setBrandConnection('online','已连接');
          return;
        }
        /* 连续两轮（≥30s）探不到才认定服务真停了；单次打空多半是切网/后台回来 */
        window.__gwPortOk=false;
        wdMisses++; if(!showing&&wdMisses>=2) restart();
      }).catch(function(){ window.__gwPortOk=false; wdMisses++; if(!showing&&!done&&wdMisses>=2) restart(); });
    },15000);
  }
  /* 跟顶栏状态点共用一套时机：橙/红 → 蒙版在位，绿 → 蒙版撤走。
     这样"点还橙着却能打字""点绿着输入区还被挡"两种情况都不会再出现。 */
  window.addEventListener('hermes:conn',function(e){
    if(DEMO) return;
    var st=(e.detail||{}).state;
    if(st==='online'){ notice=''; if(showing&&!done) applyNotice(); if(showing&&!done) ready(); return; }
    if(st==='connecting'||st==='offline'){
      if(!showing&&!done) show();
      /* 已经挂着启动蒙版时，断网也要改口；只把 connecting 当断网会误报（启动中本来就是橙） */
      else if(showing&&!done && st==='offline'){ notice='offline'; applyNotice(); }
    }
  });
  function boot(){
    if(DEMO){ show(); return; }
    if(!window.apiGet){ show(); return; }
    /* 第一帧就把蒙版立起来，跟顶栏那个橙色是同一个起点；show() 里已经挂了 1.2s 探测主循环 */
    show('pending');
    watchdog();
  }
  /* 别等 DOMContentLoaded：那要等整页解析完（实测 251ms，FCP 才 136ms），
     等于顶栏已经橙了 115ms 蒙版才起来。脚本就在 </body> 前，挂载点此时已在，直接起。 */
  if(document.readyState!=='loading'||document.querySelector('.input-outer')) boot();
  else document.addEventListener('DOMContentLoaded',boot);
})();

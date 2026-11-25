/* Mini Popup
 * 来源：index.html 内联 app.js 第 4890-5420 行（共 531 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ Mini Popup ============================ */
/* 构建模型下拉选项（按 Provider 分组、仅含启用模型）；当前值不在列表中时补一个自定义项 */
function buildModelOptionsHtml(currentValue, emptyLabel){
  var cur = String(currentValue||'');
  var html = '<option value="">'+esc(emptyLabel||'（跟随默认配置）')+'</option>';
  var found = !cur;
  (_cfg.providers||[]).filter(function(p){return p.enabled!==false;}).forEach(function(p){
    var provName = p.name || p.id;
    var models = (p.models && p.models.length) ? p.models : [{ id:p.model||'auto', name:p.model||'auto', enabled:true }];
    var opts='';
    models.forEach(function(m){
      if(m.enabled === false) return;
      var modelId = m.id || m.name || 'auto';
      var modelName = m.name || m.id || 'auto';
      if(modelId===cur) found=true;
      opts += '<option value="'+DOM.escAttr(modelId)+'"'+(modelId===cur?' selected':'')+'>'+esc(modelName)+'</option>';
    });
    if(opts) html += '<optgroup label="'+DOM.escAttr(provName)+'">'+opts+'</optgroup>';
  });
  if(!found) html += '<optgroup label="当前配置"><option value="'+DOM.escAttr(cur)+'" selected>'+esc(cur)+'（不在模型列表中）</option></optgroup>';
  return html;
}
/* ─── 思考强度（2026-11-20 建，2026-11-21 去掉「跟随」）──────────────
   档位直接落在内核的 reasoning_effort 上，不另造一套词：
   关 = thinking disabled；低/中/高 = effort 三档。
   以前还有一档「跟随默认」＝请求里根本不发 model_options，让服务商自己定 ——
   看着省事，代价是日志里只能记 reason=-、用量页只能写「未记」，谁也说不清
   这一轮到底思没思考。现在四档全显式，默认关（关 = 不花思考 token）。 */
var REASONING_LEVELS = [
  { id:'off',    t:'关',   d:'不思考' },
  { id:'low',    t:'低',   d:'浅想' },
  { id:'medium', t:'中',   d:'均衡' },
  { id:'high',   t:'高',   d:'深想' }
];
var REASONING_DEFAULT = 'off';
/* 会话档位存两处，职责不同（2026-11-21 定）：
     后端 —— 唯一权威。每轮请求都显式带 model_options.reasoning，内核把它记在
             会话状态里，刷新/切会话/换设备都以它为准；
     本地 —— 只当「首屏缓存」。面板刚打开、会话列表还没拉回来时先用它渲染，
             后端一回来立刻覆盖。两层同值就什么都不做，不同值以后端为准。
   所以这里不再把本地当唯一真源，也不在没会话 id 时假装写成功。 */
var _reasoningMap = (function(){ try{ var s=localStorage.getItem('hermes_session_reasoning_map'); return s?(JSON.parse(s)||{}):{}; }catch(e){ return {}; } })();
function _getSessionReasoning(sid){
  if(!sid) sid=currentSession;
  return (sid && _reasoningMap[sid]) || REASONING_DEFAULT;
}
function _setSessionReasoning(sid, level){
  if(!sid) sid=currentSession;
  if(!sid) return;
  /* 等于默认值就不存：localStorage 只记「跟默认不一样」的会话，
     读的时候照样回落到 REASONING_DEFAULT，行为不变、记录更干净 */
  if(level && level!==REASONING_DEFAULT) _reasoningMap[sid]=level; else delete _reasoningMap[sid];
  try{ localStorage.setItem('hermes_session_reasoning_map', JSON.stringify(_reasoningMap)); }catch(e){}
  _syncReasoningBtn();
  pushReasoningToServer(sid, level);
}
/* 把档位写进后端会话状态。失败不打断用户操作：本地已经生效，
   下一轮请求照样带 model_options.reasoning，只是刷新后要靠本地缓存兜底。 */
function pushReasoningToServer(sid, level){
  if(!sid) return;
  try{
    var payload = (level==='off') ? {reasoning:{enabled:false}} : {reasoning:{enabled:true, effort:level}};
    var body = JSON.stringify(payload);
    fetch('/app/hermes-agent/api/workspace-ui/session-reasoning/'+encodeURIComponent(sid), {
      method:'PUT', headers:{'Content-Type':'application/json'}, body:body, credentials:'same-origin'
    }).catch(function(){});
  }catch(e){}
}
/* 从后端取回某会话的档位，并覆盖本地缓存。返回 null 表示后端没有记录（跟默认一致）。 */
function pullReasoningFromServer(sid){
  if(!sid) return;
  try{
    fetch('/app/hermes-agent/api/workspace-ui/session-reasoning/'+encodeURIComponent(sid), {credentials:'same-origin'})
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){
        if(!d || !d.ok) return;
        var lv = d.effort ? d.effort : 'off';
        if(lv===_getSessionReasoning(sid)) return;       // 同值不重绘，免得弹层里滑块跳一下
        if(lv && lv!=='off') _reasoningMap[sid]=lv; else delete _reasoningMap[sid];
        try{ localStorage.setItem('hermes_session_reasoning_map', JSON.stringify(_reasoningMap)); }catch(e){}
        _syncReasoningBtn();
        var ti=document.querySelector('#popupBody think-intensity');
        if(ti && sid===currentSession){ ti.setLevelQuiet(reasoningIndexOf(lv)+1); refreshReasoningTitle(); }
      })
      .catch(function(){});
  }catch(e){}
}
function _reasoningLabel(id){
  for(var i=0;i<REASONING_LEVELS.length;i++){ if(REASONING_LEVELS[i].id===id) return REASONING_LEVELS[i].t; }
  return '关';
}
function _reasoningDesc(id){
  for(var i=0;i<REASONING_LEVELS.length;i++){ if(REASONING_LEVELS[i].id===id) return REASONING_LEVELS[i].d; }
  return '不思考';
}
/* ─── think-intensity 组件桥接（2026-11-21 换新版滑块）─────────────────
   组件只认 1..4（关/轻/均衡/极致），内核只认 off/low/medium/high。
   两边靠下面这两个纯函数互换，别在别处再写第三套映射。 */
function reasoningIndexOf(id){
  for(var i=0;i<REASONING_LEVELS.length;i++){ if(REASONING_LEVELS[i].id===id) return i; }
  return 0;                                  // 不认识的档位一律落回「关」
}
function reasoningIdOf(idx){
  var i=Math.max(1,Math.min(REASONING_LEVELS.length,Number(idx)||1))-1;
  return REASONING_LEVELS[i].id;
}
/* 面板深色 ↔ dusk，浅色 ↔ light。图标换不换这套配色都读得懂，但圆点底色、
   云雾色系差得远，反着用一眼能看出来。 */
function _tiTheme(){
  var dark=document.body.classList.contains('theme-dark')
        || document.documentElement.classList.contains('theme-dark');
  return dark ? 'dusk' : 'light';
}
/* ─── 滑轨控件（2026-11-20 五张卡片 → 滑块，2026-11-21 重做手感）───────
   四档等距刻度，默认停在最左「关」。拖动时滑块跟着手指连续走（不再一卡一卡
   跳刻度），松开才吸附到最近刻度并存档 —— 这样才「丝滑」而不是四级跳。
   点轨道任意位置、左右键也能改；刻度标签 pointer-events:none，点文字等于点轨道。 */
function _rsTicks(root){ return root ? root.querySelectorAll('.rs-tick') : []; }
function _rsRail(root){ return root ? root.querySelector('.rs-rail') : null; }
function _rsPctOf(root, clientX){
  var rail=_rsRail(root); if(!rail) return 0;
  var r=rail.getBoundingClientRect();
  return Math.min(100, Math.max(0, ((clientX-r.left)/Math.max(1,r.width))*100));
}
function _rsNearest(root, pct){
  var n=_rsTicks(root).length;
  if(n<2) return 0;
  return Math.max(0, Math.min(n-1, Math.round(pct/100*(n-1))));
}
function _rsSetPos(root, pct){
  var fill=root.querySelector('.rs-fill'), thumb=root.querySelector('.rs-thumb');
  var rail=root.querySelector('.rs-rail');
  /* 圆点位置按像素算，不交给 CSS 百分比：
     CSS 里 translateX 的 100% 指的是圆点自身宽度（36px），不是轨道宽，
     拿它乘进度算出来永远是 0 —— 圆点会卡在左边不动（2026-11-21 实测踩到）。
     正确行程 = 轨道内容区宽 - 圆点宽，内容区宽 = 轨道宽 - 2×padding。 */
  if(fill) fill.style.width=pct+'%';
  if(thumb && rail){
    var cs=getComputedStyle(rail);
    var pad=parseFloat(cs.paddingLeft)||0;
    var innerW=rail.clientWidth-pad*2;
    var tw=thumb.offsetWidth;
    var travel=Math.max(0, innerW-tw);
    thumb.style.transform='translateY(-50%) translateX('+(travel*pct/100).toFixed(2)+'px)';
  }
}
function _rsPaintTicks(root, idx){
  var ticks=_rsTicks(root);
  for(var i=0;i<ticks.length;i++){ ticks[i].classList.toggle('active', i===idx); }
}
function _paintReasoningSlider(root, lv){
  if(!root) return;
  if(typeof lv!=='string') lv=_getSessionReasoning();
  var ticks=_rsTicks(root), n=ticks.length, idx=0;
  for(var i=0;i<n;i++){ if((ticks[i].getAttribute('data-lv')||'')===lv){ idx=i; break; } }
  root.classList.remove('dragging');
  _rsPaintTicks(root, idx);
  _rsSetPos(root, n>1 ? (idx/(n-1))*100 : 0);
  root.classList.toggle('is-off', lv==='off');
  root.classList.toggle('is-max', n>1 && idx===n-1);
  root.setAttribute('aria-valuenow', String(idx));
  root.setAttribute('aria-valuetext', _reasoningLabel(lv));
  var panel=root.parentNode;
  if(panel){
    var cap=panel.querySelector('.rs-cap b'); if(cap) cap.textContent=_reasoningLabel(lv);
    var capd=panel.querySelector('.rs-cap-d'); if(capd) capd.textContent=_reasoningDesc(lv);
  }
}
function rsDown(ev, root){
  if(ev.button!==undefined && ev.button!==0) return;
  ev.preventDefault();
  try{ root.focus({ preventScroll:true }); }catch(e){}
  root.classList.add('dragging');
  try{ root.setPointerCapture(ev.pointerId); }catch(e){}
  var lastX=ev.clientX;
  var paint=function(x){
    var pct=_rsPctOf(root, x);
    _rsSetPos(root, pct);                 /* 连续跟随，不吸附 */
    var idx=_rsNearest(root, pct);
    _rsPaintTicks(root, idx);             /* 只高亮最近刻度，值等松手才落 */
    root.classList.toggle('is-off', idx===0);
    root.classList.toggle('is-max', idx===_rsTicks(root).length-1);
    root.setAttribute('aria-valuetext', _reasoningLabel((_rsTicks(root)[idx]||{}).getAttribute ? _rsTicks(root)[idx].getAttribute('data-lv') : 'off'));
  };
  paint(ev.clientX);
  var move=function(e){
    if(Math.abs(e.clientX-lastX)<1) return;   /* 1px 抖动不必重绘 */
    lastX=e.clientX; paint(e.clientX);
  };
  var up=function(e){
    document.removeEventListener('pointermove',move);
    document.removeEventListener('pointerup',up);
    document.removeEventListener('pointercancel',up);
    root.classList.remove('dragging');
    var pct=_rsPctOf(root, (e && e.clientX!==undefined) ? e.clientX : lastX);
    var t=_rsTicks(root)[_rsNearest(root, pct)];
    setReasoningLevel((t && t.getAttribute('data-lv')) || REASONING_DEFAULT, root);
  };
  document.addEventListener('pointermove',move);
  document.addEventListener('pointerup',up);
  document.addEventListener('pointercancel',up);
}
function rsKey(ev, root){
  var ticks=_rsTicks(root), n=ticks.length; if(!n) return;
  var cur=-1;
  for(var i=0;i<n;i++){ if(ticks[i].classList.contains('active')){ cur=i; break; } }
  var next=null;
  if(ev.key==='ArrowRight'||ev.key==='ArrowUp') next=(cur<0?0:Math.min(n-1,cur+1));
  else if(ev.key==='ArrowLeft'||ev.key==='ArrowDown') next=(cur<0?n-1:Math.max(0,cur-1));
  else if(ev.key==='Home') next=0;
  else if(ev.key==='End') next=n-1;
  if(next===null) return;
  ev.preventDefault();
  setReasoningLevel((ticks[next]&&ticks[next].getAttribute('data-lv'))||REASONING_DEFAULT, root);
}
function _syncReasoningBtn(){
  var b=document.getElementById('btnReasoning'); if(!b) return;
  var lv=_getSessionReasoning();
  /* 角标撤了（2026-11-21 主人要求）：输入框下面那排按钮已经够挤，
     当前档位在弹层的「当前 X」里看得见，按钮自己只保留亮/灭。 */
  var old=b.querySelector('.rs-badge'); if(old) old.remove();
  var on=lv && lv!=='off';
  b.classList.toggle('active', !!on);
  /* 档位挂回气泡（2026-11-21 晚，主人第五次提）：之前把 data-tip 一并摘掉，
     结果 hover 时这个按钮什么都不显示，而隔壁模型/能力/技能按钮都有气泡。
     现在设成「思考强度 · 低」之类，hover/点按都能看到当前档位。
     openMini 按钮在 panel-tooltip 里被排除的是 click 叠弹层逻辑，mouseover 仍走
     单例气泡，不会再出现「两份档位文案叠一起」的旧问题。 */
  b.setAttribute('data-tip', '思考强度 · ' + _reasoningLabel(lv));
  b.removeAttribute('title');
}
/* ─── 挂 think-intensity 组件（2026-11-21 换新版滑块）──────────────────
   组件内部已经把拖拽/点轨道/键盘/缓动全做了，宿主只需要：
     1. 标好当前会话的档位与主题（theme 由 body.theme-dark 决定）
     2. 听 change 事件 → 写回会话 → 同步按钮
   回写一律用 setLevelQuiet：组件新版在 level 属性变化时也会派发 change，
   直接用属性回写会被当成「用户动了滑块」，上层再存一次就成环。 */
function bindThinkIntensity(root, key){
  if(!root) return;
  var el=root.querySelector('think-intensity');
  if(!el) return;
  var lv=_getSessionReasoning();
  el.setAttribute('theme', _tiTheme());
  el.setLevelQuiet(reasoningIndexOf(lv)+1);
  el.addEventListener('change', function(e){
    var id=reasoningIdOf(e.detail && e.detail.level);
    setReasoningLevel(id, el);
  });
}
/* 主题切换后（浅↔深）把弹层里的组件配色一起换掉，不必重开弹层 */
function syncThinkIntensityTheme(){
  var els=document.querySelectorAll('#popupBody think-intensity');
  for(var i=0;i<els.length;i++) els[i].setAttribute('theme', _tiTheme());
}
function setReasoningLevel(level, el){
  level=level||REASONING_DEFAULT;
  _setSessionReasoning(currentSession, level);
  /* 组件的档位由它自己维护（用户点的就是它），这里只管把按钮和文案对齐。
     组件已被销毁时（弹层重开）由 bindThinkIntensity 重新按会话值渲染。 */
  var ti=(el && el.tagName==='THINK-INTENSITY') ? el
       : (el && el.closest && el.closest('think-intensity'))
       || document.querySelector('#popupBody think-intensity');
  if(ti) ti.setLevelQuiet(reasoningIndexOf(level)+1);
  refreshReasoningTitle();
}
/* 弹层标题跟着档位走（2026-11-21）：弹层开着拖滑块/点刻度/按键改档，
   标题也当场变「思考强度 · 中」，不是等重开才更新。 */
function refreshReasoningTitle(){
  if(activePanel!=='reasoning') return;
  var t=document.getElementById('popupTitle'); if(!t) return;
  t.textContent='思考强度 · '+_reasoningLabel(_getSessionReasoning());
}
function buildMiniData(){
  // 模型选择器：按 Provider 分组展示模型列表（Issue #5），避免全部挤在一起
  var modelGroups = [];
  (_cfg.providers||[]).filter(function(p){return p.enabled!==false;}).forEach(function(p){
    var provName = p.name || p.id;
    var provId = p.id || p.name;
    var models = (p.models && p.models.length) ? p.models : [{ id:p.model||'auto', name:p.model||'auto', enabled:true }];
    var enabledModels = [];
    models.forEach(function(m){
      if(m.enabled === false) return;
      var modelId = m.id || m.name || 'auto';
      var modelName = m.name || m.id || 'auto';
      var isActive = false;
      var _curModel = _getSessionModel();
      if(_curModel && typeof _curModel === 'object' && _curModel.model){
        isActive = (_curModel.provider === provId && _curModel.model === modelId);
      }
      enabledModels.push({ t: modelName, d: modelId, ico:'⚙️', active: isActive, provider: provId, model: modelId });
    });
    if(enabledModels.length) modelGroups.push({ name: provName, base_url: p.base_url||'', items: enabledModels });
  });
  if(!modelGroups.length) modelGroups = [{ name:'未配置', items:[{ t:'未配置模型', d:'请到「模型」页添加', ico:'⚙️' }] }];
  // A connector shortcut is actionable only when its credentials are saved.
  // The dedicated picker applies the same rule; keep this fallback data path
  // aligned so an older/openMini call cannot expose inert choices.
  /* 只列已配置的：未配置的点下去是跳配置页，不是「选它」，混在一起会让人以为能选。
     未配置的另外用 rest 汇总成一行（照抄旧弹层的 cc-sep 口径），不至于「一个都没有」时像功能没做。 */
  var _allConn=(_connState.list||[]);
  var connectors = _allConn.filter(function(c){return c.configured;}).map(function(c){
    return { t:c.name||c.kind, d:'已启用', ico:(c.icon||'🔌'), active:c.kind===_selectedConnector, kind:c.kind };
  });
  var _restConn = _allConn.filter(function(c){return !c.configured;}).map(function(c){ return { name:c.name||c.kind }; });
  var skills = (_skillLocal.length?_skillLocal:(_state&&_state.skills&&PV.skillsLocal))||[];
  var skillItems = (skills.length?skills:PV.skillsLocal).map(function(sk){
    var nm = sk.name||sk.id||'技能';
    return { t:nm, d:sk.desc||sk.description||'', ico:sk.icon||'📦', active:_activeSkills.indexOf(nm)>=0 };
  });
  return {
    model:{ title:'选择模型', groups:modelGroups },
    connector:{ title:'选择连接器', items:connectors, rest:_restConn, total:_allConn.length, foot:'管理连接器' },
    skill:{ title:'选择技能', items:skillItems },
    expert:{ title:'选择专家', items: expertsList().map(function(e){ return { id:e.id, t:e.name, d:e.dept||'', ico:e.icon||'🎯', active:false }; }) },
    quick:{ title:'快捷指令', search:false, groups:PV.quickGroups },
    reasoning:{ title:'思考强度', search:false, items:REASONING_LEVELS,
      hint:'只作用于当前会话，默认关。四档映射 DeepSeek 的 none / low / high / max。' },
    /* 能力（2026-11-16）：条目来自 panel-capabilities-ui.js 的 capabilityItems()，
       数据源是「模型 → 能力后端」那 8 个域。这里只做转发，避免两套清单漂移。
       没装那个文件时退化成空列表，面板不会崩。 */
    capability:{
      title:'本轮能力',
      search:false,
      items:(typeof window.capabilityItems==='function')?window.capabilityItems():[],
      foot:(typeof window.capabilityFoot==='function')?window.capabilityFoot():'管理能力后端',
      footPage:'models'
    }
  };
}
function expertsList(){
  if(window.AGENCY_PERSONAS && window.AGENCY_PERSONAS.length){
    return window.AGENCY_PERSONAS.map(function(p){
      return { id:p.id, name:(p.label||p.name||'未命名'), dept:(p.dept_label||p.dept||''), deptId:(p.dept||''), icon:(p.emoji||p.icon||'🎯') };
    });
  }
  return PV.experts.map(function(e){ return { id:e.id, name:e.name, dept:(e.dept||''), deptId:(e.dept||''), icon:(e.icon||'🎯') }; });
}
/* 动态加载 agency-agents-zh 专家库（Issue #1）。
   打包后的 app 中 js/personas_library.js 可能因浏览器缓存/加载时序失败，这里兜底注入并回调重渲染。
   采用版本号缓存键（替代 Date.now() 强制每次重下载）+ 多次重试，确保 268 位专家必然加载。 */
function ensurePersonasLibrary(cb, attempt){
  if(window.AGENCY_PERSONAS && window.AGENCY_PERSONAS.length){ mbtiInject(); if(cb) cb(); return; }
  attempt = attempt || 1;
  var s = document.createElement('script');
  s.src = 'js/personas_library.js?v=' + (window.__APP_VER__ || 'app') + '&t=' + attempt;
  s.onload = function(){ mbtiInject(); if(cb) cb(); };
  s.onerror = function(){
    if(attempt < 4){ setTimeout(function(){ ensurePersonasLibrary(cb, attempt + 1); }, 400 * attempt); }
    else if(cb) cb();
  };
  document.head.appendChild(s);
}
/* 启动时强制刷新专家库（即便 index.html 已同步加载，也重新拉取最新版，规避旧缓存导致只剩 8 个） */
function bootstrapPersonasLibrary(){
  ensurePersonasLibrary(function(){
    if(window.AGENCY_PERSONAS && window.AGENCY_PERSONAS.length){
      if(window.__expRendered){ renderExperts(); }
      if(window.__personasOpenMini){ window.__personasOpenMini(); }
    }
  });
}
/* 连接器条目指纹：只算「已配置」的（弹层里真渲染的就是这些），加名字防改名。
   排序后比对，避免后端返回顺序变了也误判成"有新东西"。 */
function connSignature(list){
  return (list||[]).filter(function(c){ return c.configured; })
    .map(function(c){ return (c.kind||'')+'|'+(c.name||''); })
    .sort().join(',');
}
function openMini(btn, key){
  if(activeBtn===btn){ closeMini(); return; }
  closeMini();
  activeBtn=btn; activePanel=key;
  popup=document.getElementById('miniPopup');
  if(key==='model'){ _modelLevel=1; _modelProvider=null; }
  var d=buildMiniData()[key];
  document.getElementById('popupTitle').textContent=d.title;
  /* 2026-11-21 主人要求：当前档位直接写进卡片标题（「思考强度 · 低」），
     点开一眼看到状态，不用再往下找「当前 X」那一行。 */
  refreshReasoningTitle();
  /* 解释性文字挂在标题右边那个问号上（2026-11-21 主人要求），
     不再铺在弹层正文里当第二段标题 */
  var _hint=document.getElementById('popupHint');
  if(_hint){
    /* 用全站那套 data-tip 气泡（js/panel-tooltip.js 的单例层）。
       原生 title 在这条链上靠不住：同文件下面挂着的 tool-btn 都给 panel-tooltip 去掉 title 了，
       标题这里的提示也走同一条路，触屏才不会粘住、长文案也不会顶出视口。 */
    if(d.hint){ _hint.hidden=false; _hint.setAttribute('data-tip',d.hint); _hint.setAttribute('aria-label',d.hint); }
    else { _hint.hidden=true; _hint.removeAttribute('data-tip'); _hint.removeAttribute('aria-label'); }
  }
  var sw=document.getElementById('popupSearchWrap');
  sw.style.display = d.search===false ? 'none':'block';
  if(d.search!==false){ var _ps=document.getElementById('popupSearch'); _ps.placeholder='搜索'+d.title.replace('选择',''); _ps.value=''; }
  var foot=document.getElementById('popupFoot');
  if(d.foot){ foot.style.display='block'; foot.textContent=d.foot; foot.onclick=function(){ closeMini(); switchPage(d.footPage||'connectors'); }; }
  else foot.style.display='none';

  var tabs=document.getElementById('popupTabs');
  if(key==='expert'){
    tabs.style.display='flex';
    tabs.setAttribute('role','tablist');
    tabs.setAttribute('aria-label','选择专家或表达风格');
    tabs.innerHTML='<button type="button" id="popupExpertTab" role="tab" aria-controls="popupBody" aria-selected="'+(_expertPickerTab==='single')+'" tabindex="'+(_expertPickerTab==='single'?'0':'-1')+'" class="mini-popup-tab '+(_expertPickerTab==='single'?'active':'')+'" onclick="switchExpertPickerTab(\'single\')">专家</button>'+
      '<button type="button" id="popupPersonaTab" role="tab" aria-controls="popupBody" aria-selected="'+(_expertPickerTab==='persona')+'" tabindex="'+(_expertPickerTab==='persona'?'0':'-1')+'" class="mini-popup-tab '+(_expertPickerTab==='persona'?'active':'')+'" onclick="switchExpertPickerTab(\'persona\')">表达风格</button>';
    tabs.onkeydown=function(e){
      if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight'&&e.key!=='Home'&&e.key!=='End')return;
      e.preventDefault();
      var next=e.key==='Home'?'single':e.key==='End'?'persona':_expertPickerTab==='single'?'persona':'single';
      switchExpertPickerTab(next);
      tabs.querySelector('[aria-selected="true"]').focus();
    };
  } else {
    tabs.style.display='none'; tabs.innerHTML=''; tabs.onkeydown=null; tabs.removeAttribute('role'); tabs.removeAttribute('aria-label');
  }

  var popupBody=document.getElementById('popupBody');
  popupBody.innerHTML=buildMiniPopupBody(key,d);
  if(key==='expert'){
    popupBody.setAttribute('role','tabpanel');
    popupBody.setAttribute('aria-labelledby',_expertPickerTab==='single'?'popupExpertTab':'popupPersonaTab');
  } else { popupBody.removeAttribute('role'); popupBody.removeAttribute('aria-labelledby'); }
  /* capability 也要 wide：7 项 428px 塞进 320px 的默认 body 会滚，第 6/7 项
     藏在折线下，用户以为只有 5 项（2026-11-16 实测就是这个问题）。 */
  popup.classList.toggle('wide', key==='quick' || key==='capability' || key==='reasoning');
  /* 连接器只用默认 360 宽：条目就一行名字+「几个工具」，wide 反而空。 */
  if(key==='reasoning'){ _syncReasoningBtn(); bindThinkIntensity(popupBody, key); }
  popup.classList.add('open');
  document.body.classList.add('mini-open');        // 手机端靠这个类显示背板
  watchPopupResize();
  positionPopup(btn);
  /* 2026-11-23：连接器弹层原来只读 _connState.list 这份缓存 —— 那是首屏加载和
     「进外接工具页」两个时刻刷的，所以在外面加/删了服务回来点连接器还是旧列表，
     看着完全不像联动（实测点开弹层 0 次请求）。
     现在：先用缓存画一屏（不白屏不闪），同时后台重拉一次；拉回来条目真变了才重画。
     去抖靠指纹比对，顺序变了或什么都没变都不动 DOM。 */
  if(key==='connector'){
    var _sigBefore=connSignature(_connState.list);
    Promise.resolve(typeof window.panelConnectorRefresh==='function'?window.panelConnectorRefresh():null).then(function(){
      if(activePanel!=='connector'||!popup||!popup.classList.contains('open'))return;
      if(connSignature(_connState.list)===_sigBefore)return;
      var _body=document.getElementById('popupBody');
      if(!_body)return;
      _body.innerHTML=buildMiniPopupBody('connector',buildMiniData().connector);
      positionPopup(activeBtn);
    }).catch(function(){});
  }
  var first=key==='expert'?popup.querySelector('[role="tab"][aria-selected="true"]'):key==='quick'||d.search===false?popup.querySelector('#popupBody button'):document.getElementById('popupSearch');
  /* 触屏设备上 focus() 会直接把软键盘顶起来：一开面板键盘就盖住半屏，用户第一眼看到的是键盘不是列表。
     桌面保留自动聚焦（可以直接打字搜索），触屏一律不抢焦点，让用户自己点输入框。 */
  var _touch = (window.matchMedia && window.matchMedia('(pointer:coarse)').matches) || navigator.maxTouchPoints>0;
  if(first && !_touch){ try{ first.focus(); }catch(e){} }
}
function switchExpertPickerTab(tab){
  if(tab!=='single'&&tab!=='persona')return;
  _expertPickerTab=tab;
  var tabNames={single:'专家',persona:'表达风格'};
  var tabs=document.getElementById('popupTabs');
  Array.from(tabs.children).forEach(function(el){
    var active=el.textContent===tabNames[tab];
    el.classList.toggle('active',active); el.setAttribute('aria-selected',String(active)); el.tabIndex=active?0:-1;
  });
  var body=document.getElementById('popupBody');
  body.setAttribute('aria-labelledby',tab==='single'?'popupExpertTab':'popupPersonaTab');
  body.innerHTML=buildMiniPopupBody('expert', buildMiniData().expert);
  positionPopup(activeBtn);
}
var _modelLevel=1, _modelProvider=null;
function modelPickProvider(btn){
  _modelProvider = btn.getAttribute('data-prov');
  _modelLevel = 2;
  var body=document.getElementById('popupBody');
  body.innerHTML = buildMiniPopupBody('model', buildMiniData().model);
  filterMiniPopup();
  positionPopup(activeBtn);
  var back=body.querySelector('.prov-back'); if(back && window.innerWidth>768) back.focus();
}
function modelPickBack(){
  _modelLevel = 1; _modelProvider = null;
  var body=document.getElementById('popupBody');
  body.innerHTML = buildMiniPopupBody('model', buildMiniData().model);
  filterMiniPopup();
  positionPopup(activeBtn);
  var first=body.querySelector('.prov-card'); if(first && window.innerWidth>768) first.focus();
}
function buildMiniPopupBody(key,d){
  var body='';
  if(key==='quick'){
    body='<div class="cmd-grid">';
    (d.groups||[]).forEach(function(g){
      body+='<div class="cmd-group-title">'+esc(g.title)+'</div>';
      g.commands.forEach(function(c){
        body+='<button type="button" class="cmd-cell" aria-label="'+DOM.escAttr(c.title)+': '+esc(c.cmd)+'" onclick="pickQuick(\''+esc(c.cmd).replace(/\\/g,'\\\\').replace(/'/g,"\\'")+'\')">'+
          '<div class="ico">'+c.ico+'</div><div><div class="title">'+esc(c.title)+'</div><div class="sub">'+esc(c.cmd)+'</div></div></button>';
      });
    });
    body+='</div>';
  } else if(key==='model'){
    var _groups = d.groups || [];
    if(_modelLevel === 2 && _modelProvider){
      var g = null;
      for(var gi=0; gi<_groups.length; gi++){ if(_groups[gi].name===_modelProvider){ g=_groups[gi]; break; } }
      var gitems = (g && g.items) || [];
      body = '<div class="pick-list pick-groups">';
      body += '<button type="button" class="prov-back" onclick="modelPickBack()">'
            + '<span class="pb-arrow">\u2190</span><span class="pb-txt">'+esc(_modelProvider)+'</span>'
            + '<span class="pb-n">'+gitems.length+' \u4e2a\u6a21\u578b</span></button>';
      gitems.forEach(function(it){
        var _attrs = ' data-provider="'+DOM.escAttr(it.provider||_modelProvider)+'" data-model="'+DOM.escAttr(it.model||it.t)+'"';
        body += '<button type="button" class="pop-item '+(it.active?'active':'')+'" aria-pressed="'+!!it.active+'"'+_attrs
              + ' onclick="pickItem(\'model\',this)">'
              + '<div class="ico">'+it.ico+'</div><div class="txt"><div class="t">'+esc(it.t)+'</div>'
              + '<div class="d">'+esc(it.d)+'</div></div><div class="check"></div></button>';
      });
      body += '</div>';
    } else {
      var _cur = _getSessionModel();
      if(_cur && typeof _cur === 'object') _cur = _cur.model || _cur.name || '';
      /* 「跟随默认配置」只在第一级出现一次，放在最上面。
         以前它被塞进每个 provider 的二级列表里，点开任何一个来源都冒出一条，
         用户以为是重复选项——其实是同一个清除动作被复制了五份。 */
      body = '<div class="pick-list" style="margin-bottom:10px">'
           + '<button type="button" class="pop-item'+(_cur?'':' active')+'" aria-pressed="'+(!_cur)+'" data-clear="1" onclick="clearSessionModel()">'
           + '<div class="ico">\u21bb</div><div class="txt"><div class="t">\u8ddf\u968f\u9ed8\u8ba4\u914d\u7f6e</div>'
           + '<div class="d">'+( _cur ? '\u5f53\u524d\u5df2\u9009 '+esc(_cur)+'\uff0c\u70b9\u6b64\u6539\u56de\u9ed8\u8ba4' : '\u5f53\u524d\u5c31\u662f\u9ed8\u8ba4\u6a21\u578b' )+'</div></div><div class="check"></div></button></div>';
      body += '<div class="prov-cards">';
      _groups.forEach(function(g){
        var items = g.items || [];
        var act = null;
        items.forEach(function(it){ if(it.active) act = it.t; });
        var _srch = g.name + ' ' + items.map(function(it){ return it.t || ''; }).join(' ');
        body += '<button type="button" class="prov-card" data-prov="'+DOM.escAttr(g.name)+'" data-search="'+DOM.escAttr(_srch)+'" onclick="modelPickProvider(this)">'
              + '<div class="pc-top"><span class="pc-name">'+esc(g.name)+'</span>'
              + '<span class="pc-n">'+items.length+'</span></div>'
              + '<div class="pc-sub">'+(act ? '\u5f53\u524d\uff1a'+esc(act) : (items.length ? '\u9009\u4e00\u4e2a\u6a21\u578b' : '\u6682\u65e0\u53ef\u7528\u6a21\u578b'))+'</div>'
              + '</button>';
      });
      body += '</div>';
      body += '<div class="prov-tip">\u5148\u9009\u6765\u6e90\uff0c\u518d\u9009\u6a21\u578b\u00b7\u4ec5\u5f53\u524d\u4f1a\u8bdd\u751f\u6548</div>';
    }
  } else if(key==='reasoning'){
    /* 思考强度（2026-11-21 换成 think-intensity Web Component）：
       组件自包含在 Shadow DOM 里，宿主页面不产生裸 div、不引全局类名，
       样式全部收敛在组件内部；这里只负责挂标签 + 把档位对回四档语义。
       档位映射：组件 1..4 ＝ 关 / 低 / 中 / 高，与 REASONING_LEVELS 一一对应。
       每个会话都带自己的档位发请求（默认关），日志和用量页才说得清。 */
    var _lv = _getSessionReasoning();
    var _idx = reasoningIndexOf(_lv) + 1;      // 0-based → 组件 1..4
    body = '<div class="ti-host">'
         + '<think-intensity level="'+_idx+'" theme="'+_tiTheme()+'"></think-intensity>'
         + '</div>'
         + '<div class="rs-foot" style="display:none"></div>';  // 占位：旧 CSS 依赖，组件没有它也不会塌
  } else if(key==='connector'){
    /* 2026-11-22 主人要求：连接器改用和模型/思考/能力/技能/专家/快捷指令同一套锚定弹层。
       以前它是独立 <dialog> showModal + ::backdrop（蒙版），六个按钮各有各的样子。
       这里只出列表，点选交给 pickConnector（连接器要写 draft，不能走通用 pickItem）。 */
    var cc=(d.items||[]);
    body='<div class="pick-list">';
    if(!cc.length){
      body+='<div class="pop-empty" style="padding:18px;text-align:center;font-size:13px;opacity:.7">这 '+((d.total)||0)+' 个连接器都还没有保存凭证 —— 点下面「管理连接器」去配置</div>';
    } else {
      cc.forEach(function(it){
        body+='<button type="button" class="pop-item '+(it.active?'active':'')+'" aria-pressed="'+!!it.active+'" data-kind="'+DOM.escAttr(it.kind||'')+'" onclick="pickConnector(this)">'+
          '<div class="ico">'+esc(it.ico||'🔌')+'</div><div class="txt"><div class="t">'+esc(it.t)+'</div><div class="d">'+esc(it.d)+'</div></div><div class="check"></div></button>';
      });
      /* 2026-11-22 删掉「另有 N 个未配置：a、b、c…」那行：
         纯灰色罗列，不可点、不可操作，占着浮层最显眼的位置凑数；
         真要配就去底部「管理连接器」，这里报一遍名单没有用。 */
    }
    body+='</div>';
    body+='<div class="prov-tip">选中后随本轮消息声明连接器意图；实际调用由模型按可用工具决定。</div>';
  } else if(key==='capability'){
    /* 能力列表：点一下＝本轮启用，再点取消。和专家/技能不同，这里没有单选语义，
       所以不调 pickItem（那个会顺手关弹层、改单选状态），走 capabilityTap 就地翻。 */
    var caps=(d.items||[]);
    body='<div class="pick-list">';
    if(!caps.length){
      body+='<div class="pop-empty" style="padding:18px;text-align:center;font-size:13px;opacity:.7">还没读到能力后端配置 —— 去「模型 → 能力后端」看一眼</div>';
    } else {
      caps.forEach(function(it){
        body+='<button type="button" class="pop-item '+(it.active?'active':'')+'" aria-pressed="'+!!it.active+'" data-cap="'+DOM.escAttr(it.id)+'" title="'+DOM.escAttr(it.tip||it.d||'')+'" onclick="capabilityTap(this)">'+
          '<div class="ico">'+(it.ico||'⚙️')+'</div><div class="txt"><div class="t">'+esc(it.t)+'</div><div class="d">'+esc(it.d)+'</div></div><div class="check"></div></button>';
      });
    }
    body+='</div>';
    body+='<div class="prov-tip">点一下＝本轮启用，再点取消。「联网搜索」关掉是真的拦住（不调 web_search / web_extract），其它几项只是告诉模型这一轮可以做什么。标「未装配」的项去「模型 → 工具集」勾上才有效。</div>';
  } else if(key==='expert'){
    if(_expertPickerTab==='persona'){
      body='<div class="pick-list"><div class="empty-state" style="padding:18px;text-align:center">表达风格只影响当前会话的回答方式，不切换全局 SOUL、记忆或渠道环境。<br><button class="btn sm primary" style="margin-top:12px" onclick="openSessionPersonalityFromMini()">设置本会话表达风格</button></div></div>';
    } else {
      body='<div class="pick-list">';
      (d.items||[]).forEach(function(it){
        // 选中态：与「单专家注入对象」_selectedExpert 比对
        var selExpert = (_selectedExpert && _selectedExpert.id===(it.id||''));
        body+='<button type="button" class="pop-item'+(selExpert?' active':'')+'" aria-pressed="'+selExpert+'" data-id="'+DOM.escAttr(it.id||'')+'" onclick="pickItem(\'expert\',this)">'+
          '<div class="ico">'+it.ico+'</div><div class="txt"><div class="t">'+esc(it.t)+'</div><div class="d">'+esc(it.d)+'</div></div><div class="check"></div></button>';
      });
      body+='</div>';
    }
  } else {
    body='<div class="pick-list">';
    (d.items||[]).forEach(function(it){
      body+='<button type="button" class="pop-item '+(it.active?'active':'')+'" aria-pressed="'+!!it.active+'" onclick="pickItem(\''+key+'\',this)">'+
        '<div class="ico">'+it.ico+'</div><div class="txt"><div class="t">'+esc(it.t)+'</div><div class="d">'+esc(it.d)+'</div></div><div class="check"></div></button>';
    });
    body+='</div>';
  }
  return body;
}
/* 迷你弹窗通用搜索过滤：模型/专家/技能/连接器/快捷指令条目按文本实时筛选。
   模型多达上百个时避免逐个翻找；过滤后空分组连同组头一起隐藏。 */
function filterMiniPopup(){
  var ps=document.getElementById('popupSearch'); if(!ps) return;
  var q=(ps.value||'').trim().toLowerCase();
  var body=document.getElementById('popupBody'); if(!body) return;
  /* 一级列表是 .prov-card（来源卡片），二级才是 .pop-item。
     原来只过滤 .pop-item —— 在一级列表里打字，五张来源卡片纹丝不动，
     用户当然说「搜索模型没用」。来源卡片自己带着 data-search（含它名下所有模型名），
     所以搜模型名也能把卡片筛出来。 */
  function hit(el){
    if(!q) return true;
    var t=((el.textContent||'')+' '+(el.getAttribute('data-search')||'')+' '+(el.getAttribute('data-provider')||'')+' '+(el.getAttribute('data-model')||'')).toLowerCase();
    return t.indexOf(q)>=0;
  }
  var shown=0;
  body.querySelectorAll('.pop-item,.prov-card,.cmd-cell').forEach(function(it){
    var ok=hit(it); it.style.display=ok?'':'none'; if(ok) shown++;
  });
  body.querySelectorAll('.pick-group').forEach(function(g){
    var any=false; g.querySelectorAll('.pop-item,.prov-card,.cmd-cell').forEach(function(it){ if(it.style.display!=='none') any=true; });
    g.style.display=any?'':'none';
  });
  var emp=document.getElementById('popupEmpty');
  if(!emp){
    emp=document.createElement('div'); emp.id='popupEmpty'; emp.className='pop-empty';
    emp.style.cssText='padding:18px;text-align:center;font-size:13px;opacity:.6';
    body.appendChild(emp);
  }
  emp.textContent = shown ? '' : '没有匹配项';
  emp.style.display = shown ? 'none' : '';
  var tip=body.querySelector('.prov-tip'); if(tip) tip.style.display = q ? 'none' : '';
  /* 过滤会改高度，位置得跟着重排（不然底部三角又飘走） */
  if(activeBtn) positionPopup(activeBtn);
}
/* 小浮层定位：贴着触发按钮、永远留 10px 缝，上方放不下才翻到下方。
   原来只在 openMini 里定位一次，而 top 是死值 —— 二级菜单（选模型 → 某 Provider）内容更短，
   高度一缩整块就往上飘，底部那个小三角悬在离按钮两百多像素的空中。
   现在：高度变了就重排（ResizeObserver），并且按上下可用空间决定方向。 */
var _popupRO=null, _popupBusy=false, _popupLastH=0;
function positionPopup(btn){
  if(!btn||window.innerWidth<=768) return;
  _popupBusy=true;
  var rect=btn.getBoundingClientRect();
  var width=activePanel==='quick'?560:360;
  var left=rect.left + rect.width/2 - width/2;
  if(left<8) left=8;
  if(left+width>window.innerWidth-8) left=window.innerWidth-width-8;
  popup.style.width=width+'px';
  popup.style.left=left+'px';
  popup.style.maxHeight='';                       // 先清掉上一次的限高，否则量出来的高度是压过的
  var gap=10, edge=12;
  var h=popup.offsetHeight;
  var spaceAbove=rect.top-edge, spaceBelow=window.innerHeight-rect.bottom-edge;
  var up = h<=spaceAbove || spaceAbove>=spaceBelow;
  var avail = up?spaceAbove:spaceBelow;
  if(h>avail){                                    // 两边都放不下：按可用空间压高度，滚动交给 body
    popup.style.maxHeight=Math.max(200,avail)+'px';
    h=popup.offsetHeight;
  }
  popup.classList.toggle('top',up);
  popup.classList.toggle('bottom',!up);
  var top = up ? rect.top-gap-h : rect.bottom+gap;
  if(top<8) top=8;
  popup.style.top=top+'px';
  var arrowLeft=rect.left + rect.width/2 - left;
  popup.style.setProperty('--arrow-left', Math.max(18, Math.min(width-18, arrowLeft))+'px');
  var near = up ? (rect.top-(top+h))<=gap+6 : (top-rect.bottom)<=gap+6;
  popup.classList.toggle('arrow-off',!near);      // 被视口顶开、三角指不到按钮时索性藏掉
  _popupLastH=popup.offsetHeight;
  _popupBusy=false;
}
function watchPopupResize(){
  if(_popupRO||typeof ResizeObserver==='undefined') return;
  _popupRO=new ResizeObserver(function(){
    if(_popupBusy||!popup||!popup.classList.contains('open')||!activeBtn) return;
    if(Math.abs(popup.offsetHeight-_popupLastH)<1) return;
    positionPopup(activeBtn);
  });
  _popupRO.observe(popup);
}
function closeMini(restoreFocus){
  var restore=activeBtn;
  if(popup){ popup.classList.remove('open','wide'); }
  document.body.classList.remove('mini-open');
  /* 焦点还留在弹层里（搜索框）时键盘不会自己退，必须主动 blur */
  try{ var ae=document.activeElement; if(ae&&popup&&popup.contains(ae)) ae.blur(); }catch(e){}
  activeBtn=null; activePanel=null;
  document.querySelectorAll('.tool-btn').forEach(function(b){ b.classList.remove('active'); });
  if(restoreFocus!==false&&restore&&restore.isConnected) restore.focus();
}
document.addEventListener('keydown',function(e){
  if(!popup||!popup.classList.contains('open'))return;
  if(e.key==='Escape'){ e.preventDefault(); closeMini(); }
});
/* 窗口尺寸变了（转屏、拉窄）位置就过期了：桌面端重排一次，别让弹层飘到屏外 */
window.addEventListener('resize',function(){
  if(!popup||!popup.classList.contains('open'))return;
  if(window.innerWidth<=768) return;              // 手机端由 CSS 底部卡片接管
  positionPopup(activeBtn);
});
function pickItem(key, el){
  var name = el.querySelector('.t') ? el.querySelector('.t').textContent : '';
  if(key==='expert'){
    // 工具栏专家选择器：为专家开启独立会话并注入单专家（决策 3，不替换 persona）
    pickItemExpert(el.getAttribute('data-id'), el);
    return;
  } else if(key==='model'){
    var b=document.getElementById('btnModel');
    if(b){
      b.setAttribute('data-tip','模型: '+name); b.classList.add('active');
      // 更新徽章
      var oldBadge = b.querySelector('.model-badge'); if(oldBadge) oldBadge.remove();
      var badge=document.createElement('span');
      badge.className='model-badge';
      badge.textContent=name.length>8?name.slice(0,8)+'…':name;
      b.appendChild(badge);
    }
    var prov = el.getAttribute('data-provider');
    var model = el.getAttribute('data-model');
    if(prov && model){
      _selectedModel = { provider: prov, model: model };
    } else {
      _selectedModel = name;
    }
    _setSessionModel(currentSession, _selectedModel);
    toast('已选择模型：'+name+'（仅当前会话）');
    closeMini();
    return;
  } else if(key==='skill'){
    // 真实切换「已启用技能」：加入/移除 _activeSkills，渲染 chip，并在发送时注入 system 提示
    var idx=_activeSkills.indexOf(name);
    if(idx>=0){ _activeSkills.splice(idx,1); el.classList.remove('active'); el.setAttribute('aria-pressed','false'); toast('已停用技能：'+name); }
    else { _activeSkills.push(name); el.classList.add('active'); el.setAttribute('aria-pressed','true'); toast('已启用技能：'+name); }
    var b2=document.getElementById('btnSkill'); if(b2) b2.classList.toggle('active', _activeSkills.length>0);
    renderSkillChips();
    return; // 保持弹窗打开，可继续勾选多个技能
  }
  closeMini();
}
/* 工具栏专家选择器：为所选专家创建/复用独立会话，并设为单专家注入对象 */
function pickItemExpert(id, el){
  var name = (el && el.querySelector('.t')) ? el.querySelector('.t').textContent : '';
  var prompt=''; var pid=id;
  if(!pid && name){
    var f=(window.AGENCY_PERSONAS||[]).find(function(x){ return (x.label||x.name)===name; });
    if(f) pid=f.id;
  }
  var ap=(window.AGENCY_PERSONAS||[]).find(function(x){ return x.id===pid; });
  if(ap){ prompt=ap.prompt||''; if(!name) name=(ap.label||ap.name||pid); }
  var expertName = name || (pid ? pid : '');
  // Issue #6 修正：选择单个专家时不再自动创建专家团，仅注入该专家的系统提示；
  // 专家团模式需通过「选择专家」弹窗的「专家团」tab 手动启用。
  // 为每个专家创建独立的顶层 agent 分组，会话归入该分组而非 default
  var agentId = 'exp-' + pid;
  var agent = ensureAgent(agentId, { name: expertName, icon: (ap && (ap.emoji||ap.icon)) || '🎯', expertId: pid });
  function afterSwitch(){
    currentAgent = agentId;
    _selectedExpert = { id:pid||'', name:expertName, prompt:prompt };
    var t=document.getElementById('chatTitle'); if(t) t.textContent=expertName;
    renderSelectedExpertBar();
    toast('已为专家「'+expertName+'」开启独立会话（发送时注入系统提示）');
  }
  // profilefix v4（模型 A）：会话不分归属，每次开启专家对话新建一个会话（全局树平铺）。
  var existing = null;
  if(existing){
    switchSession(agentId, existing.id); afterSwitch();
  } else {
    fetch(apiUrl('/api/sessions'), { method:'POST', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
      .then(function(r){ return r.json(); })
      .then(function(s){
        _sessions.unshift(s);
        currentSession=s.id; currentAgent=agentId;
        _openTabs.push(s.id); persistTabs();
        renderSessionTabs(); renderRail(); updateHeader();
        if(window.innerWidth<=768) closeRailDrawer();
        sendRaw('/title '+expertName); afterSwitch();
      })
      .catch(function(){ toast('创建会话失败'); });
  }
  closeMini();
}
function agencyIdByName(name){
  if(!window.AGENCY_PERSONAS) return '';
  var f=window.AGENCY_PERSONAS.find(function(x){ return (x.label||x.name)===name; });
  return f ? f.id : '';
}
/* 兼容旧快捷入口：任务方案是唯一工作流/专家分工入口。 */
function pickWorkflowFromMini(key){
  switchPage('plans');
}
function clearWorkflowFromMini(){
  switchPage('plans');
}
/* Keep expression style session-scoped; never activate a global Hermes profile here. */
function openSessionPersonalityFromMini(){ closeMini(); if(window.pwPersonality) window.pwPersonality(); }
/* 连接器激活卡片（渲染在输入区上方，best-effort 调用首个工具） */
var _selectedModelMap = (function(){ try{ var s=localStorage.getItem('hermes_selected_model_map'); return s?JSON.parse(s):{}; }catch(e){ return {}; } })();
// 无当前会话时选择的模型暂存于此，会话创建后自动绑定（修复：新建会话前选模型被丢弃的问题）
var _pendingModel = '';
function _getSessionModel(sid){ return _selectedModelMap[sid||currentSession] || ''; }
function _setSessionModel(sid, val){ if(!sid) sid=currentSession; if(!sid){ if(val) _pendingModel = val; return; } if(val){ _selectedModelMap[sid]=val; } else { delete _selectedModelMap[sid]; } try{ localStorage.setItem('hermes_selected_model_map', JSON.stringify(_selectedModelMap)); }catch(e){} }
// 会话创建成功后调用：把暂存的模型绑定到新会话（若该会话尚未绑定过模型）
function _applyPendingModel(sid){
  if(_pendingModel && sid && !_selectedModelMap[sid]){
    _selectedModelMap[sid] = _pendingModel;
    _pendingModel = '';
    try{ localStorage.setItem('hermes_selected_model_map', JSON.stringify(_selectedModelMap)); }catch(e){}
    _syncModelBtn();
  }
}
function clearSessionModel(){
  _pendingModel = '';
  _setSessionModel(currentSession, '');
  _selectedModel = '';
  /* 2026-11-21 修：原来这里硬写 data-tip='选择模型' 并摘掉 active/徽章，
     点完看着像「没选模型」，刷新后 _syncModelBtn 又按默认模型重画，
     两次显示不一样。清除=回到跟随默认，直接交给 _syncModelBtn 统一渲染。 */
  _syncModelBtn();
  toast('已清除模型选择，将使用默认配置');
  closeMini();
}
// 兼容旧版全局 key 迁移
var _selectedModel = (function(){ try{ var s=localStorage.getItem('hermes_selected_model'); if(s){ var v=JSON.parse(s); localStorage.removeItem('hermes_selected_model'); return v; } return ''; }catch(e){ return ''; } })();
if(_selectedModel && currentSession){ _setSessionModel(currentSession, _selectedModel); _selectedModel=''; }
function persistSelectedModel(){ _setSessionModel(currentSession, _selectedModel); }
var _activeSkills = [];   // 当前会话已启用的技能（名称列表），发送时注入 system 提示
var _selectedExpert = null;     // 单专家注入对象 {id,name,prompt}（决策 3，随会话）
var _selectedConnector = '';    // 当前选中的连接器 kind（字符串）
var _wfSteps = [];              // 工作流 DAG 编辑中的步骤工作副本
function renderSkillChips(){
  var box=document.getElementById('skillChips'); if(!box) return;
  if(!_activeSkills.length){ box.innerHTML=''; box.style.display='none'; return; }
  box.style.display='flex';
  box.innerHTML = _activeSkills.map(function(n){
    return '<button type="button" class="skill-chip" aria-label="移除技能：'+esc(n)+'" title="移除技能：'+esc(n)+'" onclick="removeSkill(\''+esc(n).replace(/\\/g,'\\\\').replace(/'/g,"\\'")+'\')">'+esc(n)+' <span class="x" aria-hidden="true">×</span></button>';
  }).join('');
}
function removeSkill(n){
  var idx=_activeSkills.indexOf(n); if(idx>=0) _activeSkills.splice(idx,1);
  var b2=document.getElementById('btnSkill'); if(b2) b2.classList.toggle('active', _activeSkills.length>0);
  renderSkillChips();
}
function pickQuick(cmd){
  closeMini();
  /* 交给 panel-slash.js 按命令种类分派：/model 走两级卡片弹窗、带参命令进 chip。
     旧版直接 handleSlashCommand(cmd)，/model 会被判成"切换模型"而跳去配置页。 */
  if(window.slashInsert && window.slashInsert(cmd)) return;
  handleSlashCommand(cmd);
}
function handleSlashCommand(cmd){
  if(!cmd || cmd.charAt(0)!=='/'){ sendRaw(cmd); return; }
  var parts = cmd.split(' ');
  var base = parts[0].toLowerCase();
  var arg = parts.slice(1).join(' ').trim();
  if(base==='/new'){
    if(window.openNewSessionModal) window.openNewSessionModal(arg);
    else toast('快捷操作暂不可用，请刷新面板后重试');
    return;
  }
  if(base==='/stop'){
    chatStop();
    toast('已停止当前生成');
    return;
  }
  if(window.handlePanelSlashCommand){ window.handlePanelSlashCommand(cmd); return; }
  var ta=document.getElementById('chatInput');
  if(ta){ta.value=cmd;autoResize(ta);if(typeof saveDraft==='function')saveDraft(currentSession);}
  toast('此快捷命令暂不可用，请刷新面板后重试');
}
function appendSystemMessage(text){
  var body=document.getElementById('chatBody'); if(!body) return;
  var div=document.createElement('div'); div.className='system-tip'; div.textContent=text;
  body.appendChild(div); followChatBottom();
}
/* 首屏把「思考」按钮的档位徽标画出来（切换会话时 tabs.js 还会再调一次） */
(function(){
  function boot(){ try{ _syncReasoningBtn(); }catch(e){} }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

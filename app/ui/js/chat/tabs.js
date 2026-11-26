/* 会话树（Rail）+ 浏览器式多会话标签 + 流式渲染节流
 * 来源：index.html 内联 app.js 第 579-2091 行（共 1513 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ 会话树（Rail） ============================ */
/* ============================ 多会话标签（浏览器式多开） ============================ */
/* _openTabs：已打开的会话标签 id 数组（有序）；_tabDrafts：各标签输入框草稿；_tabStreaming：流式状态 */
var _openTabs = [];
var _tabDrafts = {};
var _tabStreaming = {};
var _chatHTML = {};
/* 会话消息窗口化（2026-11-20 用户要求：别一次性注入全部消息）。
   进会话只取最后一页，滚到顶再往前取一页 —— 长会话/多图会话首屏不用再建几百个气泡，
   输入框不再等 2~3 秒。_winFrom 是已渲染窗口的起始序号（0 = 已经到第一条），
   _winTotal 是服务端总数，两者的差就是顶上那条「载入更早」要取的量。 */
var _winFrom = {}, _winTotal = {}, _winBusy = {};
var CHAT_PAGE = 60;   // 与 MAX_VISIBLE_MSGS 对齐：反正超过 60 条也要折叠
function _winUrl(sid){
  if(_winFrom[sid] === undefined) return '/api/sessions/'+encodeURIComponent(sid)+'?tail='+CHAT_PAGE;
  return '/api/sessions/'+encodeURIComponent(sid)+'?from='+_winFrom[sid];
}
function _winTake(sid, win, count){
  if(win && typeof win.total === 'number'){ _winTotal[sid] = win.total; _winFrom[sid] = win.from; return; }
  if(_winFrom[sid] === undefined){ _winFrom[sid] = 0; _winTotal[sid] = count || 0; }
}
/* 【2026-10-09 修复】流式渲染节流。
   根因：onDelta 每收到一个 delta 就执行「全量 renderMarkdown + mdEl.innerHTML 重建 +
   强制 reflow 滚动 + body.innerHTML 全序列化」，回复越长单次开销越大；长回复时浏览器
   主线程饱和 → 视觉上「不出字 / 看不到连续输出」，等生成结束后才一次性显示完整。
   方案：合并高频 delta（默认最多约 10 次/秒渲染），收尾时 onDone 仍做全量渲染兜底。 */
var _streamRenderSt = {};
function _throttledRender(key, fn, minGap){
  minGap = minGap || 100;
  var st = _streamRenderSt[key] || (_streamRenderSt[key] = {timer:null, last:0, pending:null});
  st.pending = fn;
  if(st.timer) return;
  var wait = Math.max(0, minGap - (Date.now() - st.last));
  if(wait === 0){
    st.last = Date.now();
    var f0 = st.pending; st.pending = null;
    try{ f0(); }catch(e){}
    return;
  }
  st.timer = setTimeout(function(){
    st.timer = null; st.last = Date.now();
    var f = st.pending; st.pending = null;
    if(f){ try{ f(); }catch(e){} }
  }, wait);
}
function _flushStreamRender(key){
  var st = _streamRenderSt[key];
  if(!st) return;
  if(st.timer){ clearTimeout(st.timer); st.timer = null; }
  var f = st.pending; st.pending = null;
  if(f){ try{ f(); }catch(e){} }  _pushRead();
}  // sid → chatBody.innerHTML 快照（流式后台继续时保留最新内容，切回时从缓存恢复）

/* 未读清账（2026-11-20）：只有「当前会话 + 滚到底 + 页面可见」才算看过。
   规则由用户定：滚到底才算清掉一个，跨端共享同一份计数。 */
var _pushReadTimer = null;
function _pushRead() {
  clearTimeout(_pushReadTimer);
  _pushReadTimer = setTimeout(function () {
    try {
      if (document.visibilityState !== 'visible') return;
      if (!currentSession) return;
      var body = document.getElementById('chatBody');
      if (!body || !chatAtBottom(body)) return;
      if (typeof window.__pwReadSession === 'function') window.__pwReadSession(currentSession);
    } catch (e) {}
  }, 300);
}
try { _openTabs = JSON.parse(localStorage.getItem('hermes_open_tabs') || '[]'); } catch (e) { _openTabs = []; }
function persistTabs() { try { localStorage.setItem('hermes_open_tabs', JSON.stringify(_openTabs)); } catch (e) {} }

/* 渲染顶部标签栏 */
function renderSessionTabs() {
  var scroll = document.getElementById('tabsScroll');
  if (!scroll) return;
  var html = '';
  _openTabs.forEach(function (sid) {
    var s = _sessions.find(function (x) { return x.id === sid; });
    if (!s) return;
    var active = (sid === currentSession);
    var rawTitle = (s.title && s.title !== 'New Chat' && s.title !== '未命名会话') ? s.title : '新会话';
    var streaming = !!_tabStreaming[sid];
    html += '<div class="session-tab' + (active ? ' active' : '') + (streaming ? ' streaming' : '') + '" title="' + DOM.escAttr(rawTitle) + '">' +
      '<button type="button" class="tab-select" data-session-id="' + DOM.escAttr(sid) + '" aria-current="' + (active?'page':'false') + '" aria-label="切换到会话：' + esc(rawTitle) + '" title="双击可编辑名称与归类" onclick="switchTab(\'' + esc(sid) + '\')" ondblclick="renameSession(\'' + esc(sid) + '\',event)"><span class="tab-dot"></span><span class="tab-title">' + esc(rawTitle) + '</span></button>' +
      '<button type="button" class="tab-action tab-close" title="关闭标签" aria-label="关闭会话标签：' + esc(rawTitle) + '" onclick="closeTab(\'' + esc(sid) + '\')">×</button>' +
      '</div>';
  });
  scroll.innerHTML = html;
  var activeEl = scroll.querySelector('.session-tab.active');
  if (activeEl && activeEl.scrollIntoView) { try { activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {} }
  var btn = document.getElementById('tabNewBtn');
  if (btn) btn.style.display = 'inline-flex';
  syncSessionTabsVisibility();
}

/* 标签的焦点框比本体四边各多伸 4px（2px outline + 2px offset），.tabs-scroll 是
   overflow:auto 滚动容器 —— 标签贴着容器边缘时，这 4px 外框就被裁掉了。
   容器 padding:6px 只保住「滚到两端」的情形；用户滚到中间任意位置停下时，
   贴边那只标签按下仍然被切（2026-11-23 主人指出：最左边标签左边被压盖）。
   修法：按下/聚焦时把该标签滚进安全区，让外框四周永远有 6px 余量。 */
var TAB_RING_PAD = 6;
function ensureTabRingVisible(tab) {
  var sc = document.getElementById('tabsScroll');
  if (!tab || !sc) return;
  var tr = tab.getBoundingClientRect(), sr = sc.getBoundingClientRect();
  var dl = (sr.left + TAB_RING_PAD) - tr.left;        // >0 表示左边余量不够
  var dr = tr.right - (sr.right - TAB_RING_PAD);      // >0 表示右边余量不够
  if (dl > 0) sc.scrollLeft -= dl;
  else if (dr > 0) sc.scrollLeft += dr;
}
document.addEventListener('mousedown', function (e) {
  var tab = e.target && e.target.closest ? e.target.closest('.session-tab') : null;
  if (tab) ensureTabRingVisible(tab);
}, true);
document.addEventListener('focusin', function (e) {
  var tab = e.target && e.target.closest ? e.target.closest('.session-tab') : null;
  if (tab) ensureTabRingVisible(tab);
}, true);

/* 保存/恢复指定标签的输入框草稿 */
function saveDraft(sid) {
  var ta = document.getElementById('chatInput');
  if (ta && sid) _tabDrafts[sid] = ta.value;
}
function restoreDraft(sid) {
  var ta = document.getElementById('chatInput');
  if (!ta) return;
  ta.value = _tabDrafts[sid] || '';
  try { autoResize(ta); } catch (e) {}
  var send = document.getElementById('sendBtn');
  if (send && !_msgState.streaming) send.disabled = !ta.value.trim();
}

/* 打开（或激活）一个会话标签 */
function openTabCore(sid) {
  if (!sid) return;
  if (_openTabs.indexOf(sid) === -1) { _openTabs.push(sid); persistTabs(); }
  switchTab(sid);
}

/* 切换激活标签：流式后台继续（并行多会话）。切换前保存当前 chatBody → _chatHTML[currentSession]，切回时仍优先用缓存（流式最新） */
function switchTabCore(sid) {
  if (!sid) return;
  /* 通道会话返回修复（2026-11-25）：从「通道会话只读预览」点回面板自己的会话时，
     打开通道会话并没有改 currentSession，于是这里 sid===currentSession 成立、
     直接 return，updateHeader() 不执行 —— 顶部标题就卡在「xxx 通道会话」不动。
     判据是 _channelViewActive：通道视图下不算「已在当前会话」，必须走完整流程刷标题。 */
  if (sid === currentSession && !_channelViewActive) {
    /* 点左树上的当前会话（2026-11-16 修）：原本这里直接 return，
       画板会话在对话视图下点它毫无反应，看着像功能没生效。
       是画板就把呈现切回画布，别的什么都不动。 */
    if (window.CanvasMode) {
      var _selfType = 'chat';
      try { if (typeof window.pwSessionType === 'function') _selfType = window.pwSessionType(sid) || 'chat'; } catch (e) {}
      if (_selfType === 'canvas') {
        try {
          if (!CanvasMode.isOn() || CanvasMode.currentSession() !== sid) CanvasMode.enter(sid);
          CanvasMode.showCanvas();
        } catch (e) {}
      }
    }
    // 点击当前激活标签：收起标签栏（省出聊天空间），再点按钮可重新展开
    var _tabs = document.querySelector('.page-container .session-tabs');
    if (_tabs && _tabs.classList.contains('visible')) {
      _tabsManuallyHidden = true;
      _multiTabsForced = false;
      _saveTabsPref();
      syncSessionTabsVisibility();
    }
    return;
  }
  var body = document.getElementById('chatBody');
  if (body && currentSession && _cacheSane(currentSession, body)) {
    _chatHTML[currentSession] = body.innerHTML;
    /* 光存 HTML 字符串不够（2026-11-20 第六次）：切回来要 innerHTML 重写一遍，
       189 个 img 全部重新解码，高度从 0 一档档撑开 —— 用户说的「切过去一两秒才开始跳」。
       这里把节点本身搬进文档片段存着，切回来直接 append，图片位图还在，一次解码都不用。 */
    try{
      var _keepFrag = document.createDocumentFragment();
      while(body.firstChild) _keepFrag.appendChild(body.firstChild);
      _domCachePut(currentSession, _keepFrag);
    }catch(e){}
  }
  else if (currentSession) {
    /* 还在加载（或加载失败）就切走了：别把半截 DOM 存成快照，
       否则切回来先画出那两个气泡，fetch 回来又被「指纹一致」挡在门外，永远只有两个。 */
    _domCacheDrop(currentSession);
  }
  saveDraft(currentSession, true);   // 切换只抓取实际内容，不把尚未加载的默认选项当编辑
  currentSession = sid;
  /* 通道会话返回修复（2026-11-25）：从只读预览点回面板会话时，把通道视图的痕迹一起收掉，
     否则顶部「返回」按钮和隐藏的输入框会跟着残留，看着像还在通道里。 */
  if (_channelViewActive) {
    _channelViewActive = false;
    var _rb2 = document.getElementById('chReturnBtn'); if(_rb2) _rb2.style.display = 'none';
    var _cmp = document.getElementById('chatComposer'); if(_cmp) _cmp.hidden = false;
    window.dispatchEvent(new Event('panel-session-changed'));
  }
  /* 2026-11-20 修闪动：以前这里对「旧会话」调用 scrollChatToBottom()，紧接着内容被换掉，
     浏览器来不及画就被覆盖；真正让画面上下跳的是下一步的清空。这里只打开跟随，不动 DOM。 */
  _follow = true;
  renderSessionTabs();
  renderRail(); updateHeader();
  restoreDraft(sid);
  _pushRead();
  _syncModelBtn();
  if(typeof _syncReasoningBtn==='function') _syncReasoningBtn();   // 思考强度按钮的档位徽标跟会话走
  _syncGenBarToTab(sid);   // 按当前会话恢复 genBar 状态（多会话并行不互相覆盖）
  _checkActiveGen(sid);    // 后端仍在生成 → 恢复「正在继续生成…」提示
  // 工作区大纲 tab 激活时，切换会话后同步刷新大纲
  var _ws = document.getElementById('workspacePanel');
  if (_ws && _ws.classList.contains('open')) {
    var _wt = _ws.querySelector('.ws-tab.active');
    if (_wt && _wt.textContent.indexOf('大纲') !== -1) loadOutline();
  }
  if (body) {
    var cached = _chatHTML[sid];
    var _fragBack = _domCacheTake(sid);
    if (_fragBack && _fragBack.firstChild) {
      /* 节点级还原：不重排、不解码，位置也在原样 */
      while (body.firstChild) body.removeChild(body.firstChild);
      body.appendChild(_fragBack);
      body.setAttribute('data-sid', sid);
      if(window.ToolUI) ToolUI.paintAll(body);
      followChatBottom();
      loadSessionMessages(sid, true);
    } else if (cached) {
      // 命中内存快照：立即恢复渲染（0 延迟），后台静默拉取最新消息覆盖，避免显示过期内容
      body.innerHTML = cached;
      body.setAttribute('data-sid', sid);
      _settleUntil = Date.now() + 1600;   /* 快照图重新解码也要沉降，别一张一贴 */
      if(window.ToolUI) ToolUI.paintAll(body);
      followChatBottom();
      loadSessionMessages(sid, true);
    } else {
      /* 2026-11-20 修闪动：原本先塞「加载中…」，高度从三万多掉到 0，scrollTop 被钳到 0，
         用户看到的是「画面闪到顶部 → 半秒后弹到底部」。旧内容留着，等新内容整片替换。 */
      loadSessionMessages(sid);
    }
  }
  /* 画板模式（2026-11-16）：类型为 canvas 的会话把正文区换成画布。
     类型从 window.pwSessionType 取 —— panel-workspace-ui 是 IIFE，
     state 私有，之前直接读 window.state 恒为 undefined，分流永远走 chat。
     读不到按普通对话处理，绝不因为查不到类型就卡住会话打开。 */
  if (window.CanvasMode) {
    var _cvType = 'chat';
    try { if (typeof window.pwSessionType === 'function') _cvType = window.pwSessionType(sid) || 'chat'; } catch (e) {}
    if (_cvType === 'canvas') { try { CanvasMode.enter(sid); } catch (e) { try { CanvasMode.leave(); } catch (e2) {} } }
    else { try { CanvasMode.leave(); } catch (e) {} }
  }
}
document.addEventListener('keydown', function(event){
  if(event.key!=='Enter'&&event.key!==' ')return;
  var button=event.target&&event.target.closest&&event.target.closest('.session-tab .tab-select');
  if(!button)return;
  event.preventDefault();
  event.stopImmediatePropagation();
  window.switchTab(button.getAttribute('data-session-id'));
}, true);
// 从 _cfg 中查找当前真实生效的默认模型名（/status 与模型按钮兜底共用）
// 2026-11-21 修：原来只按「provider.model → models 里 default:true → 第一个 enabled」
// 猜，结果 ZeroAPI 那个 provider 有两个 enabled 模型（v4-pro / v4.1-flash-1017），
// 猜到了第一个 v4-pro，跟 config.yaml 真正在跑的 model.default 完全不是一回事。
// 真正的路由只有一处：/api/config 的 primary = {provider, model}，直接读它。
function _getActiveModelName(){
  var prim = _cfg.primary;
  if(prim && prim.model) return prim.model;
  // 老接口兼容：万一 primary 缺失，才回落到 active_provider 的清单猜测
  var ap = _cfg.active_provider;
  if(!ap) return '自动';
  var p = (_cfg.providers||[]).find(function(p){ return (p.name||p.id)===ap; });
  if(!p) return '自动';
  var model = p.model || '';
  if(model) return model;
  var models = p.models || [];
  var def = models.find(function(m){ return m.default===true; });
  if(def) return def.id || def.name || '';
  var en = models.find(function(m){ return m.enabled!==false; });
  return en ? (en.id || en.name || '') : '自动';
}
function _syncModelBtn(){
  var bm=document.getElementById('btnModel'); if(!bm) return;
  // 移除旧徽章
  var oldBadge = bm.querySelector('.model-badge'); if(oldBadge) oldBadge.remove();
  var sm=_getSessionModel();
  if(sm){
    var mName=(typeof sm==='object'&&sm.model)?sm.model:sm;
    bm.setAttribute('data-tip','本会话模型：'+mName+'（点击更换）'); bm.classList.add('active');
    // 添加小徽章显示模型名
    var badge=document.createElement('span');
    badge.className='model-badge';
    badge.textContent=mName.length>8?mName.slice(0,8)+'…':mName;
    bm.appendChild(badge);
  } else {
    // 无会话级选择时，兜底显示全局默认模型（修复：切换 Provider/模型后首页与按钮无反映）
    var globalModel = _getActiveModelName();
    var globalProv = _cfg.active_provider || '';
    if(globalModel && globalModel !== '自动'){
      bm.setAttribute('data-tip','默认模型：'+(globalProv?globalProv+' · ':'')+globalModel+'（点击更换）');
      bm.classList.add('active');
      var label = globalProv ? globalProv.slice(0,4)+'…' : globalModel;
      var badge2 = document.createElement('span');
      badge2.className='model-badge';
      badge2.textContent = label.length>8 ? label.slice(0,8)+'…' : label;
      bm.appendChild(badge2);
    } else {
      bm.setAttribute('data-tip','选择模型（尚未指定）'); bm.classList.remove('active');
    }
  }
}

/* 关闭一个会话标签（会话本身保留在左侧树）；流式中允许关闭（后台流式继续，不影响其他会话） */
function closeTab(sid) {
  var i = _openTabs.indexOf(sid);
  if (i === -1) return;
  // Closing a view does not cancel a server-owned task or erase its draft.
  if (currentSession === sid) saveDraft(sid, true);
  _openTabs.splice(i, 1); persistTabs();
  _domCacheDrop(sid);   /* 关掉就删缓存，别让没开的会话一直占内存 */
  if (currentSession === sid) {
    currentSession = _openTabs.length ? _openTabs[Math.min(i, _openTabs.length - 1)] : '';
    if (currentSession) {
      renderRail(); updateHeader();
      restoreDraft(currentSession);
      loadSessionMessages(currentSession);
      _syncModelBtn();
    } else {
      var body = document.getElementById('chatBody');
      if (body) body.innerHTML = '<div class="system-tip">没有打开的会话，点击右上角 + 新建</div>';
      updateHeader();
      _syncModelBtn();
    }
  }
  renderSessionTabs(); renderRail();
}

/* 新建会话并打开为标签 */
function newTabCore() {
  // profilefix v4（模型 A）：会话不分 agent 分组，新建会话直接入全局树
  fetch(apiUrl('/api/sessions'), { method: 'POST', headers: monitorToken ? { 'X-Monitor-Token': monitorToken } : {} })
    .then(function (r) { return r.json(); })
    .then(function (s) {
      _sessions.unshift(s);
      currentSession = s.id;
      _applyPendingModel(s.id);
      _openTabs.push(s.id); persistTabs();
      saveDraft(currentSession);   // 新建前保存当前会话草稿
      var ta = document.getElementById('chatInput'); if (ta) ta.value = '';
      renderSessionTabs(); renderRail(); updateHeader();
      if (window.innerWidth <= 768) closeRailDrawer();
      var body = document.getElementById('chatBody');
      if (body) body.innerHTML = '<div class="system-tip">新会话已创建</div>';
    })
    .catch(function () { toast('创建会话失败'); });
}

/* 与后端会话列表同步标签（删除会话后清理、首次加载默认打开一个） */
function syncTabs() {
  var valid = _sessions.map(function (s) { return s.id; });
  _openTabs = _openTabs.filter(function (sid) { return valid.indexOf(sid) !== -1; });
  if (!_openTabs.length && _sessions.length) { _openTabs.push(_sessions[0].id); }
  persistTabs();
  if (currentSession && valid.indexOf(currentSession) === -1) {
    currentSession = _openTabs.length ? _openTabs[0] : '';
  }
  renderSessionTabs();
}

/* 同步标签栏可见性：多会话按钮强制开启 > 移动端始终显示 > 桌面端仅 rail 折叠时显示 */
var _TABS_PREF_KEY = 'hermes_multi_tabs_pref';
function _loadTabsPref(){ try{ var v=JSON.parse(localStorage.getItem(_TABS_PREF_KEY)||'null'); if(v){ _multiTabsForced=!!v.forced; _tabsManuallyHidden=!!v.hidden; } }catch(e){} }
function _saveTabsPref(){ try{ localStorage.setItem(_TABS_PREF_KEY, JSON.stringify({forced:!!_multiTabsForced,hidden:!!_tabsManuallyHidden})); }catch(e){} }
var _multiTabsForced = false;
var _tabsManuallyHidden = false;   // 用户手动收起过标签栏（刷新后保持，直到再次点击按钮）
_loadTabsPref();
function toggleSessionTabsBar(){
  // 以"当前实际可见"为真相：可见 → 收起；不可见 → 展开。状态立即落盘，刷新后保持。
  var tabs = document.querySelector('.page-container .session-tabs');
  var visible = !!(tabs && tabs.classList.contains('visible'));
  if(visible){ _multiTabsForced=false; _tabsManuallyHidden=true; }
  else { _multiTabsForced=true; _tabsManuallyHidden=false; }
  _saveTabsPref();
  syncSessionTabsVisibility();
}
function updateSessionTabsToggle(){
  var tabs=document.querySelector('.page-container .session-tabs');
  var btn=document.getElementById('multiTabsBtn');
  if(!tabs||!btn) return;
  var visible=tabs.classList.contains('visible');
  var label=visible?'隐藏多会话标签':'显示多会话标签';
  btn.classList.toggle('active', visible);      // 图标点亮 = 标签栏真的在显示
  btn.setAttribute('aria-pressed', String(visible));
  btn.setAttribute('aria-expanded',String(visible));
  btn.setAttribute('aria-label',label);
  /* title 不再写：这个按钮的悬停文案归 data-tip（panel-tooltip 单例层），
     两处都写会互相摘除、闪一下原生气泡。2026-11-24 */
}
function syncSessionTabsVisibility() {
  var tabs = document.querySelector('.page-container .session-tabs');
  if (!tabs) return;
  var rail = document.getElementById('chatRail');
  if (!rail) return;
  if (_multiTabsForced) {
    tabs.classList.add('visible');  // 多会话按钮强制开启
  } else if (_tabsManuallyHidden) {
    tabs.classList.remove('visible');  // 用户手动收起后保持收起（移动端与桌面端一致）
  } else if (window.innerWidth <= 768) {
    tabs.classList.toggle('visible', _openTabs.length > 1);  // 单会话时收起冗余标签，多会话时直接切换
  } else if (rail.classList.contains('hidden')) {
    tabs.classList.add('visible');  // 桌面端：仅 rail 折叠时显示
  } else {
    tabs.classList.remove('visible');
  }
  updateSessionTabsToggle();
}

function loadSessions(){
  return fetch(apiUrl('/api/sessions'), { cache:'no-store', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.json(); })
    .then(function(d){
      _sessions = (d && d.sessions) || [];
      if(!currentSession && _sessions.length){ currentSession = _sessions[0].id; }
      else if(currentSession && !_sessions.some(function(s){ return s.id===currentSession; })){ currentSession = _sessions.length?_sessions[0].id:''; }
      syncTabs();
      // profilefix v3（模型 A）：rail 高亮跟随全局 active profile，
      // 不从会话归属恢复（角色是全局单激活的，与会话无关）
      try {
        currentAgent = _activeRailAgentId();
      } catch(e){ currentAgent = 'default'; }
      renderRail(); updateHeader();
      _syncModelBtn();
      if(currentSession) loadSessionMessages(currentSession);
    })
    .catch(function(){ toast('加载会话失败，无法连接后端'); renderRail(); });
}
function fmtDateTime(ts){
  if(!ts) return '';
  var n = Number(ts);
  if(isNaN(n)) return '';
  // 秒级时间戳（10位）自动转毫秒；毫秒级（13位）直接用（升级 0.21.149 后重打 2026-08-24）
  if(n > 0 && n < 1e12) n = n * 1000;
  var d = new Date(n);
  if(isNaN(d.getTime())) return '';
  var pad = function(n){ return (n<10?'0':'')+n; };
  var now = new Date();
  var hm = pad(d.getHours())+':'+pad(d.getMinutes());
  var sameDay = d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth() && d.getDate()===now.getDate();
  if(sameDay) return '今天 '+hm;
  var y = new Date(now); y.setDate(now.getDate()-1);
  var isYest = d.getFullYear()===y.getFullYear() && d.getMonth()===y.getMonth() && d.getDate()===y.getDate();
  if(isYest) return '昨天 '+hm;
  return (d.getMonth()+1)+'月'+d.getDate()+'日 '+hm;
}
function renderRail(){
  var el = document.getElementById('railScroll');
  if(!el) return;
  // 一次性清理 v0.20.66 期间 localStorage 存的旧 'true' 值（让默认折叠生效）
  if (!_state._railOpenCleaned) {
    try {
      var keys = Object.keys(localStorage);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('hermes_rail_open_') === 0) localStorage.removeItem(keys[i]);
      }
      _state._railOpenCleaned = true;
      try { localStorage.setItem('hermes_ui_flags', JSON.stringify({ railOpenCleaned: true })); } catch(e){}
    } catch(e){ _state._railOpenCleaned = true; }
  }
  var html = typeof pwRailHTML === 'function' ? pwRailHTML() : '';
  el.innerHTML = html;
  var cnt = document.getElementById('railCount');
  if (cnt) cnt.textContent = ((_sessions && _sessions.length) || 0) + ' 个';
  renderRailChannels();
  _paintRailState();   // 列表重建后把在跑的会话状态补回去
}
/* 通道会话：独立容器，固定在侧栏底部，不随会话列表滚动 */
function renderRailChannels(){
  var box = document.getElementById('railChannels');
  if(!box) return;
  var chGroups = _channelSessions || {};
  var chIds = Object.keys(chGroups).filter(function(k){ return k !== 'api_server'; });
  if(!chIds.length){ box.innerHTML = ''; box.classList.remove('has'); return; }
  var html = '';
  chIds.forEach(function(chId){
    var sessions = chGroups[chId];
    var def = (_chState.defs && _chState.defs[chId]) || {};
    var lbl = (_chGroupLabels && _chGroupLabels[chId]) || {};
    var chName = def.name || lbl.name || chId;
    var chIcon = def.icon || lbl.icon || '📨';
    // 树目录统一模板：与文件夹组共用同一套箭头/动画/热区/缩进/记忆
    var kids = sessions.length ? sessions.slice(0,20).map(function(s){
      var title = (s.title && s.title!=='未命名会话') ? s.title : '新会话';
      var meta = s.model ? esc(s.model) : '';
      return '<div class="session-item" onclick="openChannelSession(\''+esc(chId)+'\',\''+esc(s.id)+'\')">' +
        '<span class="dot"></span>'+
        '<span class="si-body"><span class="title">'+esc(title)+'</span>'+(meta?'<span class="meta">'+meta+'</span>':'')+'</span>'+
        '<span class="del" title="删除该通道会话" onclick="delChannelSession(\''+esc(chId)+'\',\''+esc(s.id)+'\',event)">×</span></div>';
    }).join('') : '<div class="empty-sess">暂无会话</div>';
    html += PwTree.node({ key:'ch:'+chId, def:false, icon:esc(chIcon), label:chName,
      meta:sessions.length+' 个', body:kids });
  });
  box.innerHTML = html;
  box.classList.add('has');
}
var _channelSessions = null;
var _chGroupLabels = {};
/* 侧栏内联筛选：只动 display，不重建 DOM，所以输入框不丢焦点。
   文件夹名命中时，其下所有会话一并放行。 */
window.pwRailFilter = function(q){
  q = (q || '').trim().toLowerCase();
  var el = document.getElementById('railScroll');
  if(!el) return;
  /* 未读筛选走同一条筛选链（2026-11-20 用户要求）：开关只置一个标记，显隐还是这里算，
     文件夹自展开/收起、空态提示全部复用原有逻辑，不再另写一套遍历。 */
  var unreadOnly = !!window.__pwUnreadOnly;
  var active = !!q || unreadOnly;
  var unreadOk = function(it){
    if(!unreadOnly) return true;
    return !!(window.__pwUnreadCount && window.__pwUnreadCount(it.getAttribute('data-sid')) > 0);
  };
  var hadHit = false;
  // 树结构（pw-tree-node）：文件夹比名称、会话比标题；子项命中则保留祖先并临时展开，
  // 清空后按 data-f-old 还原用户原来的开合状态。
  function walk(node){
    var key = node.getAttribute('data-tree-key') || '';
    var isFolder = key.indexOf('folder:') === 0;
    var head = node.querySelector(':scope > .pw-tree-head');
    var lab = head ? head.querySelector('.pw-tree-label') : null;
    var name = (lab ? lab.textContent : '').toLowerCase();
    var selfHit = !!q && isFolder && name.indexOf(q) >= 0;
    var kidHit = false;
    node.querySelectorAll(':scope > .pw-tree-body > .pw-tree-inner > .pw-tree-kids > .pw-tree-node').forEach(function(k){
      if(walk(k)) kidHit = true;
    });
    node.querySelectorAll(':scope > .pw-tree-body > .pw-tree-inner > .pw-tree-kids > .session-item').forEach(function(it){
      var tn = it.querySelector('.title');
      var txt = (tn ? tn.textContent : it.textContent).toLowerCase();
      var hit = (!q || selfHit || txt.indexOf(q) >= 0) && unreadOk(it);
      it.style.display = hit ? '' : 'none';
      if(hit) kidHit = true;
    });
    var show = !active || selfHit || kidHit;
    node.style.display = show ? '' : 'none';
    if(active && show) hadHit = true;
    var toggle = head ? head.querySelector('.pw-tree-toggle') : null;
    if(active && show){
      if(node.getAttribute('data-f-old') === null) node.setAttribute('data-f-old', node.classList.contains('is-open') ? '1' : '0');
      node.classList.add('is-open');
      if(toggle) toggle.setAttribute('aria-expanded', 'true');
    } else if(!active && node.getAttribute('data-f-old') !== null){
      var old = node.getAttribute('data-f-old') === '1';
      node.classList.toggle('is-open', old);
      if(toggle) toggle.setAttribute('aria-expanded', old ? 'true' : 'false');
      node.removeAttribute('data-f-old');
    }
    return show;
  }
  var tops = el.querySelectorAll(':scope > .pw-tree-node');
  if(tops.length){
    tops.forEach(walk);
  } else {
    el.querySelectorAll('.session-item').forEach(function(it){
      var tn = it.querySelector('.title');
      var txt = (tn ? tn.textContent : it.textContent).toLowerCase();
      var hit = (!q || txt.indexOf(q) >= 0) && unreadOk(it);
      it.style.display = hit ? '' : 'none';
      if(hit) hadHit = true;
    });
  }
  var empty = document.getElementById('railFilterEmpty');
  if(!empty){
    empty = document.createElement('div');
    empty.id = 'railFilterEmpty';
    empty.className = 'pw-hint';
    empty.style.cssText = 'padding:12px 14px;font-size:12px;color:var(--muted)';
    el.appendChild(empty);
  }
  empty.textContent = unreadOnly && !q ? '没有未读会话' : '没有匹配的会话或文件夹';
  empty.style.display = (active && !hadHit) ? '' : 'none';
};
function railGlobalSearchGo(){
  var inp = document.getElementById('railFilterInput');
  var v = inp ? inp.value.trim() : '';
  if(window.pwSearch) window.pwSearch(v);
}
var _channelViewActive = false;   // 通道会话只读视图状态（聊天页标题显示返回按钮，切页自动退出）
function exitChannelView(){
  _channelViewActive = false;
  window.dispatchEvent(new Event('panel-session-changed'));
  /* 退出渠道预览要把输入框放回来——以前这一步是 panel-workspace 覆盖这里补的 */
  var composer = document.getElementById('chatComposer'); if(composer) composer.hidden = false;
  var rb = document.getElementById('chReturnBtn'); if(rb) rb.style.display='none';
  var body = document.getElementById('chatBody');
  if(body) body.innerHTML = '<div class="system-tip">已退出通道会话。在左侧选择会话继续。</div>';
  updateHeader();
  loadSessions();
}
function fetchChannelSessions(){
  if(_authWallShown) return;   // 授权失效后停掉 30 秒轮询，别对着 401 空转
  apiGet('/api/channel-sessions').then(function(res){
    if(res && res.ok && res.groups){ _channelSessions = res.groups; _chGroupLabels = res.labels || {}; renderRail(); }
  }).catch(function(){});
}
function toggleChannelGroup(chId){
  // 兼容入口：外部若还按旧函数名调用，转交给统一树模板
  var btn = document.querySelector('.pw-tree-node[data-tree-key="ch:'+chId+'"] .pw-tree-toggle');
  if(btn) PwTree.toggle(btn);
}
function openChannelSession(chId, sessionId){
  scrollChatToBottom();
  // 通道会话：直接在 WEBUI 聊天窗口加载消息（从 Dashboard API 拉取）
  var def = (_chState.defs && _chState.defs[chId]) || {};
  var chName = def.name || chId;
  _channelViewActive = true;
  window.dispatchEvent(new Event('panel-session-changed'));
  var rb = document.getElementById('chReturnBtn'); if(rb) rb.style.display='inline-flex';
  // 切换到聊天页
  switchPage('chat');
  closeRailIfMobile();
  // 更新标题
  var titleEl = document.getElementById('chatTitle');
  var subEl = document.getElementById('chatSubtitle');
  if(titleEl) titleEl.textContent = chName + ' 通道会话';
  if(subEl) subEl.textContent = '加载中…';
  // 显示 loading
  var body = document.getElementById('chatBody');
  if(body) body.innerHTML = '<div class="system-tip">正在加载 '+esc(chName)+' 通道会话消息…</div>';
  // 拉取消息
  apiGet('/api/channel-sessions/'+encodeURIComponent(sessionId)+'/messages').then(function(res){
    if(!res || !res.ok || !res.messages || !res.messages.length){
      if(body) body.innerHTML = '<div class="system-tip">该通道会话暂无消息记录'+(res&&res.error&&!/fetch|Failed/i.test(res.error)?' ('+esc(res.error)+')':'')+'</div>';
      if(subEl) subEl.textContent = chName + ' · 0 条消息';
      return;
    }
    var msgs = res.messages;
    if(subEl) subEl.textContent = chName + ' · ' + msgs.length + ' 条消息' + (res.title ? ' · ' + res.title : '');
    // 渲染消息到聊天区域
    var html = '<div class="system-tip" style="background:var(--accent);color:#fff;opacity:.9">📨 '+esc(chName)+' 通道会话（只读） · '+msgs.length+' 条消息</div>';
    msgs.forEach(function(m){
      var isUser = (m.role === 'user' || m.role === 'human');
      var cls = isUser ? 'user' : 'assistant';
      var label = isUser ? '你' : ('Hermes' + (m.model ? ' · '+m.model : ''));
      var time = m.timestamp ? fmtDateTime(m.timestamp) : '';
      var content = m.content || '';
      // 简单 Markdown 渲染（代码块 + 换行）
      var rendered = esc(content).replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>').replace(/\n/g, '<br>');
      html += '<div class="msg '+cls+'"><div class="msg-bubble"><div class="md-text">'+rendered+'</div></div><div class="msg-meta">'+esc(label)+' · '+esc(time)+'</div></div>';
    });
    if(body){ body.innerHTML = html; followChatBottom(); }
  }).catch(function(e){
    if(body) body.innerHTML = '<div class="system-tip">通道会话服务暂不可用（网关/仪表盘未就绪），请稍后刷新重试</div>';
  });
}
function toggleAgent(id){
  currentAgent = id;
  var list = document.getElementById('sess-'+id);
  if(list){ var open = list.classList.toggle('open');
    // 折叠三角方向同步：expanded 类必须加到 agent-row，chevron 才会旋转（▶→▼）
    var row = list.parentNode.querySelector('.agent-row'); if(row) row.classList.toggle('expanded', open);
    localStorage.setItem('hermes_rail_open_'+id, open ? 'true' : 'false'); }
}
function switchSession(aid, sid, e){
  if(e) e.stopPropagation();
  openTab(sid);
  closeRailIfMobile();
}
/* profilefix v4：agent 分组概念已移除（会话树单一平铺），deleteAgentGroup 不再需要 */
async function delSession(sid, e){
  if(e) e.stopPropagation();
  if(!(await ui.confirm('归档该会话？聊天记录、归类和会话文件会一起保留，可从“已归档”恢复。'))) return;
  fetch(apiUrl('/api/sessions/'+encodeURIComponent(sid)), { method:'DELETE', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){
      if(!r.ok) return r.json().catch(function(){return {};}).then(function(j){ throw new Error(j.error||'归档失败'); });
      _sessions = _sessions.filter(function(s){ return s.id!==sid; });
      var ti = _openTabs.indexOf(sid);
      if(ti!==-1){ _openTabs.splice(ti,1); persistTabs(); }
      delete _tabDrafts[sid]; delete _tabStreaming[sid]; delete _chatHTML[sid]; delete _syncSigCache[sid]; delete _foldedBySid[sid];
      if(currentSession===sid) currentSession = _openTabs.length?_openTabs[0]:(_sessions.length?_sessions[0].id:'');
      renderSessionTabs(); renderRail(); updateHeader();
      if(currentSession) loadSessionMessages(currentSession);
      // 工作区大纲 tab 激活时，删除会话后同步刷新大纲
      var _ws2 = document.getElementById('workspacePanel');
      if (_ws2 && _ws2.classList.contains('open')) {
        var _wt2 = _ws2.querySelector('.ws-tab.active');
        if (_wt2 && _wt2.textContent.indexOf('大纲') !== -1) loadOutline();
      }
      else { var b = document.getElementById('chatBody'); if(b) b.innerHTML = '<div class="system-tip">没有打开的会话，点击右上角 + 新建</div>'; }
    })
    .catch(function(e){ toast(e.message||'归档失败'); });
}
/* 删除通道会话（cron/微信/QQ 等）：调 monitor 删除 API（gateway 优先，dashboard 兜底），成功后本地移除 */
async function delChannelSession(chId, sid, e){
  if(e && e.stopPropagation) e.stopPropagation();
  if(!(await ui.confirm('确定删除该通道会话？将删除 Hermes 中的该会话记录。', {danger:true}))) return;
  var hd = monitorToken ? { 'X-Monitor-Token': monitorToken } : {};
  fetch(apiUrl('/api/channel-sessions/'+encodeURIComponent(sid)), { method:'DELETE', headers:hd })
    .then(function(r){ return r.json().catch(function(){ return {}; }); })
    .then(function(j){
      if(j && j.ok){
        toast('已删除通道会话');
        if(_channelSessions && _channelSessions[chId]){
          _channelSessions[chId] = _channelSessions[chId].filter(function(s){ return String(s.id)!==String(sid); });
          renderRail();
        }
      } else {
        toast('删除失败: '+((j&&j.error)||'服务器没有返回删除原因'),'error');
      }
    })
    .catch(function(){ toast('删除失败','error'); });
}
/* 会话重命名：列表项 ✎ / 标签页 ✎ → prompt → POST /api/sessions/rename → 刷新列表与标签 */
/* 会话列表点击：单击切换会话，420ms 内再点同一项 → 打开「会话名称与归类」面板。
 * 不用 ondblclick：openTab() 里 renderRail() 会重建列表 DOM，双击第二下落在新节点上，
 * 事件配不成一对（实测 dblclick 不触发）。 */
var _railLastClick = { sid: null, t: 0 };
/* 移动端：会话既然已经开出来了，会话树抽屉还挡着就是纯碍事（2026-11-17 用户）。
 * 原来只有 switchSession 那条老路径关了抽屉，railSessionClick（现在的会话列表项）
 * 和 openChannelSession（通道会话）两条新路径都漏了 —— 同一个动作散成三条路径、
 * 只堵了一条，用户点了半天列表还杵在那儿。统一收到这里。 */
function closeRailIfMobile(){
  if(window.innerWidth<=768 && typeof closeRailDrawer==='function') closeRailDrawer();
}
function railSessionClick(sid, e){
  if(e && e.stopPropagation) e.stopPropagation();
  var now = Date.now();
  if(_railLastClick.sid === sid && now - _railLastClick.t < 420){
    _railLastClick.sid = null; _railLastClick.t = 0;
    return renameSession(sid, e);
  }
  _railLastClick.sid = sid; _railLastClick.t = now;
  openTab(sid);
  closeRailIfMobile();
}
function renameSession(sid, e){
  if(e && e.stopPropagation) e.stopPropagation();
  // 真实现是 panel-workspace-ui.js 的「会话名称与归类」弹窗；原生 prompt 只在它没加载时兜底
  if (typeof window.__pwRenameSession === 'function') return window.__pwRenameSession(sid, e);
  var s = _sessions.find(function(x){ return x.id===sid; });
  if(!s) return;
  var old = (s.title && s.title!=='New Chat' && s.title!=='未命名会话') ? s.title : '';
  var title = prompt('重命名会话：', old);
  if(title===null) return;
  title = title.trim();
  if(!title || title===old) return;
  apiPost('/api/sessions/rename', { id: sid, title: title }).then(function(r){
    if(r && r.ok){
      s.title = r.title;
      renderRail(); renderSessionTabs(); updateHeader();
      if(sid===currentSession){ var t=document.getElementById('chatTitle'); if(t) t.textContent=r.title; }
      toast('已重命名为「'+r.title+'」');
    } else {
      toast((r && r.error) || '重命名失败');
    }
  }).catch(function(){ toast('重命名失败'); });
}
/* 两个加号统一走同一个弹窗（2026-11-11 用户第 6 条）：
 * 侧栏「会话」标题旁那个加号原本直接塞一个空会话（newTab），
 * 标签栏那个却是弹窗选表达风格/模型/工作区（openNewSessionModal）——
 * 同一个动作两套行为，用的人根本不知道该按哪个。现在都走弹窗，
 * 不想选就什么都别选，直接点「创建」= 默认风格 + 当前模型 + 默认工作区。 */
function newSession(){
  openNewSessionModal();
}
/* ── 重渲染后的阅读位置（2026-11-20 真机取证）
   真机数据：用户停在离底 1100px 处读历史，轮询 4s 到点 → loadSessionMessages 整片重绘 →
   `body.scrollTop = prevTop` 把位置还原成「4 秒前那个数字」。这中间图片解码让内容长了 718px，
   同一个数字对应的画面早就不是原来那段 —— 于是画面上下来回跳，每轮一次。
   数字不可靠，锚在「当时视口顶端那条消息」上才可靠。消息只追加不重排，所以用
   「倒数第几条」当键：前面被 MAX_VISIBLE_MSGS 裁掉不影响，后面追加也不影响。 */
function captureScrollAnchor(body){
  try{
    var bt=body.getBoundingClientRect().top, els=body.querySelectorAll('.msg'), n=els.length;
    for(var i=0;i<n;i++){
      var r=els[i].getBoundingClientRect();
      if(r.bottom > bt+1){
        /* 键用「内容前 48 字」，不用索引：折叠「查看更早 N 条」会让 .msg 数量从 4 变 80，
           索引一换就锚到别的消息上（实测偏 123px）。 */
        return { txt:(els[i].textContent||'').trim().slice(0,48), off:Math.round(r.top-bt), h:Math.round(r.height), idx:i };
      }
    }
  }catch(e){}
  return null;
}
function restoreScrollAnchor(body, a, fallbackTop){
  var done=false;
  if(a && a.txt){
    try{
      var bt=body.getBoundingClientRect().top, els=body.querySelectorAll('.msg');
      var hit=null;
      for(var i=0;i<els.length;i++){
        if((els[i].textContent||'').trim().slice(0,48)===a.txt){ hit=els[i]; break; }
      }
      if(hit){
        var hr=hit.getBoundingClientRect();
        var d=(hr.top-bt)-a.off;
        /* 同一条消息、高度也一样 → 匹配可信，多远都照直补（展开/折叠能让位置差两万像素）。
           高度对不上说明找错了同文异位的节点，这时才用 600px 上限兜底。 */
        var sameEl = (a.h === undefined) || Math.abs(Math.round(hr.height) - a.h) <= 4;
        if(sameEl || Math.abs(d) <= 600){ body.scrollTop += d; }
        else { body.scrollTop = fallbackTop; }
        done=true;
      }
    }catch(e){}
  }
  if(!done) body.scrollTop=fallbackTop;
  _chatScroll.lastTop=body.scrollTop;
}

var _renderedCount = {};   /* sid → 上次渲染进 DOM 的消息条数，用于「只追加新消息」 */
var _renderedKeys  = {};   /* sid → 上次渲染的消息指纹数组，内容没变就一个节点都不碰 */
var _chatDOM = {};   /* sid → 存着节点本身的文档片段；进过的会话都留着，关标签才丢 */
function _domCachePut(sid, frag){ if(sid) _chatDOM[sid] = frag; }
function _domCacheDrop(sid){ delete _chatDOM[sid]; delete _chatHTML[sid]; delete _renderedKeys[sid]; delete _renderedCount[sid]; delete _foldedBySid[sid]; delete _winFrom[sid]; delete _winTotal[sid]; }
function _domCacheTake(sid){
  var f = _chatDOM[sid]; if(!f) return null;
  delete _chatDOM[sid];
  return f;
}
function _msgKey(m){
  var c = String(m && m.content != null ? m.content : '');
  return (m && m.role || '') + '|' + ((m && (m.ts || m.timestamp || m.created_at)) || '') + '|' +
         c.length + '|' + c.slice(0, 80) + '|' + c.slice(-40);
}
/* 会话读取期间挡输入（2026-11-20 用户）：正文还在路上就能打字，发出去接的是旧状态。
   轮询（silent）不挡——那不是用户动作；切换/首屏才挡，且 180ms 内的快加载不弹。 */
function loadSessionMessages(sid, silent, keepScroll, appendOnly){
  var _gate = !silent && window.bootMaskBusy;
  if(_gate) window.bootMaskBusy('正在读取会话…');
  var _p = _loadSessionMessagesCore(sid, silent, keepScroll, appendOnly);
  var _end = function(){ if(window.bootMaskBusyEnd) window.bootMaskBusyEnd(); };
  if(_p && typeof _p.then === 'function') _p.then(_end, _end); else setTimeout(_end, 200);
  return _p;
}
function _loadSessionMessagesCore(sid, silent, keepScroll, appendOnly){
  var body = document.getElementById('chatBody');
  if(!body) return;
  return fetch(apiUrl(_winUrl(sid)), { cache:'no-store', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ if(!r.ok) throw new Error('load'); return r.json(); })
    .then(function(s){
      if(sid!==currentSession) return;
      _winTake(sid, s._win, (s.messages||[]).length);
      var prevTop=body.scrollTop;
      var anchor=captureScrollAnchor(body);
      var following=autoScrollActive();
      var msgs = dedupeGhostMsgs(s.messages || []);
      if(!msgs.length){ body.innerHTML = welcomeHTML(); body.setAttribute('data-sid', sid); _renderOlderBar(sid); return; }
      if(!_renderedKeys[sid] && !_dimTried[sid]){
        var _pu = [];
        msgs.forEach(function(m){ _pu = _pu.concat(_msgImgUrls(m)); });
        _pu = _pu.filter(function(u){ return u && !_dimFor(u); }).slice(0, 40);
        if(_pu.length){
          _dimTried[sid] = 1;
          return _prefetchDims(_pu, 800).then(function(){ return loadSessionMessages(sid, silent, keepScroll, appendOnly); });
        }
      }
      _dimTried[sid] = 1;
      /* 只追加，不重绘（2026-11-20 第四次校准）。
         原来只要多一条消息就整片 innerHTML 重写：iPhone 上 16 张图的会话，每来一条回复
         所有 img 节点重建、高度归零再一档档撑回来，七秒钟内容上下抽动一遍。位置算得再准
         也救不了画面本身在塌。这里改成把新增那几条接在末尾，老节点（含已解码的图）原地不动。 */
      var keys = msgs.map(_msgKey);
      var oldKeys = _renderedKeys[sid] || [];
      /* 内容一模一样就一个节点都别碰（2026-11-20 第六次校准）。
         切会话是「先用快照秒画，1~2 秒后 fetch 回来」：以前 fetch 回来无条件整片重写，
         于是刚画好的列表被拆掉重建，图片高度归零再一档档撑开 —— 用户看到的就是
         「切过去一两秒才开始跳」。同一份消息没必要画第二遍。 */
      if(oldKeys.length && keys.length === oldKeys.length && keys.every(function(k,i){ return k === oldKeys[i]; }) && _cacheSane(sid, body)){
        _renderedCount[sid] = msgs.length;
      _renderedKeys[sid] = keys;
        if(!following) restoreScrollAnchor(body, anchor, prevTop); else followChatBottom();
        scheduleChatFollow();
        return;
      }
      /* 只有最后一条变了（流式 checkpoint）→ 增量换那一个气泡，别整片重画。
         但只在「变长了」时换：工具卡片重绘、时间戳补写也会让最后一条的指纹变，
         那不是新内容，换一次就白抖一下（实测内容没变也删掉 2 个节点）。 */
      var _kp = function(k){ return String(k).split('|'); };
      var _klen = function(k){ return parseInt(_kp(k)[2], 10) || 0; };
      if(oldKeys.length && keys.length === oldKeys.length && keys.length > 0 && _cacheSane(sid, body) &&
         keys.slice(0, -1).every(function(k,i){ return k === oldKeys[i]; })){
        var _nl = _kp(keys[keys.length-1]), _ol = _kp(oldKeys[oldKeys.length-1]);
        if(_nl[3] === _ol[3] && _nl[4] === _ol[4] && _nl[2] === _ol[2]){
          /* 只有时间戳在变（后端每次读都重写最后一条的 ts）：正文一模一样，
             当没变化处理。否则会掉进整片重绘 → 展开折叠 → 高度来回两万五。 */
          _renderedKeys[sid] = keys; _renderedCount[sid] = msgs.length;
          if(!following) restoreScrollAnchor(body, anchor, prevTop); else scheduleChatFollow();
          return;
        }
        patchLastMessage(sid).then(function(){ _renderedKeys[sid] = keys; _renderedCount[sid] = msgs.length; });
        if(!following) restoreScrollAnchor(body, anchor, prevTop); else followChatBottom();
        return;
      }
      var _prevN = oldKeys.length || _renderedCount[sid] || 0;
      var _prefixSame = oldKeys.length && keys.length > oldKeys.length &&
        oldKeys.every(function(k,i){ return k === keys[i]; });
      if(appendOnly && _prevN && _prefixSame && msgs.length - _prevN <= 8 && _cacheSane(sid, body)){
        try{
          var tmp=document.createElement('div');
          tmp.innerHTML = msgs.slice(_prevN).map(function(m){ return msgHTML(m); }).join('');
          while(tmp.firstChild) body.appendChild(tmp.firstChild);
          body.setAttribute('data-sid', sid);
          _renderedCount[sid] = msgs.length;
          _renderedKeys[sid] = keys;
          if(window.ToolUI) ToolUI.paintAll(body);
          _chatHTML[sid] = body.innerHTML;
          condenseChatBody();
          _renderOlderBar(sid);
          if(!following) restoreScrollAnchor(body, anchor, prevTop); else followChatBottom();
          scheduleChatFollow();
          try{ window.pwResyncQueueFx && window.pwResyncQueueFx(); }catch(e){}
          return;
        }catch(e){ /* 出岔子就走下面整片重绘的老路，宁可慢也不能白屏 */ }
      }
      /* 排队/运行中的气泡连 DOM 一起留住（2026-11-13 用户第 44 条）。
         以前重绘是把它们删掉再让 refreshQueue 画回来：动画从第一帧重来，
         看上去就是「闪一下」；中间那几秒更是空的。这里把旧节点整对搬到新树里，
         CSS 动画不断、计时不归零。 */
      var keepLive=[];
      var _liveIds=(window.pwLiveQueueIds&&window.pwLiveQueueIds())||[];
      body.querySelectorAll('.msg[data-request-id]').forEach(function(el){
        var _id=el.getAttribute('data-request-id');
        if(_liveIds.indexOf(_id)>=0||el.classList.contains('queued')||el.classList.contains('running')) keepLive.push(el);
      });
      /* 整片重绘期间立个牌子（2026-11-13 用户第 56 条）：resyncQueueFx 一看见它就让位。
         以前重绘刚写进 innerHTML、还没把活着的节点搬回来，resync 已经冲进来补占位了 ——
         补出来的占位转眼变成重复节点被删，删完下一轮又补，用户看到的就是气泡抽个不停。 */
      var newHtml = msgs.map(function(m){ return msgHTML(m); }).join('');
      window._pwHistoryRendering = true;
      try{
        /* 2026-11-20 修闪动：快照先渲染过一遍，fetch 回来内容相同就没必要再整片重写。
           重写会让高度瞬间归零再撑开，看起来就是二次跳动。 */
        if(!keepLive.length && body.innerHTML === newHtml){
          if(!following) restoreScrollAnchor(body, anchor, prevTop);
          else followChatBottom();
          scheduleChatFollow();
          return;
        }
        body.innerHTML = newHtml;
        body.setAttribute('data-sid', sid);
        /* 整片新建的这 2.6 秒内，图片一张张解码会把内容一档档撑长；这段里别逐张贴底，
           等安静下来贴最后一次（见 body load 里的 _settleFollow）。 */
        _applyImgSizing(body);   /* 已知尺寸的图先占位，别等解码撑开 */
        _settleUntil = Date.now() + 2600;
        /* 搬回来的顺序必须成对（2026-11-13 用户第 56 条）：以前照捕获时的 DOM 顺序逐个 append，
           只要捕获那一刻用户气泡还没画出来（占位是后补的），搬回来就先出现一串「只有助手卡」
           的孤儿节点，过 200ms 用户气泡才补上 —— 用户看到的就是队列卡在抽。 */
        keepLive.sort(function(x,y){
          var ix=_liveIds.indexOf(x.getAttribute('data-request-id'));
          var iy=_liveIds.indexOf(y.getAttribute('data-request-id'));
          if(ix!==iy) return ix-iy;
          var ux=x.classList.contains('user')?0:1, uy=y.classList.contains('user')?0:1;
          return ux-uy;
        });
        keepLive.forEach(function(el){
          var _id = el.getAttribute('data-request-id');
          body.querySelectorAll('.msg[data-request-id="'+_id+'"]').forEach(function(n){ n.remove(); });
          body.appendChild(el);
        });
      } finally { window._pwHistoryRendering = false; }
      if(window.ToolUI) ToolUI.paintAll(body);
      _chatHTML[sid] = body.innerHTML;  // 回写快照缓存，下次切换 0 延迟
      _renderedCount[sid] = msgs.length;
      _renderedKeys[sid] = keys;        /* 整片重绘完也要记指纹，否则下次轮询又会重画一遍 */
      /* 顺序反了会白算：折叠「查看更早 N 条」本身会改高度，必须先把折叠做完再还原阅读位置，
         否则刚锚好的位置又被折叠推走（实测差 47px，元素高度没变、总高也没变，就是折叠挪的）。 */
      condenseChatBody();
      _renderOlderBar(sid);
      if(!following) restoreScrollAnchor(body, anchor, prevTop); else followChatBottom();
      scheduleChatFollow();
      /* 整片重绘会连排队那一层的 DOM 一起换掉：呼吸灯、取消按钮、只在本地的占位气泡、
         正在跑那条的状态栏全没了，只能等下一轮 refreshQueue（4s）才回来——用户看到的
         就是「先一个气泡在处理，过几秒又闪出两条排队」。同一帧补回来（2026-11-13 第 44 条）。 */
      try{ window.pwResyncQueueFx && window.pwResyncQueueFx(); }catch(e){}
    })
    .catch(function(){ if(sid===currentSession) body.innerHTML = '<div class="chat-load-error"><span role="alert">加载消息失败，请确认后端已连接后重试。</span><button type="button" onclick="loadSessionMessages(currentSession)">重新加载消息</button></div>'; });
}

/* ── 幽灵修复：仅更新会话最后一条消息的 DOM（增量），不整页重渲染 ──
   与 loadSessionMessages 的区别：不清空 body、不重排所有消息，只替换最后一个 .msg 节点。
   用于 pollSessionSync 检测到「消息条数没变但最后一条内容变了」（另一窗口流式 checkpoint）。
   升级 0.21.149 后重打（2026-08-24） */
function patchLastMessage(sid){
  var body = document.getElementById('chatBody');
  if(!body) return;
  return fetch(apiUrl('/api/sessions/'+encodeURIComponent(sid)+'?tail=1'), { cache:'no-store', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(s){
      if(sid!==currentSession || !s || !s.messages || !s.messages.length) return;
      var msgs = dedupeGhostMsgs(s.messages || []);
      var last = msgs[msgs.length - 1];
      if(!last) return;
      var all = body.querySelectorAll('.msg');
      var lastEl = all[all.length - 1];
      if(!lastEl) return;
      var html = msgHTML(last);
      if(lastEl.outerHTML === html) return;   // 无变化不重写
      /* 正在排队/正在跑的那条不许被增量替换（2026-11-13 用户第 44 条）：
         历史版没有 data-request-id、没有环、没有状态栏，一换就成了「气泡凭空消失 2 秒」。 */
      var _lastId = lastEl.getAttribute('data-request-id') || '';
      var _live = (window.pwLiveQueueIds && window.pwLiveQueueIds()) || [];
      if(_lastId && _live.indexOf(_lastId) >= 0) return;
      var keepScroll = autoScrollActive();
      lastEl.outerHTML = html;
      body.setAttribute('data-sid', sid);
      if(window.ToolUI) ToolUI.paintAll(body);
      _chatHTML[sid] = body.innerHTML;
      if(keepScroll){ followChatBottom(); }
      scheduleChatFollow();
      condenseChatBody();
    })
    .catch(function(){});
}

/* ── 幽灵消息去重：同一用户消息后的多条完整 assistant 只保留最后一条 ──
   背景：WS 断线降级 SSE + 双流并发时，后端可能把同一条回复写成多条 assistant 消息。
   渲染前按「连续 assistant 之间没有 user 分隔」规则折叠，只留最后一条，消灭幽灵回复。 */
function dedupeGhostMsgs(msgs){
  if(!Array.isArray(msgs) || msgs.length < 2) return msgs;
  var out = [];
  for(var i = 0; i < msgs.length; i++){
    var m = msgs[i];
    if(m && m.role === 'assistant'){
      var prev = out[out.length - 1];
      if(prev && prev.role === 'assistant'){
        // 两条连续 assistant（中间无 user）：保留内容更长/更新的那一条
        var prevLen = (typeof prev.content === 'string' ? prev.content : JSON.stringify(prev.content||'')).length;
        var curLen = (typeof m.content === 'string' ? m.content : JSON.stringify(m.content||'')).length;
        if(curLen >= prevLen) out[out.length - 1] = m;
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

/* ── 聊天 DOM 治理：消息超过阈值自动折叠最早消息，防长会话/圆桌 DOM 膨胀卡死 ──
   DOM 节点数有上限后，即使几百条消息的会话滚动、渲染、markdown 布局都保持流畅。
   折叠条只保留一份 HTML 字符串，不占 DOM；点击展开恢复（60 秒保护期内不自动重折叠）。 */
var MAX_VISIBLE_MSGS = 60;
var _foldedBySid = {};        // sid → 被折叠消息的 outerHTML 数组
                              /* 必须按会话存（2026-11-20）：全局一份时，在 A 折叠了 30 条，
                                 切到 B 点「查看更早」会把 A 的消息插进 B 的气泡流里。 */
var _foldHoldUntil = 0;       // 用户展开后的保护截止时间
function _foldedOf(sid){ return _foldedBySid[sid || currentSession] || null; }
function _foldedCount(sid){ var a=_foldedOf(sid); return a ? a.length : 0; }
/* 这份 DOM 能不能当缓存用：消息数（含折叠掉的）必须够得上指纹。
   不够就是「还在加载时被抓下来的半截」——以前把它存成快照，切回来只显示两个气泡（用户 2026-11-20 报）。 */
function _domMsgCount(body, sid){
  if(!body) return 0;
  return body.querySelectorAll('.msg').length + _foldedCount(sid || currentSession);
}
function _cacheSane(sid, body){
  var keys=_renderedKeys[sid]||[];
  if(!keys.length) return false;
  /* 正文必须确实是这个会话的：切到一个没缓存的会话时，旧会话的内容会留在屏幕上
     直到 fetch 回来（有意为之，避免闪白）。这期间切走，如果把 body 存成新会话的快照，
     就等于把别人的正文记在它名下——用户看到「只剩两个气泡」就是这么来的。 */
  if(body && body.getAttribute('data-sid') && body.getAttribute('data-sid') !== sid) return false;
  return _domMsgCount(body, sid) >= keys.length;
}
/* ── 窗口化：顶部「载入更早」条 + 往前取一页（2026-11-20）──
   进会话只画最后一页（CHAT_PAGE 条）。_winFrom>0 说明上面还有，画一条可点的条；
   用户滚到顶或点这条时取上一页插到最前面，并按高度差把滚动位置顶回去 —— 阅读位置不跳。 */
function _renderOlderBar(sid){
  var body = document.getElementById('chatBody');
  if(!body) return;
  var from = _winFrom[sid] || 0;
  var bar = document.getElementById('chatOlderBar');
  if(!from){ if(bar) bar.remove(); return; }
  if(!bar){
    bar = document.createElement('div');
    bar.id = 'chatOlderBar';
    bar.className = 'chat-older-bar';
    var first = body.querySelector('.msg');
    if(first) body.insertBefore(bar, first); else body.appendChild(bar);
  }
  if(bar.getAttribute('data-from') === String(from)) return;
  bar.setAttribute('data-from', String(from));
  bar.innerHTML = '<button type="button">↑ 载入更早的 ' + from + ' 条</button>';
  bar.querySelector('button').onclick = function(){ loadOlderMessages(sid); };
}
function loadOlderMessages(sid){
  sid = sid || currentSession;
  var from = _winFrom[sid] || 0;
  var body = document.getElementById('chatBody');
  if(!from || !body || _winBusy[sid]) return Promise.resolve(false);
  var take = Math.min(CHAT_PAGE, from), start = from - take;
  _winBusy[sid] = 1;
  var bar = document.getElementById('chatOlderBar');
  if(bar) bar.classList.add('loading');
  return fetch(apiUrl('/api/sessions/'+encodeURIComponent(sid)+'?from='+start+'&limit='+take), { cache:'no-store', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ if(!r.ok) throw new Error('older'); return r.json(); })
    .then(function(s){
      if(sid !== currentSession){ return false; }
      if(s && s._win && typeof s._win.total === 'number') _winTotal[sid] = s._win.total;
      var older = dedupeGhostMsgs((s && s.messages) || []);
      if(!older.length){ _winFrom[sid] = 0; _renderOlderBar(sid); return false; }
      var oldH = body.scrollHeight, oldTop = body.scrollTop;
      var tmp = document.createElement('div');
      tmp.innerHTML = older.map(function(m){ return msgHTML(m); }).join('');
      var first = body.querySelector('.msg');
      while(tmp.firstChild){ body.insertBefore(tmp.firstChild, first); }
      _winFrom[sid] = start;
      _renderedKeys[sid] = older.map(_msgKey).concat(_renderedKeys[sid] || []);
      _renderedCount[sid] = (_renderedCount[sid] || 0) + older.length;
      if(window.ToolUI) ToolUI.paintAll(body);
      _applyImgSizing(body);
      _chatHTML[sid] = body.innerHTML;
      body.scrollTop = oldTop + (body.scrollHeight - oldH);
      _chatScroll.lastTop = body.scrollTop;
      _renderOlderBar(sid);
      return true;
    })
    .catch(function(){ return false; })
    .then(function(v){ _winBusy[sid] = 0; var b = document.getElementById('chatOlderBar'); if(b) b.classList.remove('loading'); return v; });
}

/* 从「文件」面板点一张图 → 滚到聊天里发这张图的那条消息（2026-11-20 用户要求）。
   会话消息已经窗口化了，首屏只有最后一页，目标消息很可能还没进 DOM，
   所以找不到就沿窗口往前翻，翻到顶仍没有才认输 —— 返回 false，由调用方退化成打开预览。 */
function _stemOf(name){
  return String(name||'').split('?')[0].split('/').pop()
    .replace(/\.thumb\.webp$/i,'').replace(/\.[a-z0-9]+$/i,'').toLowerCase();
}
function _findMsgWithImage(body, name){
  if(!body) return null;
  var stem = _stemOf(name), imgs = body.querySelectorAll('.msg img');
  for(var i=0;i<imgs.length;i++){
    if(_stemOf(imgs[i].getAttribute('data-full')||imgs[i].getAttribute('src')||'') === stem) return imgs[i].closest('.msg');
  }
  return null;
}
function _flashMsg(msg){
  if(!msg) return false;
  try{ msg.scrollIntoView({ block:'center', behavior:'smooth' }); }catch(e){ msg.scrollIntoView(); }
  msg.classList.remove('msg-hit');
  void msg.offsetWidth;
  msg.classList.add('msg-hit');
  setTimeout(function(){ msg.classList.remove('msg-hit'); }, 2200);
  return true;
}
function focusFileInChat(name){
  var sid = currentSession;
  if(!sid || !name) return Promise.resolve(false);
  var body = document.getElementById('chatBody');
  if(!body) return Promise.resolve(false);
  var hit = _findMsgWithImage(body, name);
  if(hit) return Promise.resolve(_flashMsg(hit));
  var guard = 0;
  function step(){
    if(guard++ > 40) return false;
    if(!((_winFrom[sid]||0) > 0)) return false;
    return loadOlderMessages(sid).then(function(ok){
      if(!ok) return false;
      var found = _findMsgWithImage(document.getElementById('chatBody'), name);
      if(found){ _flashMsg(found); return true; }
      return step();
    });
  }
  return Promise.resolve().then(step);
}
window.focusFileInChat = focusFileInChat;

function condenseChatBody(){
  if(!autoScrollActive()) return; // 阅读历史时不移除上方消息，避免位置跳动
  var body = document.getElementById('chatBody');
  if(!body) return;
  if(Date.now() < _foldHoldUntil) return;   // 用户刚展开查看旧记录：不重新折叠
  if(body.querySelector('#rtCondenseBar')) return;
  var msgs = body.querySelectorAll('.msg');
  var extra = msgs.length - MAX_VISIBLE_MSGS;
  if(extra <= 0) return;
  var hidden = [];
  for(var i = 0; i < extra; i++){ hidden.push(msgs[i].outerHTML); msgs[i].remove(); }
  if(!hidden.length) return;
  var sid = currentSession;
  var folded = (_foldedOf(sid) || []).concat(hidden);
  _foldedBySid[sid] = folded;
  var bar = document.createElement('div');
  bar.id = 'rtCondenseBar'; bar.className = 'rt-condense';
  bar.innerHTML = '<span>↕ 查看更早的 ' + folded.length + ' 条消息</span>';
  bar.onclick = function(){
    pauseChatFollow();
    var oldHeight=body.scrollHeight, oldTop=body.scrollTop;
    _foldHoldUntil = Date.now() + 60000;
    var tmp = document.createElement('div'); tmp.style.display = 'none';
    tmp.innerHTML = (_foldedOf(sid) || []).join('');
    delete _foldedBySid[sid];
    var firstMsg = body.querySelector('.msg');
    while(tmp.firstChild){ body.insertBefore(tmp.firstChild, firstMsg); }
    var b2 = document.getElementById('rtCondenseBar'); if(b2) b2.remove();
    body.scrollTop=oldTop+body.scrollHeight-oldHeight;
    _chatScroll.lastTop=body.scrollTop;
  };
  var firstMsg = body.querySelector('.msg');
  if(firstMsg) body.insertBefore(bar, firstMsg); else body.appendChild(bar);
}

/* ── 多端消息同步：轮询会话签名，另一窗口有新消息/流式进度时自动拉取渲染 ──
   后端 /api/sessions/:id/sync 返回几十字节签名（消息数+最后消息时间/长度/流式标记），
   变化才拉全量消息重渲染；本窗口自己流式或圆桌运行中跳过，防止打断本地实时 DOM。 */
var _syncSigCache = {};   // sid → 上次签名
var _syncTimer = null;
function startSessionSync(){
  if(_syncTimer) return;
  _syncTimer = setInterval(pollSessionSync, 4000);
  /* 状态条自愈：每 15 秒核对一次「条子还该不该亮」（别处取消的任务不会发终态事件）。
     挂在 session sync 启动处，保证只启一次；页面从后台回来时立刻补一次。 */
  if(!window.__genSweepTimer){
    window.__genSweepTimer = setInterval(function(){ if(!document.hidden) _genBarSweep(); }, 15000);
    document.addEventListener('visibilitychange', function(){ if(document.visibilityState==='visible') _genBarSweep(); });
  }
  document.addEventListener('visibilitychange', function(){ if(document.visibilityState==='visible') pollSessionSync(); });
  window.addEventListener('focus', pollSessionSync);
}
function pollSessionSync(){
  if(document.hidden) return;
  /* 渠道记录预览是只读的，别拿当前会话去覆盖它（原来是 panel-workspace 包一层拦） */
  if(_channelViewActive) return;
  var sid = currentSession;
  if(!sid) return;
  // 本窗口正在流式 / 圆桌运行中：DOM 已实时，跳过
  if(_tabStreaming[sid] || (_rtState && _rtState.active && _rtState.sessionId === sid)) return;
  fetch(apiUrl('/api/sessions/'+encodeURIComponent(sid)+'/sync'), { cache:'no-store', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){
      if(!d || !d.sig) return;
      var prevSig = _syncSigCache[sid];
      if(prevSig === undefined){ _syncSigCache[sid] = d.sig; return; }  // 首次：只建基线不重渲染
      if(prevSig === d.sig) return;
      _syncSigCache[sid] = d.sig;
      var prevCount = parseInt(prevSig.split('|')[0], 10) || 0;
      var newCount = parseInt(d.sig.split('|')[0], 10) || 0;
      var prevLast = prevSig.split('|')[1] || '';
      var newLast = d.sig.split('|')[1] || '';
      // 幽灵修复：消息条数没变（仅最后一条内容/流式状态变化）→ 只增量更新最后一条 DOM，不全量重渲染（消灭横跳）
      if(newCount === prevCount){
        patchLastMessage(sid);
      } else {
        loadSessionMessages(sid, false, true, true);   // 拉最新消息，只追加新气泡，保持阅读位置
      }
      // 另一窗口刚发来新用户消息且回复尚未落盘 → 显示「正在回复」提示
      var body = document.getElementById('chatBody');
      if(body && newLast.indexOf('user:') === 0 && prevLast.indexOf('user:') !== 0){
        var tip = document.getElementById('rtRemoteTip');
        if(!tip){ tip = document.createElement('div'); tip.id='rtRemoteTip'; tip.className='system-tip'; body.appendChild(tip); }
        tip.textContent = '⏳ 另一窗口正在回复…';
        if(autoScrollActive()) followChatBottom();
      }
    })
    .catch(function(){});
}
function _savedPathToUrl(p){
  /* 历史消息里只存了「已保存到本机路径: /volN/@apphome/<app>/data/...」这种盘上路径，
     而聊天气泡要的是能被 nginx 直取的 URL。把 data 前缀剥掉即可：
     <任意前缀>/data/uploads/files/x → /uploads/files/x（再补 BASE）。
     不写死应用名和卷号 —— 同一个面板会装在 fnOS(/volN/@apphome/<app>)、
     Windows(%APPDATA%\<app>) 等不同位置，认死一个路径就会静默丢图。 */
  if(!p) return '';
  p = String(p).trim();
  var m = p.match(/^(?:\/[^\/]+)*\/data(\/.*)$/);
  if(m) p = m[1];
  if(p.charAt(0) !== '/') return '';
  if(/^\/vol\d+\//.test(p)) return '';   // 仍是裸卷路径，浏览器取不到，别给空播放器
  return p;
}
/* 同一条消息里同一张图出现多次时只留第一处（2026-11-13 用户报「表情重复在发送」）。
   实际成因是模型在不同位置贴了同一个文件，两次 alt 文案还不一样，肉眼看着就是同一张图发了两遍。
   比对前先解码 URI：同一文件常一处写成 /data/tmp/a.gif、另一处写成 %E7%89%B9... 编码形式，
   不归一的话会被当成两张。丢掉的只是重复的同一张图，不影响正文。 */
function dedupeMarkdownImages(text){
  if(!text || text.indexOf('![') < 0) return text;
  var seen = {};
  return text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function(all, alt, src){
    var key;
    try { key = decodeURIComponent(src); } catch(e){ key = src; }
    key = String(key).replace(/^https?:\/\/[^/]+/i, '');   // 换域名/端口视为同一张
    if(seen[key]) return '';
    seen[key] = 1;
    return all;
  });
}
function splitContent(content){
  if(typeof content === 'string') {
    var files=[], furls=[];
    var filePattern=/\n\n### 文件: ([^\n]+?) \[[^\]]+\]\n已保存到本机路径: ([^\n]+)\n你读取此文件并分析/g;
    var text=content.replace(filePattern,function(_,name,p){
      files.push(name.replace(/^\d+_[0-9a-f]{8,}_/i,''));
      furls.push(_savedPathToUrl(p));
      return '';
    }).trimEnd();
    return { text:text, images:[], files:files, fileUrls:furls };
  }
  if(Array.isArray(content)){
    var text = '', images = [];
    content.forEach(function(p){
      if(!p) return;
      if(p.type === 'text' && p.text) text += (text ? '\n' : '') + p.text;
      else if(p.type === 'image_url' && p.image_url && p.image_url.url) images.push(p.image_url.url);
    });
    var parsed=splitContent(text);
    return { text:parsed.text, images:images, files:parsed.files||[], fileUrls:parsed.fileUrls||[] };
  }
  if(content && typeof content === 'object'){
    return { text: content.text || '', images: Array.isArray(content.images) ? content.images : [], files:Array.isArray(content.file_names)?content.file_names:[], fileUrls: Array.isArray(content.files)?content.files:[] };
  }
  return { text: '', images: [], files:[], fileUrls:[] };
}
/* 系统注入文本剥离（2026-11-17 用户要求："这些提示词显式注入的格式能不能隐藏，
   现在在会话气泡显示出来不好看"）。
   ──────────────────────────────────────────────────────────────
   服务端为了让我看懂上下文，会往 user 消息正文里拼几段机器话：
     （语音消息，转写没成功，请直接听附件）
     【画板生图】请直接调用 image_generate…提示词：xxx
     【本轮参考上下文】 / 本轮可用的本机能力：…
   这些话是给我读的，用户看到的就是一大坨不像自己说的话。
   **只在渲染层剥掉**，服务端存的原文一个字不动：
     · data-content 必须保留全文 —— 画板认父靠里面的【画板生图】提示词
       和引用块，剥了它历史图的父子关系就重建不出来（extractImages 读的就是它）；
     · 剥完如果空了但还挂着附件（语音条 / 文件卡），气泡留空是正确的，
       播放器和文件名本身就在附件区。
   剥完真的一无所有时退回原文，宁可难看也别把用户的话吞了。 */
function stripInjections(t){
  var s = String(t || '');
  // 尾部能力清单：从【本轮参考上下文】一直到结尾
  s = s.replace(/【本轮参考上下文】[\s\S]*$/, '');
  // 有的版本没带小标题，直接是这一行
  s = s.replace(/本轮可用的本机能力：[\s\S]*$/, '');
  // 画板生图指令段：到下一个小标题或结尾
  s = s.replace(/【画板生图】[\s\S]*?(?=\n\s*【|$)/g, '');
  // 语音转写失败提示（全角/半角括号都算）
  s = s.replace(/[（(]语音消息，转写没成功，请直接听附件[）)]/g, '');
  /* 长期目标（2026-11-19）：sendRaw 把 localStorage 里的目标拼在正文末尾，
     以前只保证「当次发送」的气泡用 askText 显示不脏；一旦刷新走历史渲染，
     这段就整段露出来。扫 96 个会话确认有 2 条真被用户看见过。 */
  s = s.replace(/\n+【长期目标】[\s\S]*$/, '');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s || '';
}
function toggleCronLead(btn){
  var box = btn.closest('.msg.cron-lead');
  if(!box) return;
  var open = box.classList.toggle('open');
  btn.textContent = open ? '收起' : ('展开全部 ' + (box.querySelector('.cron-lead-body') ? box.querySelector('.cron-lead-body').innerText.length : '') + ' 字');
}
function _audioSrc(u){
  if(!u) return '';
  if(/^\/vol1\//.test(u)) u = _savedPathToUrl(u);
  if(!u) return '';
  if(/^data:|^blob:/i.test(u)) return u;
  /* 绝对地址但换了个域名（比如历史消息里存过的旧域名 /app/hermes-agent/...）
     在本机和外网都取不到 —— 同应用内的音频一律折回相对路径，跟着页面自己的 origin 走。 */
  if(/^https?:/i.test(u)){
    try{
      var abs = new URL(u, location.href);
      if(abs.origin !== location.origin && /^\/(app\/hermes-agent|uploads|tmp|data)\//.test(abs.pathname)){
        return abs.pathname + abs.search;
      }
    }catch(e){}
    return u;
  }
  if(/^\/app\//.test(u)) return u;
  return (typeof chatImgSrc === 'function') ? chatImgSrc(u) : u;
}
/* 附件 → 卡片内容：音频一律给带进度条的播放器，别再只丢一个文件名。
   用户的语音、助手的 TTS、历史消息里的附件块都走这一条。 */
function fileChipsHTML(names, urls){
  names = names || []; urls = urls || [];
  return names.map(function(name, i){
    var u = urls[i] || '';
    if(u && AUDIO_EXT_RE.test(u)) return voicePlayerHTML(u, name);
    return '<span class="chat-file-chip">📎 '+esc(name)+'</span>';
  }).join('');
}
/* MediaRecorder 录出来的 webm 头部没有时长，浏览器算出来是 Infinity：
   进度条就永远是空的、时间显示 ∞。经典做法——先 seek 到极大值把索引逼出来，再回到 0。 */
document.addEventListener('loadedmetadata', function(e){
  var au = e.target;
  if(!au || au.tagName !== 'AUDIO' || !au.classList.contains('voice-attach')) return;
  if(au._durFixed) return;
  if(au.duration === Infinity || isNaN(au.duration)){
    au._durFixed = true;
    try{ au.currentTime = 1e6; }catch(err){}
    var onUpd = function(){
      if(isFinite(au.duration) && au.duration > 0){
        au.removeEventListener('timeupdate', onUpd);
        try{ au.currentTime = 0; }catch(err){}
      }
    };
    au.addEventListener('timeupdate', onUpd);
  }
}, true);
/* ── 气泡内三层信息带（2026-11-12 用户第 32 条）────────────────────────
   ① 状态栏   = 现在进行时。live 事件驱动，这一轮结束就淡出。
   ② flag chip = 已经发生的事实，跟消息一起永久留着。
   ③ .chat-info = 真提示通道（连接中断/正在恢复），不被 transient 过滤吞掉。

   两种标记以前是「正文里的一行字」，所以永远挂在气泡最底下：
     · （执行已中断）              monitor.js:2546 / 8743 拼进回复正文
     · 📦 **本会话已自动压缩**…     conversation_loop.py:2232、6641 拼进正文
   现在渲染前把它们抽出来收成 chip，正文只留真正的内容。两类都算「已发生」，
   同归 chip 层；差别是压缩属于会话级、可能重复多次，所以带 ×N，原句放 title。 */
var SYS_MARKER_PATTERNS = [
  /* 逐字对齐服务端原文，别凭印象写 —— 压缩那条必须带「（更早对话已归档…」整段才算数，
     否则回复里聊到这句话也会被折成 chip。 */
  /* 只能整行独立命中：服务端是「正文 + \n\n + 标记」拼进回复的，真标记永远独占一行。
     2026-11-13 的误伤：回复正文里引用「（执行已中断）」解释这个 bug，被裸正则当场抽成
     chip，一条完整回复凭空挂上「已中断」。所以下面三条必须锚 ^…$（/m），
     跟压缩那两条一个标准。 */
  { type:'warn',  icon:'⚠', label:'执行已中断', hint:'这一轮回复被中断，正文可能不完整',
    re:/^[ \t]*[（(]执行已中断[）)][ \t]*$/gm },
  { type:'muted', icon:'⏹', label:'已中断', hint:'这一轮被中断，正文可能不完整',
    re:/^[ \t]*[（(]已中断[）)][ \t]*$/gm },
  { type:'muted', icon:'⏹', label:'已停止', hint:'这一轮由你手动停止',
    re:/^[ \t]*[（(]已停止[）)][ \t]*$/gm },
  /* panel-chat-recovery.js:59 落在正文里的那句「> *（这条回复在生成过程中被打断，内容不完整）*」
     —— 以前不带任何模式，正文留一行斜体、状态条再写一遍，同一条气泡两个「中断」。 */
  { type:'muted', icon:'⏹', label:'已中断', hint:'这一轮回复在生成过程中被打断，内容不完整',
    re:/^[ \t]*>?[ \t]*\*?[（(]这条回复在生成过程中被打断，内容不完整[）)][ \t]*\*?[ \t]*$/gm },
  { type:'info',  icon:'📦', label:'上下文已压缩', hint:'更早的对话已归档为摘要，会话可以继续',
    re:/^[ \t]*>?[ \t]*(?:📦[ \t]*)?\*\*本会话已自动压缩\*\*（更早对话已归档[^）\n]*）[ \t]*$/gm, count:true },
  { type:'info',  icon:'📦', label:'上下文已压缩', hint:'更早的对话已归档为摘要，会话可以继续',
    re:/^[ \t]*>?[ \t]*(?:📦[ \t]*)?本会话已自动压缩（更早对话已归档[^）\n]*）[ \t]*$/gm, count:true }
];
function splitSysMarkers(text){
  var out = { text: String(text==null ? '' : text), flags: [] };
  for(var i=0;i<SYS_MARKER_PATTERNS.length;i++){
    var p = SYS_MARKER_PATTERNS[i], n = 0;
    out.text = out.text.replace(p.re, function(){ n++; return ''; });
    if(!n) continue;
    var same = null;
    for(var j=0;j<out.flags.length;j++) if(out.flags[j].label===p.label) same = out.flags[j];
    if(same) same.count += n;
    else out.flags.push({ type:p.type, icon:p.icon, label:p.label, hint:p.hint, count: p.count?n:0 });
  }
  /* 抽掉标记后可能留下空行；正文内部的单个换行不动 */
  out.text = out.text.replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').replace(/^\s+|\s+$/g,'');
  return out;
}
/* 2026-11-13（用户第 43 条）：一轮是怎么结束的，只在一处说。
   以前「执行已中断」有两个来源各说一遍 —— 状态条读 queue_status，chip 读正文里那句
   （执行已中断）。同一条气泡上下两个一模一样的提示，纯重复。
   现在：结束状态一律由 .msg-statusbar 表达，chip 层只留「上下文已压缩」这种
   跟「这轮怎么结束」无关的事实。定性顺序：结构化字段优先，没有结构化信息才退回正文标记。 */
var TURN_END_LABELS = {'执行已中断':1, '已中断':1, '已停止':1};
function turnEndState(m, flags, rawText){
  if(!m || m.role !== 'assistant') return null;
  var qs = String(m.queue_status || ''), ec = String(m.error_code || '');
  var raw = String(rawText || '');
  var ms = Number(m.duration_ms || 0) || 0;
  /* 正文里服务端写的原因（「请求失败: xxx」/「本轮中断：xxx」）只用来定性，不回显整段 */
  var mm = raw.match(/(?:请求失败|本轮中断)[:：]\s*([^\n）)]{1,160})/);
  var reason = mm ? mm[1].trim() : '';
  var blob = (reason + ' ' + ec).toLowerCase();
  var recovered = /这条回复在生成过程中被打断|服务关闭|进程退出/.test(raw);
  if(qs === 'failed' || /^(provider_|network_|http_5|http_4)/.test(ec)){
    if(ec === 'provider_timeout' || /超时|timeout|timed out/.test(blob))
      return {icon:'⏱', label:'模型超时中断', alert:1, ms:ms, hint:reason || '上游模型长时间没有返回数据，这一轮被中断'};
    if(/余额|额度|欠费|不足|quota|insufficient|credit|402|payment|billing/.test(blob))
      return {icon:'💳', label:'模型额度不足', alert:1, ms:ms, hint:reason || '当前模型额度或余额不足，换模型或充值后重试'};
    if(/econn|enotfound|eai_again|refused|connect|fetch failed|network|socket|reset|网络|断网|连不上|不可达/.test(blob))
      return {icon:'🌐', label:'连接失败', alert:1, ms:ms, hint:reason || '请求没发出去或被断开，检查网络与代理后重试'};
    return {icon:'⚠', label:'本轮失败', alert:1, ms:ms, hint:reason || '这一轮没有正常跑完'};
  }
  if(qs === 'cancelled') return {icon:'⏹', label:'已取消', alert:0, ms:ms, hint:'这一轮在开始前被取消'};
  if(qs === 'interrupted'){
    if(recovered) return {icon:'⏹', label:'执行已中断', alert:1, ms:ms, hint:'服务重启或进程退出，这一轮没跑完'};
    return {icon:'⏹', label:'已停止', alert:1, ms:ms, hint:'这一轮被中途停止（你点了停止，或连接断开），正文可能不完整'};
  }
  if(qs === 'done') return ms ? {icon:'✅', label:'完成', alert:0, ms:ms} : null;
  /* 没有结构化状态：退回正文标记——只有它知道这轮断过 */
  for(var i=0;i<(flags||[]).length;i++){
    var f = flags[i];
    if(!TURN_END_LABELS[f.label]) continue;
    if(f.label === '已停止') return {icon:'⏹', label:'已停止', alert:1, ms:ms, hint:f.hint || '这一轮由你手动停止'};
    return {icon:'⏹', label:'执行已中断', alert:1, ms:ms, hint:f.hint || '这一轮回复被中断，正文可能不完整'};
  }
  return ms ? {icon:'✅', label:'完成', alert:0, ms:ms} : null;
}
function flagsInnerHTML(flags){
  if(!flags || !flags.length) return '';
  return flags.map(function(f){
    return '<span class="flag-chip '+f.type+'" title="'+DOM.escAttr(f.hint||'')+'">'+
      '<span class="fc-ico">'+f.icon+'</span>'+esc(f.label)+(f.count>1 ? ' ×'+f.count : '')+'</span>';
  }).join('');
}
function flagsHTML(flags){
  var inner = flagsInnerHTML(flags);
  return inner ? '<div class="msg-flags">' + inner + '</div>' : '';
}
function setBubbleFlags(root, flags){
  if(!root) return;
  var bub = root.querySelector('.msg-bubble') || root;
  var box = bub.querySelector('.msg-flags');
  var inner = flagsInnerHTML(flags);
  if(!box){
    if(!inner) return;
    /* 容器只建一次，内容单独填 —— flagsHTML 自带 .msg-flags 外壳，
       往容器里塞整块 HTML 会变成「容器套容器」，chip 重复计数（2026-11-13 实测）。 */
    bub.insertAdjacentHTML('beforeend', '<div class="msg-flags" hidden></div>');
    box = bub.querySelector('.msg-flags');
  }
  if(box.innerHTML !== inner) box.innerHTML = inner;
  box.hidden = !inner;
}
function _sbElapsed(start){
  var s = Math.max(0, Math.round((Date.now()-start)/1000));
  return s < 60 ? (s+'s') : (Math.floor(s/60)+'m'+(s%60)+'s');
}
/* 毫秒 → 人话耗时（历史气泡用；流式那条走 _sbElapsed 秒表） */
function fmtDurMs(ms){
  var s = Math.max(0, Math.round(Number(ms||0)/1000));
  return s < 60 ? (s+'s') : (Math.floor(s/60)+'m'+(s%60)+'s');
}
function _sbTickNow(bar){
  if(!bar || bar.hidden) return;
  var st = Number(bar.getAttribute('data-start')||0); if(!st) return;
  var t = bar.querySelector('.sb-time'); if(t) t.textContent = '🕒 '+_sbElapsed(st);
}
/* 状态条落位（2026-11-13 用户第 40 条）：气泡正文之下、工具调用之上。
   历史/流式/durable 三条渲染路径的模板都已按这个顺序拼节点，这里再兜一次——
   旧 DOM 或别处补插的状态条会被拎回去，不用各路径各改一遍。 */
function _sbPlace(root, bar){
  if(!root || !bar) return;
  /* 锚点必须和状态栏挂在同一个父节点下，否则 insertBefore 直接抛 NotFoundError。
     刷新页面后 root 是 .msg，而 .tool-calls 在 .msg-bubble 里面——两者不同父，
     以前一 insertBefore 就抛，异常被 renderTurn 外层的 try 吞掉，状态栏永远停在
     hidden 加空内容：表现就是「跑着的那条没有状态栏，结束了才看到一个完成」（2026-11-13 用户第 55 条）。 */
  /* anchor 可能埋在容器里面（流式路径的 .tool-calls 是 .durable-tools 的子节点），
     而状态栏必须挂在气泡这一层。挂在工具卡内部的话，patchToolBox 每次重建都把它
     连根删掉，要等下一次 setBubbleStatus 才插回来——中间那段状态栏是消失的，
     回来时 sbIn 又从头播一遍。用户看到的「消失又出现、气泡闪一下」就是这个
     （2026-11-14 实测：10550ms 被摘、13433ms 才插回）。 */
  var box = root.querySelector('.msg-bubble') || root;
  var anchor = box.querySelector('.tool-calls') || box.querySelector('.durable-tools')
            || box.querySelector('.chat-info') || box.querySelector('.msg-flags');
  var kid = anchor;
  while(kid && kid.parentNode !== box) kid = kid.parentNode || null;
  if(bar.parentNode !== box){ box.insertBefore(bar, kid); return; }
  if(kid && bar.nextElementSibling !== kid) box.insertBefore(bar, kid);
}
/* 状态栏：一个气泡只留一条，再调就是更新；不传 icon 时按 mode 取顶栏那套图标 */
/* 哪些状态不该走秒表：排队/等待态还没轮到，计时会骗人（2026-11-13 用户第 44 条：
   「队列里的消息怎么能上来就开始计时呢？明明都还没有轮到他」）。 */
var _SB_NOTIMED = { queued:1, pending:1, waiting:1, idle:1 };
/* 开始时间按 data-request-id 记一份：历史重绘会整片重建气泡 DOM，
   只靠 data-start 会被清零，于是「下一秒计时又从 0s 开始」。 */
function _sbStamp(root, bar, mode){
  var timed = !_SB_NOTIMED[mode];
  if(!timed){ bar.removeAttribute('data-start'); return false; }
  var k = ''; try{ k = root.getAttribute('data-request-id') || ''; }catch(e){}
  var m = (window._sbStarts = window._sbStarts || {});
  /* 真基准：队列 job 的 started_at（服务端落盘）。刷新后内存表是空的，
     只靠 Date.now() 盖章 = 从刷新那一刻从零开始计时，而这一轮其实已经跑了 41s
     （2026-11-19 用户实测）。队列给的时间晚于本机盖章时一律以它为起点。 */
  var run = (window._sbRunStarts = window._sbRunStarts || {});
  var rs = 0; try{ rs = Number(root.getAttribute('data-run-start') || (k && run[k]) || 0) || 0; }catch(e){}
  var s0 = bar.getAttribute('data-start') || (k && m[k] ? String(m[k]) : '');
  if(!s0) s0 = String(rs || Date.now());
  else if(rs && Number(s0) - rs > 2000) s0 = String(rs);
  bar.setAttribute('data-start', s0);
  if(k){ if(Object.keys(m).length > 400) window._sbStarts = m = {}; m[k] = Number(s0); }
  return true;
}
function setBubbleStatus(root, mode, text, icon){
  if(!root) return;
  var bar = root.querySelector('.msg-statusbar');
  if(!bar) return;
  _sbPlace(root, bar);
  var cls = 'msg-statusbar' + (mode==='alert' ? ' sb-alert' : (mode==='tool' ? ' sb-tool' : ''));
  if(bar.className !== cls) bar.className = cls;
  /* 新动作到了 → 撤销排队中的淡出。以前 clearBubbleStatus 的定时器没有撤销机制，
     190ms 后照样把刚写进去的新文案 hidden 掉，下一次事件再点亮 = 又闪一次。 */
  bar._sbGen = (bar._sbGen||0) + 1;
  if(bar.classList.contains('sb-out')) bar.classList.remove('sb-out');
  var wasHidden = bar.hidden;
  bar.hidden = false;
  /* 排队态不盖时间戳：轮到它开始跑（thinking/generating/tool）时才起表 */
  var _timed = _sbStamp(root, bar, mode);
  var _ico = icon || (typeof _ST_ICON!=='undefined' && _ST_ICON[mode]) || '💭';
  /* 原地改文本，不重建 innerHTML：动作一模一样也要重建的话，子节点全是新的，
     状态栏每次更新都在"换人"，字宽/省略号重算，重插还会连带重放 sbIn。 */
  var ic = bar.querySelector('.sb-icon'), tx = bar.querySelector('.sb-text'), tm = bar.querySelector('.sb-time');
  if(!ic || !tx || !tm){
    bar.innerHTML = '<span class="sb-icon"></span><span class="sb-text"></span><span class="sb-time"></span>';
    ic = bar.querySelector('.sb-icon'); tx = bar.querySelector('.sb-text'); tm = bar.querySelector('.sb-time');
  }
  if(ic.textContent !== _ico) ic.textContent = _ico;
  var _txt = String(text||'');
  if(tx.textContent !== _txt) tx.textContent = _txt;
  /* 进场动画只在"从隐到显"时放一次；文案更新不播，否则每次换动作都淡入一次 */
  if(wasHidden){ bar.classList.remove('sb-enter'); void bar.offsetWidth; bar.classList.add('sb-enter'); }
  if(_timed) _sbTickNow(bar);
}
function clearBubbleStatus(root, delay){
  if(!root) return;
  var bar = root.querySelector('.msg-statusbar');
  if(!bar || bar.hidden) return;
  /* 代次令牌：淡出过程中来了新动作，旧定时器必须自己作废。
     没有这道闸，clear(190ms) 与 set 相邻触发时会出现「新文案刚出来就被隐藏、
     下一个事件又点亮」的闪动（2026-11-14 实测量到 clear 后 5ms 又来一次 clear）。 */
  var gen = (bar._sbGen = (bar._sbGen||0) + 1);
  setTimeout(function(){
    if(gen !== bar._sbGen) return;
    if(!bar.isConnected || bar.hidden) return;
    bar.classList.add('sb-out');
    setTimeout(function(){
      if(gen !== bar._sbGen){ bar.classList.remove('sb-out'); return; }
      bar.hidden = true; bar.innerHTML = ''; bar.className = 'msg-statusbar';
      bar.removeAttribute('data-start');
      bar.classList.remove('sb-out');
    }, 190);
  }, delay==null ? 0 : delay);
}
/* 1s 心跳：一个工具跑很久、期间没有事件时，耗时也要继续走。
   页面切后台直接跳过，不白查 DOM（2026-11-21 手机发热收敛） */
if(!window._sbTickTimer){
  window._sbTickTimer = setInterval(function(){
    if(document.hidden) return;
    var list = document.querySelectorAll('.msg-statusbar:not([hidden])');
    for(var i=0;i<list.length;i++) _sbTickNow(list[i]);
  }, 1000);
}
function msgHTMLBase(m){
  var parts = splitContent(m.content);
  var text = parts.text, imgs = parts.images;
  /* 引用消息在服务端存的是一整段「【引用上下文】…【用户追问】…」。
     历史渲染时拆回「引用卡片 + 用户原话」，否则刷新后气泡里会把引用全文再复述一遍。 */
  var quoteHtmlHist = '';
  if(m.role === 'user' && text.indexOf('【引用上下文】') === 0){
    var _qi = text.indexOf('【用户追问】');
    if(_qi > 0){
      var _q = text.slice('【引用上下文】'.length, _qi).trim();
      var _a = text.slice(_qi + '【用户追问】'.length).trim();
      /* 引用块里的「[图片] 提示词：xxx」是服务端存的字面格式（2026-11-17）。
         直接显示等于把内部格式摊给用户看，只留提示词本身。
         引用类型不止图片（文本/文件/视频/音频都可能），所以要按已知类型整类剥，
         不能只写死 [图片]；但仍要求后面紧跟「提示词：」，避免误伤用户自己写的方括号开头。 */
      _q = _q.replace(/^\[(?:图片|文本|文件|视频|音频)\]\s*提示词：/, '').trim();
      if(_q){ quoteHtmlHist = '<div class="quote-block"><div class="quote-label">引用</div>' + escapeHtml(_q) + '</div>'; text = _a; }
    }
  }
  var imgHtml = imgStackHTML(imgs);
  if(m.role === 'user'){
    var fileHtml = fileChipsHTML(parts.files, parts.fileUrls);
    /* 定时任务会话的第一条 user 消息是调度器注入的任务说明（2000+ 字），
       按普通气泡渲染就是整屏紫色、什么都看不见。折叠成灰色小字，点开才看全文。 */
    var _isCronLead = text.indexOf('[IMPORTANT: You are running as a scheduled cron job') === 0;
    if(_isCronLead){
      return '<div class="msg user cron-lead" data-content="'+DOM.escAttr(text).replace(/\"/g,'&quot;').replace(/\n/g,'&#10;')+'"><div class="chat-sender">调度器注入</div><div class="msg-bubble"><div class="cron-lead-body">'+escapeHtml(text).replace(/\n/g,'<br>')+'</div><button class="cron-lead-toggle" onclick="toggleCronLead(this)">展开全部 '+text.length+' 字</button></div><div class="msg-actions"><button class="msg-act-btn" onclick="copyMsg(this)" title="复制"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>复制</button></div><div class="msg-meta">定时任务注入 · '+fmtDateTime(m.ts||m.created_at||Date.now())+'</div></div>';
    }
    /* 2026-11-13：气泡必须带 request_id——跑马灯/呼吸灯/取消按钮全靠 data-request-id 定位，
       以前渲染时把它吞了，于是「排队中的那条」永远找不到自己的气泡。 */
    /* 2026-11-13：user 气泡以前不抽系统标记，压缩摘要尾部那行「📦 本会话已自动压缩」
       原样怼在正文里，chip 永远出不来（/compress 只能靠弹框提示，刷新即失忆）。
       现在和 assistant 同一条路：抽标记 → 弹 chip，正文只剩真内容。 */
    var _umk = splitSysMarkers(text), _uText = dedupeMarkdownImages(_umk.text);
    /* 可见正文剥掉系统注入（2026-11-17 用户要求「这些提示词显式注入的格式能不能隐藏」）：
       （语音消息，转写没成功…）、【画板生图】指令、尾部【本轮参考上下文】/本轮可用的本机能力清单，
       全部不再显示在气泡里。data-content 仍写 _uText 全量 —— 画板 extractImages 从它里面
       抠【画板生图】提示词重建父子关系，剥了画板就认不出谁接谁。 */
    var _uShow = stripInjections(_uText);
    return '<div class="msg user"'+(m.request_id?' data-request-id="'+DOM.escAttr(m.request_id)+'"':'')+(m.ts?' data-ts="'+DOM.escAttr(String(m.ts))+'"':'')+' data-content="'+DOM.escAttr(_uText).replace(/\"/g,'&quot;').replace(/\n/g,'&#10;')+'"><div class="chat-sender">你</div><div class="msg-bubble">'+quoteHtmlHist+((_uShow||'').length?escapeHtml(_uShow).replace(/\n/g,'<br>'):'')+imgHtml+(fileHtml?'<div class="chat-file-list">'+fileHtml+'</div>':'')+flagsHTML(_umk.flags)+'</div><div class="msg-actions"><button class="msg-act-btn" onclick="copyMsg(this)" title="复制"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 0-2-2V4a2 2 0 0 0 2-2h9a2 2 0 0 0 2 2v1"/></svg>复制</button><button class="msg-act-btn" onclick="quoteMsg(this)" title="引用回复"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>引用</button></div><div class="msg-meta">你 · '+fmtDateTime(m.ts||m.created_at||Date.now())+'</div></div>';
  }
  var aFileHtml = fileChipsHTML(parts.files, parts.fileUrls);
  /* 历史渲染走三层：标记抽成 chip，正文只剩真正的内容。
    结束状态（完成/中断/失败/超时/额度/连接）一律进状态条，中断类标记不再进 chip——见 turnEndState。 */
  var _mk = splitSysMarkers(text), _mkText = dedupeMarkdownImages(_mk.text);
  var _flags = _mk.flags.filter(function(f){ return !TURN_END_LABELS[f.label]; });
  /* 2026-11-13：刷新后气泡顶部原本什么都没有——流式那条状态条只在内存里，重载即失。
     现在把「怎么结束的 + 真实耗时」随消息一起渲染回来，时间来自落盘的 duration_ms。 */
  var _endState = turnEndState(m, _mk.flags, text);
  /* 早先这里是 toolsHtml 先算、_endState 后算，于是工具卡拿不到「这一轮被停了」这个事实，
     刷新后一律按 done 染绿。现在把结束态传下去，中断轮的卡才变橙。 */
  var toolsHtml = toolCallsHTML(m.tools, true, _endState ? _endState.label : '');
  /* 正文被中断吃掉、只剩执行记录时，这句不再单独占一行（2026-11-13 用户第 45 条）：
     气泡里上头写「已停止 🕒13s」、底下再写「这一轮没有产出正文（生成被中断），下面只剩执行记录」，
     两处说的是一件事。合并进状态条一句话说完。 */
  var _noBody = !_mkText && !!(toolsHtml || _flags.length);
  if(_noBody && _endState){
    _endState = Object.assign({}, _endState, {label: _endState.label + ' · 这一轮没有产出正文，下面只剩执行记录'});
  }
  var _sbHtml = '';
  if(_endState){
    var _dur = _endState.ms ? '<span class="sb-time">🕒 '+fmtDurMs(_endState.ms)+'</span>' : '';
    _sbHtml = '<div class="msg-statusbar sb-done'+(_endState.alert?' sb-alert':'')+'"'+
      (_endState.hint ? ' title="'+DOM.escAttr(_endState.hint)+'"' : '')+'>'+
      '<span class="sb-icon">'+_endState.icon+'</span>'+
      '<span class="sb-text">'+esc(_endState.label)+'</span>'+_dur+'</div>';
  }
  var msgText = esc(text).replace(/'/g,"\\'").replace(/\n/g,' ');
  var actionsHtml = '<div class="msg-actions">' +
    '<button class="msg-act-btn" onclick="copyMsg(this)" title="复制"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>复制</button>' +
    '<button class="msg-act-btn" onclick="speakMsg(this)" title="语音播放"><svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>播放</button>' +
    '<button class="msg-act-btn" onclick="quoteMsg(this)" title="引用回复"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>引用</button>' +
    '<button class="msg-act-btn" onclick="forkMsg(this)" title="Fork 新话题"><svg viewBox="0 0 24 24"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9"/><path d="M12 12v3"/></svg>Fork</button>' +
    '</div>';
  /* 正文被中断吃掉时别装哑巴（2026-11-13 用户第 33 条）：只剩一排工具卡的气泡，
     看起来就像「你说你干了，可我什么都没看到」。历史渲染能看到 tools/flags
     就说明这一轮真跑过东西，正文空就补一行说明，别让气泡变成空壳。 */
  var _emptyNote = '';
  if(_noBody && !_endState){
    _emptyNote = '<div class="msg-empty-note">这一轮没有产出正文（生成被中断），下面只剩执行记录。</div>';
  }
  /* 2026-11-13 修正：.msg-actions / .msg-meta 必须是 .msg 的直接子节点。
     panel-chat-avatar.css 用 grid 给四个子节点指派格子（bubble=row1 / meta=row2 / actions=row3），
     上一版把两者写进了 .msg-bubble 里，结果 grid-row 全落空、footer 被当成气泡正文的一部分，
     表现为「顺序不对、被包在气泡里面」。结构必须与 user 分支一致。 */
  return '<div class="msg assistant"'+(m.request_id?' data-request-id="'+DOM.escAttr(m.request_id)+'"':'')+(m.ts?' data-ts="'+DOM.escAttr(String(m.ts))+'"':'')+' data-content="'+DOM.escAttr(_mkText).replace(/\n/g,'&#10;')+'"><div class="chat-sender">'+(m.sender||m.persona_name||chatSenderName())+'</div><div class="msg-bubble">'+renderMarkdown(_mkText)+_emptyNote+imgHtml+aFileHtml+_sbHtml+toolsHtml+flagsHTML(_flags)+'</div>'+actionsHtml+'<div class="msg-meta">'+(m.sender||m.persona_name||chatSenderName())+' · '+fmtDateTime(m.ts||m.created_at||Date.now())+'</div></div>';
}

/* 唯一入口。以前这里被 panel-workspace 用 window.msgHTML=... 整个替换掉，
   「谁最后加载谁赢」，改个气泡要翻三个文件才知道哪份在跑。
   现在固定成两步：本文件负责渲染，pwDecorateMsg 只做后处理（头像/身份/时间），
   拿不到就不挂，渲染照样出。 */
function msgHTML(m){
  var html = msgHTMLBase(m);
  if (typeof window.pwDecorateMsg === 'function') {
    try { html = window.pwDecorateMsg(html, m) || html; } catch (e) {}
  }
  return html;
}

/* ── 聊天图片：卡片式堆叠 + 灯箱大图（点击任意卡片查看，←/→ 上下页切换，Esc 关闭）── */
var _lbImgs = [], _lbIdx = 0;
function chatImgSrc(u){
  if(!u) return '';
  if(/^(https?:|data:|blob:)/i.test(u)) return u;
  /* 宿主机绝对路径必须映射到应用前缀，否则 BASE + '/vol1/...' 拼出
     /app/<app>/vol1/@apphome/... 必 404（2026-11-16 生图裂图根因：
     image_generate 返回的是宿主机 data 下的绝对路径，
     面板这里直接当相对路径补前缀，图就全裂了）。
     匹配任意 "<前缀>/data/..."，不认死应用名和卷号。 */
  var m = u.match(/^(?:\/[^\/]+)*\/data(\/.*)$/);
  if(m) u = '/data' + m[1];
  // Session image links survive category changes and archive/restore.
  var artifact = u.replace(/^\/app\/[^\/]+(?=\/data\/)/,'').match(/^\/data\/sessions\/(?:[^/]+\/)+([A-Za-z0-9_-]+)\/artifacts\/([^/?#]+)([?#].*)?$/);
  if(artifact)return BASE+'/api/workspace-ui/session-file/'+artifact[1]+'/artifacts/'+artifact[2]+(artifact[3]||'');
  if(BASE&&u.startsWith(BASE+'/'))return u;
  return BASE + u; // 相对路径（/tmp /uploads /workspace /data）补 BASE 前缀
}
/* 卡片位只有 220px，原图却是 4416×2420 的 1.7 MB PNG —— 切一次会话就要为
   一张缩略图解码几百万像素。磁盘上有同名 `.thumb.webp`（480px，十几 KB）就用它，
   点击看大图仍走原图。远程图和 data/blob 本来就没有本地缩略图，原样返回。 */
function chatThumbSrc(u){
  if(!u) return '';
  if(/^(https?:|data:|blob:)/i.test(u)) return u;
  var full = chatImgSrc(u);
  return /\.thumb\.webp(?:[?#]|$)/i.test(full)?full:full.replace(/\.(png|jpe?g|webp|gif)(?=[?#]|$)/i, '.thumb.webp');
}
/* 缩略图缺失（老图/外部图）时无声回落到原图：用捕获阶段的 error 委托，
   比给每个 <img> 内联 onerror 省事，也不会因为引号转义写坏一个属性。 */
document.addEventListener('error', function(ev){
  var img = ev.target;
  if(!img || img.tagName !== 'IMG') return;
  var full = img.getAttribute('data-full');
  if(full && img.src.indexOf('.thumb.webp') >= 0){ img.removeAttribute('data-full'); img.src = full; }
}, true);
/* 图片高度记忆（2026-11-20）：第一次看到的图没法预知高度，解码完才撑开，那一撑就是「跳」。
   解码过一次就把 真实宽高 记进 localStorage，下次渲染直接用 aspect-ratio 占好位置，
   框在那儿、图后到，高度不变。键取 URL 尾部 120 字，够区分又不会把表撑爆。 */
var _imgDims = (function(){ try{ return JSON.parse(localStorage.getItem('hermes-img-dims')||'{}'); }catch(e){ return {}; } })();
var _imgDimT = null;
function _dimKey(src){
  /* 用「文件名」当键：渲染时拿到的是裸文件名（chatThumbSrc 的结果），
     解码时 img.src 是绝对 URL，两者尾巴都不一样长，必须归一到同一个键。 */
  src = String(src||'').split('?')[0];
  var i = src.lastIndexOf('/');
  return (i >= 0 ? src.slice(i+1) : src).slice(-80);
}
function _dimFor(src){ return _imgDims[_dimKey(src)] || ''; }
function _rememberImgDim(src, w, h){
  if(!src || !w || !h) return;
  var k = _dimKey(src), v = Math.round(w)+'x'+Math.round(h);
  if(_imgDims[k] === v) return;
  _imgDims[k] = v;
  clearTimeout(_imgDimT);
  _imgDimT = setTimeout(function(){ try{ localStorage.setItem('hermes-img-dims', JSON.stringify(_imgDims)); }catch(e){} }, 800);
}
/* 等比框（2026-11-20 用户报「对话里的图片被纵向压缩」）：
   以前是把自然宽高直接写死，再由 CSS 的 max-height:70vh 去裁 —— 裁的只有高度，
   宽度不动，竖图就被压扁（实测 564x718 渲染成 564x630，纵向差 14%）。
   现在先在 JS 里算出「按比例缩到框内」的尺寸，写进去的宽高本身就是等比的，
   CSS 的 max-* 永远不生效，也就不会裁掉高度。 */
function _imgViewportCap(){
  /* base.css 里手机端 max-height 是 44vh，桌面 70vh，跟着走 */
  return (window.innerWidth <= 768 ? 0.44 : 0.7) * window.innerHeight;
}
function _fitDims(w, h, maxW, maxH){
  if(!w || !h || !(maxW > 0)) return null;
  var s = Math.min(1, maxW / w, maxH / h);
  if(!(s > 0)) return null;
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}
function _imgSizing(src){
  var d = _dimFor(src); if(!d) return '';
  var p = d.split('x'), fit = _fitDims(+p[0], +p[1], 220, 220);
  if(!fit) return '';
  return 'width:'+fit[0]+'px;height:'+fit[1]+'px;aspect-ratio:'+p[0]+'/'+p[1]+';';
}
/* 首屏前先量尺寸（2026-11-20）：服务端消息里只有文件名、没有宽高，
   第一次打开这个会话时浏览器只能等图解码才知道多高 —— 那就是「第一次加载还是跳」。
   渲染前把没量过的缩略图用离屏 Image 先量一遍（最多 40 张、最多等 800ms），
   量到就把框占好再画，画面从第一帧起就不动。 */
var _dimTried = {};
function _msgImgUrls(m){
  /* 图片不是独立字段：贴纸/图片是正文里的 markdown，老附件走 splitContent。
     两条都要扒，否则量尺寸的量一批、渲染的渲染另一批，等于白量。 */
  var out = [], c = (m && m.content) || '', re = /!\[[^\]]*\]\(([^)\s]+)\)/g, mm;
  while((mm = re.exec(c))) { if(mm[1]) out.push(mm[1]); }
  try{
    var p = splitContent(c);
    (p.images || []).forEach(function(u){ if(u) out.push(chatThumbSrc(u)); });
  }catch(e){}
  var seen = {}, uniq = [];
  out.forEach(function(u){ if(u && !seen[u]){ seen[u] = 1; uniq.push(u); } });
  return uniq;
}
/* 正文里的图片（不是头像、不是表情）把尺寸先写死：max-width 是 none 的说明它有自己的 CSS，
   一律不碰——头像 40px、表情 40px 都靠类名，给它们塞 220px 会把气泡撑爆。 */
function _applyImgSizing(root){
  if(!root || !root.querySelectorAll) return;
  var imgs = root.querySelectorAll('img');
  for(var i = 0; i < imgs.length; i++){
    var im = imgs[i];
    if(im.getAttribute('data-sized')) continue;
    var d = _dimFor(im.getAttribute('src') || '');
    if(!d) continue;
    var cs = window.getComputedStyle(im);
    if(!cs || cs.maxWidth === 'none') continue;
    var q = d.split('x');
    /* 容器宽度要现取：气泡在侧栏展开/窗口缩放时会变，写死就会漏出边界或压扁 */
    var host = im.parentElement, maxW = host ? host.clientWidth : 0;
    if(!maxW) maxW = Math.min(window.innerWidth - 80, 720);
    var fit = _fitDims(+q[0], +q[1], maxW, _imgViewportCap());
    if(!fit) continue;
    im.style.width = fit[0] + 'px'; im.style.height = fit[1] + 'px';
    im.style.aspectRatio = q[0] + ' / ' + q[1];
    /* 兜底：真被 max-* 卡到时用 contain 留白，绝不拉变形 */
    im.style.objectFit = 'contain';
    im.setAttribute('data-sized', '1');
  }
}
function _prefetchDims(urls, budget){
  return new Promise(function(res){
    var left = urls.length, done = false;
    var timer = setTimeout(fin, budget);
    function fin(){ if(done) return; done = true; clearTimeout(timer); res(); }
    urls.forEach(function(u){
      var im = new Image();
      im.onload = function(){ _rememberImgDim(u, im.naturalWidth, im.naturalHeight); if(--left <= 0) fin(); };
      im.onerror = function(){ if(--left <= 0) fin(); };
      im.src = u;
    });
  });
}
function imgStackHTML(imgs){
  if(!imgs || !imgs.length) return '';
  var list = imgs.map(chatImgSrc);
  var arg = esc(JSON.stringify(list));
  if(list.length === 1){
    return '<img src="'+DOM.escAttr(chatThumbSrc(imgs[0]))+'" data-full="'+DOM.escAttr(list[0])+'" alt="图片" loading="lazy" style="'+_imgSizing(chatThumbSrc(imgs[0]))+'max-width:220px;max-height:220px;border-radius:var(--radius-md);display:block;margin-top:6px;cursor:zoom-in;object-fit:cover" onclick="openImgLightbox(\''+arg+'\',0)">';
  }
  var n = Math.min(list.length, 5);
  var off = 9;
  var html = '<div class="img-stack" style="width:'+(150+(n-1)*off)+'px;height:'+(150+(n-1)*off)+'px" onclick="openImgLightbox(\''+arg+'\',0)" title="点击查看 '+list.length+' 张图片">';
  for(var i=0;i<n;i++){
    html += '<img class="img-stack-item" src="'+DOM.escAttr(chatThumbSrc(imgs[i]))+'" data-full="'+DOM.escAttr(list[i])+'" alt="图片'+(i+1)+'" loading="lazy" style="left:'+(i*off)+'px;top:'+(i*off)+'px;z-index:'+(i+1)+'">';
  }
  /* 2026-11-18（用户手机实测「对话视图格式很怪」）：这张角标原来写成
     left:(n-1)*9+156px —— 容器总宽就是 150+(n-1)*9，156 已经越过右边界，
     整个「2 张 ▸」被甩到气泡外面，手机上一眼就是「一个孤零零的标签贴着气泡」。
     改成压在最后一张图右下角（容器内部），不再溢出。 */
  html += '<span style="position:absolute;right:6px;bottom:6px;font-size:11px;color:#fff;background:rgba(0,0,0,.55);border-radius:12px;padding:2px 9px;font-weight:600;z-index:'+(n+1)+';pointer-events:none">'+list.length+' 张 ▸</span></div>';
  return html;
}
function openImgLightbox(jsonList, idx){
  var arr = [];
  try { arr = JSON.parse(jsonList); } catch(e){ return; }
  if(!arr.length) return;
  _lbImgs = arr;
  _lbIdx = Math.max(0, Math.min(idx||0, arr.length-1));
  renderImgLightbox();
}
function renderImgLightbox(){
  var o = document.getElementById('imgLightbox');
  if(!o){
    o = document.createElement('div');
    o.id = 'imgLightbox';
    o.innerHTML = '<div class="lb-bg" onclick="closeImgLightbox()"></div>' +
      '<button class="lb-btn lb-close" onclick="closeImgLightbox()" title="关闭 (Esc)">✕</button>' +
      '<button class="lb-btn lb-prev" onclick="imgLbNav(-1)" title="上一张 (←)">‹</button>' +
      '<button class="lb-btn lb-next" onclick="imgLbNav(1)" title="下一张 (→)">›</button>' +
      '<div class="lb-count"></div>' +
      '<img class="lb-img" alt="大图预览">';
    document.body.appendChild(o);
  }
  o.querySelector('.lb-img').src = _lbImgs[_lbIdx];
  o.querySelector('.lb-count').textContent = (_lbIdx+1) + ' / ' + _lbImgs.length;
  o.style.display = 'flex';
  // 预载相邻图片，翻页不闪烁
  [1,-1].forEach(function(d){
    var i = _lbIdx + d;
    if(i>=0 && i<_lbImgs.length){ var im = new Image(); im.src = _lbImgs[i]; }
  });
}
function imgLbNav(d){
  if(!_lbImgs.length) return;
  _lbIdx = (_lbIdx + d + _lbImgs.length) % _lbImgs.length;
  renderImgLightbox();
}
function closeImgLightbox(){
  var o = document.getElementById('imgLightbox');
  if(o) o.style.display = 'none';
}
/* 消息内 Markdown 图片点击放大：复用 imgLightbox，同一条消息里的图可左右翻 */
document.addEventListener('click', function(e){
  var t = e.target;
  if(!t || t.tagName !== 'IMG') return;
  var bubble = t.closest && t.closest('.msg-bubble');
  if(!bubble) return;
  var imgs = Array.prototype.slice.call(bubble.querySelectorAll('img'));
  if(!imgs.length) return;
  var srcs = imgs.map(function(im){ return im.getAttribute('src'); });
  var idx = imgs.indexOf(t);
  openImgLightbox(JSON.stringify(srcs), idx < 0 ? 0 : idx);
});
document.addEventListener('keydown', function(e){
  var o = document.getElementById('imgLightbox');
  if(!o || o.style.display==='none') return;
  if(e.key==='Escape') closeImgLightbox();
  else if(e.key==='ArrowLeft'||e.key==='ArrowUp') imgLbNav(-1);
  else if(e.key==='ArrowRight'||e.key==='ArrowDown') imgLbNav(1);
});

/* 工具调用映射（对齐 Hermes 消息网关规范：terminal=💻 / web=🔍 / execute_code=🐍 等） */
var TOOL_EMOJI = {
  terminal: '💻', execute_code: '🐍', run_code: '🐍',
  read_file: '📄', write_file: '📝', edit_file: '✏️',
  search_files: '🔎', web: '🔍', web_search: '🔍', web_extract: '📄',
  delegate_task: '🤖', delegation: '🤖', session_search: '💬',
  browser: '🌐', image_gen: '🎨', file_ops: '📂', memory: '🧠',
  shell: '💻', bash: '💻', cmd: '💻',
};
var TOOL_NAME_ZH = {
  terminal: '终端命令', execute_code: '执行代码', run_code: '执行代码',
  read_file: '读取文件', write_file: '写入文件', edit_file: '编辑文件',
  search_files: '搜索文件', web: '网页搜索', web_search: '网页搜索', web_extract: '网页提取',
  delegate_task: '委派任务', delegation: '委派任务', session_search: '会话搜索',
  browser: '浏览器', image_gen: '图像生成', file_ops: '文件操作', memory: '记忆',
  shell: '终端命令', bash: '终端命令', cmd: '终端命令',
};
/* 工具类型 → 生成状态条（图标 mode / 文案）映射：对齐 hermes 0.20 全部内置工具
 * 规则按顺序匹配，先具体后宽泛；未知工具回退「正在调用 XX…」 */
var GEN_TOOL_STATES = [
  { re: /delegate_task|delegation|agent/i,            icon: 'agent',  text: '正在调用 Agent…' },
  { re: /execute_code|run_code|terminal|shell|bash|cmd|patch|python|jupyter|process|close_terminal|read_terminal|computer_use/i, icon: 'writing', text: '正在写代码…' },
  { re: /image_generate|image_gen/i,                  icon: 'image',  text: '正在生成图片…' },
  { re: /video_generate|video_edit|video_extend|flux/i, icon: 'video', text: '正在生成视频…' },
  { re: /vision_analyze|video_analyze|text_to_speech|tts|transcrib/i, icon: 'media', text: '正在处理媒体…' },
  { re: /web_search|^web$|search_files|session_search|search/i, icon: 'search', text: '正在搜索…' },
  { re: /web_extract|read_file|read_extract/i,        icon: 'extract', text: '正在读取内容…' },
  { re: /browser/i,                                   icon: 'browse', text: '正在浏览网页…' },
  { re: /write_file|edit_file|file_ops|file/i,        icon: 'file',   text: '正在处理文件…' },
  { re: /memory/i,                                    icon: 'memory', text: '正在读写记忆…' },
  { re: /skill/i,                                     icon: 'skill',  text: '正在调用技能…' },
  { re: /cronjob|todo|kanban/i,                       icon: 'task',   text: '正在处理任务…' },
  { re: /^ha_/i,                                      icon: 'home',   text: '正在控制设备…' },
  { re: /clarify/i,                                   icon: 'ask',    text: '正在向你确认…' },
  { re: /feishu|discord|react_to_message|send_message|remove_reaction|yuanbao|^yb_/i, icon: 'chat', text: '正在处理消息…' },
];
function genToolState(tool){
  var t = String(tool || '');
  for(var i=0;i<GEN_TOOL_STATES.length;i++){
    var m = GEN_TOOL_STATES[i];
    if(m.re.test(t)) return m;
  }
  return { icon:'tool', text:'正在调用 '+(TOOL_NAME_ZH[tool] || tool || '工具')+'…' };
}
function isToolDone(status){
  return status==='done'||status==='completed'||status==='finish'||status==='finished';
}

/* ── 折叠门面（2026-11-13 第 39 条）：真实实现已迁到 js/chat/toolcard.js
   ────────────────────────────────────────────────────────────────────────
   旧版在这里维护「盒子开着没 / 每张卡开着没」的一套私有状态，另在 document 上
   挂 capture 监听、durable 侧再存一份，一次点击被两次翻转抵掉 —— 用户实测
   「展开要点两下才能关闭」「三角小」。现在开合交给浏览器原生 <details>，
   这里只留旧调用点（compose.js / panel-durable.js）还能用的门面。 */
var ToolUI = (function(){
  function paint(box){ if(window.ToolCard) ToolCard.paint(box); }
  function paintAll(root){ if(window.ToolCard && root) ToolCard.paint(root); }
  function toggleBox(box){ if(box) box.open = !box.open; }
  function toggleCard(head){
    var box = head && head.parentNode;
    if(box && box.tagName==='DETAILS') box.open = !box.open;
  }
  function forget(){}
  function defaultClosed(box){
    if(!box || !window.ToolCard) return;
    var k = box.getAttribute && box.getAttribute('data-box');
    if(k && ToolCard.state.box[k]===undefined) box.open = false;
  }
  return { paint:paint, paintAll:paintAll, toggleBox:toggleBox, toggleCard:toggleCard, forget:forget, defaultClosed:defaultClosed };
})();
window.ToolUI = ToolUI;

function toolCardHTML(tp, hist){
  /* 2026-11-13 第 39 条：markup 全部迁到 js/chat/toolcard.js（原生 <details>），
     这里只做转发，「历史」与「流式」从此共用一份实现。 */
  return (window.ToolCard ? ToolCard.cardHTML(tp, hist) : '');
}
function toolCallsHTML(tools, hist, turn){
  if(!tools || !tools.length) return '';
  if(window.panelToolsMode && panelToolsMode()==='hidden') return '';   // 设置：隐藏工具调用区
  return (window.ToolCard ? ToolCard.groupHTML(tools, hist, null, turn) : '');
}
function toggleToolCalls(box){ if(window.ToolUI) ToolUI.toggleBox(box); }
/* 单张工具卡的开关（2026-11-13 重写）
   以前这里既写 class 又写 data-user-collapse，body 上还有一个 capture 监听也在写，
   durable 侧再存一份 open Set —— 三处各记一份，谁后写谁赢。
   现在只调 ToolUI：状态挂在盒子上，paint 是唯一出口。 */
function toolHeadToggle(head){ if(window.ToolUI) ToolUI.toggleCard(head); }
window.toolHeadToggle = toolHeadToggle;
/* 回到底部按钮（Issue #10） */
function copyMsg(btn){
  var msg = btn.closest('.msg');
  if(!msg) return;
  var text = msg.getAttribute('data-content') || msg.textContent || '';
  text = text.replace(/&#10;/g,'\n').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/<br\s*\/?>/gi,'\n');
  function done(){ var old=btn.innerHTML; btn.innerHTML='✓'; setTimeout(function(){ btn.innerHTML=old; }, 1200); }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done).catch(function(){
      try{ var ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done(); }catch(e){}
    });
  } else {
    try{ var ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done(); }catch(e){}
  }
}
/* ── 滚动跟随：唯一判据「现在是不是贴着底部」（2026-11-13 第 39 条整体重写）
   ─────────────────────────────────────────────────────────────────────────
   用户原话：只有滚动到底部才触发自动跟随；消息已经停止、没有变化，不该自己跳。

   旧实现违反这条：它维护 inputAt 时间窗、downSince 像素阈值、suppressUntil 抑制窗口，
   还在 MutationObserver 里监听 class/style 变化 —— 于是「点开一张工具卡」这种不改文字、
   只改属性的动作也会触发 followChatBottom()，画面被拽到底部，用户看到的就是
   「消息明明静止，自己往下跳」。

   新逻辑只有一条式子：
     _follow ← 用户最后一次滚动之后，是否还有 ≤8px 就到底
     内容长高时 _follow 为真才跟，否则一个像素都不动；属性变化一律不跟。
   scroll 事件每次都按几何位置重算 _follow，所以程序自己拉到底部不会误判成「用户意图」：
   拉完就在底部 → _follow 自然还是 true。没有必要再设抑制窗口。 */
var _follow = true;
var _chatScroll = { body:null, lastTop:0, frame:0 };
function autoScrollActive(){ return _follow; }
function chatAtBottom(body){ return body.scrollHeight - body.clientHeight - body.scrollTop <= 24; }
function hideScrollBtn(){ var b=document.getElementById('chatJumpBottom'); if(b) b.hidden=true; }
function positionChatJump(){
  var body=_chatScroll.body, button=document.getElementById('chatJumpBottom');
  if(!body || !button) return;
  /* 2026-11-16：输入框是浮层，按钮原来按 body 底边 -52 定位就正好压在输入框底下了。
     往上再让一个输入框高度，落在消息区可见底部之上。 */
  /* 52 是按钮离消息区底边的距离；再往上让 8px，别跟浮起的输入框贴成 0 间隙（实测正好贴住）。 */
  button.style.top=(body.offsetTop + body.clientHeight - 60 - composerH())+'px';
}
function showScrollBtn(){
  var body=_chatScroll.body, b=document.getElementById('chatJumpBottom');
  if(!body || !b) return;
  positionChatJump(); b.hidden=false;
}
/* 手指在屏幕上时，任何自动贴底都停手（2026-11-20 第三次校准）。
   真机抓包里 chatBody 在高度完全不变的一段里 ±400px 来回摆，页面上别的容器一动不动 ——
   这个形状是「iOS 回弹 + 我们贴底」在抢同一个滚动条：在底部继续上滑时 iOS 先给出
   scrollTop > max 的回弹值，`scrollHeight-clientHeight-scrollTop` 仍 ≤8 → _follow 又变 true
   → 下一帧被拉回底部 → 手指再拽上去，来回一次就是一屏闪动。
   桌面无头浏览器没有回弹，所以复现不出来，只能按形状定规矩：用户手在动，就不许自动滚。 */
var _touchActive = false, _touchUntil = 0, _lastScrollAt = 0;
var _blockedWrites = [];   /* 手指在屏上时被闸掉的滚动写入，随探针回传 */
function userBusy(){
  return _touchActive || (Date.now() < _touchUntil);
}
function followChatBottom(){
  var body=document.getElementById('chatBody');
  if(!body || !_follow || userBusy()) return;
  body.scrollTop=body.scrollHeight;
  _chatScroll.lastTop=body.scrollTop;
  hideScrollBtn();
}
var _settleUntil = 0, _settleT = null;
function _settleFollow(){
  clearTimeout(_settleT);
  _settleT = setTimeout(function(){ if(_follow) followChatBottom(); }, 260);
}
function scheduleChatFollow(){
  if(_chatScroll.frame) return;
  _chatScroll.frame=requestAnimationFrame(function(){
    _chatScroll.frame=0;
    positionChatJump();
    followChatBottom();
  });
}
function scrollChatToBottom(){
  _follow=true;
  followChatBottom();
}
function pauseChatFollow(){ _follow=false; }
function initChatScroll(){
  var body=document.getElementById('chatBody');
  if(!body || _chatScroll.body===body) return;
  _chatScroll.body=body;
  _chatScroll.lastTop=body.scrollTop;
  _follow=chatAtBottom(body);
  try{ body.style.overflowAnchor = _follow ? 'none' : 'auto'; }catch(e){}
  /* 唯一的「用户意图」来源：主容器自己的 scroll 事件。内层滚动（工具结果、代码块）
     的 scroll 不会冒泡到 body 的 target 判定里，因此天然不影响跟随。 */
  body.addEventListener('touchstart',function(){
    _touchActive=true; _touchUntil=Date.now()+1200;
    body.style.overflowAnchor='none';   /* 手指按着的时候也不许浏览器自己补偿位置 */
  },{passive:true});
  /* 手指在屏上时，谁都不许改滚动位置（2026-11-20 第五次校准）。
     前四轮都在改「改成什么位置」，用户那句一直是「我手指放在那里他都往上跳」——
     说明问题不是落点算得对不对，而是根本不该动。这里在 chatBody 上装一道闸：
     _touchActive 期间任何 scrollTop/scrollTo/scrollBy/scrollIntoView 一律丢弃并记账，
     账本挂在 window.__scrollBlocked，随真机探针一起回传，下次复现就能指名谁想动它。 */
  (function installScrollWriteGate(){
    var _b=document.getElementById('chatBody');
    if(!_b || _b.__writeGate) return;
    _b.__writeGate=true;
    /* scrollTop 定义在 Element.prototype 上，不是 HTMLDivElement.prototype ——
       只查一层原型拿不到描述符，闸门会静默不装（实测第一次就是这么白装的）。 */
    var _d=null,_p=Object.getPrototypeOf(_b);
    while(_p && !_d){ _d=Object.getOwnPropertyDescriptor(_p,'scrollTop'); _p=Object.getPrototypeOf(_p); }
    if(!_d || !_d.set){ window.__gateErr='no-scrollTop-descriptor'; return; }
    function note(api,to,cur){
      try{
        var st=''; try{ throw new Error('x'); }catch(e){ st=((e.stack||'').split('\n')[2]||'').trim(); }
        if(_blockedWrites.length>=20) _blockedWrites.shift();
        _blockedWrites.push({api:api,to:Math.round(to||0),cur:Math.round(cur||0),at:Date.now(),st:st.slice(0,150)});
        window.__scrollBlocked=_blockedWrites;
      }catch(e){}
    }
    Object.defineProperty(_b,'scrollTop',{
      configurable:true, enumerable:true,
      get:function(){ return _d.get.call(_b); },
      set:function(v){
        var cur=_d.get.call(_b);
        if(_touchActive && Math.abs(v-cur)>2){ note('scrollTop',v,cur); return; }
        _d.set.call(_b,v);
      }
    });
    ['scrollTo','scrollBy'].forEach(function(m){
      var orig=_b[m]&&_b[m].bind(_b); if(!orig) return;
      _b[m]=function(){
        if(_touchActive){ note(m,(arguments[1]!==undefined?arguments[1]:arguments[0]),_d.get.call(_b)); return; }
        return orig.apply(null,arguments);
      };
    });
    var sii=_b.scrollIntoView&&_b.scrollIntoView.bind(_b);
    if(sii) _b.scrollIntoView=function(){ if(_touchActive){ note('scrollIntoView',0,_d.get.call(_b)); return; } return sii.apply(null,arguments); };
  })();
  function endTouch(){
    _touchActive=false; _touchUntil=Date.now()+400;
    body.style.overflowAnchor = _follow ? 'none' : 'auto';
    /* 松手后确实停在底部 → 恢复自动跟随，不然流式回复再也不跟着走了 */
    setTimeout(function(){ if(!_touchActive && body && chatAtBottom(body)) _follow=true; },430);
  }
  body.addEventListener('touchend',endTouch,{passive:true});
  body.addEventListener('touchcancel',endTouch,{passive:true});
  body.addEventListener('scroll',function(e){
    if(e.target!==body) return;
    _chatScroll.lastTop=body.scrollTop;
    _lastScrollAt=Date.now();
    /* 滚到顶附近自动往前取一页（2026-11-20 窗口化）。取数中是 _winBusy 挡着，不会连发。 */
    if(body.scrollTop < 120 && (_winFrom[currentSession]||0) > 0) loadOlderMessages(currentSession);
    var at=chatAtBottom(body);
    /* 回弹期间不认「到底了」：手还在动的时候 at 会反复为 true，认了就是抢滚动。
       松手 400ms 后如果确实停在底部，下一次滚动/渲染自然会把它设回 true。 */
    _follow = at && !userBusy();
    /* 2026-11-20 闪动根因：Safari 的滚动锚定（overflow-anchor 默认 auto）和我们的
       「贴底跟随」抢同一件事 —— 一张图解码出来把高度顶高 239px，锚定先把 scrollTop
       往回拽 239，下一帧我们又设回底部，来回拉几次就是用户说的「上下闪、闪七八秒」。
       贴底时关掉锚定，由我们独占；在读历史时（_follow=false）重新打开，让浏览器
       自己保住阅读位置，不用我们算。 */
    body.style.overflowAnchor = at ? 'none' : 'auto';
    if(at){ hideScrollBtn(); _pushRead(); } else showScrollBtn();
  },{passive:true});
  /* 只有「内容真的长出来」才跟：流式追加的文字、新挂上去的节点。
     展开一张工具卡改的是几何、不是内容，但 ResizeObserver 分不出来，
     于是你点开的那张卡被自己撑高的 199px 顶出视口 —— 你看到的「闪一下」就是它。
     （2026-11-13 第 41 条实测：贴底 scrollTop 2014 → 点开 → 2213，卡顶 -1670 → -1869。）
     所以 ResizeObserver 整个删掉，跟随只看 childList 的新增节点与 characterData。 */
  new MutationObserver(function(records){
    for(var i=0;i<records.length;i++){
      var r=records[i];
      if(r.type==='characterData'){ scheduleChatFollow(); return; }
      if(r.addedNodes && r.addedNodes.length){ scheduleChatFollow(); return; }
    }
  }).observe(body,{childList:true,subtree:true,characterData:true});
  /* 图片解码完就立刻贴底，不等下一帧：真机抓到的序列是「高度 +239 → 视口先上移 233
     → 再一帧一帧爬回底部」，每张图一次，16 张图正好闪七秒多。同步贴底能把这中间的
     位移压到同一帧里，看得见的高度变化只剩图片本身出现那一下。 */
  body.addEventListener('load',function(e){
    /* 189 张图各写一次 scrollTop 就是那条「图片解码完一档档往上跳」的阶梯（2026-11-20）。
       合并到一帧里只贴一次，中间过程根本不进屏。 */
    var t=e.target;
    if(!t || t.tagName!=='IMG'){ scheduleChatFollow(); return; }
    _rememberImgDim(t.currentSrc || t.src, t.naturalWidth, t.naturalHeight);
    /* 首屏沉降期：图一张张到、高度一档档长，这时候每来一张就贴一次底 = 连续往上抽。
       改成「安静 260ms 再贴一次」，整段加载只动最后那一下。 */
    if(!_follow) return;
    if(Date.now() < _settleUntil) _settleFollow();
    else scheduleChatFollow();
  },true);
  window.addEventListener('resize',scheduleChatFollow);
  /* 窗口/侧栏一变，已占好位的图要按新宽度重算，否则等比框会漏出边界（2026-11-20） */
  var _imgRsT = null;
  window.addEventListener('resize', function(){
    clearTimeout(_imgRsT);
    _imgRsT = setTimeout(function(){
      if(!body) return;
      var sized = body.querySelectorAll('img[data-sized]');
      for(var i=0;i<sized.length;i++){ sized[i].removeAttribute('data-sized'); sized[i].style.width=''; sized[i].style.height=''; }
      _applyImgSizing(body);
    }, 180);
  });
  scheduleChatFollow();
  watchComposerHeight();
}

/* ── 输入框让位（2026-11-16 用户第 42 条） ────────────────────────────
   原话：「现在最下面的气泡会被遮盖，滚动到最下方你看怎么处理一下多滚动一下，
           往上走点不要让输入框盖住气泡」。

   根因是布局：输入框改成绝对定位浮层之后就不吃文档流了，#chatBody 一路撑到
   容器底部，最后一条气泡正好落在浮层底下 —— 滚到底 = scrollTop 拉满，
   而可视区底部那 100 多像素被浮层占着，看上去就是「盖住了」。

   解法不是改滚动算法，是让消息区自己在底部留出这段高度：
   把输入框实测高度写进 --composer-h，CSS 用它算 #chatBody 的 padding-bottom。
   留白算在 scrollHeight 里，所以 scrollTop 拉满时最后一条气泡自然停在浮层上方，
   chatAtBottom() 的 8px 判据也依然成立（滚到底确实就是到底）。

   为什么要 ResizeObserver 而不是初始化量一次：textarea 随行数长高（上限 140px）、
   工具条展开收起、切会话时 chips 增减，高度都会变。量一次就是刻舟求剑。 */
function composerH(){
  var w=document.getElementById('chatComposer');
  return w ? (w.offsetHeight||0) : 0;
}
/* 取「输入框浮层里最靠上的可见块」。浮层 #composerOverlays 是附件条 + 能力 chip +
   技能 chip 的 flex 列，谁在最上面不固定（附件条只在有附件时才出现），所以只量
   chip 顶会让附件条压住最后一条气泡里的按钮（2026-11-18）。这里先取第一个有高度的
   子元素，没有再退回能力 chip / 技能 chip。 */
function firstComposerOverlay(){
  var ov=document.getElementById('composerOverlays');
  if(ov){
    for(var i=0;i<ov.children.length;i++){ if(ov.children[i].offsetHeight) return ov.children[i]; }
  }
  var chips=document.getElementById('capabilityChips');
  if(chips && chips.offsetHeight) return chips;
  var all=document.querySelectorAll('.skill-chips');
  for(var j=0;j<all.length;j++){ if(all[j].offsetHeight) return all[j]; }
  return null;
}
function watchComposerHeight(){
  var wrap=document.getElementById('chatComposer');
  if(!wrap) return;
  /* 高度动画与留白已解耦（2026-11-21 第三轮）：toolbar 的 height/margin 改为瞬时切换、
     transform/opacity 走合成层，wrap.offsetHeight 只在切换瞬间变一次，ResizeObserver
     只触发一次、写一次 --composer-h。不再需要过渡期冻结。 */
  /* measure() 是「该写多少」的唯一来源：wrap 高度与浮层跨度取大。
     2026-11-17：能力 chip 挂在输入框外的 .input-outer 里、绝对定位贴在框上沿，
     不属于 #chatComposer 的子节点（原写法 wrap.querySelector 永远是 null），
     也不算进 offsetHeight，于是留白少了整整一行，最后一条气泡里的按钮被 chip 盖住。
     直接量「chip 顶端 → 输入框底端」的真实跨度，比累加各自高度准（还含中间的间距）。

     抽出来是因为 settle() 必须拿它判断收敛：早先 settle 只看 wrap.offsetHeight，
     判稳在 112px，写下去的时候浮层跨度已经到 113px，于是白多一次写入。 */
  var measure=function(){
    var h=wrap.offsetHeight||0;
    if(!h) return 0;
    var topEl=firstComposerOverlay();
    if(topEl){
      var cr=topEl.getBoundingClientRect(), wr=wrap.getBoundingClientRect();
      var span=Math.round(wr.bottom-cr.top);
      if(span>h) h=span;
    }
    return h;
  };
  var apply=function(){
    if(!measure()) return;               /* 画板/隐藏态读到 0，跳过别把留白写成 0 */
    applyNow();
  };
  var applyNow=function(){
    var h=measure();
    if(!h) return;
    var cur=document.documentElement.style.getPropertyValue('--composer-h');
    if(cur===h+'px') return;
    document.documentElement.style.setProperty('--composer-h',h+'px');
    /* 高度变了而用户正贴着底部 → 重新贴一次，否则留白变化会把气泡顶出视野 */
    if(_follow) scheduleChatFollow();
  };
  if(window.ResizeObserver) new ResizeObserver(apply).observe(wrap);
  window.addEventListener('resize',apply);
  /* chip 是绝对定位、重建在 #capabilityChips 里，不会改变上面的 wrap 高度，
     ResizeObserver 收不到通知 —— 必须由 renderChips() 反过来喊一声。
     这条不是动画，不该冻结：chip 增减是离散事件，写一次就够，包一层拆冻。 */
  window.__recalcComposerH=apply;
  apply();
}

/* ── 侧边栏搜索过滤：按关键词实时过滤专家分组与会话（不重建 DOM，仅显隐）── */
function filterRail(kw){
  kw = (kw||'').trim().toLowerCase();
  var rail = document.getElementById('railScroll');
  if(!rail) return;
  if(!kw){
    rail.querySelectorAll('.agent-group').forEach(function(g){ g.style.display=''; });
    rail.querySelectorAll('.session-item').forEach(function(s){ s.style.display=''; });
    rail.querySelectorAll('.rail-divider').forEach(function(d){ d.style.display=''; });
    return;
  }
  var any = false;
  rail.querySelectorAll('.agent-group').forEach(function(g){
    var nameEl = g.querySelector('.agent-row .name');
    var groupMatch = nameEl && nameEl.textContent && nameEl.textContent.toLowerCase().indexOf(kw) >= 0;
    var sessMatch = false;
    g.querySelectorAll('.session-item').forEach(function(s){
      var t = ((s.querySelector('.title')||{}).textContent || '') + ' ' + ((s.querySelector('.sess-preview')||{}).textContent || '') + ' ' + ((s.querySelector('.sess-time')||{}).textContent || '');
      var m = t.toLowerCase().indexOf(kw) >= 0;
      s.style.display = m ? '' : 'none';
      if(m) sessMatch = true;
    });
    g.style.display = (groupMatch || sessMatch) ? '' : 'none';
    if(g.style.display !== 'none') any = true;
  });
  rail.querySelectorAll('.rail-divider').forEach(function(d){ d.style.display = any ? '' : 'none'; });
}

/* ── 会话切换单层收口 ────────────────────────────────────────────────
   渠道记录预览态是 panel-workspace 的功能，它以前用 window.switchTab=…
   /window.openTab=… /window.newTab=… 三个覆盖去拦，加上 sendRaw 共四处。
   覆盖谁后加载谁赢，排查时得先数加载顺序。
   现在基础实现改成 *Core，这里只留一层外壳，接口是 window.chatChannel：
   { active, leave(), afterSwitch(id) }。没有这个对象时行为与原来完全一致。 */
function switchTab(sid){
  var ch = window.chatChannel, was = ch ? !!ch.active : false;
  if (ch) ch.leave();
  var r = switchTabCore(sid);
  if (was && ch) {ch.afterSwitch(sid); window.dispatchEvent(new Event('panel-session-changed'));}
  return r;
}
function openTab(sid){
  var ch = window.chatChannel, was = ch ? !!ch.active : false;
  if (ch) ch.leave();
  var r = openTabCore(sid);
  if (was && ch) {ch.afterSwitch(sid); window.dispatchEvent(new Event('panel-session-changed'));}
  return r;
}
function newTab(){
  var ch = window.chatChannel;
  if (ch) ch.leave();
  return newTabCore();
}

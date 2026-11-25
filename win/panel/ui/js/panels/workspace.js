/* 工作区面板 + 文件管理器
 * 来源：index.html 内联 app.js 第 2092-2196 行（共 105 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ 工作区面板 ============================ */
function syncWorkspaceEdge(){
  var panel=document.getElementById('workspacePanel');
  var chat=panel.parentElement, header=chat.querySelector('.chat-header'), tabs=chat.querySelector('.session-tabs');
  var edge=tabs.classList.contains('visible')?tabs:header;
  panel.style.setProperty('--ws-top',Math.max(0,edge.getBoundingClientRect().bottom-chat.getBoundingClientRect().top)+'px');
}
{
  let chat=document.getElementById('page-chat');
  if(chat){
    let observer=new ResizeObserver(syncWorkspaceEdge);
    for(let element of chat.querySelectorAll('.chat-header, .session-tabs')) observer.observe(element);
  }
}
function toggleWorkspace(){
  var panel=document.getElementById('workspacePanel');
  if(!panel) return;
  panel.classList.toggle('open');
  var btn=document.getElementById('wsPanelToggle');
  if(btn) btn.classList.toggle('active', panel.classList.contains('open'));
  if(panel.classList.contains('open')){
    syncWorkspaceEdge();
    if(panel.querySelector('#ws-files.active')) fmRefresh();
    else if(panel.querySelector('#ws-outline.active')) loadOutline();
  }
}
function wsSwitchTab(btn, key){
  document.querySelectorAll('.ws-tab').forEach(function(t){ t.classList.remove('active'); });
  btn.classList.add('active');
  document.querySelectorAll('.ws-pane').forEach(function(p){ p.classList.remove('active'); });
  var pane=document.getElementById('ws-'+key); if(pane) pane.classList.add('active');
  if(key==='files') fmRefresh();
  if(key==='outline') loadOutline();
}

/* ── 会话大纲 + 记忆面板（右侧工作区）──
   拉取当前会话全部消息，提取用户问题为大纲要点；点击要点滚动定位到聊天区对应消息。
   记忆区展示当前 MEMORY/USER 摘要（截断预览）。 */
function loadOutline(){
  var wrap = document.getElementById('wsOutlineContent');
  if(!wrap) return;
  var sid = currentSession;
  if(!sid){ wrap.innerHTML = '<div class="empty-state">暂无会话</div>'; return; }
  wrap.innerHTML = '<div class="empty-state" style="opacity:.6">加载大纲…</div>';
  return fetch(apiUrl('/api/sessions/'+encodeURIComponent(sid)), { cache:'no-store', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(s){
      var msgs = (s && s.messages) || [];
      if(!msgs.length){ wrap.innerHTML = '<div class="empty-state">发送消息后自动生成大纲</div>'; return; }
      var html = '';
      var uMsgs = msgs.filter(function(m){ return m.role==='user'; });
      var aMsgs = msgs.filter(function(m){ return m.role==='assistant'; });
      var toolN = 0;
      msgs.forEach(function(m){ if(m.tools && m.tools.length) toolN += m.tools.length; });
      html += '<div class="ws-outline-summary" style="padding:10px 4px 8px;border-bottom:1px solid var(--border);margin-bottom:8px;font-size:12px;color:var(--text3);line-height:1.7">' +
        '<div>💬 用户提问 <b>'+uMsgs.length+'</b> 条 · 回复 <b>'+aMsgs.length+'</b> 条 · 工具调用 <b>'+toolN+'</b> 次</div></div>';
      var idx = 0;
      msgs.forEach(function(m){
        if(m.role !== 'user') return;
        var text = '';
        if(typeof m.content === 'string') text = m.content;
        else if(Array.isArray(m.content)) text = m.content.map(function(p){ return (p&&p.text)||''; }).join(' ');
        text = (text||'').replace(/\s+/g,' ').trim();
        if(!text) return;
        var title = text.length > 48 ? text.slice(0,48)+'…' : text;
        /* 文本指纹：空文本的 user 消息（纯图片/文件）照样渲染成 .msg.user，
           按序号取第 idx 个会整体偏一位，所以跳转优先按指纹找（见 outlineJump）。 */
        var head = encodeURIComponent(text.slice(0,24));
        var ts = fmtDateTime(m.ts||m.created_at||Date.now());
        html += '<div class="ws-outline-item" data-msgidx="'+idx+'" data-head="'+head+'" style="padding:7px 8px;border-radius:var(--radius-sm);cursor:pointer;font-size:12px;line-height:1.55;color:var(--text2);border-left:2px solid transparent;margin-bottom:2px" onclick="outlineJump(this)">' +
          '<div style="color:var(--text)">'+esc(title)+'</div>' +
          '<div style="font-size:11px;color:var(--text3);margin-top:2px">'+ts+'</div></div>';
        idx++;
      });
      wrap.innerHTML = html;
      applyOutlineFilter();
    })
    .catch(function(){ wrap.innerHTML = '<div class="empty-state">大纲加载失败</div>'; });
}
/* 大纲要点点击 → 滚动到聊天区对应消息 */
function outlineJump(item){
  var idx = parseInt(item.getAttribute('data-msgidx')||'0', 10);
  var body = document.getElementById('chatBody');
  if(!body) return;
  var sid = currentSession;
  var head = '';
  try { head = decodeURIComponent(item.getAttribute('data-head')||''); } catch(e){ head = ''; }
  /* 两条对齐规则，缺一条就跳错：
     1) 大纲只收「有文本」的 user 消息，而聊天区连纯图片/文件的气泡也占一个 .msg.user，
        按序号取第 idx 个会整体偏位 —— 所以按文本指纹找。
     2) 聊天区只画最后一页（CHAT_PAGE 条），大纲却列全部消息：更早的项在 DOM 里根本不存在。
        这时不能退回序号（那是别人的消息），得先 loadOlderMessages 把更早的翻出来再找。 */
  var find = function(){
    var targets = body.querySelectorAll('.msg.user');
    if(!head) return targets[idx] || null;
    var norm = function(t){ return (t||'').replace(/\s+/g,' ').trim(); };
    var texts = [];
    for(var i=0;i<targets.length;i++) texts.push(norm(targets[i].getAttribute('data-content')||''));
    var cand = [];
    for(var j=0;j<texts.length;j++){
      if(texts[j] && texts[j].indexOf(head) !== -1) cand.push(j);
    }
    if(cand.length){
      /* 同一句话被说过两次时，取离序号最近的那个，别跳去很远的地方 */
      var pick = cand[0];
      for(var k=1;k<cand.length;k++){
        if(Math.abs(cand[k]-idx) < Math.abs(pick-idx)) pick = cand[k];
      }
      return targets[pick];
    }
    /* 整串对不上：引用块一类标记在渲染时被改写，开头的字对不齐，改按片段投票 */
    var parts = [];
    for(var p=0;p<head.length;p+=8) parts.push(head.slice(p, p+8));
    if(!parts.length) return null;
    var need = parts.length >= 3 ? 2 : 1, bi = -1, bs = 0;
    for(var m=0;m<texts.length;m++){
      if(!texts[m]) continue;
      var sc = 0;
      for(var q=0;q<parts.length;q++) if(texts[m].indexOf(parts[q]) !== -1) sc++;
      if(sc > bs || (sc === bs && sc > 0 && (bi < 0 || Math.abs(m-idx) < Math.abs(bi-idx)))){
        bs = sc; bi = m;
      }
    }
    return (bi >= 0 && bs >= need) ? targets[bi] : null;
  };
  var to = function(el){
    pauseChatFollow();
    el.scrollIntoView({ behavior:'smooth', block:'center' });
    el.style.outline = '2px solid var(--accent)';
    setTimeout(function(){ el.style.outline = ''; }, 1500);
  };
  var el = find();
  if(el){ to(el); return; }
  if(head && typeof loadOlderMessages === 'function'
     && typeof _winFrom !== 'undefined' && _winFrom[sid]){
    var tries = 0;
    var step = function(){
      tries++;
      loadOlderMessages(sid).then(function(more){
        var e2 = find();
        if(e2){ to(e2); return; }
        if(more && tries < 15) step();
        else toast('这条消息在更早的历史里，往上滚动可继续加载');
      }, function(){ toast('这条消息在更早的历史里，加载失败'); });
    };
    step();
    return;
  }
  toast(head ? '这条消息在更早的历史里，往上滚动可继续加载' : '未找到对应消息');
}
/* 大纲筛选：只切 display，不动 data-msgidx —— 隐藏项仍占原序号，跳转照旧对得上。
   loadOutline 重建列表后必须重放一次，否则切 tab / 换会话回来筛选态就丢了。 */
function applyOutlineFilter(){
  var box = document.getElementById('wsOutlineFilter');
  var wrap = document.getElementById('wsOutlineContent');
  if(!box || !wrap) return;
  var q = (box.value||'').trim().toLowerCase();
  var items = wrap.querySelectorAll('.ws-outline-item');
  var hit = 0;
  for(var i=0;i<items.length;i++){
    var ok = !q || (items[i].textContent||'').toLowerCase().indexOf(q) !== -1;
    items[i].style.display = ok ? '' : 'none';
    if(ok) hit++;
  }
  var tip = wrap.querySelector('.ws-outline-nomatch');
  if(q && items.length && !hit){
    if(!tip){
      tip = document.createElement('div');
      tip.className = 'ws-outline-nomatch';
      tip.textContent = '没有匹配的大纲要点';
      wrap.appendChild(tip);
    }
  } else if(tip){ tip.remove(); }
}

/* ============================ 文件管理器 ============================ */
var _fmCwd = '';
var _fmEditPath = '';
// 文件列表、编辑与版本恢复由 panel-files-ui.js 提供。
function fmAttachPath(path){
  var name=path.split('/').pop()||'file';
  // 以 /api/download?path= 形式引用，后端 normalizeMessage 时解析回真实路径，Agent 可直接读取分析
  _pendingAttachments.push({ url:'/api/download?path='+encodeURIComponent(path)+'&name='+encodeURIComponent(name), type:'application/octet-stream', name:name });
  toast('📎 已附加到对话：'+name);
  renderAttachChips();
  autoResize(document.getElementById('chatInput'));
}
function fmAttach(){ fmAttachPath(_fmEditPath); }
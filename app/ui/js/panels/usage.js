/* Token 用量 + 用量统计
 * 来源：index.html 内联 app.js 第 7689-7780 行（共 92 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ Token 用量 ============================ */
function renderUsageCard(){
  apiGet('/api/usage').then(function(res){
    if(!res || !res.ok || !res.usage){ return; }
    var u = res.usage;
    var el;
    el=document.getElementById('usageSessions'); if(el) el.textContent = u.total_sessions||0;
    el=document.getElementById('usageMessages'); if(el) el.textContent = u.total_messages||0;
    var models = u.by_model || [];
    el=document.getElementById('usageModels'); if(el) el.textContent = new Set(models.filter(function(row){return row.model;}).map(function(row){return row.model;})).size;
    el=document.getElementById('usageByModel');
    if(el && models.length){
      el.innerHTML = models.map(function(info){
        return '<div style="display:flex;justify-content:space-between;padding:2px 0"><span>'+esc(info.model || (info.historical?'历史汇总未分配模型':'执行记录未保存模型'))+'</span><span>'+Number(info.total_tokens).toLocaleString()+' tokens</span></div>';
      }).join('');
    }
  }).catch(function(){});
}

/* ============================ 用量统计页 ============================ */
/* 数字压缩：过长的绝对数按中文习惯折成「万 / 亿」带单位，避免大字号撑破卡片 */
function usageShort(n){
  n = Number(n) || 0;
  if(n < 10000) return {v:n.toLocaleString(), u:''};
  if(n < 100000000) return {v:(n/10000).toFixed(1), u:'万'};
  return {v:(n/100000000).toFixed(2), u:'亿'};
}
/* 标题旁的问号：口径解释走全站统一的气泡层（js/panel-tooltip.js 的 data-tip 单例）。
   别再挂原生 title —— panel-tooltip.js 的 dedupeTitles() 会把 [data-tip][title] 和
   单独带 title 的问号一起清掉，鼠标悬停和点按都不弹，看起来就是「问号点不开」。
   .usage-q 只负责长相（圆圈），交互一律交给 data-tip。 */
function usageQ(label, help){
  if(!help) return label;
  return '<span class="usage-q" tabindex="0" role="button" data-tip="'+DOM.escAttr(help)+
    '" aria-label="'+DOM.escAttr(help)+'">?</span>' + label;
}
function usageCardHtml(label, n, suffix, title){
  var c = usageShort(n);
  return '<div class="usage-card"'+(title?' data-tip="'+DOM.escAttr(title)+'"':'')+'>' +
    '<div class="usage-card-label">'+label+'</div>' +
    '<div class="usage-card-value">'+c.v+(c.u?'<span class="usage-card-unit">'+c.u+'</span>':'')+(suffix?'<span class="usage-card-unit">'+suffix+'</span>':'')+'</div></div>';
}

/* 金额卡片：值本身就是成品字符串，不走「万/亿」压缩 */
function usageRawCard(label, text){
  return '<div class="usage-card"><div class="usage-card-label">'+label+'</div>' +
    '<div class="usage-card-value usage-card-value--text">'+esc(text)+'</div></div>';
}

/* 最近调用：直接读 hermes.log 的 [Chat] 请求行，按小时聚合（不依赖 state.db 的按会话汇总） */
/* reason= 是 2026-11-20 加进日志行的（思考强度），更早的行没有这个字段 → 记「未记」。
   2026-11-21：面板取消「跟随默认」之后，每个会话都会带档位，reason=- 只剩旧行和不走
   面板的请求（CLI/QQ）—— 一律记「未记」，不再叫「跟随」，免得和设置页对不上。 */
var USAGE_LOG_RE = /^\[monitor\] (\d{4}-\d\d-\d\d) (\d\d):\d\d:\d\d \[Chat\] 请求 provider=(.+?) model=(\S+)(?:.*?\breason=(\S+))?/;
var USAGE_REASON_LABEL = {off:'关', low:'低', medium:'中', high:'高', max:'最高', on:'开', '-':'未记'};
var USAGE_REASON_ORDER = ['off','low','medium','high','max','on','-',''];
function usageHourKey(d, h){ return d + ' ' + h; }
function usageReasonChip(level, n){
  var label = USAGE_REASON_LABEL[level] || (level === '' ? '未记' : level);
  var cls = level === '' ? ' rz-none' : (level === '-' ? ' rz-follow' : ' rz-' + level);
  var zero = (n === 0) ? ' rz-zero' : '';
  return '<span class="usage-rz' + cls + zero + '" title="' + DOM.escAttr(label) + '">' + esc(label) + (n != null ? ' ×' + n : '') + '</span>';
}
function usageReasonCells(map){
  /* 四档固定全显，缺档补 ×0（2026-11-21 主人：其他档位怎么没有，要弄全）。
     只把 off/low/medium/high 强制铺满；max/on/'-'/'' 这些非标准档仍按实际出现才显示，
     免得每个模型都拖一串「最高×0 开×0 未记×0」的空噪声。 */
  var fixed = ['off','low','medium','high'];
  var chips = [];
  fixed.forEach(function(k){ chips.push(usageReasonChip(k, map[k] || 0)); });
  var keys = Object.keys(map);
  keys.sort(function(a, b){
    return (USAGE_REASON_ORDER.indexOf(a) < 0 ? 99 : USAGE_REASON_ORDER.indexOf(a))
         - (USAGE_REASON_ORDER.indexOf(b) < 0 ? 99 : USAGE_REASON_ORDER.indexOf(b));
  });
  keys.forEach(function(k){
    if(fixed.indexOf(k) >= 0) return;      /* 已铺满的四档跳过 */
    chips.push(usageReasonChip(k, map[k]));
  });
  return chips.join('');
}
function renderUsageRecent(){
  var sec = document.getElementById('usageRecentSection');
  var body = document.getElementById('usageRecentBody');
  var note = document.getElementById('usageRecentNote');
  if(!sec || !body) return;
  apiGet('/api/logs/read?file=hermes.log&lines=2000').then(function(res){
    var lines = (res && res.lines) || [];
    var rows = [];
    lines.forEach(function(line){
      var m = USAGE_LOG_RE.exec(line);
      if(m) rows.push({d:m[1], h:m[2], p:m[3].trim(), model:m[4], rsn:(m[5] || '')});
    });
    if(!rows.length){ sec.style.display = 'none'; return; }
    var last = rows[rows.length - 1];
    var lastT = Date.parse(last.d.replace(/-/g, '/') + ' ' + last.h + ':00:00');
    var cutoff = lastT - 24 * 3600 * 1000;
    var agg = {}, order = [], counted = 0, withRsn = 0;
    rows.forEach(function(r){
      var t = Date.parse(r.d.replace(/-/g, '/') + ' ' + r.h + ':00:00');
      if(isNaN(t) || t < cutoff) return;
      counted++;
      if(r.rsn) withRsn++;
      var key = usageHourKey(r.d, r.h);
      if(!agg[key]){ agg[key] = {models:{}, total:0}; order.push(key); }
      var mk = r.model + '|' + r.p;
      if(!agg[key].models[mk]) agg[key].models[mk] = {model:r.model, p:r.p, n:0, rsn:{}};
      var bucket2 = agg[key].models[mk];
      bucket2.n++;
      bucket2.rsn[r.rsn] = (bucket2.rsn[r.rsn] || 0) + 1;
      agg[key].total++;
    });
    order.reverse();
    var html = '', shown = 0;
    order.forEach(function(key){
      var bucket = agg[key];
      var list = Object.keys(bucket.models).map(function(k){return bucket.models[k];})
        .sort(function(a,b){return b.n - a.n;});
      html += '<tr class="usage-hour-row"><td colspan="4">' + esc(key.slice(5)) + ':00 · ' + bucket.total + ' 次</td></tr>';
      list.forEach(function(item){
        if(shown++ > 80) return;
        html += '<tr><td>' + esc(item.model) + '</td>' +
          '<td class="usage-provider-cell" title="' + DOM.escAttr(item.p) + '">' + esc(item.p) + '</td>' +
          '<td class="usage-reason-cell">' + usageReasonCells(item.rsn) + '</td>' +
          '<td>' + item.n + '</td></tr>';
      });
    });
    body.innerHTML = html ||
      '<tr><td colspan="4" style="color:var(--text3)">最近 24 小时没有调用记录</td></tr>';
    var newest = order[0] || '';
    /* 档位字段是后加的，旧行没有 → 直接说清有多少条带档位，不要假装全都有 */
    if(note) note.textContent = '来源 hermes.log 的 [Chat] 请求 · 最近 24 小时 · 最新 ' + newest.slice(5) + ':00'
      + ' · 带档位 ' + withRsn + '/' + counted + ' 条';
    sec.style.display = '';
  }).catch(function(){ sec.style.display = 'none'; });
}

/* 最近使用：执行记录的 first_seen/last_seen。
   回退链、上下文压缩这类调用不进 hermes.log 的 [Chat] 请求行，只有这本账能说清时间段。 */
/* 服务商键 custom_<hash> 直接铺在表里像串乱码，折成「中转 …末四位」，全名留在 title */
function usageShortProvider(p){
  if(!p) return '—';
  var m = /^custom_([0-9a-f]{4})[0-9a-f]+([0-9a-f]{4})$/.exec(p);
  return m ? ('中转 ' + m[1] + '…' + m[2]) : p;
}
function renderUsageRecentSessions(list){
  var wrap = document.getElementById('usageRecentSessionsWrap');
  var body = document.getElementById('usageRecentSessions');
  if(!wrap || !body) return;
  if(!list || !list.length){ wrap.style.display = 'none'; return; }
  var taskNames = {main:'主对话', vision:'图像理解', compression:'上下文压缩', title_generation:'标题生成'};
  body.innerHTML = list.slice(0, 24).map(function(r){
    var span = (r.first_seen && r.first_seen !== r.last_seen) ? (r.first_seen + ' → ' + r.last_seen) : (r.last_seen || r.first_seen || '—');
    var tk = usageShort(r.tokens || 0);
    return '<tr>' +
      '<td class="usage-time-cell">' + esc(span) + '</td>' +
      '<td>' + esc(r.model || '—') + '</td>' +
      '<td class="usage-provider-cell" title="' + DOM.escAttr(r.provider || '') + '">' + esc(usageShortProvider(r.provider)) + '</td>' +
      '<td>' + esc(taskNames[r.task] || r.task || '主对话') + '</td>' +
      '<td>' + Number(r.calls || 0).toLocaleString() + '</td>' +
      '<td>' + tk.v + tk.u + '</td></tr>';
  }).join('');
  wrap.style.display = '';
}

function renderUsagePage(){
  var cardsEl = document.getElementById('usageSummaryCards');
  var modelSection = document.getElementById('usageByModelSection');
  var modelList = document.getElementById('usageByModelList');
  var dailySection = document.getElementById('usageDailySection');
  var dailyBody = document.getElementById('usageDailyBody');
  var channelsSection = document.getElementById('usageChannelSection');
  var channelsEl = document.getElementById('usageChannelList');
  var emptyEl = document.getElementById('usageEmpty');
  
  cardsEl.innerHTML = '<div class="usage-card"><div class="usage-card-label">加载中...</div></div>';
  renderUsageRecent();
  modelSection.style.display = 'none';
  dailySection.style.display = 'none';
  if(channelsSection) channelsSection.style.display = 'none';
  emptyEl.style.display = 'none';
  
  apiGet('/api/usage').then(function(res){
    if(!res || !res.ok || !res.usage){
      cardsEl.innerHTML = '';
      emptyEl.textContent = res && res.error || '执行记录暂时无法读取，请重试';
      emptyEl.style.display = '';
      return;
    }
    var u = res.usage;
    var totalSessions = u.total_sessions || 0;
    var totalMessages = u.total_messages || 0;
    var models = u.by_model || [];
    var totals = u.totals || {};
    var coverage = u.coverage || {};
    function money(value){return value==null?'未记录金额':'$'+Number(value).toFixed(4);}
    
    // 汇总卡片
    cardsEl.innerHTML = 
      usageCardHtml(usageQ('总会话数', '按会话去重，口径：'+(u.source||'')+' · '+(u.period||'')), totalSessions) +
      usageCardHtml('总消息数', totalMessages) +
      usageCardHtml(usageQ('输入 tokens', '含主对话与图像理解、压缩、标题等辅助调用；不重复相加会话汇总。'), totals.input_tokens || 0) +
      usageCardHtml('输出 tokens', totals.output_tokens || 0) +
      usageCardHtml(usageQ('模型调用次数', '全部已记录调用，含辅助任务，与 tokens 同一份执行记录。'), totals.api_call_count || 0) +
      usageRawCard(usageQ('估算费用', '按各家官方刊例价 × token 现算，再乘渠道倍率（config 里 provider 名称后缀的 0.4x 这类）。DeepSeek 另外按高峰倍率×2（周一至周五 9-12、14-18），其他厂商没有这条规则不翻倍。美元价按 7.1 折人民币，glm/qwen/kimi 本身就是人民币价。不含 Search/Fetch 独立计费，是估算值，不保证等于平台账单。'), '¥'+Number(totals.cost_cny||0).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})) +
      usageRawCard(usageQ('不计价 tokens', '价目表里查不到官方价的模型，只记 token 不编金额。目前只剩 cugb-fast（学校自建模型，无公开报价）；grok/claude/gpt/gemini/glm/qwen/kimi 都已按官方价计入上方费用。'), Number(totals.unpriced_tokens||0).toLocaleString()) +
      '';
    
    var extra=u.panel_requests;
    if(extra){cardsEl.innerHTML+='<div class="usage-card" style="grid-column:1/-1"><div class="usage-card-label">'+usageQ('面板直接请求 · 单独统计','模型验证与记忆整理直接请求服务，单独列示，不并入原生会话总量。仅统计服务返回的用量；未返回或未落盘的消耗无法补算。')+'</div><p>'+Number(extra.reported_records)+' / '+Number(extra.records)+' 条记录返回用量；输入 '+Number(extra.input_tokens).toLocaleString()+'，输出 '+Number(extra.output_tokens).toLocaleString()+' tokens。</p>'+(extra.unreadable_records?'<p>有 '+Number(extra.unreadable_records)+' 份记录无法读取，以上为可读取部分。</p>':'')+(extra.by_model||[]).map(function(row){return '<p>'+esc(row.task==='model_check'?'模型验证':'记忆整理')+' · '+esc(row.model||'服务未返回模型名')+' · '+esc(row.provider||'未记录服务名')+'：输入 '+Number(row.input_tokens).toLocaleString()+' / 输出 '+Number(row.output_tokens).toLocaleString()+' tokens'+(row.missing_input||row.missing_output?'（部分字段未返回）':'')+'</p>';}).join('')+'</div>';}

    // 渠道费用：每个中转站各花了多少
    var channels = u.by_channel || [];
    if(channels.length && channelsEl){
      var maxCost = Math.max.apply(null, channels.map(function(c){return c.cost_cny||0;})) || 1;
      channelsEl.innerHTML = channels.map(function(c){
        var pct = Math.max(0, Math.round((c.cost_cny||0)/maxCost*100));
        var mult = c.multiplier && c.multiplier !== 1 ? ' · 倍率 '+c.multiplier+'x' : '';
        return '<div class="usage-model-row">' +
          '<div class="usage-model-name">'+esc(c.channel)+'<small style="display:block;color:var(--text3)">'+Number(c.tokens||0).toLocaleString()+' tokens'+esc(mult)+'</small></div>' +
          '<div class="usage-model-bar"><div class="usage-model-bar-fill" style="width:'+pct+'%"></div></div>' +
          '<div class="usage-model-stats">¥'+Number(c.cost_cny||0).toFixed(2)+'</div>' +
          '</div>';
      }).join('');
      channelsSection.style.display = '';
    }

    // 模型分布
    if(models.length){
      var maxTokens = Math.max.apply(null, models.map(function(info){return info.total_tokens;}));
      var taskNames = {main:'主对话',vision:'图像理解',compression:'上下文压缩',title_generation:'标题生成'};
      modelList.innerHTML = models.map(function(info){
        var pct = maxTokens > 0 ? Math.round(info.total_tokens / maxTokens * 100) : 0;
        return '<div class="usage-model-row">' +
          '<div class="usage-model-name">'+esc(info.model || (info.historical?'历史汇总未分配模型':'执行记录未保存模型'))+'<small style="display:block;color:var(--text3)">'+esc(taskNames[info.task] || info.task)+(info.provider?' · '+esc(info.provider):'')+'</small></div>' +
          '<div class="usage-model-bar"><div class="usage-model-bar-fill" style="width:'+pct+'%"></div></div>' +
          '<div class="usage-model-stats">'+Number(info.total_tokens).toLocaleString()+' tokens · '+info.api_call_count+' 次调用</div>' +
          '</div>';
      }).join('');
      modelSection.style.display = '';
    }
    
    // 每日用量（从会话数据推算）
    if(u.activity && u.activity.length){
      dailyBody.innerHTML = u.activity.map(function(d){
        return '<tr><td>'+esc(d.date)+'</td><td>'+d.sessions+'</td><td>'+d.messages+'</td></tr>';
      }).join('');
      dailySection.style.display = '';
    }
    renderUsageRecentSessions(u.recent || []);
  }).catch(function(){
    cardsEl.innerHTML = '';
    emptyEl.textContent = '读取失败，请检查连接后重试';
    emptyEl.style.display = '';
  });
}
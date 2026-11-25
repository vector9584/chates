/* 模型 · 能力实验室（子页面 9/9）—— 2026-11-23 改成矩阵

   改之前：选一个服务 → 选默认模型 → 手点 14 张卡，一次只测一个 provider 的一个模型。
   主人原话：「我看到模型-能力后端-DeepSeek 落点里面就有 DS 功能全测，你把这个优化一下
   可以基于我选的已经添加的模型全量测试吧。」

   所以界面变成：行 = 已添加的模型（providers[].models[]），列 = 能力项。
   每个格子必须能看见「凭什么这么判」——只有绿/红没有证据，用户还得回来问我。

   判据全部在后端（panel_cap_matrix.py），前端只上色、只展示 evidence 原文。
   关键：HTTP 200 不等于能力可用（ZeroAPI 官转对 tools 回 200 但 usage 里没有
   server_tool_use，参数被吞）。所以绿的前提是后端给的 ok=true，不是 status=200。
*/
(function () {
  'use strict';
  var host = document.getElementById('modelCapsSlot');
  if (!host) return;

  var state = {
    caps: [], rows: [], runs: {}, picked: {},
    running: false, stop: false, done: 0, total: 0, batch: 3
  };

  function api(body) {
    return fetch(apiUrl('/api/panel-models'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Monitor-Token': monitorToken || '' },
      body: JSON.stringify(body), cache: 'no-store'
    }).then(function (r) {
      return r.json().then(function (out) {
        if (!r.ok || !out.ok) throw Error(out.error || '能力请求失败');
        return out;
      });
    });
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function key(row) { return row.provider + '\u0000' + row.model; }

  function groups() {
    var out = [], seen = {};
    state.rows.forEach(function (row) {
      if (!seen[row.provider]) {
        seen[row.provider] = { provider: row.provider, name: row.provider_name, base: row.base_url, rows: [] };
        out.push(seen[row.provider]);
      }
      seen[row.provider].rows.push(row);
    });
    return out;
  }

  function cellHtml(row, cap) {
    var got = (state.runs[key(row)] || {})[cap];
    if (!got) return '<td class="cm-cell"><span class="cm-dot idle"></span></td>';
    var cls = got.ok ? 'ok' : 'bad';
    var tip = got.label + ' · HTTP ' + got.status + ' · ' + got.ms + 'ms\n' + (got.evidence || '');
    return '<td class="cm-cell ' + cls + '" title="' + esc(tip) + '">'
      + '<span class="cm-dot ' + cls + '"></span>'
      + '<span class="cm-lab">' + esc(got.label) + '</span></td>';
  }

  function rowHtml(row) {
    var caps = state.caps.map(function (cap) { return cellHtml(row, cap.id); }).join('');
    var picked = state.picked[key(row)];
    return '<tr class="cm-row' + (row.enabled ? '' : ' off') + '" data-key="' + esc(key(row)) + '">'
      + '<td class="cm-pick"><input type="checkbox" class="cm-check"' + (picked ? ' checked' : '') + '></td>'
      + '<td class="cm-model"><code>' + esc(row.model) + '</code>'
      + (row.enabled ? '' : '<span class="cm-tag">已停用</span>') + '</td>'
      + caps
      + '<td class="cm-ev">' + esc(evidenceText(row)) + '</td></tr>';
  }

  /* 一行只显示一条最有信息量的证据：优先第一条失败项的原文。
     全都绿就显示最快的一项耗时。用户扫一列就能看出哪行有问题。 */
  function evidenceText(row) {
    var got = state.runs[key(row)] || {};
    var bad = state.caps.filter(function (c) { return got[c.id] && !got[c.id].ok; })[0];
    if (bad) return bad.label + '：' + String(got[bad.id].evidence || '').slice(0, 90);
    if (!Object.keys(got).length) return '';
    return '全部通过 · ' + Math.max.apply(null, state.caps.map(function (c) {
      return (got[c.id] || {}).ms || 0;
    })) + 'ms 内跑完';
  }

  function tableHtml() {
    var head = '<tr><th class="cm-pick"><input type="checkbox" id="cmCheckAll"></th><th>模型</th>'
      + state.caps.map(function (cap) {
        return '<th title="' + esc(cap.desc) + '">' + esc(cap.label) + '</th>';
      }).join('') + '<th>证据</th></tr>';
    var body = groups().map(function (group) {
      return '<tr class="cm-group"><th colspan="' + (state.caps.length + 3) + '">'
        + esc(group.name) + ' <span class="cm-base">' + esc(group.base) + '</span></th></tr>'
        + group.rows.map(rowHtml).join('');
    }).join('');
    return '<div class="cm-wrap"><table class="cm-table"><thead>' + head + '</thead><tbody>'
      + body + '</tbody></table></div>';
  }

  function stats() {
    var total = 0, ok = 0, bad = 0;
    Object.keys(state.runs).forEach(function (k) {
      Object.keys(state.runs[k]).forEach(function (cap) {
        total++;
        if (state.runs[k][cap].ok) ok++; else bad++;
      });
    });
    return { total: total, ok: ok, bad: bad };
  }

  function barHtml() {
    var picked = Object.keys(state.picked).filter(function (k) { return state.picked[k]; }).length;
    var s = stats();
    return '<div class="cm-bar">'
      + '<button type="button" class="btn primary" id="cmRun">'
      + (state.running ? '正在跑…' : '跑选中（' + (picked || state.rows.length) + ' 个模型）') + '</button>'
      + '<button type="button" class="btn" id="cmStop"' + (state.running ? '' : ' disabled') + '>停</button>'
      + '<span class="cm-hint">共 ' + state.rows.length + ' 个模型 · 已测 ' + s.total + ' 格'
      + '（通过 ' + s.ok + ' / 未通过 ' + s.bad + '）</span>'
      + '<span class="cm-prog">' + (state.total ? state.done + ' / ' + state.total : '') + '</span>'
      + '</div>';
  }

  function render() {
    if (!state.rows.length) {
      host.innerHTML = '<div class="settings-section"><p class="page-subtitle">还没有可测试的模型，先去「通用模型」加一条。</p></div>';
      return;
    }
    host.innerHTML = '<div class="settings-section">' + barHtml() + tableHtml()
      + '<p class="cap-hint">绿 = 后端实际请求拿到硬证据（真收到分片 / tool_calls 真回来 / '
      + 'reasoning_tokens 真随档位变 / 真答对图像颜色）。鼠标停在格子上看原文报文。'
      + '「参数被吞」表示接口回了 200 但参数没生效——这种最坑，配置里看着能用。</p></div>';
    bind();
  }

  function paintRow(row) {
    var node = host.querySelector('tr[data-key="' + CSS.escape(key(row)) + '"]');
    if (!node) return;
    var cells = node.querySelectorAll('td.cm-cell');
    state.caps.forEach(function (cap, i) {
      var got = (state.runs[key(row)] || {})[cap.id];
      if (!got || !cells[i]) return;
      cells[i].className = 'cm-cell ' + (got.ok ? 'ok' : 'bad');
      cells[i].title = got.label + ' · HTTP ' + got.status + ' · ' + got.ms + 'ms\n' + (got.evidence || '');
      cells[i].innerHTML = '<span class="cm-dot ' + (got.ok ? 'ok' : 'bad') + '"></span>'
        + '<span class="cm-lab">' + esc(got.label) + '</span>';
    });
    var ev = node.querySelector('.cm-ev');
    if (ev) ev.textContent = evidenceText(row);
  }

  function selection() {
    var picked = Object.keys(state.picked).filter(function (k) { return state.picked[k]; });
    if (!picked.length) return null;
    return picked.map(function (k) {
      var parts = k.split('\u0000');
      return { provider: parts[0], model: parts[1] };
    });
  }

  /* 分批跑：一次 3 个模型 × 6 项能力 ≈ 40~70 秒，避开反代 60s 超时。
     每批回来立刻上色，用户能看着一格格填满，不用等全部跑完。 */
  function runBatch(start) {
    if (state.stop) { finish('已停止'); return; }
    var body = { action: 'cap_batch_run', start: start, limit: state.batch };
    var sel = selection();
    if (sel) body.selection = sel;
    api(body).then(function (out) {
      (out.rows || []).forEach(function (row) {
        state.runs[key(row)] = row.caps || {};
        paintRow(row);
        state.done++;
      });
      var bar = host.querySelector('.cm-prog');
      if (bar) bar.textContent = state.done + ' / ' + state.total;
      if (out.next == null) { finish('跑完'); return; }
      runBatch(out.next);
    }).catch(function (error) {
      finish('中断：' + (error.message || '请求失败'));
    });
  }

  function finish(label) {
    state.running = false;
    var s = stats();
    var btn = host.querySelector('#cmRun');
    if (btn) {
      btn.disabled = false;
      btn.textContent = label + ' · ' + s.ok + ' 通过 / ' + s.bad + ' 未通过';
    }
    var stopBtn = host.querySelector('#cmStop');
    if (stopBtn) stopBtn.disabled = true;
    var bar = host.querySelector('.cm-hint');
    if (bar) bar.textContent = '共 ' + state.rows.length + ' 个模型 · 已测 ' + s.total + ' 格';
  }

  function bind() {
    var run = host.querySelector('#cmRun');
    if (run) run.onclick = function () {
      if (state.running) return;
      var sel = selection();
      state.running = true;
      state.stop = false;
      state.done = 0;
      state.total = sel ? sel.length : state.rows.length;
      run.disabled = true;
      run.textContent = '正在跑…';
      host.querySelector('#cmStop').disabled = false;
      runBatch(0);
    };
    var stop = host.querySelector('#cmStop');
    if (stop) stop.onclick = function () { state.stop = true; };

    var all = host.querySelector('#cmCheckAll');
    if (all) all.onchange = function () {
      host.querySelectorAll('.cm-check').forEach(function (box) {
        box.checked = all.checked;
        var k = box.closest('tr').dataset.key;
        state.picked[k] = all.checked;
      });
      var bar = host.querySelector('.cm-bar');
      if (bar) bar.outerHTML = barHtml().replace(/^<div class="cm-bar">/, '<div class="cm-bar">');
      bind();
    };
    host.querySelectorAll('.cm-check').forEach(function (box) {
      box.onchange = function () {
        state.picked[box.closest('tr').dataset.key] = box.checked;
        var hint = host.querySelector('.cm-hint');
        var n = Object.keys(state.picked).filter(function (k) { return state.picked[k]; }).length;
        var btn = host.querySelector('#cmRun');
        if (btn && !state.running) {
          btn.textContent = '跑选中（' + (n || state.rows.length) + ' 个模型）';
        }
      };
    });
  }

  function load() {
    host.innerHTML = '<div class="settings-section"><p class="page-subtitle">正在读取已添加的模型…</p></div>';
    api({ action: 'cap_batch_matrix' }).then(function (out) {
      state.caps = out.caps || [];
      state.rows = out.rows || [];
      state.runs = {};
      state.picked = {};
      render();
    }).catch(function (error) {
      host.innerHTML = '<div class="settings-section"><p class="page-subtitle">读取失败：' + esc(error.message) + '</p></div>';
    });
  }

  var refresh = document.getElementById('modelCapsRefresh');
  if (refresh) refresh.onclick = function () { load(); };

  load();
  window.reloadModelCaps = load;
})();

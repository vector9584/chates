/* 模型页 · 六个域的渲染（2026-11-15 第二轮：严格对齐参考稿）
 *
 * 参考稿 DOM（/tmp/cmp/ref/skel/*.txt 是实测导出的骨架）：
 *   home      wrap > hero + sec + quick(qcard×4) + sec + cards(pcard×3)
 *   select    wrap > ph + hero + slots(slotbox×N) + chips
 *   providers wrap > ph + cards(pcard×N + pcard.add) + chips
 *   backends  wrap > ph + 类型筛选 + cards(pcard×N) + sec + chips + panel
 *   toolsets  wrap > ph + split(左 tsgrid + Tool Gateway / 右 安全边界 + 生效)
 *   config    wrap > ph + panel(code)
 *
 * 与第一轮的差别：不再用 mv2-* 类名和分段胶囊页签，全部换成参考稿那套；
 * 每个渲染器返回 DocumentFragment，#mv2Root 本身就是 .wrap。
 */
(function () {
  'use strict';
  var M = window.MV2;
  if (!M) return;
  var el = M.el, btn = M.btn, badge = M.badge, chip = M.chip, dot = M.dot,
      sec = M.sec, ph = M.ph, kv = M.kv, panel = M.panel, code = M.code;

  /* ── 小工具 ─────────────────────────────────────────── */
  function frag() { return document.createDocumentFragment(); }

  function svg(paths, size) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', '1.6');
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    node.setAttribute('width', size || 16);
    node.setAttribute('height', size || 16);
    (paths || []).forEach(function (d) {
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      node.append(p);
    });
    return node;
  }

  /* 参考稿图标库：完整 SVG 内层（path/rect/circle），stroke 风格，viewBox 0 0 24 24 */
  function svgIcon(inner, size) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', '1.8');
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    node.setAttribute('width', size || 15);
    node.setAttribute('height', size || 15);
    node.innerHTML = inner;
    return node;
  }

  var ICONS = {
    slots:   '<rect x="3" y="3" width="18" height="6" rx="1.5"/><rect x="3" y="10" width="8" height="11" rx="1.5"/><rect x="13" y="10" width="8" height="5" rx="1.5"/><rect x="13" y="16" width="8" height="5" rx="1.5"/>',
    plug:    '<path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0z"/><path d="M12 18v3"/>',
    cap:     '<path d="M4 5h16v14H4z"/><path d="m8 12 3 3 5-6"/>',
    wrench:  '<path d="M14 6a4 4 0 0 0-5 5L3 17l4 4 6-6a4 4 0 0 0 5-5l-3 3-3-3z"/>',
    mic:     '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    globe:   '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
    star:    '<path d="m12 3 2.6 5.6 6.1.8-4.5 4.3 1.1 6.1L12 17l-5.3 2.8 1.1-6.1L3.3 9.4l6.1-.8z"/>',
    file:    '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/>',
    volume:  '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    search:  '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
    eye:     '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    image:   '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'
  };

  var BACKEND_ICON = {
    stt: 'mic', tts: 'volume', web_search: 'search', web_extract: 'globe',
    vision: 'eye', ocr: 'file', image_gen: 'image', browser: 'monitor'
  };

  var ICON = {
    grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
    server: ['M4 6h16v5H4z', 'M4 13h16v5H4z', 'M7 8.5h.01', 'M7 15.5h.01'],
    cube: ['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z', 'M12 12l8-4.5', 'M12 12v9', 'M12 12L4 7.5'],
    toggle: ['M8 7h8a5 5 0 010 10H8A5 5 0 018 7z', 'M16 12a3 3 0 11-6 0 3 3 0 016 0'],
    arrows: ['M4 8h11l-3-3', 'M20 16H9l3 3'],
    plug: ['M9 3v6', 'M15 3v6', 'M6 9h12v3a6 6 0 01-12 0V9z', 'M12 18v3']
  };

  function providerName(S, id) {
    var hit = (S.catalog.providers || []).filter(function (p) { return p.id === id; })[0];
    return hit ? (hit.display_name || hit.name) : (id || '');
  }

  function providerOf(S, id) {
    return (S.catalog.providers || []).filter(function (p) { return p.id === id; })[0] || null;
  }

  function emblemOf(name) {
    var text = String(name || '?').replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, '');
    return (text.slice(0, 2) || '??').toUpperCase();
  }

  function auxTasks(S) {
    return (S.aux && S.aux.tasks) || [];
  }

  function inheritedCount(S) {
    return auxTasks(S).filter(function (t) { return !t.provider || t.provider === 'auto'; }).length;
  }

  function customCount(S) {
    return auxTasks(S).filter(function (t) { return t.provider && t.provider !== 'auto'; }).length;
  }

  function toolsetLabel(name) {
    var map = {
      web: '网页', terminal: '终端', file: '文件', vision: '视觉', memory: '记忆',
      skills: '技能', browser: '浏览器', image_gen: '图像生成', tts: '语音',
      delegation: '委派', cronjob: '定时', messaging: '消息', code_execution: '代码执行',
      clarify: '追问', computer_use: '电脑操作', context_engine: '上下文引擎',
      discord: 'Discord', discord_admin: 'Discord 管理', bfl: 'BFL 图像',
      mcp: 'MCP', kanban: '看板', todo: '待办', session_search: '会话检索',
      stt: '语音转写', video: '视频', audio: '音频', files: '文件管理',
      git: 'Git', shell: 'Shell', http: 'HTTP', sqlite: 'SQLite'
    };
    return map[name] || name;
  }

  /* ── 概览 ───────────────────────────────────────────── */
  M.pages.home = function (S) {
    var out = frag();
    var cat = S.catalog || {};
    var providers = cat.providers || [];
    var primary = cat.primary || {};
    var enabled = providers.filter(function (p) { return p.enabled !== false; }).length;
    var domains = (S.backends && S.backends.domains) || [];
    var writable = domains.filter(function (d) { return d.writable; }).length;
    var toolsets = S.toolsets || {};
    var native = domains.filter(function (d) { return d.write_via === 'config'; }).length;
    var custom = domains.filter(function (d) { return d.write_via === 'none'; }).length;

    /* hero */
    var hero = el('div', 'hero');
    hero.append(el('div', 'lead', '当前'));
    var h2 = el('h2');
    var em = el('em', null, providerName(S, primary.provider) + ' · ' + (primary.model || '—'));
    h2.append(em);
    h2.append(document.createTextNode(' 承担主推理，' + inheritedCount(S) + ' 个辅助槽位继承它。'));
    hero.append(h2);
    var stats = el('div', 'stats');
    [['LLM 服务商', enabled + ' / ' + providers.length],
     ['能力后端', writable + ' / ' + domains.length],
     ['工具集', (toolsets.count_enabled || 0) + ' / ' + (toolsets.count_all || 0)],
     ['原生可配', native + ' 直写 · ' + custom + ' 二改']
    ].forEach(function (pair) {
      var box = el('div');
      box.append(el('small', null, pair[0]));
      box.append(el('b', null, pair[1]));
      stats.append(box);
    });
    hero.append(stats);
    out.append(hero);

    /* 2026-11-16：模型清单为空的服务商 —— 配了一半的状态，必须一眼看见。
       这类服务在对话页能被选中，但二级模型列表里一个模型都没有。
       数据来自后端 catalog.alerts（needs_models 汇总）。 */
    if ((cat.alerts || []).length) {
      var alert = el('div', 'alertbar');
      var abody = el('div', 'abody');
      abody.append(el('b', null, '这些服务还没有可用模型'));
      var aul = el('ul');
      cat.alerts.forEach(function (a) { aul.append(el('li', null, a.text || a.name)); });
      abody.append(aul);
      alert.append(abody);
      alert.append(btn('去补模型', 'btn sm', function () { M.go('providers'); }));
      out.append(alert);
    }

    /* 四个配置对象 */
    out.append(sec('四个配置对象'));
    var quick = el('div', 'quick');
    [
      ['slots', '模型选择', '主模型 / 辅助任务 / 组合', 'select'],
      ['plug', 'LLM 服务商', '推理端点 · 对话内能力', 'providers'],
      ['cap', '能力后端', '语音 / 网页 / 视觉 / OCR', 'backends'],
      ['wrench', '工具集', '开关 · 安全边界', 'toolsets']
    ].forEach(function (row) {
      var card = btn('', 'qcard', function () { M.go(row[3]); });
      var ic = el('span', 'ic');
      ic.append(svgIcon(ICONS[row[0]], 18));
      card.append(ic, el('span', 't', row[1]), el('span', 'd', row[2]), el('span', 'go', '进入 ›'));
      quick.append(card);
    });
    out.append(quick);

    /* 三条链路 */
    var head = sec('链路', '方向不同，不并列');
    out.append(head);
    var cards = el('div', 'cards');
    [
      ['plug', 'independent', 'outbound · 推理', 'Hermes 调别人的模型', 'model / auxiliary / fallback / moa'],
      ['cap', 'independent', 'outbound · 能力', '工具域各自的后端注册', 'stt / tts / web.backend / vision'],
      ['globe', 'independent', 'inbound · 入口', '外部把 Hermes 当模型调', 'API server · API_SERVER_KEY']
    ].forEach(function (row) {
      var card = el('div', 'pcard');
      var top = el('div', 'top');
      var em2 = el('span', 'emblem');
      em2.append(svgIcon(ICONS[row[0]], 15));
      top.append(em2, badge('独立配置段', 'info'));
      card.append(top, el('div', 'nm', row[2]), el('div', 'url', row[3]));
      var meta = el('div', 'meta');
      meta.append(chip(row[4], true));
      card.append(meta);
      cards.append(card);
    });
    out.append(cards);
    return out;
  };

  /* ── 模型选择 · 主与辅助 ────────────────────────────── */
  function selectMain(S) {
    var out = frag();
    var primary = (S.catalog && S.catalog.primary) || {};
    var tasks = auxTasks(S);

    /* 术语按官网：model.* 是主模型，auxiliary.* 是「辅助任务」，每个任务是一个
       独立的 provider/model 槽位；fallback_providers 是「主模型备用链」。
       「主与辅助」这个词官网没有，容易让人把回退链当成第三类模型，改成「模型与插槽」。 */
    var chain = ((S.catalog && S.catalog.fallbacks) || []);
    out.append(ph('模型与插槽', '主模型 · 辅助任务槽位 · 主模型备用链', [
      btn('批量分配', 'btn sm', function () { M.sheets.assignAll && M.sheets.assignAll(S); }),
      btn('主模型与回退', 'btn sm primary', function () { M.sheets.changePrimary && M.sheets.changePrimary(S); })
    ]));

    var hero = el('div', 'hero');
    hero.append(el('div', 'lead', 'model.default'));
    var h2 = el('h2');
    h2.append(el('em', null, providerName(S, primary.provider) + ' / ' + (primary.model || '—')));
    h2.append(document.createTextNode(' · ' + inheritedCount(S) + ' 个槽位跟随 · ' + customCount(S) + ' 个单独指定'));
    hero.append(h2);

    /* 回退情况从原「回退链」子页搬到这里：主模型卡下面直接给出备用顺序和现状。
       用户原来的问题是「同一个模型到底谁在顶」，答案在 model.default 这一行旁边。 */
    /* 2026-11-23：主人说「回退模型设置不了啊，只能看啊」。原来这里只输出 <span>，
       一个按钮都没有。改成可编辑：上移/下移/删除全部当场落盘（action=routes，
       整条链当 entries 传回去），新增走「主模型与回退」弹层挑模型。
       写入口仍只有 routes 一个 action，不新增后端接口。 */
    var fbox = el('div', 'fbbox');
    hero.append(fbox);

    function saveChain(keep, note) {
      /* entries 必须带 key：后端按 key 从现有条目里原样拷回 base_url 等附加字段，
         只传 provider/model 会被判「回退路线格式不正确」并整笔拒绝。 */
      M.mutate({
        action: 'routes',
        provider: primary.provider, model: primary.model,
        entries: keep.map(function (f) { return { key: f.key }; }),
        revision: (S.catalog || {}).revision
      }, { done: note, body: '写入 fallback_providers' });
    }

    function renderChain() {
      fbox.replaceChildren();
      var list = ((S.catalog && S.catalog.fallbacks) || []).slice();
      fbox.append(el('div', 'fblb', list.length
        ? '主模型失败时按这个顺序切（fallback_providers）· 共 ' + list.length + ' 项'
        : '主模型失败时按顺序切（fallback_providers）'));
      if (!list.length) {
        fbox.append(el('p', 'fbempty', '还没有备用模型：主模型返回 429 / 5xx / 401 时不会自动切走，一次失败就是一次失败。'));
      } else {
        var flist = el('div', 'fblist');
        list.forEach(function (f, i) {
          var it = el('div', 'fbit');
          it.append(el('span', 'fbidx', String(i + 1)));
          it.append(el('span', 'fbname', providerName(S, f.provider) + ' / ' + f.model));
          var acts = el('div', 'fbact');
          function mini(label, cls, title, disabled, fn) {
            var b = btn(label, 'fbic' + (cls ? ' ' + cls : ''), fn);
            b.title = title;
            b.disabled = !!disabled;
            return b;
          }
          acts.append(mini('↑', '', '上移一位', i === 0, function () {
            var next = list.slice();
            var t = next[i - 1]; next[i - 1] = next[i]; next[i] = t;
            saveChain(next, providerName(S, t.provider) + ' / ' + t.model + ' 提到第 ' + i + ' 位');
          }));
          acts.append(mini('↓', '', '下移一位', i === list.length - 1, function () {
            var next = list.slice();
            var t = next[i + 1]; next[i + 1] = next[i]; next[i] = t;
            saveChain(next, providerName(S, t.provider) + ' / ' + t.model + ' 降到第 ' + (i + 2) + ' 位');
          }));
          acts.append(mini('✕', 'del', '从备用链移除', false, function () {
            var next = list.filter(function (_, j) { return j !== i; });
            saveChain(next, '已移除备用 ' + providerName(S, f.provider) + ' / ' + f.model);
          }));
          it.append(acts);
          flist.append(it);
        });
        fbox.append(flist);
      }
      fbox.append(el('p', 'fbnote', '改完对新会话生效；正在跑的请求不受影响。'));
    }
    renderChain();
    out.append(hero);

    var slots = el('div', 'slots');
    tasks.forEach(function (task) {
      var own = task.provider && task.provider !== 'auto';
      var box = btn('', 'slotbox' + (own ? ' custom' : ''), function () {
        M.sheets.slot && M.sheets.slot(S, task);
      });
      var sn = el('span', 'sn', task.label || task.key);
      sn.append(dot(own ? 'warn' : 'ok'));
      box.append(sn);
      /* 2026-11-21：provider=auto 但有 fallback_chain 时，卡片原来说「跟随主模型」是假的——
         内核先按 auto 解析主模型，失败/不支持读图才退到 chain[0]，实际上图片就是这么读的。
         这里直接把 chain[0] 报出来，省得每次会话都点进槽位翻回退链找「到底谁在读图」。 */
      var fb0 = (task.fallback_chain || [])[0];
      var live = own ? (task.model || task.provider) : (fb0 ? (fb0.model || providerName(S, fb0.provider)) : null);
      box.append(el('span', 'sw', own ? '单独用 ' + live : (live ? '跟随主模型 · 读图实际走 ' + live : '跟随主模型')));
      box.append(el('span', 'sm', 'auxiliary.' + task.key));
      box.append(el('span', 'sx', '›'));
      slots.append(box);
    });
    out.append(slots);

    var chips = el('div', 'chips');
    chips.append(chip('单独指定可带 base_url / api_key / timeout / fallback_chain'));
    chips.append(chip('主模型备用链在上面的按钮里改；MOA 在右侧「组合回答」子页'));
    out.append(chips);
    return out;
  };

  /* ── 模型选择 · 组合回答（MOA） ─────────────────────── */
  function toggleMoa(S, on, preset) {
    var p = preset || {};
    if (on && (!p.reference_models || !p.reference_models.length || !p.aggregator || !p.aggregator.model)) {
      M.sheets.moaEdit && M.sheets.moaEdit(S, p);
      return;
    }
    M.mutate({
      action: 'moa_save', revision: (S.moa || {}).moa_revision,
      preset: p.name || (S.moa && S.moa.default_preset) || 'default',
      enabled: on,
      reference_models: (p.reference_models || []).map(function (r) { return { provider: r.provider, model: r.model }; }),
      aggregator: p.aggregator || { provider: '', model: '' }
    }, { done: on ? 'MOA 已开启' : 'MOA 已关闭',
         body: on ? '主模型切到聚合模型 ' + ((p.aggregator && p.aggregator.model) || '') : '主模型回到原值' });
  }

  function selectMoa(S) {
    var out = frag();
    var moa = S.moa || {};
    var presets = moa.presets || [];
    var enabled = !!moa.enabled;
    var active = moa.active_preset || '';
    out.append(ph('组合回答', 'moa.presets · 虚拟 provider', [
      btn('配置', 'btn sm', function () {
        var p = presets.filter(function (x) { return x.name === active; })[0] || presets[0];
        M.sheets.moaEdit && M.sheets.moaEdit(S, p || { name: (moa.default_preset || 'default') });
      })
    ]));
    var hero = el('div', 'hero');
    hero.append(el('div', 'lead', enabled ? 'MOA 已开启' : 'MOA 已关闭'));
    var h2 = el('h2');
    if (enabled) {
      var act = presets.filter(function (p) { return p.name === active; })[0] || {};
      h2.append(el('em', null, active));
      h2.append(document.createTextNode(' 承担聚合，' + ((act.reference_models) || []).length + ' 个参考模型并行。'));
    } else {
      var cp = moa.current_primary || {};
      h2.append(el('em', null, providerName(S, cp.provider) + ' / ' + (cp.model || '—')));
      h2.append(document.createTextNode(' 当前走主模型，开启 MOA 后切到聚合模型。'));
    }
    hero.append(h2);
    out.append(hero);
    if (!presets.length) {
      out.append(el('div', 'empty', '还没有预设，点「配置」建第一个'));
    } else {
      var cards = el('div', 'cards');
      presets.forEach(function (p) {
        var isActive = enabled && p.name === active;
        var card = el('div', 'pcard' + (isActive ? ' on' : ''));
        var top = el('div', 'top');
        top.append(el('span', 'emblem', emblemOf(p.name)));
        top.append(isActive ? badge('启用中', 'ok') : badge('预设'));
        card.append(top);
        card.append(el('div', 'nm', p.name));
        var meta = el('div', 'meta');
        meta.append(chip((p.reference_models || []).length + ' 参考'));
        meta.append(chip('聚合 ' + ((p.aggregator && p.aggregator.model) || '—')));
        if (p.fanout) meta.append(chip(p.fanout, true));
        card.append(meta);
        var foot = el('div', 'foot');
        foot.append(btn('配置', 'btn sm', function () { M.sheets.moaEdit && M.sheets.moaEdit(S, p); }));
        if (isActive) foot.append(btn('关闭', 'btn sm danger', function () { toggleMoa(S, false, p); }));
        else foot.append(btn('启用', 'btn sm primary', function () { toggleMoa(S, true, p); }));
        card.append(foot);
        cards.append(card);
      });
      out.append(cards);
    }
    out.append(panel('成本落点', [
      el('p', 'mini', '开启后每个请求并行打 N 个参考模型，再加一次聚合调用，token 约为 (N+1) 倍；参考模型只给聚合模型供上下文，不直接回给用户。')
    ]));
    return out;
  }

  /* 模型选择分派器 */
  M.pages.select = function (S) {
    var tab = (S.tab && S.tab.select) || 'main';
    /* 2026-11-23：独立的「回退链」子页已删除，fallback_providers 的现状
       并进「模型与插槽」的主模型卡，写入口只有「主模型与回退」弹层一处。 */
    if (tab === 'moa') return selectMoa(S);
    return selectMain(S);
  };

  /* 一张服务商卡里的一把密钥：只是「有一把 key，它管着几个模型」的一行状态。
     2026-11-16 用户明确：卡片上只允许三个服务商级按钮（编辑/停用/删除），
     key 级的编辑、启停、删除全部搬进编辑面板 —— 所以这里一个按钮都不放，
     否则每加一把 key 就多出一组按钮。 */
  /* 2026-11-16：原名也叫 keyRow，跟下面密钥子页那个函数重名 —— JS 后定义覆盖
     前定义，于是服务商卡片实际跑的是「密钥子页」那套逻辑：它读 k.configured，
     而卡片喂进来的数据结构里只有 api_key_configured，全是 undefined，
     整页每一行都判成缺密钥。卡片和子页的行长得不一样（这边是 kdot+kcount，
     那边是 kname+hint+改值按钮），本来就不该共用一个函数名。改名分开。 */
  function svcKeyRow(S, k) {
    var off = k.enabled === false;
    var row = el('div', 'keyrow' + (off ? ' off' : ''));
    var head = el('div', 'krow');
    head.append(el('span', 'kdot' + (off ? ' off' : '')));
    /* 兜底不再是 k.id：custom_xxx 是内核生成的，用户既没起过也改不了，
       显示它等于把实现细节当名字。 */
    head.append(el('span', 'klabel', k.key_label || k.name || '未命名密钥'));
    /* 2026-11-16：模型数只算启用的。取消勾选的模型会归档成 enabled:false
       留在数组里（不丢历史元数据），所以数 length 永远显示全量 —— 用户取消
       了一个还显示 4 个，会以为保存没生效。 */
    var live = (k.models || []).filter(function (m) { return typeof m === 'string' || m.enabled !== false; });
    head.append(el('span', 'kcount', live.length + ' 模型'));
    if (k.api_key_configured === false) head.append(badge('缺密钥'));
    row.append(head);
    return row;
  }

  /* ── 服务商级批量动作（2026-11-16）─────────────────────────
     卡片上的「停用/删除」是服务商级：一个服务商 = 一个 group = N 条 provider，
     也就是 N 把 key。后端 toggle/delete 都是单条 mv 语义，且每次写都会换
     revision，所以必须串行、每步重新取最新 revision，不能 Promise.all。
     逐把执行 → 汇总成功几把、哪把为什么失败，比「失败」两个字有用。 */
  async function svcToggle(S, keys, turnOff, label) {
    var target = !turnOff;
    var todo = keys.filter(function (k) { return (k.enabled !== false) !== target; });
    if (!todo.length) {
      M.toast('没有变化', label + ' 已经是' + (target ? '全部启用' : '全部停用') + '状态', 'ok');
      return;
    }
    var ok = 0, fails = [];
    for (var i = 0; i < todo.length; i++) {
      var k = todo[i];
      try {
        await M.api({ action: 'toggle', id: k.id, enabled: target, revision: (S.catalog || {}).revision });
        ok++;
      } catch (e) {
        fails.push((k.key_label || k.id) + '：' + ((e && e.message) || e));
      }
    }
    M.toast((fails.length ? '部分' : '') + (target ? '已启用' : '已停用'),
      label + ' · ' + ok + '/' + todo.length + ' 把密钥' + (fails.length ? '\n' + fails.join('\n') : ''),
      fails.length ? 'bad' : 'ok');
    /* 2026-11-16：只 load 不 render，卡片就还是旧样子 —— 用户点完停用，toast
       说「已停用」，卡片却依旧亮着、徽标依旧写「正常」，非要刷新才变。
       load() 只把数据拉进 S，落到 DOM 必须紧跟一次 render()。 */
    if (M.load) await M.load();
    if (M.render) M.render();
  }

  async function svcDelete(S, keys, label) {
    if (!keys || !keys.length) return;
    var ids = keys.map(function (k) { return k.id; });
    /* 2026-11-16 血泪（用户实测踩出来的）：这里原来是逐把发 delete，成功一把
       算一把。第一把没被引用就真的删掉了，第二把被 MOA 引用才报 409 —— 弹窗
       上写着「还有引用，删不了」，回来一看组里少了一半，报错和事实对不上。
       整组删除必须一次发出去，后端要么全删要么一把不动。 */
    try {
      var out = await M.api({ action: 'group_delete', id: ids[0], ids: ids, revision: (S.catalog || {}).revision });
      /* 2026-11-16：删服务商时后端会把「少了还能跑」的引用顺手摘掉（频道覆盖、
         回退链里的一项、MOA 参考模型、回滚记录、会话 /model 覆盖）。这些是静默
         改动，必须打出来 —— 用户得知道自己少配了什么，而不是过两天发现某个频道
         悄悄换了模型。 */
      var swept = (out && out.auto_cleaned) || [];
      var sess = (out && out.sessions_reset) || [];
      /* 会话覆盖也逐条列出来。原来这里折成「N 个会话的模型覆盖」，用户只知道
         数量、不知道哪个群哪个对话被改了 —— 而这两个地方正是他下次打开会看到
         模型变了的地方，必须点名。多了折成「等 N 处」。 */
      var extra = swept.concat(sess);
      var shown = extra.slice(0, 4).join('、');
      if (extra.length > 4) shown += ' 等 ' + extra.length + ' 处';
      M.toast('已删除', label + ' · ' + ids.length + ' 把密钥' + (extra.length ? '；顺手清了 ' + shown : ''), 'ok');
    } catch (e) {
      M.toast('一把都没删', label + ' · ' + ((e && e.message) || e), 'bad');
    }
    if (M.load) await M.load();
    if (M.render) M.render();
  }

  /* 删除整个服务商是不可逆的，先让用户看清要删几把 key。
     引用检查是从弹层那版（M.sheets.providerDelete）搬过来的 —— 卡片这条路径
     原来一个检查都没有，删掉正在当主模型、或者被回退链/辅助任务引用的服务也照删，
     配置里就留下一根悬空的引用。那版从来没被调用过（纯死代码），检查搬完就删掉了。 */
  function svcDeleteConfirm(S, keys, label) {
    var cat = S.catalog || {};
    var primary = cat.primary || {};
    var ids = keys.map(function (k) { return k.id; });
    var blockers = [];
    /* 会被后端顺手清掉的引用（摘掉之后配置照样成立），跟 blockers 分开展示。 */
    var tidy = [];
    if (primary.provider && ids.indexOf(primary.provider) >= 0) {
      blockers.push('它是当前主模型（' + primary.model + '）');
    }
    /* 2026-11-16：回退链里的一项不拦了。用户原话「只要有一个频道在用就不能删，
       这得多麻烦」—— 少一项回退照样能跑，后端 auto_clean 会摘掉它并回报。
       只有「少了就跑不动」的才留在 blockers 里。 */
    ((cat.fallbacks) || []).forEach(function (f) {
      if (ids.indexOf(f.provider) >= 0) tidy.push('回退链里的 ' + f.model);
    });
    ((S.aux && S.aux.tasks) || []).forEach(function (t) {
      var who = '辅助任务「' + (t.label || t.key) + '」';
      if (ids.indexOf(t.provider) >= 0) blockers.push(who + '在用');
      /* 回退链也是引用：主用 auto、备用挂在这条服务上的情况，只查 provider 会漏。 */
      (t.fallback_chain || []).forEach(function (f, i) {
        if (ids.indexOf(f.provider) >= 0) tidy.push(who + '回退链第 ' + (i + 1) + ' 项');
      });
    });
    /* MOA 预设的聚合模型和参考模型同样是引用，原来这里一个都没查。
       S.moa 只在打开过「组合回答」页时才加载，取不到就跳过 —— 后端还有一道闸。 */
    ((S.moa && S.moa.presets) || []).forEach(function (p) {
      var agg = p.aggregator || {};
      if (ids.indexOf(agg.provider) >= 0) blockers.push('MOA 预设「' + p.name + '」的聚合模型');
      (p.reference_models || []).forEach(function (r, i) {
        if (ids.indexOf(r.provider) >= 0) tidy.push('MOA 预设「' + p.name + '」参考模型第 ' + (i + 1) + ' 个');
      });
    });
    if (blockers.length) {
      var blocked = M.sheet({ title: '删不了 ' + label, sub: '还有 ' + blockers.length + ' 处在引用它' });
      blocked.body.append(el('div', 'errline', '先把这些引用改到别的服务，再回来删：'));
      var deps = el('div', 'deps');
      blockers.forEach(function (line) { deps.append(el('div', 'dh', '· ' + line)); });
      blocked.body.append(deps);
      blocked.foot.append(btn('知道了', 'btn primary', function () { blocked.close(); }));
      return;
    }
    var sheet = M.sheet({
      title: '删除 ' + label,
      sub: keys.length > 1 ? '这个服务商下的 ' + keys.length + ' 把密钥会全部删除' : '这把密钥会被删除'
    });
    var body = el('div', 'mblock');
    body.append(el('div', 'mbar bad', '删掉后这个服务商的配置和 .env 里的密钥变量一起清掉，不能撤销'));
    var list = el('div', 'mlist');
    keys.forEach(function (k, i) {
      var r = el('div', 'mrow');
      /* 这里原来显示 k.id —— 也就是 custom_umw4fn6uw5d42。那个字符串是内核
         生成的内部标识，用户没起过、也改不了，拿它当名字显示等于把实现细节
         丢到脸上。改成序号 + 密钥名。 */
      r.append(el('span', 'mid mono', '#' + (i + 1)));
      r.append(el('span', 'mname', k.key_label || '未命名密钥'));
      r.append(el('span', 'mctx', (k.models || []).length + ' 模型'));
      list.append(r);
    });
    body.append(list);
    /* 会被顺手清掉的引用：不拦，但必须在确认删之前说清楚。用户要的是
       「别拿一个频道拦我」，不是「悄悄替我改配置」。 */
    if (tidy.length) {
      body.append(el('div', 'mbar', '下面 ' + tidy.length + ' 处引用会跟着摘掉，摘完回落全局默认，其余配置不受影响'));
      var tlist = el('div', 'deps');
      tidy.forEach(function (line) { tlist.append(el('div', 'dh', '· ' + line)); });
      body.append(tlist);
    }
    sheet.body.append(body);
    sheet.foot.append(btn('取消', 'btn', function () { sheet.close(); }));
    sheet.foot.append(btn('确认删除', 'btn danger', function () {
      sheet.close();
      svcDelete(S, keys, label);
    }));
  }

  /* 用这把密钥向它自己的端点拉真实模型清单。走 monitor 已有的 discover：
     传 provider_id + model + use_saved_credential，它自己从 .env 取密钥，
     明文 key 不出后端。拉不到就一个字都不动，免得把手工维护的清单清空。 */
  /* ── 服务商 · LLM 服务 ──────────────────────────────── */
  function providersLlm(S) {
    var out = frag();
    var cat = S.catalog || {};
    var providers = cat.providers || [];

    out.append(ph('LLM 服务商', 'providers: 注册表 · 只放推理端点', [
      btn('+ 添加服务', 'btn sm primary', function () { M.sheets.providerAdd && M.sheets.providerAdd(S); })
    ]));

    // 后端给 groups：同一个中转站的多把 key 收成一张卡。老后端没有 groups 就按
    // providers 一对一渲染 —— 没有 group 的服务，行为跟以前完全一样。
    var groups = (cat.groups && cat.groups.length) ? cat.groups
      : providers.map(function (p) { return { group: '', name: p.name || p.id, display_name: p.display_name || p.name || p.id, base_url: p.base_url || '', keys: [p] }; });

    var cards = el('div', 'cards');
    groups.forEach(function (g) {
      var keys = g.keys || [];
      var anyOn = keys.some(function (k) { return k.enabled !== false; });
      /* 2026-11-16：有密钥但一个模型都没拉到的服务商，卡上直接挂红标 —— 它
         在对话页选得中，点进去二级列表却是空的。 */
      var needModels = keys.some(function (k) { return k.needs_models; });
      var card = el('div', 'pcard' + (anyOn ? '' : ' off'));
      var top = el('div', 'top');
      top.append(el('span', 'emblem', emblemOf(g.display_name || g.name)));
      /* 2026-11-16：官方 / 第三方标识。判据是地址落没落在官方预设表里（后端
         group_view 算好 official 一起下发），不看名字 —— 叫「DeepSeek 官方」
         却指向中转站的，照样算第三方。 */
      top.append(g.official ? badge('官方', 'pri') : badge('第三方'));
      var am = null;
      if (M.S && M.S.authMark) {
        for (var xi = 0; xi < keys.length; xi++) {
          if (M.S.authMark[keys[xi].id]) { am = M.S.authMark[keys[xi].id]; break; }
        }
      }
      top.append(!anyOn ? badge('停用') : (needModels ? badge('缺模型', 'warn') : badge('正常', 'ok')));
      /* 2026-11-23：保存后探测的结果挂卡头。没探过不占位置，探通了上面已经写着
         「正常」，不重复说；探失败把原因亮出来 —— 配完自己猜不出来才叫坑。 */
      if (am && am.state && am.state !== 'ok') {
        var amBadge = badge(am.label || 'key 未生效', am.state === 'busy' ? 'info' : 'err');
        var amTip = [];
        if (am.code) amTip.push('HTTP ' + am.code);
        if (am.ms) amTip.push(am.ms + 'ms');
        if (am.detail) amTip.push(String(am.detail).slice(0, 160));
        if (amTip.length) amBadge.setAttribute('data-tip', amTip.join(' · '));
        top.append(amBadge);
      }
      card.append(top);
      card.append(el('div', 'nm', g.display_name || g.name || '未命名服务'));
      /* 2026-11-16：卡片上不再显示服务商地址。用户原话「保存完的卡片上不要显示
         服务商地址了」。卡片要回答的是「这服务能用吗、几把密钥、几个模型」，
         地址是配置细节，编辑面板里看得到，铺在首页只是噪音。 */
      var meta = el('div', 'meta');
      /* 不再显示「服务商 <group>」：group 是后端内部聚合键（值是第一条
         provider 的 id），别的卡片没有，露出来就成了一张卡比别人多一个标签。 */
      /* 多把时候由下面的 .keybar 统一说「N 把密钥 · M 把启用」，这里只在单把时
         补一个，别让同一张卡上同一件事说两遍。 */
      if (keys.length === 1) meta.append(chip('1 把密钥'));
      /* 2026-11-16：模型数只数启用的。取消勾选的模型会归档成 enabled:false 留在
         数组里（不丢历史元数据），数 length 会让「取消了还显示 4 个」——用户会以为
         保存没生效。总数不丢，有停用的补一句「共 N」。 */
      var allM = keys.reduce(function (n, k) { return n + (k.models || []).length; }, 0);
      var onM = keys.reduce(function (n, k) {
        return n + (k.models || []).filter(function (m) { return typeof m === 'string' || m.enabled !== false; }).length;
      }, 0);
      meta.append(chip(onM + ' 模型' + (allM > onM ? '（共 ' + allM + '）' : '')));
      card.append(meta);
      /* 多把密钥默认折叠（2026-11-17 用户原话：「已经配置的多个可以做一个折叠，
         一个密钥就一行把卡片撑的很高」）。
         卡片要回答的是「这服务能不能用、有几把、几个模型」，密钥明细是第二层。
         折叠状态记在 S.keyExpand 上 —— render 每次重画 DOM，状态不存就点了就弹回去。 */
      var gid = g.group || keys[0].id;
      S.keyExpand = S.keyExpand || {};
      var open = !!(S.keyExpand[gid]);
      var list = el('div', 'keylist');
      keys.forEach(function (k) { list.append(svcKeyRow(S, k)); });
      if (keys.length > 1) {
        var onN = keys.filter(function (k) { return k.enabled !== false; }).length;
        var bar = el('div', 'keybar');
        bar.append(el('span', 'mini', keys.length + ' 把密钥 · ' + onN + ' 把启用'));
        bar.append(btn(open ? '收起' : '展开', 'btn sm', function () {
          S.keyExpand[gid] = !open;
          M.render();
        }));
        card.append(bar);
        if (!open) list.style.display = 'none';
      }
      card.append(list);
      /* 服务商级三个按钮：卡片最底部一行（.foot 有 margin-top:auto + 顶部
         分隔线 + flex:1 等宽），作用于整个服务商；key 级的编辑/启停/删除
         全在编辑面板里，卡片上不出现。
         2026-11-16：原来用的是 .cacts，它既没有 margin-top:auto 也没分隔线、
         还把它放在 keylist 前面，于是三个按钮浮在卡片中间、小得像标签。 */
      var foot = el('div', 'foot');
      foot.append(btn('编辑', 'btn', function () {
        M.sheets.providerEdit && M.sheets.providerEdit(S, keys[0]);
      }));
      foot.append(btn(anyOn ? '停用' : '启用', 'btn', function () {
        svcToggle(S, keys, anyOn, g.display_name || g.name || '未命名服务');
      }));
      foot.append(btn('删除', 'btn danger', function () {
        svcDeleteConfirm(S, keys, g.display_name || g.name || '未命名服务');
      }));
      card.append(foot);
      cards.append(card);
    });

    var add = btn('', 'pcard add', function () { M.sheets.providerAdd && M.sheets.providerAdd(S); });
    add.append(el('span', 'plus', '+'), el('span', 't', '添加 LLM 服务'), el('span', 'url', '自定义 providers.<name>'));
    cards.append(add);
    out.append(cards);

    var chips = el('div', 'chips');
    chips.append(chip('语音 / OCR / 搜索不在这里配'));
    chips.append(chip('密钥与对话内能力在右侧「密钥」「对话内能力」子页'));
    chips.append(chip('providers.<name>: base_url · api_mode · extra_headers · discover_models', true));
    out.append(chips);
    return out;
  };

  /* ── 服务商 · 密钥 ──────────────────────────────────── */
  /* 一行密钥：主显人读的名字，变量名降到小字。
     以前直接把 CUSTOM_UMU5G7PYGOZES_API_KEY 顶在最前面，用户根本认不出
     它是 DeepSeek 官方那条服务的 key —— 同一个东西在服务商页叫名字，到这里
     变成内部 id，两页对不上号，看着就像两块功能在重复。 */
  function keyRow(S, k) {
    var tone = k.orphan ? ' bad' : (k.configured ? (k.active ? '' : ' off') : ' miss');
    var row = el('div', 'krow' + tone);
    var main = el('div', 'kmain');
    var title = el('div', 'ktitle');
    title.append(el('span', 'kname', k.label || k.name));
    if (k.orphan) title.append(badge('引用失效', 'err'));
    else if (!k.configured) title.append(badge('缺密钥', 'err'));
    else if (!k.active) title.append(badge('备着'));
    else title.append(badge('在用', 'ok'));
    main.append(title);
    var sub = el('div', 'ksub');
    sub.append(el('span', 'mono kvar', k.name));
    if (k.hint) sub.append(el('span', 'mini', ' ' + k.hint));
    main.append(sub);
    if (k.used_by && k.used_by.length) main.append(el('div', 'mini kuse', '用于 ' + k.used_by.join('、')));
    // 真孤儿（这条变量没有任何有效使用者）才在行里铺原因；只是「另有引用失效」
    // 的话给一句短的 —— 把整段原因抄到每行，等于同一句话在页面上喊两遍。
    if (k.orphan) {
      (k.orphans || []).forEach(function (why) { main.append(el('div', 'mini kbad', why)); });
    } else if ((k.orphans || []).length) {
      main.append(el('div', 'mini knote', '另有 ' + k.orphans.length + ' 处引用已失效，见上方提示'));
    }
    row.append(main);
    var act = el('div', 'kact');
    act.append(btn(k.configured ? '改值' : '填值', 'btn sm' + (k.configured ? '' : ' primary'),
      function () { M.sheets.keyEdit && M.sheets.keyEdit(S, k); }));
    row.append(act);
    return row;
  }

  function providersKeys(S) {
    var out = frag();
    var K = S.keys || {};
    var groups = K.groups || [];
    var orphans = K.orphans || [];
    out.append(ph('密钥', '凭据仓库 · 主显服务名，变量名在下面', [
      btn('+ 添加密钥', 'btn sm primary', function () { M.sheets.keyAdd && M.sheets.keyAdd(S); })
    ]));
    // 三块面板各管一件事，用户分不清就会觉得在重复做。摆在一句话里。
    out.append(el('div', 'keylead',
      '这一页只管「钥匙是什么」。连哪个地址、有哪些模型在服务商页；用谁干活在能力后端页。'));

    if (orphans.length) {
      var warn = el('div', 'keywarn');
      warn.append(el('b', null, '有引用指不到东西'));
      orphans.forEach(function (o) { warn.append(el('div', 'mini', o.reason)); });
      out.append(warn);
    }

    if (!groups.length) {
      out.append(el('div', 'empty', 'config 里没有引用任何环境变量'));
    } else {
      groups.forEach(function (g) {
        out.append(panel(g.label + '（' + g.keys.length + '）',
          g.keys.map(function (k) { return keyRow(S, k); })));
      });
    }
    out.append(el('p', 'mini', '值写进 ' + (K.env_file || 'config 同目录 .env') +
      '（现有 ' + (K.env_count || 0) + ' 个变量），config.yaml 里用 ${KEY} 引用，不落明文。变量名不能在这里改：config 引用着它，改名要连 config 一起改。'));
    return out;
  }

  /* ── 服务商 · 对话内能力 ────────────────────────────── */
  function dsProvider(S) {
    var providers = (S.catalog && S.catalog.providers) || [];
    return providers.filter(function (p) {
      return p.enabled !== false && p.request_extra && Object.keys(p.request_extra).length;
    })[0] || null;
  }

  function chatToolState(ds, key) {
    var extra = ds.request_extra || {};
    if (key === 'thinking') return !!(extra.thinking && extra.thinking.type !== 'disabled');
    if (key === 'title') return !!(extra.title && extra.title.enabled !== false);
    if (key === 'safety') return !!extra.safety_check;
    return false;
  }

  function toggleChatTool(S, ds, key) {
    var extra = JSON.parse(JSON.stringify(ds.request_extra || {}));
    var on = !chatToolState(ds, key);
    if (key === 'thinking') { if (on) extra.thinking = { type: 'enabled' }; else delete extra.thinking; }
    else if (key === 'title') { if (on) extra.title = { enabled: true }; else delete extra.title; }
    else if (key === 'safety') { if (on) extra.safety_check = { level: 'high' }; else delete extra.safety_check; }
    M.mutate({ action: 'update', id: ds.id, changes: { request_extra: extra }, revision: (S.catalog || {}).revision },
      { done: (on ? '已开启 ' : '已关闭 ') + key, body: '写入 providers.<id>.extra_body' });
  }

  /* DeepSeek 官方专属的三个请求参数（thinking / title / safety_check）。
     2026-11-20：不再单独占一个「服务商 → DeepSeek 服务端能力」页签 —— 那一页
     只有三个开关却自称「对话内能力」，看的人以为是模型能力总表。改成模型配置
     里的一段：当前 provider 的 base_url 命中 api.deepseek.com 才渲染，别家不显示。 */
  function dsServerParams(S, prov, opts) {
    /* 2026-11-21 三处返工：
       ① 样式写死浅色（#0f172a/#dbeafe）在深色主题下和整张卡片不是一套 —— 全走变量；
       ② 两个「开/关」药丸按钮换成模型页通用的 .mv2-switch；
       ③ 说明文字不再铺在卡片正文里，挂到卡片名右边的问号上（主人原话）。
       另外支持 opts：新增服务时还没有 provider 记录，用 opts.baseUrl / opts.extra
       走草稿，保存时再落盘 —— 这样「新建」和「编辑」是同一段渲染。 */
    opts = opts || {};
    var out = frag();
    var base = String((prov && prov.base_url) || opts.baseUrl || '').toLowerCase();
    if (base.indexOf('api.deepseek.com') < 0) return out;
    /* opts.extra 是调用方给的「当前状态」，有就给（哪怕是 {}）——
       空对象是合法状态，代表「两个开关都关了」。不能拿空对象当「没传」去
       回落到 prov.request_extra：那样用户把开关关掉之后，重画又从 provider
       读回 enabled:true，开关自己弹回去，看着就是「点了没反应」
       （2026-11-21 实测）。调用方现在一律显式传当前值。 */
    var extra = (opts.extra && typeof opts.extra === 'object')
      ? opts.extra : ((prov && prov.request_extra) || {});

    var hd = el('div', 'ui-panel-hd');
    hd.append(el('span', 'ui-panel-title', '服务端参数'));
    var q = el('span', 'ui-hint mp-hint', '?');
    /* 气泡一句话说清「写哪、干什么」；细节留在 extra_body.title / .safety_check
       这两个键名上（卡片里就印着），不在气泡里复述。 */
    var hint = '写入 extra_body：标题生成让 DeepSeek 替会话起名，安全校验走 high 档。';
    q.setAttribute('data-tip', hint);
    q.setAttribute('aria-label', hint);
    hd.append(q);
    hd.append(el('span', 'ui-panel-tag', 'DeepSeek 官方专属'));
    out.append(hd);

    var card = el('div', 'ui-panel dsx-card');
    [['title', '标题生成', 'extra_body.title'],
     ['safety', '安全校验', 'extra_body.safety_check']].forEach(function (row) {
      var key = row[0];
      var on = key === 'title'
        ? !!(extra.title && extra.title.enabled !== false)
        : !!extra.safety_check;
      /* div 不是 label：整行是 label 时点一下开关会冒泡到 label 上再触发一次
         click，等于来回翻两下（实测开关点一次最后仍是原状态）。 */
      var line = el('div', 'ui-panel-row dsx-row');
      var left = el('div', 'ui-panel-row-main dsx-l');
      left.append(el('span', 'ui-panel-row-title dsx-n', row[1]));
      left.append(el('code', 'ui-panel-row-sub dsx-k', row[2]));
      var sw = el('button', 'ui-switch dsx-sw' + (on ? ' on' : ''));
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
      sw.setAttribute('aria-label', row[1]);
      sw.onclick = function () {
        var next = !sw.classList.contains('on');
        var nxt = JSON.parse(JSON.stringify(extra));
        if (key === 'title') { if (next) nxt.title = { enabled: true }; else delete nxt.title; }
        else { if (next) nxt.safety_check = { level: 'high' }; else delete nxt.safety_check; }
        var paint = function (on) {
          sw.classList.toggle('on', on);
          sw.setAttribute('aria-checked', on ? 'true' : 'false');
        };
        /* 先翻，再落盘：以前等后端回来才变，看着就是「按了没反应」 */
        paint(next);
        var prev = extra;
        extra = nxt;
        if (opts.onChange) { opts.onChange(nxt, key, next); return; }
        var p = M.mutate({ action: 'update', id: prov.id, changes: { request_extra: nxt }, revision: (S.catalog || {}).revision },
          { done: (next ? '已开启 ' : '已关闭 ') + row[1], body: '写入 providers.<id>.extra_body' });
        if (p && typeof p.then === 'function') {
          p.then(function (r) {
            if (r && r.ok === false) { extra = prev; paint(!next); }
          }, function () { extra = prev; paint(!next); });
        }
      };
      line.append(left, sw);
      card.append(line);
    });
    out.append(card);
    return out;
  }

  M.pages.dsServerParams = dsServerParams;

  /* 服务商分派器 */
  M.pages.providers = function (S) {
    var tab = (S.tab && S.tab.providers) || 'llm';
    if (tab === 'keys') return providersKeys(S);
    return providersLlm(S);
  };

  /* ── 能力后端 ───────────────────────────────────────── */
  var backendFilter = 'all';

  /* ── 能力后端 · 全部域 ──────────────────────────────── */
  /* 能力卡上的凭据区：这张卡当前选的来源要哪把钥匙、配了没有、去哪儿填。
     以前只有生图卡在 meta 里塞一句「FAL_KEY · 未配置」，别的卡什么都没有，
     用户得自己猜到「密钥」页去找 —— 而现在密钥页显示的是变量名，对不上号。 */
  function credBlock(S, d) {
    var creds = d.creds || [];
    var wrap = el('div', 'cardcred');
    // 「密钥」提成整块的小标题：有凭据的卡和没凭据的卡否则长得不一样，
    // 用户扫一排卡片时会觉得有的卡少了点东西。
    wrap.append(el('div', 'credhead', '密钥'));
    if (!creds.length) {
      // 空着最误导：一张卡什么都不提，会被当成「漏了没配」。
      var plain = el('div', 'credrow');
      var text = d.cred_state === 'inherit' ? '继承主模型，无需单独密钥'
        : d.cred_state === 'unset' ? '还没选来源'
        : '无需密钥（本机运行）';
      plain.append(el('span', 'mini credreuse', text));
      wrap.append(plain);
      return wrap;
    }
    creds.forEach(function (c) {
      var line = el('div', 'credrow' + (c.configured ? '' : ' miss'));
      line.append(el('span', 'credname', c.label));
      if (c.reuse) {
        line.append(el('span', 'mini credreuse', c.hint || '用服务商页配好的那条'));
      } else {
        line.append(el('span', 'mono credvar', c.name));
        line.append(c.configured ? badge('已配', 'ok') : badge('缺', 'err'));
        line.append(btn(c.configured ? '改值' : '填值', 'btn sm' + (c.configured ? '' : ' primary'),
          function () {
            if (!M.sheets.keyEdit) return;
            M.sheets.keyEdit(S, { name: c.name, label: c.label, configured: c.configured,
                                   hint: c.hint, used_by: [d.label], orphans: [] });
          }));
      }
      wrap.append(line);
    });
    return wrap;
  }
  /* 导出给编辑弹层用：凭据块跟着卡片一起搬进弹层，两处各画一遍迟早走样。 */
  M.credBlock = credBlock;

  function backendsAll(S) {
    var out = frag();
    var domains = (S.backends && S.backends.domains) || [];

    out.append(ph('能力后端', '按工具域注册 · 与 LLM provider 独立', [
      btn('+ 自定义来源', 'btn sm primary', function () { M.sheets.backendCustom && M.sheets.backendCustom(S); })
    ]));

    /* 类型筛选：用真实的三类状态，不硬造分类 */
    var filters = el('div', 'chips');
    [['all', '全部'], ['本页可配', '本页可配'], ['需二改', '需二改']].forEach(function (row) {
      var chipBtn = btn(row[1], 'chip' + (backendFilter === row[0] ? ' pri' : ''), function () {
        backendFilter = row[0];
        M.render();
      });
      chipBtn.style.cursor = 'pointer';
      filters.append(chipBtn);
    });
    out.append(filters);

    var shown = domains.filter(function (d) {
      if (backendFilter === 'all') return true;
      return d.status === backendFilter;
    });

    var cards = el('div', 'cards');
    shown.forEach(function (d) {
      var card = el('div', 'pcard backend');
      card.style.setProperty('--accent', d.writable ? '#4d7fd6' : '#bc4c3d');
      var top = el('div', 'top');
      var em = el('span', 'emblem');
      em.append(svgIcon(ICONS[BACKEND_ICON[d.key] || 'cap'], 15));
      top.append(em, badge(d.status, d.status_tone));
      card.append(top);
      card.append(el('div', 'nm', d.label));
      card.append(el('div', 'url mono', d.path));
      var meta = el('div', 'meta');
      var currentText = d.provider || (d.detail && d.detail.model) || '未设置';
      meta.append(chip(currentText, true));
      if (d.detail && d.detail.model && d.provider) meta.append(chip(d.detail.model));
      if (d.detail && d.detail.language) meta.append(chip('语言 ' + d.detail.language));
      if (d.detail && d.detail.providers) meta.append(chip(d.detail.providers + ' 个提供方'));
      if (d.note && d.kernel !== false) meta.append(chip(d.note));
      /* 密钥状态进摘要：外层留一眼就能看出「这张卡还缺东西」，不用点开弹层才知道。
         只说缺哪个，已配的不占地方 —— 七八张卡全列「已配」等于没有信息。 */
      var missingCreds = (d.creds || []).filter(function (c) { return !c.configured && !c.reuse; });
      if (missingCreds.length) {
        meta.append(chip('缺 ' + missingCreds.map(function (c) { return c.name; }).join(' / '), false));
      }
      card.append(meta);

      /* 内核不读这张卡的键（目前只有 ocr）这句提示已经搬进「编辑」弹层
         （2026-11-17 用户原话：这个元素把卡片撑开了，放到打开编辑后的面板里去）。
         卡片外层只留摘要，警告属于「点开才知道」的那类细节。 */

      /* 外层只留摘要，所有可编辑的东西（来源、密钥、模型、参数）全进「编辑」弹层。
         以前是整块内联展开：一屏七八张卡各自摊着下拉框、密钥行、保存按钮，
         想改哪张得先在一堆控件里把它认出来，改完还得担心点错行。 */
      var cardFoot = el('div', 'foot');
      if (d.writable) {
        cardFoot.append(btn('编辑', 'btn sm', function () {
          if (M.sheets.backendEdit) M.sheets.backendEdit(S, d);
        }));
      } else {
        cardFoot.append(el('span', 'mini', '跟随服务商原生能力，没有独立配置项'));
      }
      card.append(cardFoot);
      cards.append(card);
    });
    if (!shown.length) cards.append(el('div', 'empty', '这个筛选下没有卡'));
    out.append(cards);

    /* DS 官方端点：只用实测过的能力矩阵，没有就不显示 */
    var caps = (S.caps && (S.caps.caps || S.caps.rows)) || null;
    if (caps && caps.length) {
      out.append(sec('DS 官方端点', '实测过的接口能力'));
      var chipsRow = el('div', 'chips');
      caps.slice(0, 12).forEach(function (cap) {
        var ok = cap.ok !== false && cap.status !== 'fail';
        chipsRow.append(chip((cap.name || cap.label || cap.key || '') + ' · ' + (ok ? '通过' : '失败')));
      });
      out.append(chipsRow);
    }

    out.append(panel('每个域怎么改', [
      el('p', 'mini', '来源直接在本页选、保存即写入 config.yaml；语音（stt/tts）与视觉（vision）也内联在这里，不再跳专属编辑器。'),
      el('p', 'mini', '凭据就在卡片上：选完来源，卡里会列出它要的变量、显示配了没有，点「填值」直接写 .env。不用自己记变量名。'),
      el('p', 'mini', '文字识别这张卡特殊：内核没有 ocr 配置段（hermes-src 里 grep baimiao 是 0 命中），真干活的是 baimiao-ocr 技能，它只读 .env 的 BAIMIAO_USER / BAIMIAO_PASS。所以这张卡的选项只当备忘。'),
      el('p', 'mini', '生图选「自定义中转站」时没有独立凭据，直接复用你选的那条 LLM 服务的地址和密钥。三套端点自动依次尝试：/v1/images/generations → /v1/chat/completions → /v1beta/models/<模型>:generateContent，哪套通就用哪套。'),
      el('p', 'mini', '入站接口（把本机当模型给别的程序调）不在这里，状态由语音配置服务统一读取，见概览页的「入站接口」链路。')
    ]));
    return out;
  };

  /* ── 能力后端 · DeepSeek 落点 ───────────────────────── */
  var DS_CAP_LANDING = {
    models: 'providers · 服务商',
    chat_basic: 'model.default · 主模型',
    chat_thinking: 'extra_body.thinking',
    chat_title: 'extra_body.title',
    chat_safety: 'extra_body.safety_check',
    chat_search: 'deepseek_web_search 工具',
    chat_readurl: 'deepseek_read_url 工具',
    chat_reminder: 'latest_reminder · 主模型',
    chat_file: 'deepseek /files',
    tool_search: 'web.backend · 搜索',
    tool_fetch: 'web.backend · 抓取',
    tool_ocr: '无独立槽位 · 跟随服务商',
    tool_asr: 'stt.provider',
    tool_tts: 'tts.provider'
  };

  /* ── DeepSeek 落点：上方选一个供应商的一个模型，下方列全部功能，一键全测 ──
     2026-11-23 主人定：原来这里是「59 模型 × 6 能力」的横向矩阵，跑偏了。
     原思路是「测现有 DeepSeek 的所有功能」，落点对的是「能力 → 落到哪个配置对象」，
     不是「哪个模型能不能说话」。所以现在：
       上：供应商下拉 + 模型下拉 + 一键全测
       下：全部功能逐条列，每条带「落到哪」和实测证据
     能力不足的统一在 S.dsCaps/S.dsRuns 里，切供应商不用重新拉清单。 */
  function backendsDs(S) {
    var out = frag();
    out.append(ph('DeepSeek 落点', '选一个供应商的一个模型，下方全部功能一键全测'));

    var view = S.dsView || null;
    if (!view) {
      out.append(el('div', 'empty', '正在读取已添加的服务商…'));
      M.sheets.loadDsSuite && M.sheets.loadDsSuite(S);
      return out;
    }

    var providers = view.providers || [];
    var caps = view.caps || [];
    /* 默认选谁：优先「主模型所在的那个供应商」——那才是用户日常在用的通道，
       测它才有意义。没有 main 标记就退回第一个（2026-11-23 实测：默认落到
       排序第一的 fan，它只有 deepseek-v4-pro，一键全测 0/14，纯属配错对象）。 */
    if (!S.dsProvider && providers.length) {
      var main = providers.filter(function (p) { return p.main; })[0];
      S.dsProvider = (main || providers[0]).id;
    }
    var cur = providers.filter(function (p) { return p.id === S.dsProvider; })[0] || providers[0];
    if (!cur) {
      out.append(el('div', 'empty', '还没有已添加的服务商，先去「通用模型」加一条。'));
      return out;
    }
    if (!S.dsModel || !(cur.models || []).some(function (m) { return m.id === S.dsModel; })) {
      /* 模型也优先挑 DeepSeek 的：这是「DS 落点」页，默认落在 GLM 上等于没测到正题。 */
      var ds = (cur.models || []).filter(function (m) { return /deepseek/i.test(m.id); })[0];
      S.dsModel = (ds || (cur.models || [])[0] || {}).id || '';
    }

    /* 上方选择栏：供应商 → 模型 → 一键全测 */
    var bar = el('div', 'dsbar');
    var selP = el('select', 'dssel');
    providers.forEach(function (p) {
      var o = el('option', '', p.name + '（' + (p.models || []).length + ' 个模型）');
      o.value = p.id;
      if (p.id === S.dsProvider) o.selected = true;
      selP.append(o);
    });
    selP.addEventListener('change', function () {
      S.dsProvider = selP.value;
      S.dsModel = '';
      M.render();
    });
    bar.append(selP);

    var selM = el('select', 'dssel');
    (cur.models || []).forEach(function (m) {
      var o = el('option', '', m.id + (m.enabled === false ? '（已停用）' : ''));
      o.value = m.id;
      if (m.id === S.dsModel) o.selected = true;
      selM.append(o);
    });
    selM.addEventListener('change', function () { S.dsModel = selM.value; M.render(); });
    bar.append(selM);

    var running = !!S.dsBusy;
    var runBtn = btn(running ? '正在跑…' : '一键全测', 'btn pri', function () {
      if (running) return;
      S.dsBusy = true;
      S.dsRuns = {};
      S.dsError = '';
      M.render();
      runDsSuite(S, S.dsProvider, S.dsModel);
    });
    if (running) runBtn.disabled = true;
    bar.append(runBtn);

    var got = (S.dsRuns || {});
    var done = Object.keys(got).length;
    if (done && !running) {
      var pass = Object.keys(got).filter(function (k) { return got[k] && got[k].ok; }).length;
      bar.append(el('span', 'mini', '通过 ' + pass + '/' + done +
        (S.dsSeconds ? ' · ' + S.dsSeconds + 's' : '')));
    } else if (!done) {
      bar.append(el('span', 'mini', '共 ' + caps.length + ' 项功能，每一项真发请求，不看 HTTP 200 就算过。'));
    }
    out.append(bar);
    if (S.dsError) out.append(el('div', 'empty', S.dsError));

    /* 下方功能卡片：对齐「模型-能力后端-全部域」那套 pcard 视觉。
       头像徽章 MO/CH/TO/G 直接复用 .emblem 圆形 —— 之前把它们打成正文文字，
       主人原话「你的名字上的 MO、ch 那是原来的卡片头像，你弄成文字干嘛」。
       通用五项（连通性/流式/函数调用/json/识图）单列一组，它们是「这条线能不能
       拿来干活」的底线，不是 DeepSeek 专属功能。 */
    var EMBLEM = { models: 'MO', chat: 'CH', tools: 'TO', generic: 'G' };
    var ACCENT = { models: 'var(--primary)', chat: 'var(--accent,var(--primary))',
                   tools: 'var(--warn,var(--primary))', generic: 'var(--ok,var(--primary))' };
    var groups = [
      ['models', '模型清单', 'GET /models'],
      ['chat', '对话内能力', '走 /chat/completions'],
      ['tools', '独立接口', '不走对话，单独端点'],
      ['generic', '通用能力', '任何 OpenAI 兼容通道的底线']
    ];
    groups.forEach(function (g) {
      /* models 那一项在后端 CAPS 里 group 标的是 chat（它确实走 /models 端点，
         但语义上属于「模型清单」），所以这里按 id 单独拎出来，否则 MO 徽章
         永远不出现，模型清单会混在 CH 组里（2026-11-23 实测）。 */
      var items = caps.filter(function (c) {
        if (g[0] === 'generic') return c.generic;
        if (g[0] === 'models') return c.id === 'models';
        return c.group === g[0] && !c.generic && c.id !== 'models';
      });
      if (!items.length) return;
      out.append(sec(g[1], g[2]));
      var grid = el('div', 'cards dscards');
      items.forEach(function (cap) {
        var cell = got[cap.id] || null;
        var state = !cell ? 'idle' : (cell.ok ? 'ok' : 'bad');
        var card = el('div', 'pcard dscard ' + state);
        var top = el('div', 'top');
        var em = el('span', 'emblem', EMBLEM[g[0]] || '·');
        em.style.background = ACCENT[g[0]] || 'var(--primary)';
        top.append(em);
        if (cell) top.append(el('span', 'chip ' + (cell.ok ? 'ok' : 'bad'),
          cell.ok ? '通过' : '不支持'));
        else top.append(el('span', 'chip', '未测'));
        card.append(top);
        card.append(el('div', 'nm', cap.label));
        card.append(el('div', 'url mono', cap.target));
        var meta = el('div', 'meta');
        if (cell) {
          meta.append(el('span', 'chip', 'HTTP ' + cell.status));
          meta.append(el('span', 'chip', cell.ms + 'ms'));
        } else {
          meta.append(el('span', 'chip', '待测'));
        }
        card.append(meta);
        var foot = el('div', 'foot');
        var desc = el('div', 'mini', cell ? (cell.label || '') : cap.desc);
        foot.append(desc);
        if (cell) {
          var ev = el('div', 'mini dsev', (cell.evidence || '').slice(0, 140));
          ev.title = cell.evidence || '';
          foot.append(ev);
        }
        /* 思考强度：细粒度档位条，不是开/关两态。每档真打一次，
           reasoning_tokens 直接标在条上，哪档被上游吞了一眼看得见。 */
        if (cell && cap.id === 'thinking' && (cell.levels || []).length) {
          var gantt = el('div', 'dsgantt');
          var maxRt = Math.max.apply(null, cell.levels.map(function (x) { return x.rt || 0; }).concat([1]));
          cell.levels.forEach(function (L) {
            var row = el('div', 'dsgantt-row');
            var lb = el('span', 'dsgantt-lb', L.level);
            row.append(lb);
            var track = el('div', 'dsgantt-track');
            var fillBar = el('div', 'dsgantt-fill' + (L.ok ? '' : ' bad'));
            fillBar.style.width = Math.max(6, Math.round((L.rt || 0) / maxRt * 100)) + '%';
            track.append(fillBar);
            row.append(track);
            row.append(el('span', 'dsgantt-val', (L.ok ? (L.rt + 't') : '失败')));
            gantt.append(row);
          });
          foot.append(gantt);
        }
        card.append(foot);
        grid.append(card);
      });
      out.append(grid);
    });

    out.append(panel('这些功能落在配置的哪里', [
      el('p', 'mini', '对话内能力靠 provider 的 extra_body 和服务端工具；独立接口落在 web/stt/tts 各自后端。'),
      el('p', 'mini', '「不支持」和「参数被吞」要分开看：前者接口根本没有这个端点（常见于中转），后者回 200 但参数没生效——后者最坑，配置里看着能用。'),
      el('p', 'mini', '全测只发请求、只读结果，不写 config.yaml，不碰 revision。')
    ]));
    return out;
  }

  /* 一键全测：一次请求跑完全部能力项。
     慢模型（思考模式默认开会把 max_tokens 吃光）可能跑 60 秒以上，所以前端
     超时单独放 240 秒，和保存探测那条硬超时保持一致。 */
  function runDsSuite(S, provider, model) {
    fetch(apiUrl('/api/panel-models'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Monitor-Token': window.monitorToken || '' },
      body: JSON.stringify({ action: 'ds_suite_run', provider: provider, model: model }),
      cache: 'no-store'
    }).then(function (r) { return r.json(); }).then(function (out) {
      S.dsBusy = false;
      if (!out || !out.ok) throw Error((out && out.error) || '全测失败');
      S.dsRuns = out.results || {};
      S.dsSeconds = out.seconds || 0;
      M.render();
    }).catch(function (error) {
      S.dsBusy = false;
      S.dsError = error.message || '全测失败';
      M.render();
    });
  }

  M.sheets.runDsSuite = runDsSuite;

  M.sheets.loadDsSuite = function (S) {
    fetch(apiUrl('/api/panel-models'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Monitor-Token': window.monitorToken || '' },
      body: JSON.stringify({ action: 'ds_suite_view' }), cache: 'no-store'
    }).then(function (r) { return r.json(); }).then(function (out) {
      S.dsView = out || null;
      M.render();
    }).catch(function () { S.dsView = S.dsView || null; M.render(); });
  };

  /* 能力后端分派器 */
  M.pages.backends = function (S) {
    var tab = (S.tab && S.tab.backends) || 'all';
    if (tab === 'ds') return backendsDs(S);
    return backendsAll(S);
  };

  /* ── 工具集 ─────────────────────────────────────────── */
  M.pages.toolsets = function (S) {
    var out = frag();
    var data = S.toolsets || {};
    var rows = data.toolsets || [];
    var gateway = data.gateway || {};

    out.append(ph('工具集', 'toolsets · platform_toolsets.' + (data.platform || 'api_server'), [
      btn('恢复平台默认', 'btn sm', function () {
        M.mutate({ action: 'save_toolsets', platform: data.platform, follow_default: true, revision: data.revision },
          { done: '已恢复平台默认', body: '删掉 platform_toolsets 里这个平台的自定义清单，回到内核默认组合' });
      })
    ]));

    var split = el('div', 'split');
    var left = el('div');

    var note = data.follow_default
      ? '当前跟随平台默认（' + (data.default_name || '') + '），点卡片会写入显式清单'
      : '写入 platform_toolsets / agent.disabled_toolsets';
    left.append(sec('启用', note));

    var grid = el('div', 'tsgrid');
    rows.forEach(function (row) {
      var card = btn('', 'tscard' + (row.enabled ? ' on' : ''), function () {
        var next = rows.filter(function (r) {
          if (r.name === row.name) return !r.enabled;
          return r.enabled;
        }).map(function (r) { return r.name; });
        M.mutate({ action: 'save_toolsets', platform: data.platform, enabled: next, revision: data.revision },
          { done: (row.enabled ? '已关闭 ' : '已开启 ') + toolsetLabel(row.name) + '（' + row.name + '）',
            body: '对新会话生效；当前会话的助手工具集在下一轮重新装载' });
      });
      card.append(el('span', 'tsn', toolsetLabel(row.name)));
      card.append(el('span', 'mono', row.name));
      card.append(dot(row.enabled ? 'ok' : 'idle'));
      grid.append(card);
    });
    left.append(grid);

    /* Tool Gateway：网关真实开关（不是 Nous Portal 订阅那套，如实标注） */
    left.append(sec('Tool Gateway', 'gateway.* · 网关真实开关'));
    var gwRows = [];
    gwRows.push(kv('gateway.strict', badge(gateway.strict ? '开启' : '关闭', gateway.strict ? 'ok' : '')));
    gwRows.push(kv('gateway.trust_recent_files', badge(gateway.trust_recent_files ? '信任' : '不信任', gateway.trust_recent_files ? 'ok' : '')));
    gwRows.push(kv('gateway.trust_recent_files_seconds', String(gateway.trust_recent_files_seconds == null ? '—' : gateway.trust_recent_files_seconds)));
    gwRows.push(kv('gateway.media_delivery_allow_dirs', (gateway.media_delivery_allow_dirs || []).length + ' 个目录'));
    var toggleStrict = btn(gateway.strict ? '关闭严格模式' : '开启严格模式', 'btn sm', function () {
      M.mutate({ action: 'save_toolsets', platform: data.platform, gateway: { strict: !gateway.strict }, revision: data.revision },
        { done: '网关严格模式已' + (gateway.strict ? '关闭' : '开启'), body: '写入 config.yaml 的 gateway.strict' });
    });
    gwRows.push(toggleStrict);
    left.append(panel('', gwRows));
    split.append(left);

    var aside = el('div', 'aside');
    var secRows = [];
    secRows.push(kv('security.allow_private_urls', badge(data.allow_private_urls ? '已允许' : '默认 false', data.allow_private_urls ? 'warn' : 'ok')));
    secRows.push(el('p', 'mini', '自定义内网地址（Ollama、自建 Whisper、SearXNG、局域网 OCR）必须开启，否则 URL 工具会拦截私网。'));
    secRows.push(btn(data.allow_private_urls ? '禁止私网地址' : '允许私网地址', 'btn sm block', function () {
      M.mutate({ action: 'save_toolsets', platform: data.platform, allow_private_urls: !data.allow_private_urls, revision: data.revision },
        { done: '已' + (data.allow_private_urls ? '禁止' : '允许') + '私网地址', body: '写入 config.yaml 的 security.allow_private_urls' });
    }));
    aside.append(panel('安全边界', secRows));

    aside.append(panel('生效', [
      kv('工具集变更', '/reset 新会话'),
      kv('CLI', '下次启动'),
      kv('Gateway', '下个新会话'),
      kv('安全边界', '立即生效')
    ]));
    split.append(aside);
    out.append(split);
    return out;
  };

  /* ── 配置 · config.yaml ─────────────────────────────── */
  function configYaml(S) {
    var out = frag();
    var preview = S.preview || {};
    var text = preview.text || '（读取失败）';

    out.append(ph('config.yaml', '写入 Hermes 原生字段', [
      btn('复制', 'btn sm', async function () {
        try {
          await navigator.clipboard.writeText(text);
          M.toast('已复制', preview.lines + ' 行 · ' + preview.bytes + ' 字节');
        } catch (error) {
          M.toast('复制失败', '浏览器拒绝了剪贴板访问：' + error.message, 'bad');
        }
      }),
      btn('写入', 'btn sm primary', function () { M.sheets.configWrite && M.sheets.configWrite(S); })
    ]));

    var head = badge(preview.masked ? '已脱敏' : '已同步', preview.masked ? 'warn' : 'ok');
    out.append(panel('文件预览', [
      code(text),
      el('p', 'mini', (preview.lines || 0) + ' 行 · ' + (preview.bytes || 0) + ' 字节 · 密钥值已替换为 ****（已隐藏），写回时不会带上这些掩码')
    ], head));
    return out;
  };

  /* ── 配置 · 生效与写入 ──────────────────────────────── */
  function configApply(S) {
    var out = frag();
    out.append(ph('生效与写入', '每个写操作的属性'));
    var split = el('div', 'split');
    var left = el('div');
    var cat = S.catalog || {};
    var auxTasks = (S.aux && S.aux.tasks) || [];
    var ownCount = auxTasks.filter(function (t) { return t.provider && t.provider !== 'auto'; }).length;
    var domains = (S.backends && S.backends.domains) || [];
    var toolsets = S.toolsets || {};
    left.append(panel('本次改动', [
      kv('model.default', (cat.primary && cat.primary.model) || '—'),
      kv('单独指定槽位', ownCount + ' / ' + auxTasks.length),
      kv('fallback_providers', (cat.fallbacks || []).length + ' 条'),
      kv('能力后端', domains.length + ' 域'),
      kv('工具集', (toolsets.count_enabled || 0) + ' 启用')
    ], badge('已同步', 'ok')));
    var audit = (S.audit && S.audit.snapshots) || [];
    if (audit.length) {
      var rows = audit.slice(0, 15).map(function (item) {
        var when = item.at ? new Date(item.at * 1000).toLocaleString('zh-CN', { hour12: false }) : '';
        var row = el('div', 'kv');
        row.append(el('span', null, (when || '') + ' · ' + item.name.split('-')[0]));
        var right = el('b');
        right.append(el('span', 'mono', item.bytes + ' 字节'));
        row.append(right);
        return row;
      });
      left.append(panel('操作记录', rows));
    }
    split.append(left);
    var aside = el('div', 'aside');
    aside.append(panel('生效边界', [
      kv('CLI', '下次启动'),
      kv('Gateway', '下个新会话'),
      kv('当前会话换模型', '/model'),
      kv('工具集变更', '/reset'),
      el('p', 'mini', '辅助槽位改了没生效：先看是否新会话、是否仍为 auto、目标服务是否缺凭据。')
    ]));
    var chipsRow = el('div', 'chips');
    ['hermes model', 'hermes fallback', 'hermes tools', 'hermes config set'].forEach(function (c) {
      chipsRow.append(chip(c, true));
    });
    aside.append(panel('可复现', [chipsRow]));
    split.append(aside);
    out.append(split);
    return out;
  }

  /* 配置分派器 */
  M.pages.config = function (S) {
    var tab = (S.tab && S.tab.config) || 'yaml';
    if (tab === 'apply') return configApply(S);
    return configYaml(S);
  };
})();

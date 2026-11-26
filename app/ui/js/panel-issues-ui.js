/* panel-issues-ui.js — 右上角「反馈」入口与提交表单
 *
 * 为什么要有：GitHub 按钮对普通人等于不存在——不会注册、不会提 issue，
 * 反馈就直接丢了。这里做成站内表单：点板块、写两句、填个名字就提交，
 * 落进面板自己的收件箱（var/issues/issues.jsonl），不依赖任何外部账号。
 *
 * 交互约定：
 *  - 板块是两级树，先点一级再点二级；只点一级也能提交（不强迫细分）
 *  - 名字、标题、正文三项都必填，缺哪项就地提示，不弹 alert
 *  - 提交成功后原地显示编号，表单清空但保留名字（同一个人常连着报）
 *  - 失败必须把后端那句原因原样显示出来，不能只说"提交失败"
 */
(function () {
  var TAXONOMY = null;       /* 缓存分类树，第二次打开直接复用 */
  var LAST_NAME_KEY = 'chates.issue.name';
  /* 没送出去的反馈（网络抖动、星图限流）暂存本机，下次打开面板补发。
     为什么要有：上报是 fire-and-forget，失败是静默的 —— 用户看到"已收到"
     （本地确实存了），但我这边一条都没有。装在他电脑上的本地记录我永远读不到，
     所以必须补发，否则又回到"石沉大海"。只存最近 20 条，防止 localStorage 涨。 */
  var PENDING_KEY = 'chates.issue.pending';
  var PENDING_MAX = 20;

  function esc(s) { return DOM.escAttr(s); }

  function url(p) {
    try { if (typeof apiUrl === 'function') return apiUrl(p); } catch (e) {}
    return p;
  }

  function headers() {
    var h = { 'Content-Type': 'application/json' };
    try { if (typeof monitorToken !== 'undefined' && monitorToken) h['X-Monitor-Token'] = monitorToken; } catch (e) {}
    return h;
  }

  function rememberedName() {
    try { return localStorage.getItem(LAST_NAME_KEY) || ''; } catch (e) { return ''; }
  }

  function rememberName(n) {
    try { localStorage.setItem(LAST_NAME_KEY, n); } catch (e) {}
  }

  function version() {
    /* 顶栏只挂 GitHub 发布版号；取不到再退到 package 自带版本 */
    try {
      var el = document.getElementById('brandVerGh');
      var t = el ? String(el.textContent || '').replace(/^v/i, '').trim() : '';
      if (!t) { try { t = String(window.__APP_VER__ || '').trim(); } catch (e2) {} }
      return t;
    } catch (e) { return ''; }
  }

  /* ─── 弹层骨架 ─────────────────────────────────────────────── */
  function buildOverlay() {
    var ov = document.createElement('div');
    ov.className = 'pw-issue-ov';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.innerHTML = ''
      + '<div class="pw-issue-card">'
      +   '<div class="pw-issue-head">'
      +     '<h3>提交问题</h3>'
      +     '<button class="pw-issue-x" type="button" aria-label="关闭">×</button>'
      +   '</div>'
      +   '<div class="pw-issue-body">'
      +     '<label class="pw-issue-lb">问题板块 <i>必选</i></label>'
      +     '<div class="pw-issue-groups" id="pwIssueGroups"></div>'
      +     '<div class="pw-issue-leaves" id="pwIssueLeaves"></div>'
      +     '<div class="pw-issue-picked" id="pwIssuePicked">未选择</div>'
      +     '<label class="pw-issue-lb" for="pwIssueTitle">问题标题 <i>必填</i></label>'
      +     '<input class="pw-issue-in" id="pwIssueTitle" type="text" maxlength="200" placeholder="一句话说清什么问题">'
      +     '<label class="pw-issue-lb" for="pwIssueDetail">具体问题 <i>必填</i></label>'
      +     '<textarea class="pw-issue-ta" id="pwIssueDetail" maxlength="8000" placeholder="怎么操作、看到了什么、期望是什么"></textarea>'
      +     '<label class="pw-issue-lb" for="pwIssueName">你的名字 <i>必填</i></label>'
      +     '<input class="pw-issue-in" id="pwIssueName" type="text" maxlength="64" placeholder="方便我知道是谁提的">'
      +     '<div class="pw-issue-msg" id="pwIssueMsg"></div>'
      +   '</div>'
      +   '<div class="pw-issue-foot">'
      +     '<button class="pw-issue-btn ghost" type="button" id="pwIssueCancel">取消</button>'
      +     '<button class="pw-issue-btn primary" type="button" id="pwIssueSend">提交</button>'
      +   '</div>'
      + '</div>';
    return ov;
  }

  function showMsg(card, text, kind) {
    var el = card.querySelector('#pwIssueMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'pw-issue-msg' + (kind ? ' ' + kind : '');
  }

  /* ─── 分类树渲染 ───────────────────────────────────────────── */
  var pickedGroup = null;
  var pickedLeaf = null;

  function renderGroups(card) {
    var box = card.querySelector('#pwIssueGroups');
    box.innerHTML = '';
    (TAXONOMY || []).forEach(function (g) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pw-issue-chip';
      b.textContent = g.label;
      b.setAttribute('data-gid', g.id);
      b.onclick = function () {
        pickedGroup = g.id;
        pickedLeaf = null;
        renderGroups(card);
        renderLeaves(card, g);
        updatePicked(card);
      };
      if (pickedGroup === g.id) b.classList.add('on');
      box.appendChild(b);
    });
  }

  function renderLeaves(card, group) {
    var box = card.querySelector('#pwIssueLeaves');
    box.innerHTML = '';
    if (!group) return;
    group.children.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pw-issue-chip sm';
      b.textContent = group.label + ' / ' + c.label;
      b.onclick = function () {
        pickedLeaf = c.id;
        renderLeaves(card, group);
        updatePicked(card);
      };
      if (pickedLeaf === c.id) b.classList.add('on');
      box.appendChild(b);
    });
  }

  function pickedId() { return pickedLeaf || pickedGroup || ''; }

  function updatePicked(card) {
    var el = card.querySelector('#pwIssuePicked');
    if (!el) return;
    var id = pickedId();
    if (!id) { el.textContent = '未选择'; el.className = 'pw-issue-picked'; return; }
    var label = id;
    (TAXONOMY || []).forEach(function (g) {
      if (g.id === id) label = g.label;
      g.children.forEach(function (c) {
        if (c.id === id) label = g.label + ' / ' + c.label;
      });
    });
    el.textContent = '已选：' + label;
    el.className = 'pw-issue-picked ok';
  }

  /* ─── 提交 ─────────────────────────────────────────────────── */
  /* --- 上报星图（2026-11-26）---
   *
   * 本地 /api/issue 只写本机 var/issues/issues.jsonl —— 装在别人电脑上时
   * 那条记录永远躺在对方硬盘里，我这边收不到。所以本地记录之外再推一份到星图，
   * 由 NAS 上的 cron 转成 GitHub issue。
   *
   * 为什么是「额外推一份」而不是「只推星图」：
   *   本地那份是用户自己能在汇总视图里看到的，砍掉他这边就空了；
   *   星图那份是给我看的。两边各留各的，互不依赖。
   *
   * 失败不打扰用户：星图不通就当没这回事，本地提交已经成功了，
   * 给他弹一个「上传失败」纯属添堵。
   */
  /* 星图上报地址。写死是故意的 —— 见下面 why。
   *
   * why 不放配置、不读环境变量、不让客户端持有任何密钥：
   *   分发出去的每个安装包都要能提交，不能让用户配任何东西。
   *   原实现要求 CHATES_SHELL.reportCode（preload 从环境变量读），结果
   *   (a) 网页版没有这个对象 → 静默跳过；
   *   (b) 别人装的 exe 没配环境变量 → 也静默跳过。
   *   等于只有开发者本机能用。所以码整条路砍掉。
   *
   * 滥用防线在服务端，不靠客户端持有的秘密：
   *   来源指纹（sha256 后存，不存明文 IP）+ 双层限流 + 同内容去重
   *   + 只写不读（数据在 .data 点目录，nginx 不服务）+ 长度上限。
   *
   * 想换地址只需改这一行，所有客户端下次更新自动跟随。
   */
  var REPORT_URL = 'https://ruibing.wang/report/';

  function pendingRead() {
    try {
      var raw = localStorage.getItem(PENDING_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function pendingWrite(arr) {
    try {
      if (!arr || !arr.length) localStorage.removeItem(PENDING_KEY);
      else localStorage.setItem(PENDING_KEY, JSON.stringify(arr.slice(-PENDING_MAX)));
    } catch (e) {}
  }

  function pendingPush(body) {
    var arr = pendingRead();
    var fp = (body.title || '') + '|' + (body.body || '');
    for (var i = 0; i < arr.length; i++) {
      if (((arr[i].title || '') + '|' + (arr[i].body || '')) === fp) return;
    }
    arr.push(body);
    pendingWrite(arr);
  }

  /* 把队列里攒的补发掉。成功一条删一条；失败就留在队里等下次。 */
  function pendingFlush() {
    var arr = pendingRead();
    if (!arr.length) return;
    var shell = (typeof window !== 'undefined' && window.CHATES_SHELL) || null;
    var base = (shell && shell.reportUrl) ? String(shell.reportUrl) : REPORT_URL;
    if (!base) return;
    var api = base.replace(/\/?$/, '') + '/api.php?a=submit';
    var rest = [];
    var left = arr.length;
    arr.forEach(function (body) {
      fetch(api, {
        method: 'POST', mode: 'cors', credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (r) {
        if (!r.ok) rest.push(body);
      }).catch(function () {
        rest.push(body);
      }).then(function () {
        left -= 1;
        if (left === 0) pendingWrite(rest);
      });
    });
  }

  function reportUpstream(payload) {
    var shell = (typeof window !== 'undefined' && window.CHATES_SHELL) || null;
    /* 允许桌面版用注入值覆盖（比如内网调试指向本地星图），没有就用常量 */
    var base = (shell && shell.reportUrl) ? String(shell.reportUrl) : REPORT_URL;
    if (!base) return;

    var api = base.replace(/\/?$/, '') + '/api.php?a=submit';

    /* 面板分类是本地那套树，星图是扁平 id。对不上就报「其他」，
       别硬塞一个对方不认识的 id —— 那边会降级，但白跑一趟。 */
    var MAP = {
      'runtime-start': 'runtime-start',  'runtime-update': 'runtime-update',
      'runtime-perf':  'runtime-perf',   'runtime-error':  'runtime-error',
      'chat-render':   'chat-render',    'chat-stream':    'chat-stream',
      'chat-session':  'chat-session',   'chat-input':     'chat-input',
      'panel-model':   'panel-model',    'panel-nav':      'panel-nav',
      'panel-theme':   'panel-theme',    'panel-file':     'panel-file',
      'panel-voice':   'panel-voice',    'channel-recv':   'channel-recv',
      'channel-send':  'channel-send',   'channel-media':  'channel-media',
      'other-feature': 'other-feature',  'other-doc':      'other-doc',
      'other-misc':    'other-misc'
    };
    var cat = MAP[payload.category] || 'other-misc';

    var os = '';
    try {
      var ua = navigator.userAgent || '';
      if (/Windows NT 10/.test(ua)) os = 'Windows 10/11';
      else if (/Windows NT/.test(ua)) os = 'Windows';
      else if (/Mac OS X/.test(ua)) os = 'macOS';
      else if (/Linux/.test(ua)) os = 'Linux';
    } catch (e) {}

    /* from 标来源：桌面 exe（Electron 注入了 CHATES_SHELL）记 desktop，
       网页面板/公网入口记 web。以前写死 desktop，星图里所有记录都长一样，
       排查时区分不出是哪个客户端来的。 */
    var body = {
      category: cat,
      title: payload.title,
      body: payload.detail,
      contact: payload.name || '',
      env: { version: payload.version || '', os: os, from: (shell ? 'desktop' : 'web') }
    };

    /* credentials: omit —— 跨域 POST，别把本机 session 捎过去 */
    try {
      fetch(api, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (r) {
        /* 429（限流）与 5xx 也算没送到，攒着下次补 */
        if (!r.ok) pendingPush(body);
      }).catch(function () {
        pendingPush(body);          /* 网络不通同样攒着 */
      });
    } catch (e) {
      pendingPush(body);
    }
  }

  function submit(card) {
    var name = (card.querySelector('#pwIssueName').value || '').trim();
    var title = (card.querySelector('#pwIssueTitle').value || '').trim();
    var detail = (card.querySelector('#pwIssueDetail').value || '').trim();
    var category = pickedId();

    if (!category) { showMsg(card, '请先选择问题板块', 'err'); return; }
    if (!title)    { showMsg(card, '请填写问题标题', 'err'); return; }
    if (!detail)   { showMsg(card, '请描述具体问题', 'err'); return; }
    if (!name)     { showMsg(card, '请填写你的名字', 'err'); return; }

    var btn = card.querySelector('#pwIssueSend');
    btn.disabled = true;
    btn.textContent = '提交中…';
    showMsg(card, '', '');

    fetch(url('/api/issue'), {
      method: 'POST',
      headers: headers(),
      credentials: 'same-origin',
      body: JSON.stringify({
        name: name,
        category: category,
        title: title,
        detail: detail,
        version: version(),
        platform: navigator.platform || '',
        ua: navigator.userAgent || ''
      })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        return { ok: r.ok, body: j };
      });
    }).then(function (res) {
      btn.disabled = false;
      btn.textContent = '提交';
      var body = res.body || {};
      if (res.ok && body.ok) {
        rememberName(name);
        card.querySelector('#pwIssueTitle').value = '';
        card.querySelector('#pwIssueDetail').value = '';
        pickedGroup = null; pickedLeaf = null;
        renderGroups(card);
        card.querySelector('#pwIssueLeaves').innerHTML = '';
        updatePicked(card);
        /* 本地记完再推一份到星图，失败静默 */
        reportUpstream({
          name: name, category: category, title: title,
          detail: detail, version: version()
        });
        showMsg(card, '已收到，编号 ' + (body.item && body.item.id ? body.item.id : '—'), 'ok');
        /* 让汇总视图下次打开重新拉 */
        try { window._issueSummaryDirty = true; } catch (e) {}
      } else {
        showMsg(card, body.error || '提交失败，请稍后再试', 'err');
      }
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = '提交';
      showMsg(card, '网络不通，没能提交', 'err');
    });
  }

  /* ─── 汇总视图 ─────────────────────────────────────────────── */
  function renderSummary(card) {
    var box = card.querySelector('.pw-issue-body');
    box.innerHTML = '<div class="pw-issue-loading">读取中…</div>';
    fetch(url('/api/issue/summary'), { credentials: 'same-origin', headers: headers() })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) { box.innerHTML = '<div class="pw-issue-msg err">读取失败</div>'; return; }
        var h = '';
        h += '<div class="pw-issue-sumtop">共 ' + (j.total || 0) + ' 条反馈</div>';
        h += '<div class="pw-issue-sumgroups">';
        (j.groups || []).forEach(function (g) {
          h += '<div class="pw-issue-sumg"><span>' + esc(g.label) + '</span><b>' + g.count + '</b></div>';
        });
        h += '</div>';
        if (!j.recent || !j.recent.length) {
          h += '<div class="pw-issue-empty">还没有反馈</div>';
        } else {
          h += '<div class="pw-issue-list">';
          j.recent.forEach(function (it) {
            h += '<div class="pw-issue-item">'
              +  '<div class="pw-issue-itop"><b>' + esc(it.title) + '</b>'
              +  '<span>' + esc(it.categoryLabel || '') + '</span></div>'
              +  '<div class="pw-issue-idetail">' + esc(it.detail) + '</div>'
              +  '<div class="pw-issue-imeta">' + esc(it.name || '') + ' · '
              +  esc(String(it.createdAt || '').replace('T', ' ').slice(0, 16)) + '</div>'
              +  '</div>';
          });
          h += '</div>';
        }
        if (j.skipped) h += '<div class="pw-issue-msg err">有 ' + j.skipped + ' 条损坏记录已跳过</div>';
        box.innerHTML = h;
      })
      .catch(function () {
        box.innerHTML = '<div class="pw-issue-msg err">读取失败</div>';
      });
  }

  /* ─── 打开 ─────────────────────────────────────────────────── */
  function open(mode) {
    var old = document.querySelector('.pw-issue-ov');
    if (old) old.remove();

    var ov = buildOverlay();
    document.body.appendChild(ov);

    var card = ov.querySelector('.pw-issue-card');
    card.querySelector('.pw-issue-x').onclick = close;
    card.querySelector('#pwIssueCancel').onclick = close;

    if (mode === 'summary') {
      card.querySelector('.pw-issue-head h3').textContent = '反馈汇总';
      card.querySelector('.pw-issue-foot').innerHTML =
        '<button class="pw-issue-btn ghost" type="button" id="pwIssueBack">返回提交</button>';
      renderSummary(card);
      card.querySelector('#pwIssueBack').onclick = function () {
        ov.remove();
        openForm();
      };
      return;
    }

    openForm(ov);
  }

  function openForm(ov) {
    if (!ov) {
      var old = document.querySelector('.pw-issue-ov');
      if (old) old.remove();
      ov = buildOverlay();
      document.body.appendChild(ov);
      ov.querySelector('.pw-issue-x').onclick = close;
      ov.querySelector('#pwIssueCancel').onclick = close;
    }
    /* 打开面板就是"下次开机"，先把上回没送出去的补一遍 */
    try { pendingFlush(); } catch (e) {}

    var card = ov.querySelector('.pw-issue-card');
    card.querySelector('#pwIssueName').value = rememberedName();
    card.querySelector('#pwIssueSend').onclick = function () { submit(card); };

    var loadGroups = function (tax) {
      TAXONOMY = tax;
      renderGroups(card);
      showMsg(card, '', '');
      /* 名字已记住时把光标放到标题，省一次点击 */
      var t = card.querySelector('#pwIssueTitle');
      if (rememberedName() && t) t.focus();
      else card.querySelector('#pwIssueName').focus();
    };

    if (TAXONOMY) { loadGroups(TAXONOMY); return; }
    fetch(url('/api/issue/taxonomy'), { credentials: 'same-origin', headers: headers() })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok || !Array.isArray(j.taxonomy)) {
          showMsg(card, '板块加载失败', 'err');
          return;
        }
        loadGroups(j.taxonomy);
      })
      .catch(function () { showMsg(card, '板块加载失败', 'err'); });
  }

  function close() {
    var ov = document.querySelector('.pw-issue-ov');
    if (ov) ov.remove();
  }

  /* Esc 关闭 */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var ov = document.querySelector('.pw-issue-ov');
      if (ov) { ov.remove(); e.stopPropagation(); }
    }
  }, true);

  /* 右上角「问题反馈」图标：本地表单（2026-11-26 定稿）
   *
   * 表单先交到自己这一侧（POST /api/issue → <home>/var/issues/issues.jsonl），
   * 生成本地编号；成功后静默再交一份到星图（reportUpstream），由 NAS 上的
   * cron 同步成 GitHub issue。
   *
   * 为什么不是"点图标直接跳星图页面"：跳过去要重新填一遍，还要自己带版本号；
   * 而本地这一份让「装在自己机器上」的用户也能在面板里看到自己报过什么。
   * 为什么客户端不持上报码：安装包谁都能拿到，包里的码等于公开 —— 防线放在
   * 服务端的指纹限流与去重上（见星图 api.php）。
   */
  window.pwIssueOpen = function () { open('form'); };
  window.pwIssueSummary = function () { open('summary'); };
  window.pwIssueClose = close;
})();

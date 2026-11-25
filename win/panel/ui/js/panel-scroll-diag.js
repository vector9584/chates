/* 客户端取证：iPhone 上「切会话画面上下闪动」（2026-11-20）
 *
 * 桌面无头浏览器复现不出来，只能在真机留现场。这里只做一件事：
 * 监听 #chatBody 与页面滚动，若 2.5 秒内出现 3 次以上换向（上下反复），
 * 就把那一小段几何/时序采样 POST 到 /api/client-diag，供事后读取。
 *
 * 平时开销：一个 passive 滚动监听 + 环形缓冲（60 条），不跑 rAF、不轮询。
 * 每页只上报一次，避免刷屏。
 */
(function () {
  if (navigator.webdriver) return;          // 无头/自动化环境不采
  var BUF = [];
  var CAP = 60;
  var sent = 0;          // 最多采 3 次：切会话本身也会触发重绘，别让一次合法切换把名额烧光
  var lastSendAt = -1e9;
  var lastSeen = null;
  var pendingKind = 'scroll-oscillation';

  function now() { return Math.round(performance.now()); }

  function snap(src) {
    var body = document.getElementById('chatBody');
    var de = document.documentElement;
    return {
      t: now(),
      src: src,
      bodyTop: body ? Math.round(body.scrollTop) : -1,
      bodyH: body ? Math.round(body.scrollHeight) : -1,
      bodyCh: body ? Math.round(body.clientHeight) : -1,
      docTop: Math.round((document.scrollingElement || de).scrollTop || 0),
      winY: Math.round(window.scrollY || 0),
      vvTop: window.visualViewport ? Math.round(window.visualViewport.offsetTop) : -1,
      vvH: window.visualViewport ? Math.round(window.visualViewport.height) : -1,
      cls: document.body.className,
      n: body ? body.querySelectorAll('.msg').length : 0,
    };
  }

  function reversals(rows) {
    var dirs = [], i, d;
    for (i = 1; i < rows.length; i++) {
      d = rows[i].bodyTop - rows[i - 1].bodyTop;
      if (Math.abs(d) > 25) dirs.push(d > 0 ? 1 : -1);
    }
    var count = 0;
    for (i = 1; i < dirs.length; i++) if (dirs[i] !== dirs[i - 1]) count++;
    return count;
  }

  function capture(kind) {
    if (sent >= 3) return;
    if (now() - lastSendAt < 3000) return;
    sent++; lastSendAt = now(); pendingKind = kind || 'scroll-oscillation';
    var body = document.getElementById('chatBody');
    var frames = [];
    var t0 = now();
    (function tick() {
      frames.push(snap('frame'));
      if (now() - t0 < 2000) requestAnimationFrame(tick);
      else send(frames);
    })();
  }

  function send(frames) {
    var payload = {
      kind: pendingKind,
      url: location.href,
      ua: navigator.userAgent,
      dpr: window.devicePixelRatio,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      session: (typeof currentSession === 'string' ? currentSession : ''),
      standalone: (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        (navigator.standalone === true),
      events: BUF.slice(-60),
      frames: frames,
      /* 手指按着时被闸掉的滚动写入：谁想动、想动到哪、当时的栈顶一行 */
      blocked: (window.__scrollBlocked || []).slice(-6),
    };
    var token = '';
    try { token = localStorage.getItem('panel-device-token') || window.monitorToken || ''; } catch (e) {}
    fetch('/api/client-diag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Monitor-Token': token },
      body: JSON.stringify(payload),
    }).catch(function () { sent = Math.max(0, sent - 1); lastSendAt = -1e9; });
  }

  /* 闸门记账不会触发 scroll 事件，单独看一眼：有新的被拦记录就采一次现场 */
  var _blockedSeen = 0;
  setInterval(function () {
    var n = (window.__scrollBlocked || []).length;
    if (n > _blockedSeen) { _blockedSeen = n; capture('write-blocked'); }
  }, 1500);

  function onScroll(e) {
    var t = e.target;
    if (!(t === document || t === window || (t && t.id === 'chatBody') || t === document.documentElement)) return;
    var s = snap(t && t.id ? t.id : 'doc');
    BUF.push(s);
    if (BUF.length > CAP) BUF.shift();
    var recent = [];
    for (var i = BUF.length - 1; i >= 0; i--) {
      if (now() - BUF[i].t > 2500) break;
      recent.unshift(BUF[i]);
    }
    if (recent.length >= 6 && reversals(recent) >= 3) capture('scroll-oscillation');
    /* 第二种现场：一帧之内位置跳了 400px 以上、而高度基本没变 —— 这正是
       「整片重绘后按旧数字还原滚动位置」的形状（真机抓到的 718px 那一跳）。
       换向计数抓不到它，因为只有一下。 */
    if (lastSeen && Math.abs(s.bodyTop - lastSeen.bodyTop) > 400 &&
        Math.abs(s.bodyH - lastSeen.bodyH) < 100) {
      BUF.push(s);
      capture('scroll-jump');
    }
    lastSeen = s;
  }

  /* 第三种现场：整片重绘本身（innerHTML 换掉一大片）。记下换之前的位置和节点数，
     这样即使后续滚动很平缓，也能判断「是不是每 4 秒被重绘一次」。 */
  (function watchRerender() {
    var body = document.getElementById('chatBody');
    if (!body) return setTimeout(watchRerender, 1200);
    var prev = snap('init');
    new MutationObserver(function (rs) {
      var add = 0, rem = 0;
      for (var i = 0; i < rs.length; i++) { add += rs[i].addedNodes.length; rem += rs[i].removedNodes.length; }
      if (add >= 3 && rem >= 3) {
        var s = snap('rerender');
        s.added = add; s.removed = rem; s.prevTop = prev.bodyTop; s.prevH = prev.bodyH;
        BUF.push(s);
        if (BUF.length > CAP) BUF.shift();
        capture('rerender');
      }
    }).observe(body, { childList: true });
    setInterval(function () { prev = snap('poll'); }, 500);
  })();

  document.addEventListener('scroll', onScroll, { passive: true, capture: true });
})();

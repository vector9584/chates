/*! panel-unread-rail.js — 会话树未读小圆点 + 「只看未读」开关（2026-11-20 第二版：做减法）
 *
 * 第一版自己写了一套树遍历去收列表，跟搜索框的筛选逻辑重复了。现在只留两件事：
 *   1. 记住每个会话的未读数（跟角标/推送共用 api/push/unread，不另建计数）
 *   2. 给未读会话的名字后面点一个小圆点
 * 显隐全部交给既有的 pwRailFilter —— 开关只是把 window.__pwUnreadOnly 置真再调它一次，
 * 文件夹自展开、空态提示、文字筛选叠加，都是现成那套在跑。
 */
(function () {
  var MAP = {};
  var on = false;   // 跟搜索框一样只管这一次打开：刷新就回到全部，不记忆

  function api(p) { return new URL('api/push/' + p, document.baseURI).href; }
  function rail() { return document.getElementById('railScroll'); }

  /* 筛选链读这个：返回该会话未读数，没有就是 0 */
  window.__pwUnreadCount = function (sid) { return Number(MAP[sid] || 0); };
  window.__pwUnreadOnly = on;

  function syncBtn() {
    var b = document.getElementById('railUnreadBtn');
    if (!b) return;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.title = on ? '只看未读（再点显示全部）' : '只看未读';
  }

  /* 列表是 innerHTML 整片重建的，所以每次重建后按 MAP 补一遍小圆点 */
  function paintMarks() {
    var el = rail();
    if (!el) return;
    var items = el.querySelectorAll('.session-item[data-sid]');
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var n = Number(MAP[it.getAttribute('data-sid')] || 0);
      var dot = it.querySelector('.si-unread');
      if (dot) dot.hidden = !(n > 0);
      if (n > 0) it.classList.add('has-unread');
      else it.classList.remove('has-unread');
    }
  }

  function rerun() {
    var input = document.getElementById('railFilterInput');
    if (window.pwRailFilter) window.pwRailFilter(input ? input.value : '');
    paintMarks();
    syncBtn();
  }

  window.pwRailUnreadToggle = function () {
    on = !on;
    window.__pwUnreadOnly = on;
    rerun();
  };

  /* 长按「只看未读」按钮 → 清空所有未读（2026-11-21 用户需求）。
   * 600ms 长按触发 __pwClearAllUnread()（在 panel-push.js，清后端账 + 清角标 + 广播），
   * 成功后 toast 反馈；长按松手时用捕获阶段 click 拦掉原本的 pwRailUnreadToggle()，
   * 避免「清空完又顺手切到只看未读」。 */
  function bindLongPressClear() {
    var b = document.getElementById('railUnreadBtn');
    if (!b) return;
    var timer = null, fired = false, sx = 0, sy = 0;
    function cancel() { if (timer) { clearTimeout(timer); timer = null; } }
    function fire() {
      timer = null;
      fired = true;
      // 先退出「只看未读」再清账：清空后 rerun 会直接回全部，不停在一瞬间的空列表
      if (on) { on = false; window.__pwUnreadOnly = false; }
      if (window.__pwClearAllUnread) {
        window.__pwClearAllUnread().then(function (d) {
          if (d && d.ok !== false && window.toast) toast('已清空所有未读', 'success');
        });
      }
    }
    function start(x, y) { fired = false; sx = x; sy = y; cancel(); timer = setTimeout(fire, 600); }
    if (window.PointerEvent) {
      // preventDefault：按住不放时浏览器别启动原生 text selection（否则长按按钮会
      // 选中下方会话列表第一个文件夹名）。不杀 click——pointerdown 的 preventDefault 不拦 click。
      b.addEventListener('pointerdown', function (e) { e.preventDefault(); start(e.clientX, e.clientY); });
      b.addEventListener('pointermove', function (e) {
        if (timer && (Math.abs(e.clientX - sx) > 12 || Math.abs(e.clientY - sy) > 12)) cancel();
      });
      b.addEventListener('pointerup', cancel);
      b.addEventListener('pointercancel', cancel);
      b.addEventListener('pointerleave', cancel);
    } else {
      // 兜底：老环境没有 PointerEvent，退回 touch + mouse（触屏上可能有 300ms 模拟 mouse 干扰，主场景已覆盖）
      b.addEventListener('touchstart', function (e) { var t = e.touches[0]; start(t.clientX, t.clientY); }, { passive: true });
      b.addEventListener('touchmove', function (e) {
        var t = e.touches[0];
        if (timer && (Math.abs(t.clientX - sx) > 12 || Math.abs(t.clientY - sy) > 12)) cancel();
      }, { passive: true });
      b.addEventListener('touchend', cancel);
      b.addEventListener('touchcancel', cancel);
      b.addEventListener('mousedown', function (e) { if (e.button === 0) start(e.clientX, e.clientY); });
      b.addEventListener('mousemove', function (e) {
        if (timer && (Math.abs(e.clientX - sx) > 12 || Math.abs(e.clientY - sy) > 12)) cancel();
      });
      b.addEventListener('mouseup', cancel);
      b.addEventListener('mouseleave', cancel);
    }
    // 长按已触发清空时，松手那一下别再触发 onclick 的 pwRailUnreadToggle()
    b.addEventListener('click', function (e) {
      if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; }
    }, true);
    // 移动端长按会触发系统 contextmenu（Android 长按菜单/选中），拦掉，只留自己的长按手势
    b.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  /* 调试/测试用：直接喂一份 {sid:count}，不发请求 */
  window.__pwUnreadSet = function (map) { MAP = map || {}; rerun(); };
  window.__pwUnreadGet = function () { return { on: on, map: MAP }; };

  window.addEventListener('hermes:unread', function (e) {
    MAP = (e && e.detail) || {};
    rerun();
  });

  function pull() {
    fetch(api('unread'), { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (d) { MAP = (d && d.sessions) || {}; rerun(); })
      .catch(function () {});
  }

  var mo = null;
  function watchRail() {
    var el = rail();
    if (!el || !window.MutationObserver) return;
    if (mo) mo.disconnect();
    mo = new MutationObserver(function () { paintMarks(); });
    mo.observe(el, { childList: true });
  }

  function boot() { syncBtn(); watchRail(); pull(); bindLongPressClear(); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) pull(); });
})();

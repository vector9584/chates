/* 全局气泡提示层（2026-11-12 重做）
 *
 * 为什么要换掉原来的 CSS 伪元素方案：
 *   1) `[data-tip]::after{white-space:nowrap}` —— 长提示（「按住说话：松手发语音；空输入框上长按＝转文字」）
 *      一行铺开 300+px，靠左/靠右的按钮直接把气泡顶出视口，用户看到的就是「超长」。
 *   2) 没有 hover 能力判定 —— 触屏上 :hover 会粘住，手指点过麦克风后气泡一直挂在输入框上，
 *      正好压住 placeholder 和录音提示，这是「遮盖」的来源。
 *   3) 和原生 title 重复 —— 同一个按钮同时有 data-tip / title / aria-label 三份文案，
 *      自定义气泡 + 系统气泡前后脚各弹一次，这是「多处提示」的来源。
 *
 * 现在的做法：一个 position:fixed 的单例气泡，JS 量完宽高后夹进视口，
 * 只有 (hover:hover) and (pointer:fine) 才有；有 data-tip 的元素在启动时统一删掉 title。
 */
(function () {
  'use strict';

  var MQ = '(hover:hover) and (pointer:fine)';
  var canHover = !!(window.matchMedia && window.matchMedia(MQ).matches);
  var layer = null;
  var current = null;
  var locked = false;   /* 点击展开的气泡：鼠标移开不收，点空白/Esc 才收 */

  /* 触屏判定：问号/按钮在触屏上没 hover，但有 pointer，靠点按展开（toggle）。 */
  var touchMQ = '(pointer:coarse)';
  var isTouch = !!(window.matchMedia && window.matchMedia(touchMQ).matches);

  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    layer = document.createElement('div');
    layer.id = 'tipLayer';
    layer.setAttribute('role', 'tooltip');
    document.body.appendChild(layer);
    return layer;
  }

  function show(el, pin) {
    var text = el.getAttribute('data-tip');
    if (!text) return;
    var l = ensureLayer();
    l.textContent = text;
    l.classList.add('show');

    /* 必须先让 show 生效再量：刚 add('show') 那一刻元素还在 display:none 的
       旧样式上，直接读 getBoundingClientRect 会拿到 0×0，于是气泡按「高度 0」
       定位，跑到目标右上方甚至飘出容器（2026-11-21 实测：问号气泡偏到左上）。 */
    void l.offsetHeight;
    var r = el.getBoundingClientRect();
    var lr = l.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var m = 8;
    var top = r.top - lr.height - 8;
    var below = false;
    if (top < m) {                       // 上方放不下（贴顶的按钮）→ 翻到下方
      top = r.bottom + 8;
      below = true;
    }
    if (top + lr.height > vh - m) top = Math.max(m, vh - lr.height - m);
    var left = r.left + r.width / 2 - lr.width / 2;
    left = Math.max(m, Math.min(left, vw - lr.width - m));

    l.style.top = Math.round(top) + 'px';
    l.style.left = Math.round(left) + 'px';
    l.dataset.below = below ? '1' : '0';
    current = el;
    locked = !!pin;
  }

  function hide() {
    if (layer) layer.classList.remove('show');
    current = null;
    locked = false;
  }

  function targetOf(node) {
    if (!node || !node.closest) return null;
    return node.closest('[data-tip]');
  }

  document.addEventListener('mouseover', function (e) {
    if (isTouch) return;                 /* 触屏点按会先派发模拟 mouseover，交给 click 处理 */
    var t = targetOf(e.target);
    if (t) { if (t !== current) show(t); }
    else hide();
  }, true);

  document.addEventListener('mouseout', function (e) {
    if (isTouch) return;
    if (locked) return;                  /* 点击锁定后，移开鼠标不收回 */
    var to = e.relatedTarget;
    if (!to || !targetOf(to)) hide();
  }, true);

  document.addEventListener('focusin', function (e) {
    if (isTouch) return;                 /* 触屏点按会派发 focusin+click，交给 click 统一 toggle */
    var t = targetOf(e.target);
    if (t) show(t);
  }, true);
  document.addEventListener('focusout', hide, true);
  document.addEventListener('scroll', hide, true);

  /* 点 data-tip 元素切换气泡，点别处收起 —— 桌面和触屏走同一套。
     2026-11-21 改：原先桌面端 click 一律 hide()，只有 hover 能看见。
     结果用户鼠标点问号「点不开」——他期望的是点一下弹出来，不是把鼠标悬在上面。
     hover/focus 仍然会亮（保留无点击习惯），click 负责再给一次明确的开合。 */
  document.addEventListener('click', function (e) {
    var t = targetOf(e.target);
    var pinned = locked;
    /* openMini 按钮（模型/思考强度/能力/技能/专家）点开的就是它自己的弹层，
       不再叠一个同名气泡挡视线、还得再点一次才关。思考强度另有一层：
       它的档位只写在弹层标题里，按钮本身连 data-tip 都不挂了（2026-11-21）。 */
    if (t && /openMini\s*\(/.test(t.getAttribute('onclick') || '')) t = null;
    if (t) {
      /* 点一下展开、再点收起。桌面鼠标点过之后气泡留着，移开也不立刻收，
         要收就点空白处或按 Esc —— 长解释得给人时间读。 */
      if (current === t && pinned && layer && layer.classList.contains('show')) hide();
      else show(t, true);
    } else {
      hide();
    }
  }, true);

  /* 点开的气泡，鼠标移开不收回（否则刚弹出就消失）。
     由 mouseout 时检查是否「点击锁定」。 */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hide();
  }, true);

  window.addEventListener('resize', hide, true);

  /* 有 data-tip 的元素不再保留原生 title，否则系统气泡会和自定义气泡打架。
     日志点名到元素（tag#id.class），别只报个数——只报个数的时候得回去 grep 全站才找得到源头。 */
  function describe(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    var c = (el.className && String(el.className).trim()) ? String(el.className).trim().split(/\s+/).slice(0, 2) : [];
    if (c.length) s += '.' + c.join('.');
    return s;
  }
  function dedupeTitles() {
    var list = document.querySelectorAll('[data-tip][title]');
    if (!list.length) return [];
    var names = [];
    for (var i = 0; i < list.length; i++) {
      names.push(describe(list[i]));
      list[i].removeAttribute('title');
    }
    return names;
  }
  function boot() {
    var names = dedupeTitles();
    if (names.length) console.info('[tooltip] 去掉重复的原生 title：' + names.length + ' 个 → ' + names.join(', '));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 动态插入的按钮（模型胶囊、房间工具条、专家库重渲染）也要补齐：
     页面里不少块是 innerHTML 整段重刷的，刷一次 title 就长回来一次，
     所以除了启动跑一遍，还要盯着 DOM 变化。 */
  window.tipDedupe = dedupeTitles;
  if (window.MutationObserver) {
    var pend = null;
    new MutationObserver(function () {
      if (pend) return;
      pend = setTimeout(function () { pend = null; dedupeTitles(); }, 200);
    }).observe(document.body, { childList: true, subtree: true });
  }
})();

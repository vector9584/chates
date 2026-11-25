/* 消息头像装饰器（2026-11-11，v3）
 * v1 自作聪明画了 emoji 头像（🐳/首字），把用户自己上传的 GIF 头像顶掉了——头像的真源是
 *   .chat-sender > .pw-avatar（panel-workspace-ui.js 的 avatarHTML 生成，可能是
 *   /api/workspace-ui/avatars/<sha>.gif 的 <img>），形状由 .circle 控制。
 * v3 改为「搬运真头像」：把那个 .pw-avatar 的 outerHTML 克隆进 .msg-avatar 槽位，
 *   GIF / emoji / 形状 / 专家头像全部原样保留；.chat-sender 只有名字文本，继续隐藏。
 *
 * 为什么不重写 innerHTML：渲染器有十几处，且流式更新里用了
 *   asst.insertBefore(bar, asst.querySelector('.msg-meta'))
 * 这种「直接子节点」假设，包 wrapper 会直接抛 NotFoundError。
 */
(function () {
  function slotClass(m) {
    return 'msg-avatar' + (m.classList.contains('user') ? ' me' : ' bot');
  }

  function bindAvatarClick(el, isMe) {
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', isMe ? '我的资料与头像' : '当前角色设置');
    el.title = isMe ? '我的资料与头像' : '当前角色设置';
    el.style.cursor = 'pointer';
    function open() {
      try {
        if (isMe) {
          if (typeof window.openMyProfile === 'function') window.openMyProfile();
          else if (window.pwIdentity) window.pwIdentity('me');
        } else {
          if (typeof window.openRoleMenu === 'function') window.openRoleMenu();
          else if (window.pwOpenRole) window.pwOpenRole();
        }
      } catch (e) {}
    }
    el.addEventListener('click', function (e) { e.stopPropagation(); open(); });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); open(); }
    });
  }

  function decorate() {
    var body = document.querySelector('.chat-body');
    if (!body) return;
    var msgs = body.querySelectorAll('.msg');
    var missing = false;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var exists = m.querySelector(':scope > .msg-avatar');
      if (exists) {
        // 29) 形状是「裁切」：设置里切成圆形/方形后，已经渲染出来的消息也要跟着变。
        //    真源是克隆进来的 .pw-avatar 身上的 .circle，槽位只是跟着贴同一个类。
        var inner = exists.querySelector('.pw-avatar');
        exists.classList.toggle('circle', !!(inner && inner.classList.contains('circle')));
        continue;
      }
      var src = m.querySelector('.chat-sender .pw-avatar');
      if (!src) { missing = true; continue; }
      var av = document.createElement('div');
      av.className = slotClass(m) + ' real';   // real = 里面是真头像，槽位不画边框/底色
      av.innerHTML = src.outerHTML;   // 保留 <img src="...gif"> 与 .circle 形状
      bindAvatarClick(av, m.classList.contains('user'));
      m.insertBefore(av, m.firstChild);
    }
    // 老消息没有 .chat-sender 时，请工作区模块先把身份头像补上，下一拍再搬
    if (missing && typeof window.pwDecorateLive === 'function') {
      try { window.pwDecorateLive(); } catch (e) {}
    }
  }

  var pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    var run = function () { pending = false; try { decorate(); } catch (e) {} };
    if (window.requestAnimationFrame) requestAnimationFrame(run); else setTimeout(run, 16);
  }

  function boot() {
    var body = document.querySelector('.chat-body');
    if (!body) { setTimeout(boot, 300); return; }
    decorate();
    try {
      new MutationObserver(schedule).observe(body, { childList: true, subtree: true });
    } catch (e) {}
    // 兜底：切换会话会整块重绘，MutationObserver 在 visibility 恢复的瞬间可能漏拍
    // 2026-11-21 发热收敛：3s→8s，且后台跳过——decorate 全量遍历 .msg，稳态没变化也白跑
    setInterval(function () { if (document.hidden) return; schedule(); }, 8000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

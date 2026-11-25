/* ============================================================================
 * think-intensity · 思考强度滑块（自包含 Web Component）
 *
 * 零全局污染：
 *   - 结构在 Shadow DOM 内，页面里不产生任何裸 div
 *   - 样式在 Shadow DOM 内，选择器全部收敛到 .ti-root，不影响宿主页面
 *   - 脚本是 IIFE，除标准的 customElements 注册外不挂任何全局变量
 *   - 支持同一页面多实例，各自独立
 *
 * 用法：
 *   页面引入 思考强度滑块组件.js 后，写入一个 think-intensity 标签即可：
 *   theme 取 light 或 dusk，level 取 1 到 4（示例：theme="light" level="4"）。
 *
 * 属性：
 *   theme  = light | dusk     配色版本
 *   level  = 1..4             档位（关 / 轻 / 均衡 / 极致）
 *
 * 接口：
 *   el.level = 3              setter / getter
 *   el.theme = 'dusk'
 *   el.setLevel(2)
 *   el.addEventListener('change', e => e.detail) // { level, name }
 *
 * 视觉：彩色流云整条满铺、四档全部持续流动；滑块只改云雾的
 *       云量 / 浓度 / 彩度 / 流速 / 翻涌 / 亮度，不做雾的开关。
 * 手感：拖拽时整条滑道（圆点、光晕、云雾的浓度/彩度/云量/流速/亮度、
 *       圆点配色、外沿光环）都按指针位置连续插值变化，不是四档硬切；
 *       松手 / 点击 / 键盘用 340ms 缓动渐变到目标档，无跳变、无过冲。
 * ========================================================================== */

(function () {
  'use strict';

  /* 防重复注册（多次引入脚本、热更新都安全） */
  if (customElements.get('think-intensity')) return;

  const LEVEL_NAMES = ['关', '轻', '均衡', '极致'];

  /* 圆点图标用实心矢量而非字体符号：笔画更粗、不受系统字体影响，
     浅色亮雾上也能看清。四档 = 电源 / 小星 / 中星 / 大星。 */
  const STAR = '<path d="M10 4.4C10.65 7.8 12.2 9.35 15.6 10 12.2 10.65 10.65 12.2 10 15.6 9.35 12.2 7.8 10.65 4.4 10 7.8 9.35 9.35 7.8 10 4.4Z" fill="currentColor"/>';
  const svgIcon = (inner) =>
    '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">' + inner + '</svg>';
  const ICONS = [
    svgIcon(
      '<path d="M10 3.5V9.1" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/>' +
      '<path d="M5.55 6.05a6.45 6.45 0 1 0 8.9 0" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/>'
    ),
    svgIcon('<g transform="translate(10 10) scale(.62) translate(-10 -10)">' + STAR + '</g>'),
    svgIcon('<g transform="translate(10 10) scale(.86) translate(-10 -10)">' + STAR + '</g>'),
    svgIcon(STAR)
  ];

  /* ---------- 云片配置（模块内常量，非全局） ----------
     四层共 40 片/组，两组完全相同 → 无缝循环，总计 80 片。
     core = 关档仍保留的前几片，其余由 --dense 按档位淡入淡出。 */
  const LAYERS = [
    { key:'deep',  n:11, core:4, seed:1101, blur:[6,8], w:[12,22], h:[74,116], y:[-34,42], colors:[1,2,4,3,2,1,5,3,4,2,1], anims:['tiB1','tiB2','tiB3'], dur:[9,15],   o:[.78,.96], rot:0 },
    { key:'crest', n:10, core:3, seed:2202, blur:[4,6], w:[9,14],  h:[42,74],  y:[-26,44], colors:[6,5,6,4,6,5,6,3,5,6],   anims:['tiB1','tiB2','tiB3'], dur:[8,13],   o:[.80,.96], rot:0 },
    { key:'silk',  n:9,  core:2, seed:3303, blur:[3,5], w:[7,11],  h:[34,56],  y:[-14,46], colors:[6,5,4,6,3,6,5,4,6],     anims:['tiS1','tiS2'],        dur:[6.5,11], o:[.72,.92], rot:-15 },
    { key:'extra', n:10, core:0, seed:4404, blur:[3,4], w:[5,9],   h:[26,48],  y:[-18,48], colors:[6,5,6,2,6,4,6,5,6,3],   anims:['tiS1','tiS2'],        dur:[5.5,9.5],o:[.68,.90], rot:-11 }
  ];

  /* ---------- 连续样式插值 ----------
     四个锚点对应 0 / 1/3 / 2/3 / 1 的滑动进度。
     拖拽时按指针位置在这四点间线性插值，云雾的浓度、彩度、云量、
     流速、亮度、圆点颜色全部连续变化，不是四档硬切。
     关档（p=0）也保留一层漂亮的薄紫雾，不再是空槽。 */
  const STOPS = [
    { p:0,    tone:.03, cloud:.46, crest:.34, silk:.16, extra:.07, sat:.50, dense:.20, fogSat:1.02, halo:.36, front:.30, speed:44, breath:.50 },
    { p:1/3,  tone:.09, cloud:.56, crest:.40, silk:.26, extra:.16, sat:.62, dense:.46, fogSat:1.06, halo:.48, front:.62, speed:28, breath:.85 },
    { p:2/3,  tone:.19, cloud:.80, crest:.68, silk:.52, extra:.48, sat:.84, dense:.78, fogSat:1.14, halo:.70, front:1,   speed:18, breath:1.15 },
    { p:1,    tone:.28, cloud:1,   crest:1,   silk:1,   extra:1,   sat:1,   dense:1,   fogSat:1.20, halo:.90, front:0,   speed:12, breath:1.35 }
  ];

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const clampLevel = (v) => Math.min(4, Math.max(1, parseInt(v, 10) || 1));
  const levelToP = (n) => (clampLevel(n) - 1) / 3;
  const pToLevel = (p) => Math.round(clamp01(p) * 3) + 1;

  /* p ∈ [0,1] → 一组连续样式值 */
  function sampleStyle(p) {
    p = clamp01(p);
    let i = 0;
    while (i < STOPS.length - 2 && p > STOPS[i + 1].p) i++;
    const a = STOPS[i], b = STOPS[i + 1];
    const t = clamp01((p - a.p) / (b.p - a.p));
    const mix = (k) => a[k] + (b[k] - a[k]) * t;
    return {
      tone:mix('tone'), cloud:mix('cloud'), crest:mix('crest'),
      silk:mix('silk'), extra:mix('extra'), sat:mix('sat'),
      dense:mix('dense'), fogSat:mix('fogSat'), halo:mix('halo'),
      front:mix('front'), speed:mix('speed'), breath:mix('breath')
    };
  }

  /* 固定种子伪随机：纯函数，不依赖任何外部状态 */
  function seeded(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /* 生成「一组」云片；同一层调用两次用同一颗种子 → 两组字符串完全相同 */
  function buildSet(layer) {
    const r = seeded(layer.seed);
    const between = (a, b) => a + (b - a) * r();
    let out = '<div class="ti-set">';
    for (let i = 0; i < layer.n; i++) {
      const step = 108 / layer.n;
      const x   = -8 + i * step + between(-2.5, 2.5);
      const y   = between(layer.y[0], layer.y[1]);
      const w   = between(layer.w[0], layer.w[1]);
      const h   = between(layer.h[0], layer.h[1]);
      const c   = layer.colors[i % layer.colors.length];
      const an  = layer.anims[i % layer.anims.length];
      const dur = between(layer.dur[0], layer.dur[1]).toFixed(2) + 's';
      const o   = between(layer.o[0], layer.o[1]).toFixed(2);
      const bl  = between(layer.blur[0], layer.blur[1]).toFixed(1) + 'px';
      const rot = layer.rot ? (layer.rot + between(-5, 5)).toFixed(1) + 'deg' : '0deg';
      const cls = i >= layer.core ? ' class="is-dense"' : '';
      out += '<i' + cls + ' style="' +
        '--x:'   + x.toFixed(1)   + '%;' +
        '--y:'   + y.toFixed(1)   + '%;' +
        '--w:'   + w.toFixed(1)   + '%;' +
        '--h:'   + h.toFixed(1)   + '%;' +
        '--c:var(--c' + c + ');' +
        '--blur:' + bl + ';' +
        '--rot:'  + rot + ';' +
        '--an:'   + an + ';' +
        '--dur:'  + dur + ';' +
        '--o:'    + o + ';' +
      '"></i>';
    }
    return out + '</div>';
  }

  function buildCloudsHTML() {
    return LAYERS.map(function (l) {
      const set = buildSet(l);           /* 只生成一次，复用两次 → 绝对无缝 */
      return '<div class="ti-pack ti-pack--' + l.key + '">' + set + set + '</div>';
    }).join('');
  }

  /* ---------- 组件样式：全部收敛在 Shadow DOM 的 .ti-root 之下 ---------- */
  const CSS = `
    :host {
      display:block; width:100%; max-width:620px;
      /* 浅紫版 */
      --wall-hi:#ffffff; --wall:#eceefa; --wall-lo:#d8dcf0;
      /* 腔底是「同色系的淡紫白」而不是中性白或灰蓝：
         云边缘透明时透出的是淡紫，颜色连贯、不发灰也不发白 */
      --cavity-hi:#e9e5fa; --cavity:#f1edfc; --cavity-lo:#faf7ff;
      --cavity-shade:rgba(96,80,170,.09);
      --line:#e0e3f2;
      /* 同色系靛紫邻近色：叠加只会更紫，不会互相抵消成灰 */
      --c1:rgba(56,60,208,.98); --c2:rgba(98,54,222,.96);
      --c3:rgba(146,72,234,.94); --c4:rgba(180,112,242,.92);
      --c5:rgba(118,94,234,.96); --c6:rgba(214,186,255,1);
      --hi:rgba(243,232,255,.90);
      --accent:#6064ea; --ring:#c9cdf2; --on-orb:#ffffff;
      --orb-ink-shadow:rgba(34,32,116,.62);
      --orb-off-ink:#2b2e96;
      --tone-ink:#f0eaff;
      --halo-ink:rgba(198,178,255,.62); --front-ink:rgba(226,212,255,.92);
      --glaze-cap:rgba(255,255,255,.60); --glaze-foot:rgba(255,255,255,.22);
      --glaze-top:rgba(255,255,255,.92); --glaze-bot:rgba(64,70,130,.12);
      --halo-ring:rgba(96,100,234,.14); --shadow-soft:rgba(84,92,145,.18);
      --soft:rgba(96,100,234,.20);
      --outer:0 1px 3px rgba(84,92,145,.12);
      --other:#9dd6c3;
    }
    :host([theme="dusk"]) {
      /* 深绿版 */
      --wall-hi:#7e8db4; --wall:#5c6b95; --wall-lo:#495880;
      --cavity-hi:#1d4660; --cavity:#28576d; --cavity-lo:#34687e;
      --cavity-shade:rgba(6,28,44,.16);
      --line:rgba(255,255,255,.22);
      /* 同色系薄荷青邻近色，去掉会发灰的互补紫与偏蓝 */
      --c1:rgba(126,230,192,.95); --c2:rgba(70,217,198,.92);
      --c3:rgba(86,208,212,.90); --c4:rgba(159,232,208,.88);
      --c5:rgba(96,220,202,.92); --c6:rgba(146,236,200,.94);
      --hi:rgba(172,246,216,.62);
      --accent:#9dd6c3; --ring:#2f6a54; --on-orb:#123f31;
      --orb-ink-shadow:rgba(8,42,32,.38);
      --orb-off-ink:#d9fff1;
      --tone-ink:#bfe8dc;
      --halo-ink:rgba(126,224,198,.58); --front-ink:#d6fff0;
      --glaze-cap:rgba(255,255,255,.22); --glaze-foot:rgba(255,255,255,.09);
      --glaze-top:rgba(255,255,255,.28); --glaze-bot:rgba(22,58,70,.18);
      --halo-ring:rgba(157,214,195,.16); --shadow-soft:rgba(20,38,66,.16);
      --soft:rgba(157,214,195,.24);
      --outer:0 2px 8px rgba(20,38,66,.16);
      --other:#6064ea;
    }

    .ti-root, .ti-root * { box-sizing:border-box; }
    .ti-root {
      position:relative; padding-top:26px; width:100%;
      font-family:ui-rounded,-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
      -webkit-user-select:none; user-select:none;
    }
    .ti-theme {
      position:absolute; top:0; right:2px; width:16px; height:16px; padding:0;
      border-radius:50%; border:2px solid var(--line); background:var(--other);
      opacity:.55; cursor:pointer; box-shadow:var(--outer);
      transition:opacity .2s ease, transform .2s ease;
    }
    .ti-theme:hover { opacity:1; transform:scale(1.12); }
    .ti-theme:focus-visible, .ti-slider:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }

    /* 真胶囊：999px；32px 高，圆点 18px、留白 4px → 圆点上下各 7px 空隙
       （2026-11-21 第三轮：34px 仍被判「还是大」，再收一档并同步把内腔 inset 从 5 收到 4，
       让 32-18=14/2=7px 与腔体 4px 留白对齐，圆点顶边不蹭。只改 PC，移动端断点仍是 44px。） */
    .ti-slider {
      /* 这些值只是「脚本尚未渲染」时的兜底；实际全部由 _render(p)
         按滑动进度连续写入内联，四档之间没有任何硬切。 */
      --pad:4px; --orb:18px; --p:1;
      --tone:.28; --cloud:1; --crest:1; --silk:1; --extra:1;
      --sat:1; --dense:1; --fog-sat:1.2;
      --speed:12s; --breath:1.35; --halo:.9; --front:0;
      --orb-mix:100%; --ink-mix:100%; --border-mix:42%; --glow-op:1;
      /* 2026-11-21：弹层里只有 336px 宽，68px 高显得又胖又占地方（宽高比 4.94，
         比一个按钮还厚）。压到 46px、圆点 26px —— 4px 轨道留白，宽高比约 7.3，
         和面板其他行高同层级。 */
      position:relative; height:32px; border-radius:999px; overflow:hidden;
      background:var(--wall);
      border:1px solid color-mix(in srgb, var(--accent) var(--border-mix), var(--line));
      box-shadow:var(--outer);
      cursor:grab; touch-action:none; isolation:isolate;
      transition:border-color .4s ease;
    }
    .ti-slider:active { cursor:grabbing; }
    /* 拉满才亮起的外沿光环：可见度由 --glow-op 连续控制，
       呼吸动画只改 box-shadow，因此拖动时不会出现动画突然启停。 */
    .ti-slider::after {
      content:""; position:absolute; inset:0; border-radius:999px; pointer-events:none;
      opacity:var(--glow-op);
      box-shadow:0 0 0 3px var(--soft);
      animation:tiRing 3.6s ease-in-out infinite;
    }
    @keyframes tiRing {
      0%,100% { box-shadow:0 0 0 3px var(--soft); }
      50%     { box-shadow:0 0 0 6px var(--soft); }
    }

    /* 1 管壁：明灭呼吸 */
    .ti-wall {
      position:absolute; z-index:1; inset:2px; border-radius:999px;
      background:linear-gradient(180deg, var(--wall-hi), var(--wall) 45%, var(--wall-lo));
      box-shadow:inset 0 1px 0 var(--glaze-top), inset 0 -1px 0 var(--glaze-bot);
      animation:tiWallGlow 9s ease-in-out infinite alternate; pointer-events:none;
    }
    @keyframes tiWallGlow { from { filter:brightness(.96); } to { filter:brightness(1.08); } }
    /* 2 内腔 */
    .ti-cavity {
      /* 32px 胶囊 + 18px 圆点：腔体内缩 4px，圆点上下各 7px，蹭不到边 */
      position:absolute; z-index:2; inset:4px; border-radius:999px;
      background:linear-gradient(180deg, var(--cavity-hi), var(--cavity) 48%, var(--cavity-lo));
      box-shadow:inset 0 2px 5px var(--cavity-shade), inset 0 -1px 0 rgba(255,255,255,.22), inset 0 0 0 1px rgba(255,255,255,.09);
      pointer-events:none;
    }
    /* 3 全腔亮度台阶 */
    .ti-tone {
      position:absolute; z-index:3; inset:4px; border-radius:999px;
      background:var(--tone-ink); opacity:var(--tone);
      pointer-events:none;   /* 由 _render 连续写入，不能再叠 CSS transition */
    }

    /* 4 彩色流云 = 跑马灯本体：四层各自 200% 宽、两组相同云并排，
       translateX(-50%)→0 无缝向右循环；层速度比 1/.68/.52/.40。 */
    .ti-clouds {
      position:absolute; z-index:4; inset:4px; border-radius:999px;
      overflow:hidden; pointer-events:none;
      opacity:var(--sat);
      animation:tiCloudGlow 8s ease-in-out infinite alternate;
    }
    @keyframes tiCloudGlow {
      from { filter:saturate(var(--fog-sat)) brightness(.99); }
      to   { filter:saturate(var(--fog-sat)) brightness(1.035); }
    }
    /* 时长固定为基准 10s 的一组比例；档位速度由脚本改 playbackRate，
       切档时云不会因 duration 突变而瞬间跳位。--speed 只作为档位数据源。 */
    .ti-pack {
      position:absolute; inset:0; display:flex; width:200%; height:100%;
      animation-name:tiCloudRun; animation-duration:10s;
      animation-timing-function:linear; animation-iteration-count:infinite;
      will-change:transform;
    }
    .ti-pack--deep  { opacity:var(--cloud); }
    .ti-pack--crest { opacity:var(--crest); animation-duration:6.8s; }
    .ti-pack--silk  { opacity:var(--silk);  animation-duration:5.2s; }
    .ti-pack--extra { opacity:var(--extra); animation-duration:4s; }
    @keyframes tiCloudRun { from { transform:translateX(-50%); } to { transform:translateX(0); } }

    .ti-set { position:relative; flex:0 0 50%; height:100%; }
    .ti-set i {
      position:absolute; left:var(--x); top:var(--y); width:var(--w); height:var(--h);
      border-radius:50%;
      /* 中心实色段收窄、边缘提前衰减：云片之间留出干净底色，
         避免大片浓色半透明互相压成浊色 */
      background:radial-gradient(ellipse at center, var(--c) 0%, var(--c) 27%, transparent 70%);
      filter:blur(var(--blur)); opacity:var(--o);
      animation-name:var(--an); animation-duration:var(--dur);
      animation-timing-function:ease-in-out; animation-iteration-count:infinite;
      animation-direction:alternate;
    }
    /* 增量云片：密度由档位控制 —— 关档几乎隐去，极致全开 */
    .ti-set i.is-dense { opacity:calc(var(--o) * var(--dense)); }
    .ti-pack--deep .ti-set i::after,
    .ti-pack--crest .ti-set i::after {
      content:""; position:absolute; inset:34% 37%; border-radius:50%;
      background:radial-gradient(ellipse at center, var(--hi) 0%, var(--hi) 26%, transparent 74%);
      filter:blur(3px); opacity:.5;
    }

    @keyframes tiB1 {
      from { transform:translateY(calc(-9% * var(--breath))) scale(.9); }
      to   { transform:translateY(calc(10% * var(--breath))) scale(1.14); }
    }
    @keyframes tiB2 {
      from { transform:translateY(calc(11% * var(--breath))) scale(1.1); }
      to   { transform:translateY(calc(-9% * var(--breath))) scale(.9); }
    }
    @keyframes tiB3 {
      from { transform:translate(calc(-5% * var(--breath)), calc(-6% * var(--breath))) scale(.93); }
      to   { transform:translate(calc(6% * var(--breath)), calc(8% * var(--breath))) scale(1.16); }
    }
    @keyframes tiS1 {
      from { transform:translateY(calc(-9% * var(--breath))) rotate(var(--rot)) scaleX(.88); }
      to   { transform:translateY(calc(10% * var(--breath))) rotate(var(--rot)) scaleX(1.14); }
    }
    @keyframes tiS2 {
      from { transform:translateY(calc(11% * var(--breath))) rotate(var(--rot)) scaleX(1.12); }
      to   { transform:translateY(calc(-8% * var(--breath))) rotate(var(--rot)) scaleX(.9); }
    }

    /* 5 圆点柔光团 */
    .ti-halo {
      position:absolute; z-index:5; top:4px; bottom:4px; width:36%; border-radius:999px;
      left:calc(var(--pad) + (100% - var(--pad) * 2 - var(--orb)) * var(--p) + var(--orb) / 2 - 18%);
      opacity:var(--halo); filter:blur(18px);
      background:radial-gradient(ellipse at center, var(--halo-ink), transparent 72%);
      pointer-events:none;
    }
    /* 6 前沿月牙 */
    .ti-front {
      position:absolute; z-index:6; top:7px; bottom:7px; width:16px; border-radius:999px;
      left:calc(8px + (100% - 16px) * var(--p) - 22px);
      opacity:var(--front); filter:blur(3px);
      background:radial-gradient(ellipse at 50% 50%, var(--front-ink), transparent 72%);
      pointer-events:none;
    }

    /* 7 圆点：主题实色球，四周留空 + 同色淡光晕，不与腔壁直连 */
    .ti-orb {
      position:absolute; z-index:7; width:var(--orb); height:var(--orb); top:50%;
      border-radius:50%; display:grid; place-items:center;
      left:calc(var(--pad) + (100% - var(--pad) * 2 - var(--orb)) * var(--p));
      transform:translateY(-50%);
      /* 球色随进度从「淡主题色」连续过渡到「满主题色」；
         图标色在最左端用对比色、很快过渡到可读的常色，全程清晰 */
      background:color-mix(in srgb, var(--accent) var(--orb-mix), var(--wall));
      border:2px solid var(--ring);
      color:color-mix(in srgb, var(--on-orb) var(--ink-mix), var(--orb-off-ink));
      font-size:9px; font-weight:800;
      box-shadow:0 0 0 4px var(--halo-ring), 0 1px 3px var(--shadow-soft), inset 0 1px 0 var(--glaze-top), inset 0 -1px 0 var(--glaze-bot);
      transition:transform .2s ease;
    }
    /* 图标描边：浅色版用深靛蓝暗边勾出白图标，深色版用淡暗边，
       避免被明亮彩雾/玻璃高光吃掉 */
    .ti-orb svg {
      display:block; width:11px; height:11px;
      filter:drop-shadow(0 1px 1.5px var(--orb-ink-shadow));
    }
    .ti-slider:active .ti-orb { transform:translateY(-50%) scale(1.06); }

    /* 8 顶层玻璃罩：盖在圆点之上 */
    .ti-glaze { position:absolute; z-index:8; inset:0; border-radius:999px; pointer-events:none; }
    .ti-glaze::before {
      content:""; position:absolute; left:7%; right:7%; top:2px; height:6px; border-radius:999px;
      background:linear-gradient(90deg,transparent,var(--glaze-cap) 35%,var(--glaze-cap) 65%,transparent);
      filter:blur(2px); animation:tiGlazeSlide 14s ease-in-out infinite alternate;
    }
    .ti-glaze::after {
      content:""; position:absolute; left:12%; right:12%; bottom:2px; height:5px; border-radius:999px;
      background:linear-gradient(0deg,var(--glaze-foot),transparent); filter:blur(2px);
    }
    @keyframes tiGlazeSlide { from { transform:translateX(-7%); opacity:.55; } to { transform:translateX(7%); opacity:1; } }

    @media (max-width:520px) {
      .ti-slider { --pad:5px; --orb:24px; height:44px; }
    }
    @media (prefers-reduced-motion:reduce) {
      .ti-root *, .ti-root *::before, .ti-root *::after {
        animation-duration:.001ms !important; animation-iteration-count:1 !important;
        transition-duration:.001ms !important;
      }
    }
  `;

  const SHELL = `
    <div class="ti-root" part="root">
      <button class="ti-theme" part="theme" type="button" aria-label="切换配色版本"></button>
      <div class="ti-slider" data-lv="4" role="slider" tabindex="0"
           aria-label="思考强度" aria-valuemin="1" aria-valuemax="4" aria-valuenow="4" aria-valuetext="4 极致">
        <div class="ti-wall"></div>
        <div class="ti-cavity"></div>
        <div class="ti-tone"></div>
        <div class="ti-clouds"></div>
        <div class="ti-halo"></div>
        <div class="ti-front"></div>
        <div class="ti-orb"><svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M10 4.4C10.65 7.8 12.2 9.35 15.6 10 12.2 10.65 10.65 12.2 10 15.6 9.35 12.2 7.8 10.65 4.4 10 7.8 9.35 9.35 7.8 10 4.4Z" fill="currentColor"/></svg></div>
        <div class="ti-glaze"></div>
      </div>
    </div>
  `;

  /* ---------- 组件类 ---------- */
  class ThinkIntensity extends HTMLElement {
    static get observedAttributes() { return ['theme', 'level']; }

    constructor() {
      super();
      const root = this.attachShadow({ mode:'open' });
      root.innerHTML = '<style>' + CSS + '</style>' + SHELL;

      this._slider = root.querySelector('.ti-slider');
      this._orb    = root.querySelector('.ti-orb');
      this._btn    = root.querySelector('.ti-theme');
      root.querySelector('.ti-clouds').innerHTML = buildCloudsHTML();

      this._ready = false;
      this._p = 1;            /* 当前连续进度，滑动时逐帧更新 */
      this._dragging = false;
      this._raf = 0;          /* 拖拽 rAF */
      this._easeRaf = 0;      /* 松手 / 键盘缓动 rAF */
      this._lastRate = -1;
      this._speedPrimed = false;
      this._bind();
    }

    connectedCallback() {
      if (!this.hasAttribute('theme')) this.setAttribute('theme', 'light');
      if (!this.hasAttribute('level')) this.setAttribute('level', '4');
      const n = this._readLevel();
      this._p = levelToP(n);
      this._render(this._p);          /* 首帧直接落位，不做入场动画 */
      this._syncA11y(n);
      this._syncThemeLabel();
      this._ready = true;
      requestAnimationFrame(() => this._syncSpeed(true));
    }

    attributeChangedCallback(name, oldV, newV) {
      if (oldV === newV || !this._slider) return;
      if (name === 'theme') { this._syncThemeLabel(); return; }
      if (name === 'level') {
        const n = this._readLevel();
        this._syncA11y(n);
        if (!this._ready) return;
        /* 提交档位 = 从当前进度平滑缓动到该档锚点；change 只在这里派发一次 */
        this._animateTo(levelToP(n));
        if (this._quiet) return;              /* setLevelQuiet 的回写不算用户操作 */
        this.dispatchEvent(new CustomEvent('change', {
          detail: { level:n, name:LEVEL_NAMES[n - 1] },
          bubbles:true, composed:true
        }));
      }
    }

    /* -- 对外属性 -- */
    /* 回写用 setQuiet：宿主只想让组件显示某档（重开弹层、外部同步）时不该收到
       change —— 否则「渲染」会被当成「用户操作」，上层再回写一次就成环。
       2026-11-21 接新组件时补，改动仅在 Shadow 内，旧调用方零影响。 */
    setLevelQuiet(v) {
      const n = clampLevel(v);
      if (this._readLevel() === n) return;
      this._quiet = true;
      this.setAttribute('level', String(n));
      this._quiet = false;
    }
    get level() { return this._readLevel(); }
    set level(v) { this.setAttribute('level', String(clampLevel(v))); }
    get theme() { return this.getAttribute('theme') === 'dusk' ? 'dusk' : 'light'; }
    set theme(v) { this.setAttribute('theme', v === 'dusk' ? 'dusk' : 'light'); }
    setLevel(v) { this.level = v; }

    _readLevel() {
      const n = parseInt(this.getAttribute('level'), 10);
      return (n >= 1 && n <= 4) ? n : 4;
    }

    _syncThemeLabel() {
      this._btn.setAttribute('aria-label', this.theme === 'dusk' ? '切换到浅色紫球版' : '切换到深色绿球版');
    }

    _syncA11y(n) {
      const s = this._slider;
      s.dataset.lv = n;
      s.setAttribute('aria-valuenow', String(n));
      s.setAttribute('aria-valuetext', n + ' ' + LEVEL_NAMES[n - 1]);
      this._orb.innerHTML = ICONS[n - 1];
    }

    /* 核心：把连续进度 p 写成一整组内联变量。
       圆点位置、云雾浓度/彩度/云量/流速/亮度、圆点配色、外沿光环
       全部同源连续变化 —— 滑动时整条滑道都在跟着变，不是只有圆点在动。 */
    _render(p) {
      p = clamp01(p);
      this._p = p;
      const v = sampleStyle(p);
      const st = this._slider.style;
      st.setProperty('--p', p.toFixed(4));
      st.setProperty('--tone',   v.tone.toFixed(3));
      st.setProperty('--cloud',  v.cloud.toFixed(3));
      st.setProperty('--crest',  v.crest.toFixed(3));
      st.setProperty('--silk',   v.silk.toFixed(3));
      st.setProperty('--extra',  v.extra.toFixed(3));
      st.setProperty('--sat',    v.sat.toFixed(3));
      st.setProperty('--dense',  v.dense.toFixed(3));
      st.setProperty('--fog-sat',v.fogSat.toFixed(3));
      st.setProperty('--halo',   v.halo.toFixed(3));
      st.setProperty('--front',  v.front.toFixed(3));
      st.setProperty('--speed',  v.speed.toFixed(2) + 's');
      st.setProperty('--breath', v.breath.toFixed(3));
      st.setProperty('--orb-mix',   (20 + 80 * p).toFixed(1) + '%');
      st.setProperty('--ink-mix',   (clamp01(p / .12) * 100).toFixed(1) + '%');
      st.setProperty('--border-mix',(p * 42).toFixed(1) + '%');
      st.setProperty('--glow-op',   clamp01((p - .80) * 5).toFixed(3));
      this._syncSpeed();
    }

    /* 松手 / 点击 / 键盘：从当前进度缓动到目标锚点（340ms ease-out），
       每一帧仍走 _render，所以云雾是「渐变」到新档，不是瞬间换一张图。 */
    _animateTo(target) {
      if (this._easeRaf) cancelAnimationFrame(this._easeRaf);
      const from = this._p, dist = target - from;
      if (Math.abs(dist) < .0005) { this._render(target); this._easeRaf = 0; return; }
      const dur = 340, t0 = performance.now();
      const step = (now) => {
        const k = clamp01((now - t0) / dur);
        const e = 1 - Math.pow(1 - k, 3);
        this._render(from + dist * e);
        this._easeRaf = k < 1 ? requestAnimationFrame(step) : 0;
      };
      this._easeRaf = requestAnimationFrame(step);
    }

    /* 速度 = 基准 10s / 当前 --speed。直接赋值 playbackRate 会保持
       currentTime 连续，所以逐帧变速只改变「快慢」，云的位置不会跳。 */
    _syncSpeed(force) {
      if (!this.isConnected) return;
      const s = this._slider;
      const base = parseFloat(getComputedStyle(s).getPropertyValue('--speed')) || 12;
      const rate = 10 / base;
      const packs = s.querySelectorAll('.ti-pack');
      let need = force || Math.abs(rate - this._lastRate) >= .004;
      if (!need) {
        for (const pack of packs) {
          for (const anim of pack.getAnimations()) {
            if (Math.abs(anim.playbackRate - rate) > .004) { need = true; break; }
          }
          if (need) break;
        }
      }
      if (!need) return;
      this._lastRate = rate;
      packs.forEach((pack) => {
        pack.getAnimations().forEach((anim) => { anim.playbackRate = rate; });
      });
      if (!this._speedPrimed) {
        this._speedPrimed = true;
        requestAnimationFrame(() => this._syncSpeed(true));
      }
    }

    /* 指针位置 → 0..1 连续进度 */
    _fracFromX(clientX) {
      const r  = this._slider.getBoundingClientRect();
      const cs = getComputedStyle(this._slider);
      const pad = parseFloat(cs.getPropertyValue('--pad')) || 6;
      const orb = parseFloat(cs.getPropertyValue('--orb')) || 38;
      const usable = Math.max(1, r.width - pad * 2 - orb);
      return clamp01((clientX - r.left - pad - orb / 2) / usable);
    }

    _levelFromX(clientX) {
      return pToLevel(this._fracFromX(clientX));
    }

    _bind() {
      const s = this._slider;
      let raf = 0, pendingX = 0, startX = 0, moved = false;

      /* 拖拽每帧走 _render：圆点与整条云雾同步连续变化 */
      const render = () => {
        raf = 0;
        this._render(this._fracFromX(pendingX));
      };

      const finish = (e) => {
        if (!this._dragging) return;
        this._dragging = false;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        const x = (e && typeof e.clientX === 'number') ? e.clientX : pendingX;
        const lv = this._levelFromX(x);
        if (this.level === lv) this._animateTo(levelToP(lv)); /* 同档单击也平滑归位 */
        else this.level = lv;                                  /* 换档：缓动 + 一次 change */
      };

      s.addEventListener('pointerdown', (e) => {
        if (this._easeRaf) { cancelAnimationFrame(this._easeRaf); this._easeRaf = 0; }
        this._dragging = true;
        moved = false;
        startX = e.clientX;
        pendingX = e.clientX;
        s.setPointerCapture(e.pointerId);
      });
      s.addEventListener('pointermove', (e) => {
        if (!this._dragging) return;
        pendingX = e.clientX;
        if (!moved && Math.abs(e.clientX - startX) > 3) moved = true;
        if (moved && !raf) raf = requestAnimationFrame(render);
      });
      s.addEventListener('pointerup', finish);
      s.addEventListener('pointercancel', finish);
      s.addEventListener('lostpointercapture', finish);
      s.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp')   { this.level = this.level + 1; e.preventDefault(); }
        if (e.key === 'ArrowLeft'  || e.key === 'ArrowDown') { this.level = this.level - 1; e.preventDefault(); }
        if (e.key === 'Home') { this.level = 1; e.preventDefault(); }
        if (e.key === 'End')  { this.level = 4; e.preventDefault(); }
      });
      this._btn.addEventListener('click', () => {
        this.theme = this.theme === 'light' ? 'dusk' : 'light';
      });
    }
  }

  customElements.define('think-intensity', ThinkIntensity);
})();

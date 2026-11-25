/* 主题切换
 * 来源：index.html 内联 app.js 第 5670-5693 行（共 24 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。
 * 2026-11-23 三钮合一：跟随系统 / 白天 / 黑夜 → 单个互斥切换钮。
 *   - 默认（含每次刷新）都跟随系统，不读 localStorage
 *   - 点一下按对立色走，且不写 localStorage —— 刷新即回到跟随系统
 */

/* 当前实际生效的亮暗（auto 模式下由系统决定） */
function resolvedTheme(){
  return document.body.classList.contains('theme-light') ? 'light' : 'dark';
}

function setTheme(mode){
  currentTheme=mode;
  document.body.classList.remove('theme-light','theme-dark');
  if(mode==='light'){ document.body.classList.add('theme-light'); }
  else if(mode==='dark'){ document.body.classList.add('theme-dark'); }
  else {
    if(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) document.body.classList.add('theme-dark');
    else document.body.classList.add('theme-light');
  }
  /* 一个按钮两个图标：亮色显示月亮（点了变暗），暗色显示太阳（点了变亮） */
  var sun=document.getElementById('themeIconSun'), moon=document.getElementById('themeIconMoon');
  if(sun && moon){
    var isLight=resolvedTheme()==='light';
    sun.style.display  = isLight ? 'none' : 'block';
    moon.style.display = isLight ? 'block' : 'none';
  }
  var btn=document.getElementById('btnThemeToggle');
  if(btn) btn.title = resolvedTheme()==='light' ? '切到黑夜模式' : '切到白天模式';
  syncWordmark();
}

/* 互斥切换：不缓存。刷新时 init.js 会重新 setTheme('auto')，回到跟随系统。 */
function toggleTheme(){
  setTheme(resolvedTheme()==='light' ? 'dark' : 'light');
}

/* auto 模式下系统亮暗变了要跟着变；手动切换后（mode 非 auto）不再跟随。 */
try {
  var _themeMql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if(_themeMql && _themeMql.addEventListener) _themeMql.addEventListener('change', function(){
    if(currentTheme==='auto') setTheme('auto');
  });
} catch(e){}

/* 顶栏词标：src 由 apiUrl() 拼（自带 /app/<app> 前缀，经门户打开也取得到），
   按主题选深/浅两张，全挂就退成文字。2026-11-12 取代原来的 CSS mask。 */
function syncWordmark(){
  /* 词标已不再走网络图：css/panel-wordmark.css 用 base64 遮罩 + currentColor，
     主题/连接态全靠 CSS 变量自动跟随。空壳保留，避免历史调用点 ReferenceError。 */
}

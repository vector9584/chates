// 预加载脚本：只暴露极少量壳层能力。
// 原则是「能不给就不给」—— 面板本身是个完整的 web 应用，它自己会 fetch 自己的 API，
// 不需要壳帮它转发。这里只留版本信息和「窗口控制」两样，且都只读/无副作用。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('CHATES_SHELL', {
  isDesktop: true,
  platform: process.platform,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  /* 检查更新：顶栏 GitHub 版本号点一下就走这里。
     invoke 而不是 send —— 页面要拿到结果来做提示（有新版本 / 已是最新 / 失败）。
     主进程那边有 30 秒超时并总是 resolve，不会让按钮永远转圈。 */
  checkUpdates: () => ipcRenderer.invoke('chates:check-updates'),

  /* 问题上报（2026-11-26）：
     reportUrl  —— 对外提交页地址
     reportCode —— 一次性上报码，只能提交问题，读不到任何东西
     appVersion —— 客户端版本，提交页自动填，省得用户自己找
     openExternal —— 用系统默认浏览器打开，不在应用窗口里跳走

     地址和码从运行时配置读（main.js 那边在 app.whenReady 里解析完写进 env），
     不硬编码在这里 —— 换地址、吊销旧码都不用重新打包。 */
  reportUrl: process.env.CHATES_REPORT_URL || '',
  reportCode: process.env.CHATES_REPORT_CODE || '',
  appVersion: process.env.CHATES_APP_VERSION || '',
  openExternal: (url) => ipcRenderer.invoke('chates:open-external', String(url)),
});

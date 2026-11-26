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
});

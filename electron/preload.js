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
     右上角的反馈面板原样保留，只是提交时额外往星图推一份 ——
     页面没法直接跨域 POST（星图是另一个域名），所以地址和码从这里注入。

       reportUrl  —— 星图接口根地址，如 https://ruibing.wang/report/
       reportCode —— 上报码，只能提交，读不到任何东西
       appVersion —— 客户端版本，随单带上，省得用户自己填

     三个值都从运行时配置读（main.js 在 whenReady 里解析完写进 env），
     不硬编码 —— 换地址、吊销旧码都不用重新打包。 */
  reportUrl: process.env.CHATES_REPORT_URL || '',
  reportCode: process.env.CHATES_REPORT_CODE || '',
  appVersion: process.env.CHATES_APP_VERSION || '',
});

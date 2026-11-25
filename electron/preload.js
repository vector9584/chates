// 预加载脚本：只暴露极少量壳层能力。
// 原则是「能不给就不给」—— 面板本身是个完整的 web 应用，它自己会 fetch 自己的 API，
// 不需要壳帮它转发。这里只留版本信息和「窗口控制」两样，且都只读/无副作用。
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('CHATES_SHELL', {
  isDesktop: true,
  platform: process.platform,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
});

// panel-fs-utf8.js — 强制以 utf8 写字符串的统一入口
//
// 为什么需要它：Node 的 fs.writeFileSync(path, string) 在省略 encoding 时用
// 「系统代码页」。Linux/macOS 的默认代码页就是 utf8，所以本地开发永远看不到问题；
// Windows 上是 ANSI 代码页（简中 = CP936/GBK）。写不进 GBK 的字符会被替换成
// '?'，更糟的是某些字符会连带吃掉紧随其后的字节，把 JSON 的引号也吞掉。
//
// 实际踩到的后果（2026-11-25，Windows 桌面版）：
//   var/panel-state/auth.json 里设备名「飞牛浏览器」写成 `娴忚鍣?`，
//   字符串失去闭合 → JSON.parse 抛错 → 面板全站 503
//   「设备授权记录读取失败，请检查存储后重试」→ Electron 壳等满 60 秒弹
//   「面板启动超时」。服务其实在跑、端口也在听，就是每个请求都 503。
//
// 本项目有 60+ 处 writeFileSync/appendFileSync 在写中文（SOUL.md、MEMORY.md、
// notes.md、SKILL.md、每日记忆、日志、配置文件），逐处补 encoding 必漏。
// 所以在模块边界统一包一层：**字符串补 utf8，Buffer/TypedArray 原样透传**
// （二进制数据传 encoding 是错的，会让 Node 走字符串分支）。
//
// 用法：
//   import {writeFileSync, appendFileSync} from './panel-fs-utf8.js';
//   然后照常调用，不需要再关心 encoding。

import * as fs from 'node:fs';

function wrap(orig) {
  return function writeWithUtf8(pathOrFd, data, options) {
    if (typeof data === 'string') {
      // 没给 options：补 utf8
      if (options === undefined || options === null) return orig(pathOrFd, data, 'utf8');
      // options 是字符串编码：用户显式指定了，尊重它
      if (typeof options === 'string') return orig(pathOrFd, data, options);
      // options 是对象但没有 encoding：补 utf8，保留 flag/mode 等
      if (typeof options === 'object' && options.encoding == null)
        return orig(pathOrFd, data, {...options, encoding: 'utf8'});
      // options 显式带 encoding：尊重
      return orig(pathOrFd, data, options);
    }
    // Buffer / Uint8Array 等：原样透传
    return orig(pathOrFd, data, options);
  };
}

export const writeFileSync = wrap(fs.writeFileSync);
export const appendFileSync = wrap(fs.appendFileSync);
export {fs};

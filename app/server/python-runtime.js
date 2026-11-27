/**
 * Python 运行时解析 —— 全仓唯一入口（2026-11-27）
 *
 * 为什么必须有这个文件：
 *   同一条 "venv/bin/python3" 被 8 个后端模块各写了一遍，于是 Windows 上
 *   每一处都炸。用户看到的只是"取会话目录失败"（panel-workspace.js 先跑到），
 *   实际坏的是整片。
 *
 *   典型报错（2026-11-27 Windows 实测）：
 *     spawn C:\Users\...\CHATES\data\venv\bin\python3 ENOENT
 *
 * 三种运行时形态（monitor.js:570 早写过，但只有它自己知道）：
 *   fpk / Linux       <data>/venv/bin/python3
 *   fpk / Windows     <data>/venv/Scripts/python.exe
 *   独立桌面版         <resources>/runtime/python/python.exe
 *                      （不在 data 下，由 Electron 壳注入 CHATES_PYTHON_ROOT）
 *
 * 关键事实：独立桌面版**没有 data/venv 这个目录**，永远不会有。
 * runtime 是打进安装包的，data/venv 只在 fpk 安装时由 init.sh 建。
 * 所以不能"找不到 venv 就当 python3 在 PATH 里"——Windows 上 PATH 没有 python3。
 */

import {existsSync, statSync} from 'fs';
import {join} from 'path';

const IS_WIN = process.platform === 'win32';

/** 候选路径，按优先级排列，只返回真实存在的那个。 */
function candidates() {
  const data = process.env.DATA_DIR || '';
  const out = [];

  // 1. Electron 壳显式注入（独立桌面版唯一来源，最可信）
  //    注意：注入的可能是「目录」也可能是「可执行文件」，必须两种都展开。
  //    2026-11-27 实测踩过两次：
  //      a) 只推原值 → existsSync(目录) 通过 → spawn(目录) ENOENT
  //      b) 用 /python$/ 判断"是不是文件" → 目录恰好叫 python（真实现状
  //         resources/runtime/python）被误判成可执行文件 → 又回到 a)
  //    所以只认「真文件」：用 statSync 判 isFile，不靠名字猜。
  const injected = process.env.CHATES_PYTHON_ROOT || process.env.PANEL_PYTHON;
  if (injected) {
    const exeName = IS_WIN ? 'python.exe' : 'python3';
    // 注入值本身是不是真文件（而不是目录或不存在）
    let injectedIsFile = false;
    try {
      injectedIsFile = existsSync(injected) && statSync(injected).isFile();
    } catch {
      injectedIsFile = false;
    }
    if (injectedIsFile) {
      out.push(injected);
    } else {
      out.push(join(injected, exeName));                        // 目录 → 直接子文件
      out.push(join(injected, IS_WIN ? 'Scripts' : 'bin', exeName));
      out.push(injected);            // 兜底（理论上不该命中，会被 isFile 挡掉）
    }
  }

  // 2. data/venv（fpk 安装形态）
  if (data) {
    const venv = join(data, 'venv');
    if (IS_WIN) {
      out.push(join(venv, 'Scripts', 'python.exe'));
      out.push(join(venv, 'Scripts', 'python3.exe'));
      // 兜底：万一有人把 POSIX 布局复制过来了
      out.push(join(venv, 'bin', 'python3'));
    } else {
      out.push(join(venv, 'bin', 'python3'));
      out.push(join(venv, 'bin', 'python'));
    }
  }

  return out;
}

/**
 * 解析出可执行的 Python 绝对路径。
 * @returns {{path: string, source: string}} source 用于诊断，标明是哪种形态
 */
export function resolvePython() {
  const tried = [];
  for (const p of candidates()) {
    if (!p) continue;
    tried.push(p);
    try {
      if (!existsSync(p)) continue;
      // 目录绝不能当解释器返回：spawn(目录) 在 Windows 上是 ENOENT，
      // 在 Linux 上是 EACCES，两种都炸。2026-11-27 真机踩过。
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      if (isDir) continue;

      const src = p.includes('runtime') ? 'desktop-runtime'
        : p.includes('/venv/') || p.includes('\\venv\\') ? 'venv'
        : 'injected';
      return {path: p, source: src};
    } catch {
      /* 权限之类，跳过 */
    }
  }

  // 3. 最后才靠 PATH —— Linux 上通常有 python3，Windows 几乎必然没有
  const fallback = IS_WIN ? 'python.exe' : 'python3';
  if (process.env.PANEL_PYTHON_DEBUG) {
    console.error('[resolvePython] 全部候选都不存在:', tried);
    console.error('[resolvePython] 退回 PATH 查找:', fallback);
  }
  return {path: fallback, source: 'path'};
}

/** 只要路径的简写，绝大多数调用点用这个。 */
export function pythonPath() {
  return resolvePython().path;
}

/** 诊断用：把候选与命中情况拼成一行，贴进报错里能直接看出坏在哪。 */
export function pythonDiagnostics() {
  const {path, source} = resolvePython();
  return `python=${path} source=${source} platform=${process.platform} data=${process.env.DATA_DIR || '(unset)'} injected=${process.env.CHATES_PYTHON_ROOT || '(unset)'}`;
}

export {IS_WIN};

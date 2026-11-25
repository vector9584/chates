// 会话思考强度（2026-11-21）
// 存「这个会话选的是哪一档」，存在 VAR/panel-state/reasoning/<sid>.json。
// 为什么不塞进 Hermes 自己的 session 状态：那边是进程内对象，重启就没了；
// 面板要的是「刷新/换设备/重启之后，这个会话还是那档」。
// 也不塞 panel-workspace.json：那里每会话一条 overlay 记录，读写整文件，
// 档位变更频率比它高，混在一起容易互相踩。
import * as fs from 'node:fs';
import {join} from 'node:path';
import {StateFile, safeId} from './panel-state.js';

const LEVELS = new Set(['off', 'low', 'medium', 'high']);
const EFFORT2LV = {none: 'off', off: 'off'};

export function normalizeReasoning(level) {
  if (level === null || level === undefined) return 'off';
  const v = String(level).trim().toLowerCase();
  if (v === '' || EFFORT2LV[v]) return 'off';
  return LEVELS.has(v) ? v : null;
}

export function createSessionReasoning(root) {
  const dir = join(root, 'reasoning');
  const file = sid => new StateFile(
    join(dir, safeId(sid) + '.json'),
    () => ({version: 1, level: 'off', updated_at: 0}),
    {validate: d => d && d.version === 1 && typeof d.level === 'string'}
  );

  return {
    /* 没有记录时返回 off —— StateFile.read() 文件不存在时给的就是初始值，
       所以「updated_at 为 0」等价于「这个会话从没设过」，不必额外判文件。 */
    get(sid) {
      const d = file(sid).read();
      return d.updated_at ? (normalizeReasoning(d.level) || 'off') : 'off';
    },
    put(sid, level) {
      const norm = normalizeReasoning(level);
      if (norm === null) return null;
      file(sid).write({version: 1, level: norm, updated_at: Date.now()});
      return norm;
    },
  };
}

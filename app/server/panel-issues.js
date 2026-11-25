/* Issue 收件箱（面板内反馈，无需 GitHub 账号）
 *
 * 背景：右上角原只有一个跳 GitHub 的按钮，普通人不会提 issue，反馈就丢了。
 * 这里给一个站内表单：分类树点选 + 标题/正文 + 提交人必填，落到本地面板
 * 数据目录，再由汇总视图统一查看。
 *
 * 存储：<home>/var/issues/issues.jsonl（JSON Lines，一行一条，只追加不改写）
 *   - 追加写而不是读-改-写整个数组，避免并发提交互相覆盖
 *   - 每行独立可解析，坏一行不毁全库
 *
 * 编码：写盘统一 utf8（Windows 上不写 encoding 会按 cp936 写坏中文，
 * 这是本项目同一天踩过的第三个坑，见 knowledge/项目/hermes-windows/05）。
 */
import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/* 分类树：两级。键名固定，改动必须同步前端 ISSUE_TAXONOMY。
 * 只给稳定存在的版块，不追功能细枝——分太细用户点不到自己要报的地方。 */
export const ISSUE_TAXONOMY = [
  { id: 'chat', label: '对话', children: [
    { id: 'chat-session',   label: '会话' },
    { id: 'chat-tree',      label: '会话树' },
    { id: 'chat-panel',     label: '对话面板' },
    { id: 'chat-input',     label: '输入框' },
    { id: 'chat-render',    label: '消息渲染' },
    { id: 'chat-stream',    label: '流式输出' },
  ]},
  { id: 'panel', label: '面板', children: [
    { id: 'panel-nav',      label: '导航与布局' },
    { id: 'panel-model',    label: '模型与配置' },
    { id: 'panel-skill',    label: '技能' },
    { id: 'panel-memory',   label: '记忆与资料' },
    { id: 'panel-cron',     label: '定时任务' },
    { id: 'panel-file',     label: '文件与上传' },
    { id: 'panel-voice',    label: '语音与朗读' },
    { id: 'panel-theme',    label: '主题与样式' },
  ]},
  { id: 'channel', label: '渠道', children: [
    { id: 'channel-config', label: '渠道配置' },
    { id: 'channel-recv',   label: '收不到消息' },
    { id: 'channel-send',   label: '发不出消息' },
    { id: 'channel-media',  label: '图片与语音' },
  ]},
  { id: 'runtime', label: '运行', children: [
    { id: 'runtime-start',  label: '启动与连接' },
    { id: 'runtime-update', label: '更新与升级' },
    { id: 'runtime-perf',   label: '卡顿与性能' },
    { id: 'runtime-error',  label: '报错与崩溃' },
  ]},
  { id: 'other', label: '其他', children: [
    { id: 'other-feature',  label: '功能建议' },
    { id: 'other-doc',      label: '文档与说明' },
    { id: 'other-misc',     label: '其他' },
  ]},
];

const ALL_LEAF_IDS = new Set(
  ISSUE_TAXONOMY.flatMap(g => g.children.map(c => c.id))
);
/* 一级 id 也可当叶子用（用户只想选"对话"不细分） */
const ALL_GROUP_IDS = new Set(ISSUE_TAXONOMY.map(g => g.id));

function labelOf(id) {
  for (const g of ISSUE_TAXONOMY) {
    if (g.id === id) return g.label;
    for (const c of g.children) if (c.id === id) return `${g.label} / ${c.label}`;
  }
  return null;
}

const MAX_NAME = 64;
const MAX_TITLE = 200;
const MAX_BODY = 8000;

function bad(msg, status = 400) {
  return { ok: false, error: msg, status };
}

function clean(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

export function createIssueStore({ home }) {
  const dir = join(home, 'var', 'issues');
  const file = join(dir, 'issues.jsonl');

  function ensureDir() {
    mkdirSync(dir, { recursive: true });
  }

  /* 读全部条目。坏行跳过但计数，不静默吞掉——静默吞等于告诉用户"提交成功"却丢了。 */
  function list() {
    if (!existsSync(file)) return { items: [], skipped: 0 };
    const raw = readFileSync(file, 'utf8');
    const items = [];
    let skipped = 0;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t);
        if (o && typeof o === 'object') items.push(o);
        else skipped++;
      } catch {
        skipped++;
      }
    }
    return { items, skipped };
  }

  /* 提交。校验全部通过才落盘，任何一项不合格都不写。 */
  function submit(body) {
    if (!body || typeof body !== 'object') return bad('提交内容为空');

    const name = clean(body.name, MAX_NAME);
    if (!name) return bad('请填写你的名字');
    if (name.length < 1) return bad('名字太短');

    const category = clean(body.category, 64);
    if (!category) return bad('请选择问题板块');
    if (!ALL_LEAF_IDS.has(category) && !ALL_GROUP_IDS.has(category)) {
      return bad('问题板块不在可选范围内');
    }

    const title = clean(body.title, MAX_TITLE);
    if (!title) return bad('请填写问题标题');
    if (title.length < 2) return bad('标题太短，至少 2 个字');

    const detail = clean(body.detail, MAX_BODY);
    if (!detail) return bad('请描述具体问题');
    if (detail.length < 5) return bad('请把问题描述清楚一点，至少 5 个字');

    const item = {
      id: `iss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      name,
      category,
      categoryLabel: labelOf(category) || category,
      title,
      detail,
      /* 提交时环境快照，排查时有用：版本、平台、UA 前 160 字 */
      context: {
        version: clean(body.version, 40) || null,
        platform: clean(body.platform, 40) || null,
        ua: clean(body.ua, 160) || null,
      },
    };

    ensureDir();
    appendFileSync(file, JSON.stringify(item) + '\n', 'utf8');
    return { ok: true, item };
  }

  /* 汇总：按一级版块分组，便于一眼看出哪块问题最多 */
  function summary() {
    const { items, skipped } = list();
    const byGroup = {};
    for (const g of ISSUE_TAXONOMY) byGroup[g.id] = { label: g.label, count: 0 };
    for (const it of items) {
      const gid = String(it.category || '').split('-')[0];
      const key = byGroup[gid] ? gid : 'other';
      byGroup[key].count++;
    }
    const sorted = items.slice().sort((a, b) =>
      String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    );
    return {
      total: items.length,
      skipped,
      groups: ISSUE_TAXONOMY.map(g => ({ id: g.id, label: g.label, count: byGroup[g.id].count })),
      recent: sorted.slice(0, 50),
    };
  }

  return { submit, list, summary, taxonomy: ISSUE_TAXONOMY, file };
}

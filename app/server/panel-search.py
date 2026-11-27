#!/usr/bin/env python3
"""Read-only search across panel, room and channel conversations.

2026-11-11 性能重写（第 36 项）：
  旧版对 2 字关键词（「面板」「会话」这种中文最常见长度）走的是
  `instr(lower(content))` —— 1.8G 的 messages 表全表扫，实测 8.5s 且被
  7s 超时打断（partial=True），等于每次都白跑一遍还只回 6 条。
  trigram FTS 只对 >=3 字生效，2 字必然退化，所以这里改成：
    · >=3 字 → messages_fts_trigram，ORDER BY timestamp DESC LIMIT 200
    · <3 字  → 先按 last_activity_at 取最近 600 个会话，再只在这些会话里 LIKE
  两条路径都有 LIMIT，延迟可预期；超时也保留已经拿到的结果，不再整段丢弃。
"""
import json, sqlite3, sys, time
from pathlib import Path
try:
  import sys as _sys_enc
  _sys_enc.stdout.reconfigure(encoding='utf-8')
  _sys_enc.stderr.reconfigure(encoding='utf-8')
except Exception:
  pass

root = Path(sys.argv[1]); var = Path(sys.argv[2])
q = sys.argv[3].strip(); offset = int(sys.argv[4]) if len(sys.argv) > 4 else 0
LIMIT = 200
out = []; partial = False; capped = False
needle = q.casefold()

def text(v):
    if isinstance(v, str): return v
    if isinstance(v, list): return '\n'.join(str(x.get('text', '')) for x in v if isinstance(x, dict))
    return ''

def add(kind, sid, title, body, index, ts, role='assistant', message_id=None):
    if not isinstance(body, str): return
    p = body.casefold().find(needle)
    if p < 0: return
    start = max(0, p - 65); end = min(len(body), p + len(q) + 140)
    out.append(dict(kind=kind, session_id=sid, title=title or '未命名会话',
                    snippet=('…' if start else '') + body[start:end] + ('…' if end < len(body) else ''),
                    message_index=index, message_id=message_id, ts=ts or 0, role=role))

if not q:
    print('{"results":[],"total":0}'); sys.exit()

# ── 1. 面板会话 + 专家房间（JSON，16M 上下，几十毫秒） ──────────────
for f in (var / 'chat/sessions').glob('*.json'):
    try: s = json.loads(f.read_text())
    except Exception: continue
    if s.get('group'): continue
    add('panel', s['id'], s.get('title'), s.get('title', ''), -1, s.get('updated_at'))
    for i, m in enumerate(s.get('messages', [])):
        if m.get('role') in ('user', 'assistant'):
            add('panel', s['id'], s.get('title'), text(m.get('content')), i, m.get('ts'), m['role'])

try: rooms = {r['id']: r for r in json.loads((root / 'rooms.json').read_text())}
except Exception: rooms = {}
for file in (var / 'panel-state/rooms').glob('*.json'):
    try:
        room = json.loads(file.read_text()); rooms[room['id']] = room
    except Exception: partial = True
for r in rooms.values():
    add('room', r['id'], r.get('title'), r.get('title', ''), -1, r.get('updated_at'))
    for i, m in enumerate(r.get('messages', [])):
        add('room', r['id'], r.get('title'), text(m.get('text')), i, m.get('ts'), m.get('kind'), m.get('id'))

# ── 2. 渠道会话（state.db） ────────────────────────────────────────
# 2026-11-27：state.db 不存在时，sqlite3.connect 在 ro 模式下抛错、被外层吞成 partial=True，
# 前端拿到的是「0 条结果」——用户以为搜不到，实际是库根本没有。这里先判存在性，
# 缺失就把原因带出去，让页面能显示「会话状态库还没建立」而不是假装搜完了。
db_note = ''
if not (root / 'state.db').exists():
    partial = True
    db_note = '会话状态库还没建立，发一条消息或重启应用后会自动创建'
try:
    c = sqlite3.connect('file:' + str(root / 'state.db') + '?mode=ro', uri=True, timeout=2)
    deadline = time.monotonic() + 2.0
    c.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 20000)

    # 标题命中：sessions 表很小，保持全扫
    # 2026-11-27：去掉 source!='api_server'。桌面版（Windows/macOS 打包版）的会话
    # 一律由网关以 api_server 写进 state.db，不存在 var/chat/sessions/*.json，
    # 原来那条过滤把用户全部真实会话排除干净——搜「Desktop」「casm」一律 0 条。
    # 保留 kind='channel' 便于前端跳转，语义上它现在就是「state.db 里的会话」。
    try:
        for sid, title, ts in c.execute(
            "SELECT id,COALESCE(title,display_name,''),last_activity_at FROM sessions "
            "WHERE instr(lower(COALESCE(title,display_name,'')),lower(?))>0 LIMIT 50", (q,)):
            add('channel', sid, title, title, -1, (ts or 0) * 1000)
    except sqlite3.Error: partial = True

    got = 0
    cols = "s.id,COALESCE(s.title,s.display_name,s.source),m.content,m.id,m.timestamp,m.role"
    if len(q) >= 3:
        query = '"' + q.replace('"', '""') + '"'
        sql = ("SELECT " + cols + " FROM messages_fts_trigram f JOIN messages m ON m.id=f.rowid "
               "JOIN sessions s ON s.id=m.session_id WHERE messages_fts_trigram MATCH ? "
               "AND m.role IN ('user','assistant') AND m.active=1 "
               "ORDER BY m.timestamp DESC LIMIT " + str(LIMIT))
        args = (query,)
    else:
        # 2 字以内：trigram 用不上。先按活跃度圈出候选会话，再**分批**在候选里 LIKE。
        # 一次圈 600 个会话做一条大 IN，遇到热门词还是要扫几十万行（实测 2.3s）。
        # 改成分批 + 早停：一批 60 个会话，凑够 200 条或超过 1.5s 就收手，
        # 延迟有上界，热门词第一批就命中。
        recent = [r[0] for r in c.execute(
            "SELECT id FROM sessions "
            "ORDER BY COALESCE(last_activity_at,0) DESC LIMIT 600")]
        t0 = time.monotonic()
        for i in range(0, len(recent), 60):
            chunk = recent[i:i + 60]
            if not chunk: break
            ph = ','.join('?' * len(chunk))
            sql = ("SELECT " + cols + " FROM messages m JOIN sessions s ON s.id=m.session_id "
                   "WHERE m.session_id IN (" + ph + ") AND instr(lower(m.content),lower(?))>0 "
                   "AND m.role IN ('user','assistant') AND m.active=1 "
                   "ORDER BY m.timestamp DESC LIMIT " + str(LIMIT))
            try:
                for sid, title, content, mid, ts, role in c.execute(sql, tuple(chunk) + (q,)):
                    got += 1
                    add('channel', sid, title, text(content), mid, (ts or 0) * 1000, role)
            except sqlite3.OperationalError:
                partial = True
                break
            if got >= LIMIT:
                capped = True
                break
            if time.monotonic() - t0 > 1.5:
                partial = True
                break
        sql = None; args = None

    if sql:
        try:
            for sid, title, content, mid, ts, role in c.execute(sql, args):
                got += 1
                add('channel', sid, title, text(content), mid, (ts or 0) * 1000, role)
            if got >= LIMIT: capped = True
        except sqlite3.OperationalError: partial = True   # 进度回调中断：保留已拿到的
    c.close()
except sqlite3.Error:
    partial = True

out.sort(key=lambda x: x['ts'], reverse=True)
print(json.dumps({'results': out[offset:offset + 40], 'total': len(out), 'offset': offset,
                  'has_more': offset + 40 < len(out), 'partial': partial, 'capped': capped,
                  'note': db_note},
                 ensure_ascii=False))

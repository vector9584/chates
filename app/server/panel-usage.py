import datetime
import json
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path
try:
  import sys as _sys_enc
  _sys_enc.stdout.reconfigure(encoding='utf-8')
  _sys_enc.stderr.reconfigure(encoding='utf-8')
except Exception:
  pass

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from panel_pricing import (channel_multiplier, model_class, peak_ratio,
                               price_summary, token_cost)
except ImportError:  # 单独跑测试时的兜底：没有计价模块就不编数字
    channel_multiplier = model_class = peak_ratio = token_cost = price_summary = None

TOKEN_FIELDS = ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'api_call_count')


def load_providers(config_path):
    """读 config.yaml 的 providers，用来还原渠道倍率。读不到就返回空字典。"""
    try:
        import yaml
        with open(config_path, encoding='utf-8') as handle:
            data = yaml.safe_load(handle) or {}
        providers = data.get('providers') or {}
        return providers if isinstance(providers, dict) else {}
    except Exception:
        return {}


def read_usage(database, config_path=None):
    connection = sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True, timeout=5)
    if not config_path:
        # monitor.js 只传库路径，倍率得自己找：库就在 data/ 下，config.yaml 同级。
        guess = Path(database).resolve().parent / 'config.yaml'
        if guess.is_file():
            config_path = str(guess)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA query_only=ON')
    connection.execute('BEGIN')
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'sessions' not in tables:
        raise ValueError('用量数据库缺少会话表')
    providers = load_providers(config_path) if config_path else {}
    priced_ok = token_cost is not None

    def select_fields(table, fields):
        columns = {row[1] for row in connection.execute('PRAGMA table_info('+table+')')}
        selected = [field for field in fields if field in columns]
        return [dict(row) for row in connection.execute('SELECT '+','.join(selected)+' FROM '+table)]

    sessions = select_fields('sessions', ('id', 'model', 'started_at', 'ended_at', 'billing_base_url', *TOKEN_FIELDS))
    ledger = select_fields('session_model_usage', ('session_id','model','billing_provider','billing_base_url','task',*TOKEN_FIELDS,'estimated_cost_usd','actual_cost_usd','cost_status','first_seen','last_seen')) if 'session_model_usage' in tables else []
    recorded_main = defaultdict(lambda: defaultdict(int))
    # 辅助调用（vision/compression）常常没记 base_url，用同会话主记录的地址兜底，
    # 否则它们只能按原价算，「custom」这种 provider id 会漏到渠道名上。
    session_base = {}
    for row in sessions:
        url = row.get('billing_base_url')
        if row.get('id') and url:
            session_base[row['id']] = url
    for row in ledger:
        if not row.get('billing_base_url') and row.get('session_id') in session_base:
            row['billing_base_url'] = session_base[row['session_id']]
    groups = {}

    def key_for(model, provider, task, historical, channel):
        return (model, provider, task, historical, channel)

    def ensure(model, provider, task, historical, channel):
        key = key_for(model, provider, task, historical, channel)
        if key not in groups:
            groups[key] = {'model': model, 'provider': provider, 'task': task, 'historical': historical,
                           'channel': channel,
                           'session_ids': set(), 'estimated_cost_usd': 0.0, 'actual_cost_usd': 0.0,
                           'cost_cny': 0.0, 'priced_records': 0, 'billed_records': 0, 'usage_records': 0,
                           'unpriced_tokens': 0, 'multiplier': 1.0, 'multiplier_label': None,
                           **{field: 0 for field in TOKEN_FIELDS}}
        return groups[key]

    def add(row, historical=False):
        raw_model = row.get('model')
        model = None if not raw_model or raw_model in ('unknown', 'auto') else raw_model
        provider = row.get('billing_provider') or None
        task = row.get('task') or 'main'
        multiplier, label = 1.0, None
        if priced_ok and model:
            multiplier, label = channel_multiplier(row.get('billing_base_url'), model, providers)
        target = ensure(model, provider, task, historical, label or provider or '未标记')
        target['usage_records'] += 1
        target['session_ids'].add(row.get('session_id') or row.get('id'))
        for field in TOKEN_FIELDS:
            target[field] += int(row.get(field) or 0)
        cost_status = row.get('cost_status') or ''
        # 库里存着的金额仍然单独记：有就展示，但不拿它当估算的唯一来源。
        auxiliary_estimate = bool(row.get('task')) and float(row.get('estimated_cost_usd') or 0) > 0
        if row.get('estimated_cost_usd') is not None and (cost_status not in ('unknown', 'unavailable', 'unpriced', '') or auxiliary_estimate):
            target['estimated_cost_usd'] += float(row['estimated_cost_usd'])
            target['priced_records'] += 1
        if row.get('actual_cost_usd') is not None and cost_status in ('actual', 'billed', 'actual_reported'):
            target['actual_cost_usd'] += float(row['actual_cost_usd'])
            target['billed_records'] += 1

        # 按 token 现算：这是面板「估算费用」的真来源。
        if priced_ok and model:
            ratio = peak_ratio(row.get('first_seen'), row.get('last_seen'))
            amount = token_cost(model, row.get('cache_read_tokens'), row.get('input_tokens'),
                                row.get('output_tokens'), multiplier, ratio)
            if amount is None:
                target['unpriced_tokens'] += int(row.get('input_tokens') or 0) + int(row.get('output_tokens') or 0) + int(row.get('cache_read_tokens') or 0)
            else:
                target['cost_cny'] += amount
                target['multiplier'] = multiplier
                target['multiplier_label'] = label

    for row in ledger:
        add(row)
        if not row.get('task'):
            for field in TOKEN_FIELDS:
                recorded_main[row['session_id']][field] += int(row.get(field) or 0)

    for session in sessions:
        saved = recorded_main.get(session['id'], {})
        remainder = {field: max(0, int(session.get(field) or 0) - saved.get(field, 0)) for field in TOKEN_FIELDS}
        if any(remainder.values()):
            # 主对话：用会话自己的模型与起止时间，按跨度分摊高峰占比
            add({'id': session['id'], 'model': session.get('model'),
                 'billing_base_url': session.get('billing_base_url'),
                 'first_seen': session.get('started_at'), 'last_seen': session.get('ended_at'),
                 **remainder}, historical=True)

    rows = []
    for group in groups.values():
        group['sessions'] = len(group.pop('session_ids'))
        group['total_tokens'] = group['input_tokens'] + group['output_tokens']
        if not group['priced_records']:
            group['estimated_cost_usd'] = None
        if not group['billed_records']:
            group['actual_cost_usd'] = None
        group['cost_cny'] = round(group['cost_cny'], 4)
        rows.append(group)
    rows.sort(key=lambda row: row['total_tokens'], reverse=True)

    totals = {field: sum(row[field] for row in rows) for field in TOKEN_FIELDS}
    totals['total_tokens'] = totals['input_tokens'] + totals['output_tokens']
    totals['estimated_cost_usd'] = sum(row['estimated_cost_usd'] or 0 for row in rows) if any(row['priced_records'] for row in rows) else None
    totals['actual_cost_usd'] = sum(row['actual_cost_usd'] or 0 for row in rows) if any(row['billed_records'] for row in rows) else None
    # 面板主数字：按 token 现算的人民币估算。
    totals['cost_cny'] = round(sum(row['cost_cny'] for row in rows), 2)
    totals['unpriced_tokens'] = sum(row['unpriced_tokens'] for row in rows)
    totals['priced'] = priced_ok

    # 按渠道汇总，方便看出每个中转站各自花了多少。
    by_channel = {}
    for row in rows:
        label = row.get('multiplier_label') or (row.get('provider') or '未标记')
        item = by_channel.setdefault(label, {'channel': label, 'cost_cny': 0.0, 'tokens': 0,
                                             'multiplier': row.get('multiplier', 1.0), 'unpriced_tokens': 0})
        item['cost_cny'] += row['cost_cny']
        item['tokens'] += row['total_tokens']
        item['unpriced_tokens'] += row['unpriced_tokens']
    for item in by_channel.values():
        item['cost_cny'] = round(item['cost_cny'], 2)
    # 2026-11-22：grok/claude/gpt/gemini/glm 已按各自官方刊例价计价，不再只进 unpriced。
    # unpriced_tokens 现在只剩「价目表里查不到的模型」——真·无价可查的那部分。
    channel_rows = [c for c in by_channel.values() if c['cost_cny'] > 0]
    channel_rows.sort(key=lambda x: x['cost_cny'], reverse=True)

    activity = []
    message_count = 0
    if 'messages' in tables:
        columns = {row[1] for row in connection.execute('PRAGMA table_info(messages)')}
        where = 'WHERE active=1' if 'active' in columns else ''
        message_count = connection.execute('SELECT count(*) FROM messages ' + where).fetchone()[0]
        activity = [dict(row) for row in connection.execute(
            "SELECT date(timestamp,'unixepoch','+8 hours') AS date,count(*) AS messages,count(distinct session_id) AS sessions "
            'FROM messages ' + where + ' GROUP BY date ORDER BY date DESC LIMIT 30')]

    # 最近使用：按会话 × 模型 × 任务给出时间段与调用次数。
    recent = []
    if 'session_model_usage' in tables:
        ledger_columns = {row[1] for row in connection.execute('PRAGMA table_info(session_model_usage)')}
        if {'first_seen', 'last_seen'} <= ledger_columns:
            cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=48)).timestamp()
            titles = {}
            if 'sessions' in tables:
                session_columns = {row[1] for row in connection.execute('PRAGMA table_info(sessions)')}
                if 'title' in session_columns:
                    titles = {row[0]: row[1] for row in connection.execute('SELECT id,title FROM sessions')}
            sql = ('SELECT session_id,model,billing_provider,billing_base_url,task,api_call_count,input_tokens,output_tokens,cache_read_tokens,'
                   'first_seen,last_seen FROM session_model_usage WHERE last_seen >= ? ORDER BY last_seen DESC LIMIT 60')
            zone = datetime.timezone(datetime.timedelta(hours=8))
            for row in connection.execute(sql, (cutoff,)):
                item = dict(row)
                item['calls'] = int(item.pop('api_call_count') or 0)
                item['tokens'] = int(item.pop('input_tokens') or 0) + int(item.pop('output_tokens') or 0)
                cache_read = int(item.pop('cache_read_tokens') or 0)
                item['model'] = item.get('model') or ''
                item['provider'] = item.pop('billing_provider', None) or ''
                base_url = item.pop('billing_base_url', None)
                item['task'] = item.get('task') or ''
                item['title'] = (titles.get(item['session_id']) or '')[:40]
                if priced_ok and item['model']:
                    multiplier, label = channel_multiplier(base_url, item['model'], providers)
                    amount = token_cost(item['model'], cache_read, item['tokens'] - cache_read, 0,
                                        multiplier, peak_ratio(item.get('first_seen'), item.get('last_seen')))
                    item['cost_cny'] = round(amount, 4) if amount else 0
                    item['channel'] = label or item['provider']
                for field in ('first_seen', 'last_seen'):
                    stamp = item.get(field)
                    item[field] = datetime.datetime.fromtimestamp(float(stamp), zone).strftime('%m-%d %H:%M') if stamp else ''
                recent.append(item)

    connection.close()
    coverage = {'ledger_rows': len(ledger), 'main_rows': sum(not row.get('task') for row in ledger),
                'auxiliary_rows': sum(bool(row.get('task')) for row in ledger),
                'priced_rows': sum(row['priced_records'] for row in rows),
                'billed_rows': sum(row['billed_records'] for row in rows),
                'historical_tokens': sum(row['total_tokens'] for row in rows if row['historical']),
                'ledger_unattributed_tokens': sum(row['total_tokens'] for row in rows if not row['historical'] and row['model'] is None)}
    coverage['unpriced_rows'] = len(ledger) - coverage['priced_rows']
    notes = [
        '估算费用按各家官方刊例价 × token 现算，再乘渠道倍率；DeepSeek 另乘高峰倍率。',
        '高峰=周一至周五 9-12、14-18（北京时间）价格翻倍，只作用于 DeepSeek 价目，其他厂商不翻倍；未接法定节假日，节假日会算贵一倍。',
        '美元价按 7.1 折人民币；glm / qwen / kimi 本身是人民币报价，不折算。',
        '不含 Search / Fetch 的独立计费，也不含图片理解之外的额外项；价目表里查不到官方价的模型（目前只有 cugb-fast）只列 token 不计价。',
        '所以这是可复现的估算，不保证等于任一平台的账单。',
    ]
    payload = {'source': 'Hermes 执行记录', 'timezone': 'Asia/Shanghai', 'period': '全部已记录调用',
               'total_sessions': len(sessions), 'total_messages': message_count, 'totals': totals, 'by_model': rows,
               'by_channel': channel_rows, 'activity': activity, 'recent': recent, 'coverage': coverage,
               'unattributed_tokens': sum(row['total_tokens'] for row in rows if row['model'] is None),
               'notes': notes, 'currency': 'CNY',
               'updated_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    if price_summary:
        payload['pricing'] = price_summary()
    return payload


if __name__ == '__main__':
    try:
        config = sys.argv[2] if len(sys.argv) > 2 else None
        print(json.dumps({'ok': True, 'usage': read_usage(sys.argv[1], config)}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': '读取用量失败：' + str(error)}, ensure_ascii=False))
        sys.exit(1)

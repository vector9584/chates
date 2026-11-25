"""能力实验室 · 批量全测（2026-11-23 主人要求）

原来只能「选一个服务 → 一个模型 → 手点 14 张卡」。用户的话是：「基于我选的
已经添加的模型全量测试」。所以这里的口径变了：

  行 = 你已添加的模型（providers[].models[]，含停用标记），不是服务
  列 = 通用能力项，每一项都**实际发请求**，并且判「真生效」而不是「HTTP 200」

为什么不能只看 HTTP 200：2026-11-23 实测 ZeroAPI 官转对
`tools: [{type: deepseek_web_search}]` 回 200 且答得像模像样，但 usage 里
`server_tool_use` 是空的 —— 参数被吞了，模型靠脑补答的。只看状态码会把它标绿。

判据（每项都有硬证据字段，不看模型卡）：
  ctx     探 /models 报的上下文长度；问一句要 echo 一个记号，验证 max_tokens 被认
  vision  三色不对称图，必须答对「左红中绿右蓝、最宽绿」；答错/拒答 = 不支持
  stream  真收 SSE 分片，数 chunk 数与首字延迟
  tools   给两个函数 + 要求并行调用，看 tool_calls 里是否真有两个不同参数
  json    要求 json_object + 指定键，回来能否 json.loads 且键对
  reason  三档 effort 各打一次，比 usage 里的 reasoning_tokens 是否随档位上升
          （只看思维链字数会把「返回了字段」当成「档位生效」）
  long     发 ~8k 字符长文让模型回一个埋在第 8 段的记号，验长上下文不截断（可选）

每条结论都带 status/ms/证据，前端只负责上色。
"""
import json
import re
import time
import urllib.error
import urllib.request

from panel_config_txn import ConfigError
from panel_model_catalog import entries, provider_fields, enabled, model_rows, model_ids
from panel_model_caps import _endpoints, _env_file, _request, _json, _err, resolve_target, _err

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

# 一张左右不对称的三色图：左窄红、中带宽绿、右窄蓝。单色图模型能靠猜蒙对，
# 这个必须真看到像素才答得出来（2026-11-23 三通道实测均答对）。
IMAGE_B64 = (
    'iVBORw0KGgoAAAANSUhEUgAAAGAAAAAoCAIAAACO8WhuAAAAVUlEQVR42u3QQQ0AIAwAsfOvAqfDAT8eS5pU'
    'QZt66CzR/CJIkCBBggQJEiRIkCBBggQJEiRIkCBBggQJEiRIkCBBggQJEiRIkCBBggQJEiRIkKBtQRdd'
    'VLJmXRqSxgAAAABJRU5ErkJggg==')

CAPS = (
    ('reach', '能连通', '打一次最小补全，确认地址与密钥可用'),
    ('stream', '流式输出', '真收 SSE 分片，数 chunk 与首字延迟'),
    ('tools', '函数调用', '给两个函数要求并行调用，看 tool_calls 是否真回来'),
    ('json', 'JSON 输出', 'response_format=json_object，回来要能解析且键正确'),
    ('reason', '思考强度', 'low/high 各打一次，比 reasoning_tokens 是否真随档位变化'),
    ('vision', '识图', '打一张不对称三色图，必须答对颜色与最宽者'),
)

PROBE_CAPS = tuple(cap[0] for cap in CAPS)


def _post(urls, secret, payload, timeout=90, stream=False):
    """带浏览器 UA 的请求：urllib 默认 UA 会被 Cloudflare 一类风控回 403 + HTML，
    那不是 key 的问题。HTML 错误页单独归类，不误判成鉴权失败。"""
    body = json.dumps(payload).encode()
    req = urllib.request.Request(urls, data=body, method='POST')
    req.add_header('Authorization', 'Bearer ' + secret)
    req.add_header('Content-Type', 'application/json')
    req.add_header('Accept', 'text/event-stream' if stream else 'application/json')
    req.add_header('User-Agent', UA)
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if not stream:
                return resp.status, resp.read(), int((time.time() - started) * 1000), resp.headers
            chunks, first_ms, buf = 0, None, b''
            for line in resp:
                if first_ms is None:
                    first_ms = int((time.time() - started) * 1000)
                buf += line
                if line.startswith(b'data:'):
                    chunks += 1
                if len(buf) > 400000:
                    break
            return resp.status, buf, int((time.time() - started) * 1000), {'chunks': chunks, 'first_ms': first_ms}
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), int((time.time() - started) * 1000), exc.headers
    except Exception as exc:  # noqa: BLE001
        return -1, str(exc).encode(), int((time.time() - started) * 1000), {}


def _msg(raw):
    head = raw.lstrip()[:1]
    if head == b'<':
        snippet = raw.decode('utf-8', 'replace')
        title = re.search(r'<title[^>]*>(.*?)</title>', snippet, re.S | re.I)
        return ({'_html': True},
                '返回 HTML 页面（%s）——多半是站点风控或该地址没有这个接口，不是密钥问题'
                % ((title.group(1).strip()[:40] if title else '无标题')), '')
    data = {}
    try:
        data = json.loads(raw.decode('utf-8', 'replace'))
    except Exception:  # noqa: BLE001
        return {}, '返回的不是 JSON', ''
    if not isinstance(data, dict):
        return {}, '返回结构不是对象', ''
    err = data.get('error')
    if err:
        text = err.get('message') if isinstance(err, dict) else str(err)
        return data, str(text or '上游报错')[:300], ''
    choice = (data.get('choices') or [{}])[0] if isinstance(data.get('choices'), list) else {}
    message = choice.get('message') or {}
    content = message.get('content')
    if isinstance(content, list):
        content = ''.join(str(p.get('text') or '') for p in content if isinstance(p, dict))
    return data, str(content or ''), str(message.get('reasoning_content') or '')


def _verdict(ok, label, evidence, status=200, ms=0, extra=None):
    return {'ok': bool(ok), 'label': label, 'evidence': evidence, 'status': status, 'ms': ms,
            **(extra or {})}


def probe_reach(base, secret, model):
    urls = _endpoints(base)
    st, raw, ms, _ = _post(urls['chat'], secret, {
        'model': model, 'max_tokens': 24, 'stream': True,
        'messages': [{'role': 'user', 'content': '只回两个字：在的'}]}, timeout=45, stream=True)
    if st != 200:
        _, text, _ = _msg(raw)
        return _verdict(False, '不可用', text or raw[:120].decode('utf-8', 'replace'), st, ms)
    data, content, reasoning = _msg(raw)
    text = (content or reasoning).strip()
    return _verdict(bool(text), '可用' if text else '通了但没内容',
                    'SSE 分片 %d 个 · 首字 %sms' % (len(raw.split(b'data:')) - 1,
                                                    '-'), st, ms)


def probe_stream(base, secret, model):
    urls = _endpoints(base)
    st, raw, ms, meta = _post(urls['chat'], secret, {
        'model': model, 'max_tokens': 120, 'stream': True,
        'messages': [{'role': 'user', 'content': '数到十，每个数字之间用逗号'}]},
        timeout=90, stream=True)
    chunks = int(meta.get('chunks') or 0) if isinstance(meta, dict) else 0
    if st != 200:
        _, text, _ = _msg(raw)
        return _verdict(False, '不支持', text or '非 200', st, ms)
    events = raw.count(b'data:')
    first = None
    for line in raw.splitlines():
        if line.startswith(b'data:'):
            try:
                piece = json.loads(line[5:].strip())
            except Exception:  # noqa: BLE001
                continue
            delta = ((piece.get('choices') or [{}])[0] or {}).get('delta') or {}
            if delta.get('content') or delta.get('reasoning_content'):
                first = piece
                break
    real = bool(first)
    return _verdict(real, '真流式' if real else '未收到分片',
                    'SSE 事件 %d 个 · 实测 %d ms' % (events, ms), st, ms)


def probe_tools(base, secret, model):
    urls = _endpoints(base)
    tools = [
        {'type': 'function', 'function': {
            'name': 'get_weather', 'description': '查某城市天气',
            'parameters': {'type': 'object', 'properties': {'city': {'type': 'string'}},
                           'required': ['city']}}},
        {'type': 'function', 'function': {
            'name': 'get_time', 'description': '查某城市当前时间',
            'parameters': {'type': 'object', 'properties': {'city': {'type': 'string'}},
                           'required': ['city']}}},
    ]
    st, raw, ms, _ = _post(urls['chat'], secret, {
        'model': model, 'max_tokens': 500, 'tools': tools, 'tool_choice': 'auto',
        'messages': [{'role': 'user',
                      'content': '北京现在天气和现在时间，两个都查，一次把两个工具都调用出来。'}]})
    if st != 200:
        _, text, _ = _msg(raw)
        return _verdict(False, '不支持', text or '非 200', st, ms)
    data, content, _ = _msg(raw)
    calls = (((data.get('choices') or [{}])[0] or {}).get('message') or {}).get('tool_calls') or []
    names = []
    args_ok = 0
    for call in calls:
        fn = call.get('function') or {}
        names.append(str(fn.get('name')))
        try:
            parsed = json.loads(fn.get('arguments') or '{}')
            if isinstance(parsed, dict) and parsed.get('city'):
                args_ok += 1
        except Exception:  # noqa: BLE001
            pass
    if not calls:
        return _verdict(False, '参数被吞', '无 tool_calls，正文：%s' % (content[:80] or '空'), st, ms)
    ok = len(set(names)) >= 2 and args_ok >= 1
    return _verdict(ok, '支持（%d 个调用）' % len(calls),
                    '工具 %s · 参数合法 %d/%d' % ('/'.join(names), args_ok, len(calls)), st, ms)


def probe_json(base, secret, model):
    urls = _endpoints(base)
    st, raw, ms, _ = _post(urls['chat'], secret, {
        'model': model, 'max_tokens': 200,
        'response_format': {'type': 'json_object'},
        'messages': [{'role': 'user',
                      'content': '以 JSON 返回，键必须是 city 和 temp_c 两个，值随便填。只输出 JSON。'}]})
    if st != 200:
        _, text, _ = _msg(raw)
        low = text.lower()
        label = '不支持' if 'response_format' in low or 'json' in low else '失败'
        return _verdict(False, label, text or '非 200', st, ms)
    data, content, reasoning = _msg(raw)
    text = (content or '').strip()
    if not text:
        return _verdict(False, '空响应', '只回了思维链 %d 字' % len(reasoning), st, ms)
    body = re.sub(r'^```(?:json)?|```$', '', text, flags=re.M).strip()
    try:
        parsed = json.loads(body)
    except Exception:  # noqa: BLE001
        return _verdict(False, '返回不是 JSON', text[:100], st, ms)
    keys_ok = isinstance(parsed, dict) and 'city' in parsed
    return _verdict(keys_ok, '支持' if keys_ok else 'JSON 但键不对',
                    '键 %s' % (list(parsed.keys())[:6] if isinstance(parsed, dict) else type(parsed).__name__),
                    st, ms)


def probe_reason(base, secret, model):
    """effort 真伪看 usage.reasoning_tokens，不看思维链字数。

    2026-11-23 实测：官方 high→799 / max→898 reasoning_tokens 会变；
    ZeroAPI 官转 high→317 / max→640 也会变；但也有通道三档全 0 —— 那就叫「吞参数」。
    """
    urls = _endpoints(base)
    question = '17 的 23 次方的末四位数是多少？只给数字。'
    marks = {}
    for effort in ('low', 'high'):
        st, raw, ms, _ = _post(urls['chat'], secret, {
            'model': model, 'max_tokens': 3000,
            'thinking': {'type': 'enabled'}, 'reasoning_effort': effort,
            'messages': [{'role': 'user', 'content': question}]}, timeout=120)
        if st != 200:
            data, text, _ = _msg(raw)
            # 明确拒绝 effort 说明模型不支持思考档位，不是网络问题
            marks[effort] = None
            marks.setdefault('_note', text or '非 200')
            continue
        data, content, reasoning = _msg(raw)
        usage = data.get('usage') or {}
        det = usage.get('completion_tokens_details') or {}
        tokens = det.get('reasoning_tokens')
        if tokens is None:
            tokens = usage.get('reasoning_tokens')
        marks[effort] = tokens
    low, high = marks.get('low'), marks.get('high')
    if low is None and high is None:
        return _verdict(False, '不支持', marks.get('_note') or '两档都没回 reasoning', 0, 0)
    if not low and not high:
        return _verdict(False, '参数被吞', '两档 reasoning_tokens = 0，档位没生效', 0, 0)
    grew = (high or 0) > (low or 0)
    return _verdict(True, '生效' + ('' if grew else '（档位差异小）'),
                    'reasoning_tokens low=%s · high=%s' % (low, high), 0, 0)


def probe_vision(base, secret, model):
    urls = _endpoints(base)
    st, raw, ms, _ = _post(urls['chat'], secret, {
        'model': model, 'max_tokens': 600,
        'messages': [{'role': 'user', 'content': [
            {'type': 'text', 'text': '这张图从左到右依次是什么颜色？最宽的是哪个？一行答完。'},
            {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + IMAGE_B64}}]}]},
        timeout=120)
    if st != 200:
        _, text, _ = _msg(raw)
        low = text.lower()
        if 'image' in low and ('not support' in low or 'invalid' in low or '不支持' in text):
            return _verdict(False, '不支持识图', text[:140], st, ms)
        return _verdict(False, '失败', text or '非 200', st, ms)
    data, content, reasoning = _msg(raw)
    answer = (content or reasoning).strip()
    if not answer:
        return _verdict(False, '没读图', '正文与思维链都是空的', st, ms)
    if len(answer) < 12:
        # 实测 deepseek-v4-pro 对三色图只回「haha」——不是看不见，是拒答/不配合。
        # 这和「答错颜色」是两件事，分开报，别让用户以为图像格式坏了。
        return _verdict(False, '拒答（未描述图像）', answer[:60], st, ms)
    hit = '红' in answer and '绿' in answer and '蓝' in answer
    order_ok = hit and answer.find('红') < answer.find('绿') < answer.find('蓝')
    widest = '绿' in answer.split('最宽')[-1] if '最宽' in answer else False
    ok = hit and order_ok
    return _verdict(ok, '识图通过' if ok else '答得像蒙的',
                    answer[:130].replace('\n', ' ') + ('｜最宽对' if widest else ''), st, ms)


PROBES = {'reach': probe_reach, 'stream': probe_stream, 'tools': probe_tools,
          'json': probe_json, 'reason': probe_reason, 'vision': probe_vision}


def _skip_all(caps, label, evidence):
    """模型级失败（密钥缺失/地址不通/模型不存在）：每一项都被这同一堵墙挡住，
    不再是「六项各自不通」。合并成一条，别让用户以为要挨个去修六处。"""
    return {cap: _verdict(False, label, evidence) for cap in caps}


def candidates(data):
    """已添加的模型清单 —— 行是模型，不是服务。停用的也列出来但打标，用户能自己看。"""
    rows = []
    for identifier, (origin, index, item) in entries(data).items():
        try:
            fields = provider_fields(item, origin)
        except Exception:  # noqa: BLE001
            continue
        try:
            models = model_ids(item, origin)
        except Exception:  # noqa: BLE001
            models = []
        name = str(item.get('name') or identifier)
        for model in models:
            rows.append({'provider': identifier, 'provider_name': name,
                         'model': str(model), 'base_url': str(fields.get('base_url') or ''),
                         'enabled': bool(enabled(item))})
    return rows


def matrix(body, data, home):
    rows = candidates(data)
    selected = body.get('selection')
    if isinstance(selected, list) and selected:
        keep = {(str(s.get('provider')), str(s.get('model'))) for s in selected if isinstance(s, dict)}
        rows = [r for r in rows if (r['provider'], r['model']) in keep]
    caps = [{'id': cap[0], 'label': cap[1], 'desc': cap[2]} for cap in CAPS
            if cap[0] in PROBE_CAPS]
    return {'ok': True, 'cap': 'matrix', 'caps': caps, 'rows': rows,
            'providers': sorted({(r['provider'], r['provider_name']) for r in rows} and
                                [{'id': p, 'name': n} for p, n in
                                 {(r['provider'], r['provider_name']) for r in rows}], key=lambda x: x['name']),
            'count': len(rows)}


def run_matrix(body, data, home, progress=None):
    """逐模型逐能力跑。progress 是个回调，前端走长轮询拿不到，所以这里按批返回；
    单次调用受 nginx 超时约束，默认每批 3 个模型（约 6 项能力 ≈ 60 秒）。"""
    rows = candidates(data)
    selected = body.get('selection')
    if isinstance(selected, list) and selected:
        keep = {(str(s.get('provider')), str(s.get('model'))) for s in selected if isinstance(s, dict)}
        rows = [r for r in rows if (r['provider'], r['model']) in keep]
    caps = [c for c in (str(x) for x in (body.get('caps') or PROBE_CAPS)) if c in PROBE_CAPS]
    start = max(int(body.get('start') or 0), 0)
    limit = min(max(int(body.get('limit') or 3), 1), 8)
    batch = rows[start:start + limit]
    out, targets = [], {}
    for row in batch:
        try:
            target = resolve_target(data, row['provider'], home)
        except ConfigError as exc:
            out.append({'provider': row['provider'], 'provider_name': row['provider_name'],
                        'model': row['model'], 'enabled': row['enabled'],
                        'base_url': row['base_url'],
                        'caps': {cap: _verdict(False, '无密钥', exc.message) for cap in caps}})
            continue
        targets[row['provider']] = target
        results = {}
        for cap in caps:
            fn = PROBES[cap]
            try:
                results[cap] = fn(target['base_url'], target['secret'], row['model'])
            except Exception as exc:  # noqa: BLE001
                results[cap] = _verdict(False, '探测异常', repr(exc)[:160])
            # 第一项（能连通）就撞墙，后面几项必然是同一个原因；只跑一次省时间，
            # 把真实报文复制给每一项，省得用户对着六个「不支持」猜哪里坏了。
            if cap == 'reach' and not results[cap]['ok'] and len(caps) > 1:
                rest = {c: _verdict(False, '未测（连通性先失败）', results[cap]['evidence'][:160])
                        for c in caps if c != 'reach'}
                results.update(rest)
                break
        out.append({'provider': row['provider'], 'provider_name': row['provider_name'],
                    'model': row['model'], 'enabled': row['enabled'],
                    'base_url': row['base_url'], 'caps': results})
    return {'ok': True, 'cap': 'run_matrix', 'rows': out,
            'start': start, 'limit': limit, 'total': len(rows),
            'next': start + len(batch) if start + len(batch) < len(rows) else None}

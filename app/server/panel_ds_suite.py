"""DeepSeek 落点功能全测 —— 一个供应商的一个模型 × 全部 18 项能力。

设计口径（2026-11-23 主人定）：
  上方选一个 provider + 一个 model，下方列出 DeepSeek 现有全部功能，一键全测。
  每一项都真发请求，判据是「真拿到硬证据」，不是 HTTP 200。

18 项按主人给的清单分四组，字段名全部按官方 API 参考核准：
  对话内能力  MO模型清单 CH基础对话 CH深度思考 CH会话标题 CH内容安全
              CH联网搜索 CH阅读链接 CH用户元信息 CH文件解析
  独立接口    TO独立搜索 TO独立抓取 TOOCR接口 TO语音识别 TO语音合成
  落点映射    每一项同时对出它落到 config.yaml 的哪个对象

为什么必须逐项真打（2026-11-23 实测教训）：
  ZeroAPI 官转对 /v1/tools/search 回 200 + 一张 SPA 的 HTML 首页。
  只看状态码会把「中转根本没有这个端点」判成「支持」。所以：
    - 响应必须能解析成 JSON，且带该端点该有的字段
    - Content-Type 是 text/html 一律判失败，并把「这是网页不是接口」写进证据
"""
import base64
import json
import struct
import time
import urllib.error
import urllib.request
import uuid
import zlib

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

# 18 项能力：id, 分组, 短名, 落到哪个配置对象, 判据说明
CAPS = (
    # --- 对话内能力（走 /chat/completions，服务端内置工具）---
    ('models',    'chat', 'MO模型清单',   'providers 的 base_url + api_key',
     'GET /models 返回 JSON 列表，且里面真有这个模型'),
    ('chat',      'chat', 'CH基础对话',   'model.default · 主模型',
     '普通 chat/completions 往返，答出指定串'),
    ('thinking',  'chat', 'CH深度思考',   'extra_body.thinking + reasoning_effort',
     'thinking 开/关各打一次，看 reasoning_tokens 是否真随档位变'),
    ('title',     'chat', 'CH会话标题',   'extra_body.title',
     'title 参数，服务端真生成一个短标题'),
    ('safety',    'chat', 'CH内容安全',   'extra_body.safety_check',
     'safety_check 开启时正常问题照答（不误杀）'),
    ('websearch', 'chat', 'CH联网搜索',   'tools: deepseek_web_search',
     '给 deepseek_web_search 工具，要求查实时信息，看结果里有无引用'),
    ('readurl',   'chat', 'CH阅读链接',   'tools: deepseek_read_url',
     '给 deepseek_read_url 工具，要求读 example.com 并复述页面上的话'),
    ('reminder',  'chat', 'CH用户元信息', 'latest_reminder · 主模型',
     '问「今天几号」看是否被注入当前日期（不是训练截止日）'),
    ('fileparse', 'chat', 'CH文件解析',   'files 上传后用 file_id 引用',
     '真上传一张图拿 file_id，再在对话里引用它'),

    # --- 独立接口（不走对话）---
    ('tosearch',  'tools', 'TO独立搜索',  'web.backend · 搜索',
     'POST /v1/tools/search，回 results 数组'),
    ('tofetch',   'tools', 'TO独立抓取',  'web.backend · 抓取',
     'POST /v1/tools/fetch，回 Markdown 正文'),
    ('toocr',     'tools', 'TOOCR接口',   '无独立槽位 · 跟随服务商',
     'POST /v1/tools/ocr 传图，回 pages[].text'),
    ('toasr',     'tools', 'TO语音识别',  'stt.provider',
     'POST /v1/tools/asr 传音频，回 text'),
    ('tottss',    'tools', 'TO语音合成',  'tts.provider',
     'POST /v1/tools/tts，回真 WAV（RIFF 头）'),
)

PROBE_CAPS = tuple(c[0] for c in CAPS)

# 通用能力卡：任何 OpenAI 兼容通道都该有的五件事，不分 DeepSeek 专属。
# 主人 2026-11-23 点名要回来：「连通性、流式输出、函数调用、json 输出、识图」。
# 之前我把它们塞进 DS 14 项里一起算，结果界面上看不见了 —— 这几项是判断
# 「这条线到底能不能拿来干活」的底线，要单独成卡，不能混在功能清单里。
GENERIC = (
    ('g_reach',   'G连通性',   'GET /models',        '能连上、能认证、模型清单能返回'),
    ('g_stream',  'G流式输出', 'stream: true',       '真收到多个分片，不是一次性吐完'),
    ('g_tools',   'G函数调用', 'tools + tool_choice', '模型真回 tool_calls，参数能解析'),
    ('g_json',    'Gjson输出', 'response_format',    '给定 json_schema，回来的正文能解析成 JSON'),
    ('g_vision',  'G识图',     '多模态 image_url',   '真发一张三色图，能答对颜色顺序'),
)

# 思考强度的细粒度档位：不是开/关两档就完事。
# 官方 reasoning_effort 认 low / medium / high；这里逐档真打，看 reasoning_tokens
# 是否随档位单调变化。哪一档被吞、哪一档其实一样，一眼能看出来。
EFFORT_LEVELS = ('minimal', 'low', 'medium', 'high')

# 主清单 18 项里另外 4 项是「映射说明」，不单独发请求：
#   TO独立搜索 → web.backend · 搜索      （已并入 tosearch 的证据）
#   TO独立抓取 → web.backend · 抓取      （已并入 tofetch）
#   TOOCR      → 无独立槽位 · 跟随服务商 （已并入 toocr）
#   用户元信息 → latest_reminder          （已并入 reminder）


def _bands_png():
    """96×40 不对称三色图：左 10px 红、中 56px 绿、右 30px 蓝。
    不对称是为了「答对颜色」不能靠猜——纯色图模型蒙一个也能中。"""
    w, h = 96, 40
    raw = b''
    for _ in range(h):
        row = b'\x00'
        for x in range(w):
            row += bytes((220, 30, 30)) if x < 10 else (
                bytes((30, 190, 60)) if x < 66 else bytes((30, 60, 220)))
        raw += row

    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)

    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw))
            + chunk(b'IEND', b''))


def _urls_of(ep):
    """把 _endpoints() 的字典折成「chat 优先的地址列表」，供只打对话的探针用。"""
    if isinstance(ep, dict):
        return [ep.get('chat')] if ep.get('chat') else []
    return list(ep or [])


def _root_of(ep):
    """取 root（去掉 /v1 和 /chat/completions 的部分），独立接口都挂在它下面。"""
    if isinstance(ep, dict) and ep.get('tool'):
        return str(ep['tool']('search')).rsplit('/tools/', 1)[0]
    urls = _urls_of(ep)
    if not urls:
        return ''
    return urls[0].split('/chat/completions')[0].rstrip('/').removesuffix('/v1')


def _talk(urls, secret, payload, timeout=120, stream=True, raw=False):
    """逐 URL 试（同一个 provider 可能配了多个 base 候选）。
    stream=True 是硬要求：部分中转对 stream=false 直接回 400 streaming_required，
    那不是模型不支持，是接口要求。"""
    if stream and isinstance(payload, dict) and 'stream' not in payload:
        payload = dict(payload, stream=True)
    urls = _urls_of(urls)
    last = (0, b'', 0, {})
    for url in urls:
        req = urllib.request.Request(url, data=json.dumps(payload).encode(), method='POST')
        req.add_header('Authorization', 'Bearer ' + secret)
        req.add_header('Content-Type', 'application/json')
        req.add_header('User-Agent', UA)
        started = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
                last = (resp.status, body, int((time.time() - started) * 1000), dict(resp.headers))
                if resp.status == 200:
                    return last
        except urllib.error.HTTPError as exc:
            last = (exc.code, exc.read(), int((time.time() - started) * 1000), dict(exc.headers or {}))
            if exc.code not in (404, 405, 400):
                return last
        except Exception as exc:  # noqa: BLE001
            last = (0, repr(exc).encode(), int((time.time() - started) * 1000), {})
    return last


def _multipart(urls, secret, pairs, timeout=120):
    boundary = '----b' + uuid.uuid4().hex
    body = b''
    for key, value in pairs:
        if isinstance(value, tuple):
            name, content, ctype = value
            body += (f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"; '
                     f'filename="{name}"\r\nContent-Type: {ctype}\r\n\r\n').encode() + content + b'\r\n'
        else:
            body += f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
    body += f'--{boundary}--\r\n'.encode()
    if isinstance(urls, dict):
        urls = [urls[k] for k in ('ocr', 'asr') if urls.get(k)] or []
    else:
        urls = list(urls or [])
    last = (0, b'', 0, {})
    for url in urls:
        req = urllib.request.Request(url, data=body, method='POST')
        req.add_header('Authorization', 'Bearer ' + secret)
        req.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')
        req.add_header('User-Agent', UA)
        started = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                last = (resp.status, resp.read(), int((time.time() - started) * 1000), dict(resp.headers))
                return last
        except urllib.error.HTTPError as exc:
            last = (exc.code, exc.read(), int((time.time() - started) * 1000), dict(exc.headers or {}))
            if exc.code not in (404, 405):
                return last
        except Exception as exc:  # noqa: BLE001
            last = (0, repr(exc).encode(), int((time.time() - started) * 1000), {})
    return last


def _verdict(ok, label, evidence, status=200, ms=0, extra=None):
    row = {'ok': bool(ok), 'label': label, 'evidence': str(evidence)[:400],
           'status': status, 'ms': ms}
    if extra:
        row.update(extra)
    return row


def _json(body, headers):
    """把响应体解析成 JSON。走中转时最常见的坑：200 + text/html 的 SPA 首页。
    那种「成功」比 403 更隐蔽，必须单独判。"""
    ctype = str((headers or {}).get('Content-Type') or (headers or {}).get('content-type') or '')
    text = body[:4000].decode('utf-8', 'replace')
    if 'html' in ctype.lower() or text.lstrip().lower().startswith('<!doctype html'):
        return None, 'HTTP 200 但回的是网页（text/html），这个中转没有该端点'
    try:
        return json.loads(body.decode('utf-8', 'replace')), None
    except Exception:
        return None, '响应不是 JSON：' + text[:120].replace('\n', ' ')


def _answer(body, headers):
    """把 SSE 分片拼成正文 + reasoning + tool_calls + 用量。"""
    ctype = str((headers or {}).get('Content-Type') or '')
    text = body.decode('utf-8', 'replace')
    if 'html' in ctype.lower() or text.lstrip().lower().startswith('<!doctype html'):
        return None, 'HTTP 200 但回的是网页（text/html），这个中转没有该端点'
    content, reasoning, tools, usage, chunks, first_ms = [], [], [], {}, 0, None
    title = ''
    if 'text/event-stream' in ctype or text.lstrip().startswith('data:'):
        for line in text.splitlines():
            line = line.strip()
            if not line.startswith('data:'):
                continue
            data = line[5:].strip()
            if data == '[DONE]':
                break
            try:
                obj = json.loads(data)
            except Exception:
                continue
            chunks += 1
            if obj.get('usage'):
                usage = obj['usage']
            for choice in obj.get('choices') or []:
                delta = choice.get('delta') or {}
                if delta.get('content'):
                    if first_ms is None:
                        first_ms = chunks
                    content.append(delta['content'])
                if delta.get('reasoning_content'):
                    reasoning.append(delta['reasoning_content'])
                if delta.get('tool_calls'):
                    # 流式 tool_calls 是按 index 分片下发的：第一片带 id/name，
                    # 后续每片只带 arguments 的一小截（`{"`、`city`、`":"北京"`…）。
                    # 直接 extend 会得到一串残片，arguments 几乎全是空的，
                    # 看起来像「模型没回参数」——实际是没拼回去（2026-11-23 实测：
                    # get_weather 的参数被拆成 8 片，最后 arguments 只剩 ''）。
                    for call in delta['tool_calls']:
                        idx = int(call.get('index') or 0)
                        while len(tools) <= idx:
                            tools.append({'id': '', 'type': 'function',
                                          'function': {'name': '', 'arguments': ''}})
                        slot = tools[idx]
                        if call.get('id'):
                            slot['id'] = call['id']
                        fn = call.get('function') or {}
                        if fn.get('name'):
                            slot['function']['name'] = fn['name']
                        if fn.get('arguments'):
                            slot['function']['arguments'] += fn['arguments']
                if delta.get('title'):
                    title = str(delta['title'])
                if choice.get('message', {}).get('title') if isinstance(choice.get('message'), dict) else False:
                    title = str(choice['message']['title'])
    else:
        try:
            obj = json.loads(text)
        except Exception:
            return None, '响应既不是 SSE 也不是 JSON：' + text[:120].replace('\n', ' ')
        if obj.get('usage'):
            usage = obj['usage']
        for choice in obj.get('choices') or []:
            msg = choice.get('message') or {}
            content.append(msg.get('content') or '')
            if msg.get('reasoning_content'):
                reasoning.append(msg['reasoning_content'])
            if msg.get('tool_calls'):
                tools.extend(msg['tool_calls'])
    if not title and isinstance(obj, dict):
        for choice in obj.get('choices') or []:
            msg = choice.get('message')
            if isinstance(msg, dict) and msg.get('title'):
                title = str(msg['title'])
    return {'content': ''.join(content), 'reasoning': ''.join(reasoning),
            'tools': tools, 'usage': usage or {}, 'chunks': chunks,
            'title': title}, None


# ---------------- 对话内能力 ----------------

def probe_models(urls, secret, model):
    target = None
    if isinstance(urls, dict):
        url = urls.get('models') or ''
        urls = [url] if url else []
    for url in urls:
        base = url.split('/models')[0].rstrip('/')
        try:
            req = urllib.request.Request(base + '/models')
            req.add_header('Authorization', 'Bearer ' + secret)
            req.add_header('User-Agent', UA)
            started = time.time()
            with urllib.request.urlopen(req, timeout=45) as resp:
                body, status = resp.read(), resp.status
                headers = dict(resp.headers)
        except urllib.error.HTTPError as exc:
            return _verdict(False, '地址或密钥不可用', f'GET {base}/models → {exc.code}',
                            exc.code, 0)
        except Exception as exc:  # noqa: BLE001
            return _verdict(False, '地址不可达', f'GET {base}/models → {exc!r}'[:200])
        ms = int((time.time() - started) * 1000)
        data, err = _json(body, headers)
        if err:
            return _verdict(False, '地址不可用', err, status, ms)
        ids = [str(x.get('id')) for x in (data.get('data') or []) if isinstance(x, dict)]
        hit = model in ids
        target = _verdict(hit, '模型在清单里' if hit else '模型不在清单里',
                          f'GET /models 200，共 {len(ids)} 个模型；' +
                          (f'找到 {model}' if hit else f'没有 {model}，前几个：' + ', '.join(ids[:6])),
                          status, ms)
        return target
    return _verdict(False, '无可用地址', 'provider 没有配 base_url')


def probe_chat(urls, secret, model):
    status, body, ms, headers = _talk(urls, secret, {
        'model': model, 'max_tokens': 64,
        'messages': [{'role': 'user', 'content': '只回四个字母：PONG'}]})
    got, err = _answer(body, headers)
    if err:
        return _verdict(False, '对话不通', err, status, ms)
    text = (got['content'] or '').strip()
    ok = 'PONG' in text.upper()
    return _verdict(ok, '对话往返正常' if ok else '答非所问',
                    f'{ms}ms，{got["chunks"]} 个分片，正文：{text[:90]}', status, ms)


def probe_thinking(urls, secret, model):
    """思考强度逐档真打，不是只有开/关。

    主人 2026-11-23 指出「思考强度也只弄了开、关没有细粒度划分」。
    现在把 minimal/low/medium/high 四档各打一次，记下每档的
    reasoning_tokens 和正文长度，前端按档位画出来 —— 哪一档被上游吞掉、
    哪两档其实一样，一眼看得见。
    """
    url = _chat_url(urls)
    levels, detail = [], {}
    total_ms = 0
    for level in EFFORT_LEVELS:
        payload = {
            'model': model, 'max_tokens': 900,
            'reasoning_effort': level,
            'messages': [{'role': 'user',
                          'content': '一个数除以 3 余 2，除以 5 余 3，最小是多少？只给数字。'}]}
        status, body, ms, headers = _talk(url, secret, payload)
        total_ms += ms
        got, err = _answer(body, headers)
        if err:
            levels.append({'level': level, 'ok': False, 'label': err[:60],
                           'rt': 0, 'chars': 0, 'ms': ms, 'answer': ''})
            continue
        usage = got.get('usage') or {}
        det = usage.get('completion_tokens_details') or {}
        rt = int(det.get('reasoning_tokens') or 0)
        answer = (got.get('content') or '').strip()
        levels.append({'level': level, 'ok': True, 'label': f'{rt} tokens',
                       'rt': rt, 'chars': len(answer), 'ms': ms, 'answer': answer[:60]})
        detail[level] = rt

    usable = [x for x in levels if x['ok']]
    if not usable:
        return _verdict(False, '思考不可用', '四档全部失败', 200, total_ms,
                        {'levels': levels})
    rts = [x['rt'] for x in usable]
    # 判据三层：真出思考 token、档位之间真不同、高档不低于低档（单调）
    has_rt = any(x > 0 for x in rts)
    distinct = len(set(rts)) > 1
    monotonic = rts == sorted(rts)
    ok = has_rt and distinct
    if not has_rt:
        label = '四档都没有 reasoning_tokens（只把思维链塞进正文）'
    elif not distinct:
        label = f'四档 token 数一样（{rts[0]}），档位被上游吞了'
    elif not monotonic:
        label = f'档位有效但不单调 {rts}'
    else:
        label = f'四档递进 {rts}'
    return _verdict(ok, label,
                    ' / '.join(f'{x["level"]}={x["rt"]}t' for x in usable),
                    200, total_ms,
                    {'levels': levels, 'distinct': distinct, 'monotonic': monotonic})


def probe_title(urls, secret, model):
    # 官方写法是对象不是布尔：{"title": {"enabled": true}}，且标题落在
    # 流式最后一个 chunk 的 delta.title（非流式在 message.title）。写在顶层，不是 extra_body。
    status, body, ms, headers = _talk(urls, secret, {
        'model': model, 'max_tokens': 400,
        'title': {'enabled': True},
        'messages': [{'role': 'user', 'content': '我叫示例用户，在北京做地理信息相关工作，喜欢用 NAS 存电影。'}]})
    got, err = _answer(body, headers)
    if err:
        return _verdict(False, '标题参数不通', err, status, ms)
    title = (got.get('title') or '').strip()[:60]
    ok = bool(title)
    return _verdict(ok, '服务端生成了标题' if ok else '响应里没有 title 字段',
                    f'标题 = {title}' if ok else
                    f'正文：{(got["content"] or "")[:100]}（官方说明：被拒答或出错时可能不带标题）',
                    status, ms)


def probe_safety(urls, secret, model):
    status, body, ms, headers = _talk(urls, secret, {
        'model': model, 'max_tokens': 80,
        'extra_body': {'safety_check': True},
        'messages': [{'role': 'user', 'content': '中国的首都是哪个城市？只回城市名。'}]})
    got, err = _answer(body, headers)
    if err:
        return _verdict(False, '安全参数不通', err, status, ms)
    text = (got['content'] or '')
    refused = bool(got.get('refusal') or (got.get('usage') or {}).get('refusal'))
    # 判据：正常问题不能被误杀。安全参数若要 400/拒绝正常问题，那是有害的。
    ok = bool(text.strip()) and not refused
    return _verdict(ok, '正常问题照答（未误杀）' if ok else '正常问题被拦',
                    f'正文：{text[:90] or "(空)"}；refusal={refused}', status, ms)


def probe_websearch(urls, secret, model):
    status, body, ms, headers = _talk(urls, secret, {
        'model': model, 'max_tokens': 500,
        'tools': [{'type': 'function', 'function': {
            'name': 'deepseek_web_search',
            'description': '联网搜索，返回带引用的网页结果',
            'parameters': {'type': 'object', 'properties': {
                'query': {'type': 'string', 'description': '搜索词'}}, 'required': ['query']}}}],
        'messages': [{'role': 'user',
                      'content': '用 deepseek_web_search 查一下 DeepSeek 最新发布的模型是什么，给出引用。'}]})
    got, err = _answer(body, headers)
    if err:
        return _verdict(False, '联网搜索不通', err, status, ms)
    used = [t.get('function', {}).get('name') for t in got['tools'] if isinstance(t, dict)]
    cited = 'http' in (got['content'] or '') or bool(got.get('citations'))
    ok = bool(used) or cited
    return _verdict(ok, '服务端真去搜了' if ok else '既没调工具也没引用',
                    f'tool_calls={used}；正文：{(got["content"] or "")[:110]}', status, ms)


def probe_readurl(urls, secret, model):
    status, body, ms, headers = _talk(urls, secret, {
        'model': model, 'max_tokens': 500,
        'tools': [{'type': 'function', 'function': {
            'name': 'deepseek_read_url',
            'description': '读取网页正文',
            'parameters': {'type': 'object', 'properties': {
                'url': {'type': 'string'}}, 'required': ['url']}}}],
        'messages': [{'role': 'user',
                      'content': '读 https://example.com 这个页面，告诉我页面上的版权声明那句话是什么。'}]})
    got, err = _answer(body, headers)
    if err:
        return _verdict(False, '读链接不通', err, status, ms)
    text = got['content'] or ''
    used = [t.get('function', {}).get('name') for t in got['tools'] if isinstance(t, dict)]
    # example.com 正文里有一句 "This domain is for use in documentation examples"
    hit = ('documentation' in text.lower() or '示例' in text or 'example' in text.lower())
    ok = hit or bool(used)
    return _verdict(ok, '真读了页面' if ok else '没读到页面内容',
                    f'tool_calls={used}；正文：{text[:110]}', status, ms)


def probe_reminder(urls, secret, model):
    import datetime
    today = datetime.date.today()
    # max_tokens 不能小：思考模式默认开，思维链会吃光预算，正文 0 字，
    # 那不是「没注入日期」，是预算被 reasoning 吃了（2026-11-23 实测踩过）。
    status, body, ms, headers = _talk(urls, secret, {
        'model': model, 'max_tokens': 800,
        'messages': [{'role': 'user', 'content': '今天是几月几号？只回日期。'}]})
    got, err = _answer(body, headers)
    if err:
        return _verdict(False, '元信息不通', err, status, ms)
    text = got['content'] or ''
    ok = (str(today.year) in text) and (str(today.month) in text)
    return _verdict(ok, '日期真注入了' if ok else '答案里没有当前日期',
                    f'今天={today}；模型答：{text[:80]}', status, ms)


def probe_fileparse(urls, secret, model):
    base = _root_of(urls)
    png = _bands_png()
    status, body, ms, headers = _multipart([base + '/files'], secret,
                                          [('purpose', 'user_data'),
                                           ('file', ('bands.png', png, 'image/png'))])
    data, err = _json(body, headers)
    if err:
        return _verdict(False, '上传失败', err, status, ms)
    fid = data.get('id')
    if not fid:
        return _verdict(False, '没有 file_id', str(data)[:160], status, ms)
    status2, body2, ms2, headers2 = _talk(urls, secret, {
        'model': model, 'max_tokens': 800,
        'messages': [{'role': 'user', 'content': [
            {'type': 'text', 'text': '这张图从左到右是什么颜色？按顺序说。'},
            {'type': 'file', 'file_id': fid}]}]})
    got, err2 = _answer(body2, headers2)
    if err2:
        return _verdict(False, 'file_id 引用失败', err2, status2, ms2)
    text = got['content'] or ''
    ok = any(c in text for c in ('红', '绿', '蓝')) or 'red' in text.lower()
    return _verdict(ok, 'file_id 引用成功' if ok else '引用后没读到图',
                    f'file_id={fid}；答：{text[:100]}', status2, ms + ms2)


# ---------------- 独立接口 ----------------

def probe_tosearch(urls, secret, model):
    base = _root_of(urls)
    status, body, ms, headers = _talk([base + '/tools/search'], secret,
                                      {'query': 'DeepSeek V4', 'count': 3}, stream=False)
    data, err = _json(body, headers)
    if err:
        return _verdict(False, '独立搜索不可用', err, status, ms)
    hits = data.get('results') or data.get('data') or []
    ok = isinstance(hits, list) and len(hits) > 0
    title = (hits[0].get('title') if ok and isinstance(hits[0], dict) else '')
    return _verdict(ok, f'返回 {len(hits)} 条结果' if ok else '没有结果数组',
                    f'第一条：{title}' if ok else str(data)[:160], status, ms)


def probe_tofetch(urls, secret, model):
    base = _root_of(urls)
    status, body, ms, headers = _talk([base + '/tools/fetch'], secret,
                                      {'url': 'https://example.com'}, stream=False)
    data, err = _json(body, headers)
    if err:
        return _verdict(False, '独立抓取不可用', err, status, ms)
    text = str(data.get('content') or data.get('markdown') or '')
    ok = len(text.strip()) > 40
    return _verdict(ok, '抓到正文' if ok else '正文为空',
                    f'{len(text)} 字：{text[:100].replace(chr(10), " ")}', status, ms)


def probe_toocr(urls, secret, model):
    base = _root_of(urls)
    png = _bands_png()
    status, body, ms, headers = _multipart([base + '/tools/ocr'], secret,
                                           [('purpose', 'text_recognition'),
                                            ('file', ('bands.png', png, 'image/png'))])
    data, err = _json(body, headers)
    if err:
        return _verdict(False, 'OCR 不可用', err, status, ms)
    pages = data.get('pages') or []
    ok = isinstance(pages, list) and len(pages) > 0
    text = (pages[0].get('text') if ok and isinstance(pages[0], dict) else '') or ''
    return _verdict(ok, f'识别 {len(pages)} 页' if ok else '没有 pages 数组',
                    f'首屏文本：{text[:110]}', status, ms)


def probe_toasr(urls, secret, model):
    base = _root_of(urls)
    # 先合成一句，再让 ASR 读回来 —— 单向测 ASR 得自己造音频，闭环更硬
    status, body, ms, headers = _talk([base + '/tools/tts'], secret,
                                      {'text': '你好，这是一次语音合成测试。', 'voice_id': 'stella'},
                                      stream=False)
    ctype = str((headers or {}).get('Content-Type') or '')
    if status != 200 or 'audio' not in ctype.lower() or body[:4] != b'RIFF':
        return _verdict(False, '拿不到测试音频', f'TTS 前置失败：{status} {ctype}', status, ms)
    status2, body2, ms2, headers2 = _multipart([base + '/tools/asr'], secret,
                                               [('file', ('speech.wav', body, 'audio/wav'))])
    data, err = _json(body2, headers2)
    if err:
        return _verdict(False, '语音识别不可用', err, status2, ms2)
    text = str(data.get('text') or '')
    ok = len(text.strip()) > 2
    return _verdict(ok, f'听出 {len(text)} 字' if ok else '没识别出文字',
                    f'回了：{text[:80]}', status2, ms + ms2)


def probe_tottss(urls, secret, model):
    base = _root_of(urls)
    status, body, ms, headers = _talk([base + '/tools/tts'], secret,
                                      {'text': '你好，这是一次语音合成测试。', 'voice_id': 'stella'},
                                      stream=False)
    ctype = str((headers or {}).get('Content-Type') or '')
    if status != 200:
        return _verdict(False, '语音合成不可用',
                        f'{status}：{body[:140].decode("utf-8", "replace")}', status, ms)
    ok = body[:4] == b'RIFF' and len(body) > 2000
    return _verdict(ok, f'合成 {len(body) // 1024} KB WAV' if ok else '不是 WAV',
                    f'Content-Type={ctype}，前 12 字节={body[:12]!r}', status, ms)


# ---------------- 通用五项：任何 OpenAI 兼容通道的底线 ----------------
# 这五项不测「DeepSeek 有没有这个功能」，测的是「这条线能不能拿来干活」。
# 判据一律要硬证据：真分片数、真 tool_calls、真解析出 JSON、真答对颜色。

_BANDS = None


def _bands_png():
    """三色竖条图（左红/中绿/右蓝），识图探针用。
    每次现画不读外部文件 —— 探针不能依赖磁盘上碰巧存在的素材。"""
    global _BANDS
    if _BANDS is not None:
        return _BANDS
    import struct
    import zlib
    w, h = 96, 40
    seg = [w // 3, w // 3, w - 2 * (w // 3)]
    colors = [(220, 40, 40), (40, 170, 70), (40, 70, 210)]
    raw = b''
    for _y in range(h):
        line = b'\x00'
        for (cw, col) in zip(seg, colors):
            line += bytes(col) * cw
        raw += line

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    _BANDS = (b'\x89PNG\r\n\x1a\n'
              + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
              + chunk(b'IDAT', zlib.compress(raw, 9))
              + chunk(b'IEND', b''))
    return _BANDS


def _chat_url(urls):
    """_talk/_multipart 内部走 _urls_of()，它按可迭代对象逐项试。
    所以这里必须返回「列表」，不能返回裸字符串 —— 传字符串进去会被当成
    字符序列，第一个 URL 变成 'h'，报 unknown url type: 'h'（2026-11-23 实测踩到）。"""
    if isinstance(urls, dict):
        url = urls.get('chat') or ''
    else:
        url = (urls or [''])[0]
    return [url] if url else []


def probe_g_reach(urls, secret, model):
    return probe_models(urls, secret, model)


def probe_g_stream(urls, secret, model):
    url = _chat_url(urls)
    status, body, ms, headers = _talk(url, secret, {
        'model': model, 'max_tokens': 200,
        'messages': [{'role': 'user', 'content': '从 1 数到 20，逗号隔开，不要别的话。'}]})
    got, err = _answer(body, headers)
    if err:
        return _verdict(False, '流式不通', err, status, ms)
    n = int(got.get('chunks') or 0)
    # 一个分片 = 一次性吐完，那只是「长得像流式」
    ok = n > 1
    return _verdict(ok, f'{n} 个分片' if ok else '只有 1 个分片（等于没流式）',
                    f'{ms}ms，分片 {n} 个，正文 {len(got.get("content") or "")} 字', status, ms,
                    {'chunks': n})


def probe_g_tools(urls, secret, model):
    """函数调用：真让模型回 tool_calls，参数还得能解析。

    2026-11-23 实测两个坑，都别再踩：
    1) 流式 tool_calls 按 index 分片，不拼就只剩空 arguments（已在 _answer 修）。
    2) 不带 tool_choice 反而好使：这条官方线对
       {"tool_choice":{"type":"function","function":{...}}} 直接回 400，
       强制指定反而测不出来。所以不给 tool_choice，让它自己决定调不调。
    """
    url = _chat_url(urls)
    tools = [{'type': 'function', 'function': {
        'name': 'get_weather', 'description': '查某城市当前天气',
        'parameters': {'type': 'object', 'properties': {
            'city': {'type': 'string', 'description': '城市名'}},
            'required': ['city']}}}]
    status, body, ms, headers = _talk(url, secret, {
        'model': model, 'max_tokens': 400, 'tools': tools,
        'messages': [{'role': 'user', 'content': '北京今天天气怎么样？用工具查，别直接回答。'}]})
    got, err = _answer(body, headers)
    if err:
        return _verdict(False, '工具不可用', err, status, ms)
    if status >= 400:
        return _verdict(False, f'接口拒绝（HTTP {status}）',
                        f'{ms}ms，HTTP {status}：' + (body or b'')[:160].decode('utf-8', 'replace'),
                        status, ms)
    calls = got.get('tools') or []
    if not calls:
        return _verdict(False, '模型没回 tool_calls',
                        f'{ms}ms，正文：{(got.get("content") or "")[:80]}'
                        '（回了正文却没调工具，说明 tools 参数被吞了）', status, ms)
    name = str((calls[0].get('function') or {}).get('name') or calls[0].get('name') or '')
    args = (calls[0].get('function') or {}).get('arguments') or calls[0].get('arguments') or ''
    parsed = None
    try:
        parsed = json.loads(args) if isinstance(args, str) else args
    except Exception:
        parsed = None
    ok = 'get_weather' in name and isinstance(parsed, dict) and 'city' in parsed
    return _verdict(ok, '真回了 tool_calls 且参数可解析' if ok else 'tool_calls 参数解析不了',
                    f'函数 {name}，参数 {str(args)[:80]}', status, ms,
                    {'calls': [{'name': name, 'arguments': str(args)[:200]}]})


def probe_g_json(urls, secret, model):
    url = _chat_url(urls)
    schema = {'type': 'object', 'properties': {
        'name': {'type': 'string'}, 'age': {'type': 'integer'}},
        'required': ['name', 'age'], 'additionalProperties': False}
    status, body, ms, headers = _talk(url, secret, {
        'model': model, 'max_tokens': 300,
        'response_format': {'type': 'json_object'},
        'messages': [{'role': 'user',
                      'content': '把「张三，30 岁」抽成 JSON：{"name":"...","age":0}。只输出 JSON。'}]})
    got, err = _answer(body, headers)
    if err:
        return _verdict(False, 'JSON 模式不可用', err, status, ms)
    text = (got.get('content') or '').strip()
    parsed = None
    for candidate in (text, text[text.find('{'):text.rfind('}') + 1] if '{' in text else ''):
        try:
            parsed = json.loads(candidate)
            break
        except Exception:
            continue
    ok = isinstance(parsed, dict) and 'name' in parsed and 'age' in parsed
    return _verdict(ok, 'JSON 可解析' if ok else '回来的不是合法 JSON',
                    f'{ms}ms，正文：{text[:120]}', status, ms,
                    {'parsed': parsed if isinstance(parsed, dict) else None,
                     'schema': schema})


def probe_g_vision(urls, secret, model):
    import base64
    url = _chat_url(urls)
    b64 = base64.b64encode(_bands_png()).decode('ascii')
    data_url = 'data:image/png;base64,' + b64
    status, body, ms, headers = _talk(url, secret, {
        'model': model, 'max_tokens': 300,
        'messages': [{'role': 'user', 'content': [
            {'type': 'text', 'text': '这张图从左到右三条竖条分别是什么颜色？按顺序只说颜色名。'},
            {'type': 'image_url', 'image_url': {'url': data_url}}]}]})
    got, err = _answer(body, headers)
    if err:
        return _verdict(False, '多模态不可用', err, status, ms)
    text = (got.get('content') or '').strip()
    low = text.lower()
    red = ('红' in text) or ('red' in low)
    green = ('绿' in text) or ('green' in low)
    blue = ('蓝' in text) or ('blue' in low)
    ok = red and green and blue
    return _verdict(ok, '答对三色' if ok else '没答对颜色',
                    f'{ms}ms，回答：{text[:120]}', status, ms,
                    {'answer': text[:200]})


PROBES = {
    'models': probe_models, 'chat': probe_chat, 'thinking': probe_thinking,
    'title': probe_title, 'safety': probe_safety, 'websearch': probe_websearch,
    'readurl': probe_readurl, 'reminder': probe_reminder, 'fileparse': probe_fileparse,
    'tosearch': probe_tosearch, 'tofetch': probe_tofetch, 'toocr': probe_toocr,
    'toasr': probe_toasr, 'tottss': probe_tottss,
    'g_reach': probe_g_reach, 'g_stream': probe_g_stream, 'g_tools': probe_g_tools,
    'g_json': probe_g_json, 'g_vision': probe_g_vision,
}


def _strip_prefix(label):
    """CAPS 里的 label 为了日志可读带了 MO/CH/TO/G 前缀。
    卡片界面用 .emblem 圆形徽章表达同一个信息，再带前缀就成了
    「[CH] CH基础对话」双份（2026-11-23 主人指出）。所以出口统一剥掉。"""
    for p in ('MO', 'CH', 'TO', 'G'):
        if label.startswith(p):
            return label[len(p):]
    return label


def catalog():
    """能力清单：DS 专属 14 项 + 通用 5 项。

    通用五项单独带 generic=True 标记，前端据此渲染在另一组卡片里 ——
    它们的性质不同：DS 那 14 项回答「这个通道有没有 DeepSeek 的某个功能」，
    通用 5 项回答「这条线到底能不能拿来干活」。
    """
    out = [{'id': c[0], 'group': c[1], 'label': _strip_prefix(c[2]), 'target': c[3],
            'desc': c[4], 'generic': False} for c in CAPS]
    out += [{'id': g[0], 'group': 'generic', 'label': _strip_prefix(g[1]), 'target': g[2],
             'desc': g[3], 'generic': True} for g in GENERIC]
    return out


# 通用五项的能力 id，run() 默认不跑（费时），前端勾了才跑
GENERIC_IDS = tuple(g[0] for g in GENERIC)
ALL_PROBE_IDS = PROBE_CAPS + GENERIC_IDS


# ---------------- 面板入口：一个供应商的一个模型 × 全部能力 ----------------

def view(data, home):
    """上方两颗下拉的数据源：已添加的 provider 和它下面的模型。
    不用 panel_cap_matrix.candidates 那种「一行一个模型」的扁平表 ——
    主人要的是先选供应商、再选模型。"""
    from panel_cap_matrix import candidates

    rows = candidates(data)
    # 主模型所在的 provider —— 前端默认就选它，测用户日常在用的那条线
    main_provider = str(((data.get('model') or {}).get('provider')) or '')
    providers, seen = [], set()
    for row in rows:
        if row['provider'] not in seen:
            seen.add(row['provider'])
            providers.append({'id': row['provider'], 'name': row['provider_name'],
                              'base_url': row['base_url'],
                              'main': row['provider'] == main_provider, 'models': []})
    index = {p['id']: p for p in providers}
    for row in rows:
        item = index.get(row['provider'])
        if item is not None:
            item['models'].append({'id': row['model'], 'enabled': row['enabled']})
    return {'ok': True, 'cap': 'ds_suite_view', 'caps': catalog(),
            'providers': providers, 'count': len(providers)}


def run(body, data, home):
    """一键全测：给定 provider + model，把 CAPS 里每一项真打一遍。
    逐项独立跑，某一项炸了不影响别的项 —— 这正是「落点清单」要的：
    用户要知道哪几项是真能用、哪几项是空槽。"""
    from panel_cap_matrix import resolve_target
    from panel_config_txn import ConfigError

    provider = str(body.get('provider') or '').strip()
    model = str(body.get('model') or '').strip()
    if not provider or not model:
        return {'ok': False, 'error': '先选供应商和模型'}
    caps = [c for c in (str(x) for x in (body.get('caps') or ALL_PROBE_IDS)) if c in ALL_PROBE_IDS]
    started = time.time()
    try:
        target = resolve_target(data, provider, home)
    except ConfigError as exc:
        # ConfigError 只带 status，正文要靠 str(exc)；写 exc.message 会抛
        # AttributeError，把真正的错误原因整个吞掉（2026-11-23 实测踩到）。
        reason = str(exc) or '配置读取失败'
        return {'ok': False, 'error': reason,
                'results': {c: _verdict(False, '无密钥', reason) for c in caps}}
    urls = target.get('urls') or []
    if not urls:
        return {'ok': False, 'error': '该服务没有可用的 base_url',
                'results': {c: _verdict(False, '无地址', '') for c in caps}}
    results = {}
    for cap in caps:
        try:
            results[cap] = PROBES[cap](urls, target['secret'], model)
        except Exception as exc:  # noqa: BLE001
            results[cap] = _verdict(False, '探测异常', repr(exc)[:200])
    passed = sum(1 for v in results.values() if v.get('ok'))
    return {'ok': True, 'cap': 'ds_suite_run', 'provider': provider,
            'provider_name': target.get('name'), 'model': model,
            'base_url': target.get('base_url'), 'caps': catalog(),
            'results': results, 'passed': passed, 'total': len(caps),
            'seconds': round(time.time() - started, 1)}

"""用量计价：按各家官方价目 × 渠道倍率算钱，DeepSeek 另算高峰倍率。

口径（和燃料页 usage_range.php 一致，那边是 DeepSeek 这套算法的原始出处）：
  · 价目表 元/百万 tokens = (缓存命中, 未命中输入, 输出)
      DeepSeek flash / chat : 0.02 / 1.0 / 4.0
      DeepSeek pro          : 0.15 / 4.5 / 13.5
  · 高峰时段：周一到周五 9-12、14-18（北京时间），DeepSeek 价目 ×2
      没接法定节假日，法定节假日会按高峰算，比实际贵一倍——已知偏差。
      非 DeepSeek 供应商没有这个规则，不乘高峰。
  · 渠道倍率：从 config.yaml 的 provider 名称解析 "0.4x" 这类后缀。
      同一 base_url 挂多个倍率时按模型名归属（见 channel_multiplier）。
  · 非 DeepSeek 模型按其官方刊例价折算人民币（USD 乘 USD_CNY），
      不乘高峰（那是 DeepSeek 自己的规则），但照样乘渠道倍率。
  · 不含 Search / Fetch 的独立计费，那部分 token 表里看不见，以账单为准。

2026-11-22：原来只认 DeepSeek 两档，其他模型一律返回 None 不计价。实测库里还有
grok / claude / glm / gpt / gemini 五家共 2.06 亿 token，用户要求按标准补上。
价目来源逐条记在 PRICE_SOURCES，改价时照着重查，不要凭印象改数字。
"""

import datetime
import re

# 元/百万 tokens：(缓存命中, 未命中输入, 输出)
# DeepSeek 用人民币官价，非 DeepSeek 是美元刊例价 × USD_CNY 折算后的结果。
USD_CNY = 7.1

PRICES = {
    'flash': (0.02, 1.0, 4.0),          # DeepSeek flash / chat
    'pro': (0.15, 4.5, 13.5),           # DeepSeek pro
}

# 非 DeepSeek 模型的美元刊例价（缓存命中, 未命中输入, 输出），元/百万 tokens 由它折算。
# 命中价：能查到官方缓存读价的按官方（grok 0.5、gpt 0.4、claude 0.1×input、gemini 5%×input），
#        查不到独立缓存价的按未命中价计（保守，不假装有折扣）。
USD_PRICES = {
    # 模型族关键字 → (缓存命中, 未命中输入, 输出) 美元/百万
    'grok-4.6': (0.50, 2.00, 6.00),     # xAI 官方：<200k 上下文
    'grok-4.7': (0.55, 2.20, 6.60),     # xAI 官方：<200k 上下文
    'grok': (0.50, 2.00, 6.00),         # 其他 grok 按 4.6 档
    'claude-haiku': (0.10, 1.00, 5.00), # Anthropic：缓存读 0.1×input
    'claude-sonnet': (0.20, 2.00, 10.00),
    'claude-opus': (0.50, 5.00, 25.00),
    'claude': (0.20, 2.00, 10.00),      # 其他 claude 按 sonnet 档
    'gpt-6.2': (0.40, 8.00, 40.00),     # OpenAI 官方
    'gpt': (0.40, 8.00, 40.00),
    'gemini-4': (0.10, 2.00, 10.00),    # Google Argon 优惠期；缓存输入 95% 折扣
    'gemini': (0.10, 2.00, 10.00),
    'glm': (0.23, 0.80, 2.80),          # 智谱人民币官价，不用汇率
    'qwen': (0.80, 0.80, 2.70),         # 阿里云百炼：输入0.8/输出2.7；命中价未公示，按输入价计
    'kimi': (2.00, 20.00, 100.00),      # 月之暗面 K3：输入20（命中2）/输出100
}

# glm / qwen / kimi 是人民币报价，不经 USD_CNY 折算
CNY_NATIVE = ('glm', 'qwen', 'kimi')

PRICE_SOURCES = {
    'deepseek': ('knowledge/对话沉淀/2026-11-03-回声站与燃料页.md',
                 'flash 0.02/1.0/4.0、pro 0.15/4.5/13.5，高峰×2'),
    'grok-4.7': ('docs.x.ai/developers/pricing', '$2.20/$0.55/$6.60 per 1M（<200k）'),
    'grok-4.6': ('docs.x.ai/developers/pricing', '$2.00/$0.50/$6.00 per 1M（<200k）'),
    'claude-haiku': ('platform.claude.com/docs/zh-CN/models/haiku-4-5', '$1/$5 per MTok，缓存读 0.1×'),
    'claude-sonnet-5.5': ('platform.claude.com/docs/en/models/sonnet-5-5', '$2/$10 per MTok'),
    'gpt-6.2-astra': ('developers.openai.com/api/docs/pricing', '$8/$40，缓存输入 $0.40'),
    'gemini-4-argon': ('blog.google Gemini 4 Argon 发布页', '$2/$10，缓存输入 95% off（优惠期至 2026-11-30）'),
    'glm-5.3-flash': ('bigmodel.cn/pricing', '输入¥0.8、输出¥2.8、缓存命中¥0.23'),
    'qwen3.8-flash': ('help.aliyun.com/zh/model-studio/model-pricing', '输入¥0.8、输出¥2.7'),
    'kimi-k3': ('Kimi 开放平台公示（澎湃/阿里云转述）', '输入¥20（缓存命中¥2）、输出¥100'),
}

PEAK_NOTE = '高峰=周一至周五 9-12、14-18（北京时间），仅 DeepSeek 价目 ×2'


def model_class(model):
    """模型 → 价目档位。

    DeepSeek 返回 'flash' / 'pro'（这两档有高峰倍率）；
    其他供应商返回 'usd' / 'cny'（有自己的官方刊例价，但没有 DeepSeek 的高峰规则）；
    认不出来返回 None —— 不要用 0 冒充，0 会被当成「算过且免费」。
    """
    m = (model or '').lower()
    if not m:
        return None
    if 'deepseek' in m or m in ('hermes-agent',) or m.startswith(('ds-', 'deepseek')):
        if 'pro' in m:
            return 'pro'
        return 'flash'
    for key in sorted(USD_PRICES, key=len, reverse=True):
        if key in m:
            return 'cny' if key in CNY_NATIVE else 'usd'
    return None


def usd_price(model):
    """返回 (缓存命中, 未命中输入, 输出) 美元/百万；认不出返回 None。"""
    m = (model or '').lower()
    for key in sorted(USD_PRICES, key=len, reverse=True):
        if key in m:
            return USD_PRICES[key]
    return None


def is_peak(ts):
    """北京时间是否处于 DeepSeek 官方高峰时段。"""
    try:
        moment = datetime.datetime.fromtimestamp(float(ts))
    except (TypeError, ValueError, OSError):
        return False
    return 1 <= moment.isoweekday() <= 5 and ((9 <= moment.hour < 12) or (14 <= moment.hour < 18))


def peak_ratio(start, end):
    """一段会话里落在高峰时间的比例。按半小时切片，避免长会话整段归到一边。"""
    try:
        start = float(start)
    except (TypeError, ValueError):
        return 0.0
    try:
        end = float(end)
    except (TypeError, ValueError):
        end = None
    if not end or end <= start or (end - start) > 86400 * 7:
        # 拿不到结束时间、或跨度大得不合理（83 天那种残留会话），只看起点
        return 1.0 if is_peak(start) else 0.0
    peak_seconds = 0.0
    cursor = start
    while cursor < end:
        step = min(end, cursor + 1800)
        if is_peak(cursor):
            peak_seconds += step - cursor
        cursor = step
    return peak_seconds / (end - start)


def token_cost(model, hit=0, miss=0, out=0, multiplier=1.0, peak=0.0):
    """按 token 算钱（元）。peak 是高峰占比 0~1，只有 DeepSeek 价目在高峰段 ×2。

    返回 None 表示该模型没有可用的官方价目——不要用 0 冒充，0 会被当成「算过且免费」。
    """
    kind = model_class(model)
    if not kind:
        return None
    hit, miss, out = int(hit or 0), int(miss or 0), int(out or 0)
    if kind in PRICES:
        cached, uncached, output = PRICES[kind]
        base = (hit * cached + miss * uncached + out * output) / 1_000_000
        factor = (1.0 - peak) + 2.0 * peak      # 高峰×2 只适用于 DeepSeek 自家价目
        return base * factor * (multiplier if multiplier else 1.0)
    pair = usd_price(model)
    if not pair:
        return None
    cached, uncached, output = pair
    base = (hit * cached + miss * uncached + out * output) / 1_000_000
    if kind != 'cny':
        base *= USD_CNY
    return base * (multiplier if multiplier else 1.0)


def parse_multiplier(label):
    """从 provider 名称里取倍率后缀：'ZeroAPI · DeepSeek官转 0.4x' → 0.4。

    没有后缀返回 1.0（官方原价）。中文括号里的也一样取，取不到就当原价。
    """
    match = re.search(r'(\d+(?:\.\d+)?)\s*[xX]', label or '')
    if not match:
        return 1.0
    try:
        value = float(match.group(1))
    except ValueError:
        return 1.0
    return value if 0 < value <= 20 else 1.0


def channel_multiplier(base_url, model, providers=None):
    """给一条调用找它该乘的渠道倍率。

    providers 是 config.yaml 的 providers 字典。同一 base_url 上挂着多个不同倍率的
    provider（ZeroAPI 就有 0.23x/0.4x/0.45x/0.058x 四个共用 direct.saviour.cc.cd），
    所以先按 base_url 收窄，再按模型名从各 provider 的 models 里挑匹配的。
    挑不出唯一结果时返回 1.0 并标记 not_multiplied，让面板能说出「这条按原价算的」。
    """
    url = (base_url or '').strip().lower().rstrip('/')
    if not url or not providers:
        return 1.0, None
    candidates = []
    for pid, provider in providers.items():
        p_url = str(provider.get('base_url') or '').strip().lower().rstrip('/')
        if not p_url or not url.startswith(p_url.split('/v1')[0]):
            continue
        info = {'id': pid, 'label': str(provider.get('name') or pid),
                'multiplier': parse_multiplier(str(provider.get('name') or ''))}
        models = provider.get('models')
        ids = set()
        if isinstance(models, dict):
            ids = {str(k).lower() for k in models}
        elif isinstance(models, list):
            for item in models:
                if isinstance(item, dict):
                    ids.add(str(item.get('id') or '').lower())
                else:
                    ids.add(str(item).lower())
        info['models'] = ids
        candidates.append(info)
    if not candidates:
        return 1.0, None
    # 模型名精确命中优先
    lowered = (model or '').lower()
    hits = [c for c in candidates if lowered and lowered in c['models']]
    if len(hits) == 1:
        return hits[0]['multiplier'], hits[0]['label']
    # 退回：该 base_url 上只有一个倍率时直接用它
    multipliers = {c['multiplier'] for c in (hits or candidates)}
    if len(multipliers) == 1:
        chosen = (hits or candidates)[0]
        return chosen['multiplier'], chosen['label']
    return 1.0, None


def price_summary():
    """给面板用的价目说明，前后端口径必须一致。"""
    return {
        'prices_cny_per_million': {k: list(v) for k, v in PRICES.items()},
        'usd_prices_per_million': {k: list(v) for k, v in USD_PRICES.items()},
        'usd_cny': USD_CNY,
        'peak': PEAK_NOTE,
        'currency': 'CNY',
        'note': '估算：DeepSeek 按官方价×高峰×渠道倍率；其他模型按各自官方刊例价×渠道倍率（美元按 %.2f 折算）。不含 Search/Fetch 独立计费。' % USD_CNY,
        'sources': {k: list(v) for k, v in PRICE_SOURCES.items()},
    }

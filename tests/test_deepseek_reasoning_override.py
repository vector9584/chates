"""会话级 reasoning 覆盖 DeepSeek 官方静态 extra_body 的行为。

静态 extra_body 在 SDK 里最后合并，所以覆盖必须写进 extra_body 本身，
只写顶层 kwargs 会被盖回 high —— 这组用例盯的就是这一点。
"""

import pytest

from agent.transports.chat_completions import _apply_deepseek_reasoning_override as apply

DS = "https://api.deepseek.com/v1"
RELAY = "https://direct.saviour.cc.cd/v1"


def send(reasoning_config, base_url=DS, model="deepseek-v4-pro"):
    extra_body = {"thinking": {"type": "enabled"}, "reasoning_effort": "high", "title": True}
    api_kwargs = {"model": model}
    apply(extra_body, api_kwargs, reasoning_config, model, base_url)
    return extra_body, api_kwargs


def test_disabled_turns_thinking_off_everywhere():
    extra_body, api_kwargs = send({"enabled": False})
    assert extra_body["thinking"] == {"type": "disabled"}
    assert "reasoning_effort" not in extra_body
    assert "reasoning_effort" not in api_kwargs


@pytest.mark.parametrize(
    "effort,expected",
    [
        ("low", "low"),
        ("medium", "high"),  # 官方枚举里没有 medium
        ("high", "high"),
        ("max", "max"),
    ],
)
def test_effort_lands_in_extra_body_and_kwargs(effort, expected):
    extra_body, api_kwargs = send({"enabled": True, "effort": effort})
    assert extra_body["thinking"] == {"type": "enabled"}
    assert extra_body["reasoning_effort"] == expected
    assert api_kwargs["reasoning_effort"] == expected


def test_follow_leaves_provider_default_alone():
    extra_body, api_kwargs = send(None)
    assert extra_body["reasoning_effort"] == "high"
    assert "reasoning_effort" not in api_kwargs


def test_relay_endpoint_is_never_touched():
    extra_body, api_kwargs = send({"enabled": False}, base_url=RELAY)
    assert extra_body["thinking"] == {"type": "enabled"}
    assert extra_body["reasoning_effort"] == "high"
    assert "reasoning_effort" not in api_kwargs


def test_v3_family_has_no_thinking_field():
    extra_body, api_kwargs = send({"enabled": False}, model="deepseek-chat")
    assert extra_body["thinking"] == {"type": "enabled"}
    assert "reasoning_effort" not in api_kwargs

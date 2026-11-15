"""Custom image-generation gateway — bring your own relay / aggregator.

Use this when your image model lives behind an OpenAI-compatible relay or a
Gemini-native gateway instead of one of the bundled providers (``openai``,
``fal``, ``krea``, ``deepinfra``, ``openrouter``, ``xai``, ``openai-codex``).

Configuration in ``config.yaml``::

    image_gen:
      provider: custom
      model: <whatever the picker chose>   # top-level, written by the panel
      custom:
        base_url: https://relay.example.com
        model: gemini-2.5-flash-image       # the real upstream model id
        api_key_env: IMAGE_GEN_CUSTOM_API_KEY

The API key never goes into ``config.yaml`` — put it in ``.env`` under the
variable named by ``api_key_env`` (default ``IMAGE_GEN_CUSTOM_API_KEY``).

Endpoint fallback chain, first success wins:

1. ``POST {base}/v1/images/generations`` — OpenAI images API,
   reads ``data[0].b64_json`` / ``data[0].url``.
2. ``POST {base}/v1/chat/completions`` — OpenAI chat with
   ``modalities: ["image","text"]``, reads ``choices[0].message.images[]``
   (OpenRouter-style) or a markdown/base64 image inside the content.
3. ``POST {base}/v1beta/models/{model}:generateContent`` — Gemini native,
   reads ``candidates[0].content.parts[].inlineData.data``.

Every attempt's failure is collected so the operator can see what the relay
actually rejected instead of a generic "it didn't work".
"""

from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from agent.image_gen_provider import (
    DEFAULT_ASPECT_RATIO,
    ImageGenProvider,
    error_response,
    normalize_reference_images,
    resolve_aspect_ratio,
    save_b64_image,
    save_url_image,
    success_response,
)

logger = logging.getLogger(__name__)

PROVIDER_NAME = "custom"
DISPLAY_NAME = "自定义中转站"
DEFAULT_KEY_ENV = "IMAGE_GEN_CUSTOM_API_KEY"
DEFAULT_TIMEOUT = 180

_SIZES: Dict[str, str] = {
    "landscape": "1536x1024",
    "square": "1024x1024",
    "portrait": "1024x1536",
}


# ---------------------------------------------------------------------------
# Config / secret lookup
# ---------------------------------------------------------------------------


def _image_gen_cfg() -> Dict[str, Any]:
    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        section = cfg.get("image_gen") if isinstance(cfg, dict) else None
        return section if isinstance(section, dict) else {}
    except Exception as exc:  # pragma: no cover - config always present in prod
        logger.debug("image_gen config unreadable: %s", exc)
        return {}


def _custom_cfg() -> Dict[str, Any]:
    sub = _image_gen_cfg().get("custom")
    return sub if isinstance(sub, dict) else {}


def _base_url() -> str:
    value = _custom_cfg().get("base_url")
    return value.strip().rstrip("/") if isinstance(value, str) else ""


def _api_model() -> str:
    """Upstream model id. ``image_gen.custom.model`` wins over the top-level."""
    for key in ("model",):
        value = _custom_cfg().get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    top = _image_gen_cfg().get("model")
    if isinstance(top, str) and top.strip():
        return top.strip()
    return ""


def _key_env() -> str:
    value = _custom_cfg().get("api_key_env")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return DEFAULT_KEY_ENV


def _api_key() -> str:
    try:
        from agent.secret_scope import get_secret

        return (get_secret(_key_env()) or "").strip()
    except Exception as exc:
        logger.debug("secret %s unavailable: %s", _key_env(), exc)
        return ""


def _timeout() -> int:
    value = _custom_cfg().get("timeout")
    if isinstance(value, (int, float)) and value > 0:
        return int(value)
    return DEFAULT_TIMEOUT


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def _join(base: str, path: str) -> str:
    """Join base_url and path without doubling a ``/v1`` segment."""
    base = base.rstrip("/")
    if base.endswith("/v1") and path.startswith("/v1/"):
        return base + path[len("/v1"):]
    return base + path


def _post_json(url: str, api_key: str, payload: Dict[str, Any]) -> Tuple[int, str]:
    """POST JSON, returning ``(status, body)``. Never raises for HTTP errors."""
    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        # Relays that speak Gemini natively accept x-goog-api-key; sending both
        # is harmless and saves a round-trip guess.
        "x-goog-api-key": api_key,
        "User-Agent": "hermes-image-gen-custom/1.0",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=_timeout()) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", "replace")
        except Exception:
            pass
        return exc.code, body
    except Exception as exc:
        return -1, f"{type(exc).__name__}: {exc}"


# ---------------------------------------------------------------------------
# Response extraction — every helper returns (b64, url, mime)
# ---------------------------------------------------------------------------

_DataURL = Tuple[Optional[str], Optional[str], Optional[str]]


def _split_data_url(value: str) -> Tuple[Optional[str], Optional[str]]:
    """``data:image/png;base64,AAA`` → (b64, mime)."""
    if not value.startswith("data:"):
        return None, None
    header, _, b64 = value.partition(",")
    mime = None
    if ":" in header:
        mime = header[5:].split(";")[0] or None
    return (b64 or None), mime


def _from_openai_images(payload: Any) -> _DataURL:
    if not isinstance(payload, dict):
        return None, None, None
    items = payload.get("data")
    if not isinstance(items, list) or not items:
        return None, None, None
    first = items[0]
    if not isinstance(first, dict):
        return None, None, None
    b64 = first.get("b64_json")
    if isinstance(b64, str) and b64.strip():
        return b64.strip(), None, None
    url = first.get("url")
    if isinstance(url, str) and url.strip():
        url = url.strip()
        if url.startswith("data:"):
            b64v, mime = _split_data_url(url)
            return b64v, None, mime
        return None, url, None
    return None, None, None


def _from_markdown(text: str) -> _DataURL:
    match = re.search(r"!\[[^\]]*\]\((https?://[^)\s]+|data:image/[^)\s]+)\)", text or "")
    if not match:
        return None, None, None
    ref = match.group(1)
    if ref.startswith("data:"):
        b64, mime = _split_data_url(ref)
        return b64, None, mime
    return None, ref, None


def _from_chat(payload: Any) -> _DataURL:
    if not isinstance(payload, dict):
        return None, None, None
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return None, None, None
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if not isinstance(message, dict):
        return None, None, None

    # OpenRouter-style: message.images[].image_url.url
    images = message.get("images")
    if isinstance(images, list):
        for item in images:
            if isinstance(item, dict):
                holder = item.get("image_url")
                ref = None
                if isinstance(holder, dict):
                    ref = holder.get("url")
                elif isinstance(holder, str):
                    ref = holder
                if not ref:
                    ref = item.get("url")
                if isinstance(ref, str) and ref.strip():
                    ref = ref.strip()
                    if ref.startswith("data:"):
                        b64, mime = _split_data_url(ref)
                        return b64, None, mime
                    return None, ref, None

    # Some relays embed the image in content (str or list of parts).
    content = message.get("content")
    if isinstance(content, str):
        return _from_markdown(content)
    if isinstance(content, list):
        for part in content:
            if not isinstance(part, dict):
                continue
            inline = part.get("inline_data") or part.get("inlineData")
            if isinstance(inline, dict) and isinstance(inline.get("data"), str):
                return inline["data"], None, inline.get("mimeType") or inline.get("mime_type")
            if isinstance(part.get("text"), str):
                got = _from_markdown(part["text"])
                if got[0] or got[1]:
                    return got
            holder = part.get("image_url")
            if isinstance(holder, dict) and isinstance(holder.get("url"), str):
                ref = holder["url"].strip()
                if ref.startswith("data:"):
                    b64, mime = _split_data_url(ref)
                    return b64, None, mime
                return None, ref, None
    return None, None, None


def _from_gemini(payload: Any) -> _DataURL:
    if not isinstance(payload, dict):
        return None, None, None
    candidates = payload.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return None, None, None
    content = candidates[0].get("content") if isinstance(candidates[0], dict) else None
    parts = content.get("parts") if isinstance(content, dict) else None
    if not isinstance(parts, list):
        return None, None, None
    for part in parts:
        if not isinstance(part, dict):
            continue
        for key in ("inlineData", "inline_data"):
            inline = part.get(key)
            if isinstance(inline, dict) and isinstance(inline.get("data"), str):
                mime = inline.get("mimeType") or inline.get("mime_type")
                return inline["data"], None, mime
        if isinstance(part.get("text"), str):
            got = _from_markdown(part["text"])
            if got[0] or got[1]:
                return got
    return None, None, None


def _short(text: str, limit: int = 320) -> str:
    text = " ".join((text or "").split())
    return text[:limit] + ("…" if len(text) > limit else "")


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------


class CustomGatewayImageGenProvider(ImageGenProvider):
    """Image generation through a user-supplied relay with three wire formats."""

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    @property
    def display_name(self) -> str:
        return DISPLAY_NAME

    def is_available(self) -> bool:
        return bool(_base_url() and _api_model() and _api_key())

    def list_models(self) -> List[Dict[str, Any]]:
        model = _api_model()
        if not model:
            return []
        return [
            {
                "id": model,
                "display": f"{model}（自定义中转站）",
                "speed": "取决于中转站",
                "strengths": "你自己配置的 base_url / 模型 / 密钥",
                "price": "varies",
            }
        ]

    def default_model(self) -> Optional[str]:
        return _api_model() or None

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": DISPLAY_NAME,
            "badge": "custom",
            "tag": "OpenAI 兼容或 Gemini 原生中转站，地址/模型/密钥全部自己填",
            "env_vars": [
                {
                    "key": _key_env(),
                    "prompt": "中转站 API key",
                    "url": "",
                }
            ],
        }

    def capabilities(self) -> Dict[str, Any]:
        return {"modalities": ["text"], "max_reference_images": 0}

    # -- request builders ---------------------------------------------------

    def _text_payload_openai(self, model: str, prompt: str, size: str) -> Dict[str, Any]:
        return {"model": model, "prompt": prompt, "size": size, "n": 1}

    def _chat_payload(self, model: str, prompt: str, reference_images: List[str]) -> Dict[str, Any]:
        content: Any = prompt
        extras: List[Dict[str, Any]] = []
        for ref in reference_images[:4]:
            extras.append({"type": "image_url", "image_url": {"url": ref}})
        if extras:
            content = [{"type": "text", "text": prompt}] + extras
        payload: Dict[str, Any] = {
            "model": model,
            "messages": [{"role": "user", "content": content}],
            "modalities": ["image", "text"],
        }
        return payload

    def _gemini_payload(self, prompt: str, reference_images: List[str]) -> Dict[str, Any]:
        parts: List[Dict[str, Any]] = [{"text": prompt}]
        for ref in reference_images[:4]:
            if ref.startswith("data:") and ";base64," in ref:
                header, _, b64 = ref.partition(",")
                mime = header[5:].split(";")[0] or "image/png"
                parts.append({"inlineData": {"mimeType": mime, "data": b64}})
        return {"contents": [{"parts": parts}]}

    # -- main entry point ---------------------------------------------------

    def generate(
        self,
        prompt: str,
        aspect_ratio: str = DEFAULT_ASPECT_RATIO,
        *,
        image_url: Optional[str] = None,
        reference_image_urls: Optional[List[str]] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        prompt = (prompt or "").strip()
        aspect = resolve_aspect_ratio(aspect_ratio)

        if not prompt:
            return error_response(
                error="Prompt is required and must be a non-empty string",
                error_type="invalid_argument",
                provider=PROVIDER_NAME,
                aspect_ratio=aspect,
            )

        base = _base_url()
        model = _api_model()
        api_key = _api_key()

        if not base:
            return error_response(
                error="image_gen.custom.base_url 未配置。到面板「模型 → 能力后端 → 图像生成」填中转站地址。",
                error_type="auth_required",
                provider=PROVIDER_NAME,
                aspect_ratio=aspect,
            )
        if not model:
            return error_response(
                error="image_gen.custom.model 未配置。请填写中转站里真实的模型名（例如 gemini-2.5-flash-image）。",
                error_type="invalid_argument",
                provider=PROVIDER_NAME,
                aspect_ratio=aspect,
            )
        if not api_key:
            return error_response(
                error=f"{_key_env()} 未配置。到面板「密钥」页填入中转站的 key。",
                error_type="auth_required",
                provider=PROVIDER_NAME,
                model=model,
                aspect_ratio=aspect,
            )

        refs: List[str] = []
        if isinstance(image_url, str) and image_url.strip():
            refs.append(image_url.strip())
        refs.extend(normalize_reference_images(reference_image_urls) or [])
        refs = [r for r in refs if isinstance(r, str) and r.strip()]
        modality = "image" if refs else "text"
        size = _SIZES.get(aspect, _SIZES["square"])
        prefix = "custom_" + re.sub(r"[^A-Za-z0-9]+", "-", model)[:40]

        attempts: List[str] = []

        # 1) OpenAI images API
        url1 = _join(base, "/v1/images/generations")
        status, body = _post_json(url1, api_key, self._text_payload_openai(model, prompt, size))
        b64, img_url, mime = _from_openai_images(_safe_json(body))
        if b64 or img_url:
            return self._finish(b64, img_url, mime, model, prompt, aspect, modality, prefix, "images/generations")
        attempts.append(f"[1] POST {url1} → HTTP {status}: {_short(body)}")

        # 2) OpenAI chat completions with image modality
        url2 = _join(base, "/v1/chat/completions")
        status, body = _post_json(url2, api_key, self._chat_payload(model, prompt, refs))
        b64, img_url, mime = _from_chat(_safe_json(body))
        if b64 or img_url:
            return self._finish(b64, img_url, mime, model, prompt, aspect, modality, prefix, "chat/completions")
        attempts.append(f"[2] POST {url2} → HTTP {status}: {_short(body)}")

        # 3) Gemini native generateContent
        url3 = _join(base, f"/v1beta/models/{model}:generateContent")
        status, body = _post_json(url3, api_key, self._gemini_payload(prompt, refs))
        b64, img_url, mime = _from_gemini(_safe_json(body))
        if b64 or img_url:
            return self._finish(b64, img_url, mime, model, prompt, aspect, modality, prefix, "generateContent")
        attempts.append(f"[3] POST {url3} → HTTP {status}: {_short(body)}")

        return error_response(
            error=(
                f"中转站三种端点都没返回图片（base_url={base}, model={model}）。"
                "请确认模型名与端点格式：\n" + "\n".join(attempts)
            ),
            error_type="api_error",
            provider=PROVIDER_NAME,
            model=model,
            prompt=prompt,
            aspect_ratio=aspect,
        )

    def _finish(
        self,
        b64: Optional[str],
        img_url: Optional[str],
        mime: Optional[str],
        model: str,
        prompt: str,
        aspect: str,
        modality: str,
        prefix: str,
        endpoint: str,
    ) -> Dict[str, Any]:
        image_ref: Optional[str] = None
        if b64:
            ext = "png"
            if mime and "/" in mime:
                ext = mime.split("/", 1)[1].split(";")[0] or "png"
            if ext == "jpeg":
                ext = "jpg"
            try:
                image_ref = str(save_b64_image(b64, prefix=prefix, extension=ext))
            except Exception as exc:
                return error_response(
                    error=f"图片已返回但写入缓存失败：{exc}",
                    error_type="io_error",
                    provider=PROVIDER_NAME,
                    model=model,
                    prompt=prompt,
                    aspect_ratio=aspect,
                )
        elif img_url:
            try:
                image_ref = str(save_url_image(img_url, prefix=prefix))
            except Exception as exc:
                logger.warning("custom gateway image URL not cached: %s", exc)
                image_ref = img_url

        if not image_ref:
            return error_response(
                error="中转站响应里没有可用图片数据",
                error_type="empty_response",
                provider=PROVIDER_NAME,
                model=model,
                prompt=prompt,
                aspect_ratio=aspect,
            )

        return success_response(
            image=image_ref,
            model=model,
            prompt=prompt,
            aspect_ratio=aspect,
            provider=PROVIDER_NAME,
            modality=modality,
            extra={"endpoint": endpoint},
        )


def _safe_json(body: str) -> Any:
    try:
        return json.loads(body)
    except Exception:
        return None


def register(ctx) -> None:
    """Plugin entry point — wire the custom gateway provider into the registry."""
    ctx.register_image_gen_provider(CustomGatewayImageGenProvider())

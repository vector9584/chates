"""DeepSeek Search + Fetch — plugin form.

Subclasses :class:`agent.web_search_provider.WebSearchProvider`. Two
capabilities advertised:

- ``supports_search()``  -> True (DeepSeek ``/v1/tools/search``)
- ``supports_extract()`` -> True (DeepSeek ``/v1/tools/fetch``)

DeepSeek's self-built search engine (opened 2026-10-17) returns, per hit:
``title``, ``url``, ``snippet``, ``summary`` (600-800 chars), ``content``
(full text when ``need_content=true``), ``site_name``, ``date``,
``rerank_score`` (0-3) and ``authority`` (0-4). We fold the credibility
signals (site / date / authority) into ``description`` so the model can
judge source quality without an extra round-trip.

Config keys this provider responds to::

    web:
      search_backend: "deepseek"     # explicit per-capability
      extract_backend: "deepseek"    # explicit per-capability
      backend: "deepseek"            # shared fallback for both

Env vars::

    DEEPSEEK_SEARCH_API_KEY=...    # preferred, explicit key for this provider
    DEEPSEEK_SEARCH_BASE_URL=...   # optional override of https://api.deepseek.com
    CUSTOM_UMU5G7PYGOZES_API_KEY   # fallback: the DeepSeek-official key Hermes
                                   # already uses for the deepseek-flash model
    DEEPSEEK_API_KEY               # last resort
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List

from agent.web_search_provider import WebSearchProvider

logger = logging.getLogger(__name__)

# DeepSeek enforces 5 QPS per account on both endpoints; keep a small gap
# between sequential fetches so multi-URL extract() calls don't trip it.
_FETCH_GAP_SECONDS = 0.25

_KEY_CANDIDATES = (
    "DEEPSEEK_SEARCH_API_KEY",
    "CUSTOM_UMU5G7PYGOZES_API_KEY",
    "DEEPSEEK_API_KEY",
)


def _deepseek_api_key() -> str:
    """Resolve the DeepSeek API key from the first populated env var.

    ``DEEPSEEK_SEARCH_API_KEY`` is the dedicated knob; the custom-provider
    key is accepted because that is the DeepSeek-official credential Hermes
    already stores for the primary model.
    """
    from agent.web_search_provider import get_provider_env

    for name in _KEY_CANDIDATES:
        val = get_provider_env(name)
        if val:
            return val
    return ""


def _deepseek_request(endpoint: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """POST to a DeepSeek tool endpoint and return parsed JSON."""
    import httpx

    from agent.web_search_provider import get_provider_env

    api_key = _deepseek_api_key()
    if not api_key:
        raise ValueError(
            "DeepSeek API key not set. Set DEEPSEEK_SEARCH_API_KEY "
            "(get one at https://platform.deepseek.com)."
        )

    base_url = (
        get_provider_env("DEEPSEEK_SEARCH_BASE_URL") or "https://api.deepseek.com"
    ).rstrip("/")
    url = f"{base_url}/v1/tools/{endpoint.lstrip('/')}"
    logger.info("DeepSeek %s request to %s", endpoint, url)

    response = httpx.post(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=90,
    )
    if response.status_code == 429:
        raise RuntimeError("DeepSeek search rate limit exceeded (5 QPS)")
    response.raise_for_status()
    return response.json()


def _normalize_deepseek_search_results(
    response: Dict[str, Any],
) -> Dict[str, Any]:
    """Map DeepSeek ``/tools/search`` to ``{success, data: {web: [...]}}``."""
    web_results = []
    for i, result in enumerate(response.get("results", [])):
        text = (
            result.get("snippet")
            or result.get("summary")
            or result.get("content")
            or ""
        )
        meta_bits = []
        site = result.get("site_name")
        if site:
            meta_bits.append(str(site))
        date = result.get("date")
        if date:
            meta_bits.append(str(date)[:10])
        authority = result.get("authority")
        if authority is not None:
            meta_bits.append(f"权威度 {authority}/4")
        if meta_bits:
            text = f"{text}\n[{' · '.join(meta_bits)}]"
        web_results.append(
            {
                "title": result.get("title", ""),
                "url": result.get("url", ""),
                "description": text,
                "position": i + 1,
            }
        )
    return {"success": True, "data": {"web": web_results}}


def _tavily_fallback_search(query: str, limit: int) -> Dict[str, Any] | None:
    """Fall back to Tavily when DeepSeek is down / rate-limited.

    Hermes' registry treats an explicitly configured backend as authoritative
    and does *not* auto-switch on failure, so the fallback lives here: DeepSeek
    stays the primary, Tavily silently covers 429s and transport errors.
    Returns ``None`` when Tavily is unavailable or also fails.
    """
    try:
        from plugins.web.tavily.provider import TavilyWebSearchProvider

        tv = TavilyWebSearchProvider()
        if not tv.is_available():
            return None
        result = tv.search(query, limit)
        if result.get("success"):
            logger.info("DeepSeek search failed over to Tavily")
            return result
    except Exception as exc:  # noqa: BLE001
        logger.warning("Tavily fallback search failed: %s", exc)
    return None


def _tavily_fallback_extract(urls: List[str]) -> List[Dict[str, Any]] | None:
    """Fall back to Tavily extract for URLs DeepSeek could not fetch."""
    try:
        from plugins.web.tavily.provider import TavilyWebSearchProvider

        tv = TavilyWebSearchProvider()
        if not tv.is_available():
            return None
        result = tv.extract(urls)
        if result:
            logger.info("DeepSeek fetch failed over to Tavily for %d URL(s)", len(urls))
            return result
    except Exception as exc:  # noqa: BLE001
        logger.warning("Tavily fallback extract failed: %s", exc)
    return None


class DeepSeekWebSearchProvider(WebSearchProvider):
    """DeepSeek search + fetch provider."""

    @property
    def name(self) -> str:
        return "deepseek"

    @property
    def display_name(self) -> str:
        return "DeepSeek Search"

    def is_available(self) -> bool:
        return bool(_deepseek_api_key())

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return True

    def search(self, query: str, limit: int = 5) -> Dict[str, Any]:
        """Execute a DeepSeek search."""
        try:
            from tools.interrupt import is_interrupted

            if is_interrupted():
                return {"success": False, "error": "Interrupted"}

            logger.info("DeepSeek search: '%s' (limit=%d)", query, limit)
            raw = _deepseek_request(
                "search",
                {
                    "query": query,
                    "count": max(1, min(limit, 50)),
                    # Full text is deferred to extract() to keep search cheap.
                    "need_content": False,
                },
            )
            return _normalize_deepseek_search_results(raw)
        except ValueError as exc:
            fallback = _tavily_fallback_search(query, limit)
            if fallback is not None:
                return fallback
            return {"success": False, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001 — including httpx errors
            logger.warning("DeepSeek search error: %s", exc)
            fallback = _tavily_fallback_search(query, limit)
            if fallback is not None:
                return fallback
            return {"success": False, "error": f"DeepSeek search failed: {exc}"}

    def extract(self, urls: List[str], **kwargs: Any) -> List[Dict[str, Any]]:
        """Fetch page content for each URL via DeepSeek ``/tools/fetch``.

        DeepSeek's fetch endpoint takes a single URL per call, so this loops
        sequentially (also keeps us under the 5 QPS account limit). Per-URL
        failures become entries with an ``error`` field.
        """
        documents: List[Dict[str, Any]] = []
        failed: List[str] = []
        try:
            from tools.interrupt import is_interrupted
        except Exception:  # noqa: BLE001 — interrupt module optional
            def is_interrupted() -> bool:  # type: ignore[misc]
                return False

        for idx, url in enumerate(urls):
            if is_interrupted():
                documents.append(
                    {"url": url, "title": "", "content": "", "error": "Interrupted"}
                )
                continue
            if idx:
                time.sleep(_FETCH_GAP_SECONDS)
            try:
                raw = _deepseek_request("fetch", {"url": url})
                content = raw.get("content", "") or ""
                title = raw.get("title", "") or ""
                documents.append(
                    {
                        "url": url,
                        "title": title,
                        "content": content,
                        "raw_content": content,
                        "metadata": {"sourceURL": url, "title": title},
                    }
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("DeepSeek fetch error for %s: %s", url, exc)
                failed.append(url)

        # DeepSeek 抓取失败的 URL 交给 Tavily 兜底，避免整批 extract 全灭
        if failed:
            fallback_docs = _tavily_fallback_extract(failed)
            if fallback_docs:
                documents.extend(fallback_docs)
            else:
                documents.extend(
                    {
                        "url": u,
                        "title": "",
                        "content": "",
                        "error": "DeepSeek fetch failed and Tavily fallback unavailable",
                    }
                    for u in failed
                )
        return documents

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "DeepSeek Search",
            "badge": "paid",
            "tag": "Search + fetch via DeepSeek's self-built search engine.",
            "env_vars": [
                {
                    "key": "DEEPSEEK_SEARCH_API_KEY",
                    "prompt": "DeepSeek API key (used for Search/Fetch)",
                    "url": "https://platform.deepseek.com",
                },
            ],
        }

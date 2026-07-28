from __future__ import annotations

import dataclasses
import json
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any, cast

from .config import CollectorConfig

_SECRET_KEY = re.compile(r"(?:api[_-]?key|authorization|password|secret|token)$", re.I)


def _plain(value: Any, depth: int = 0) -> Any:
    if depth > 6:
        return "<max-depth>"
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)
    if dataclasses.is_dataclass(value):
        return _plain(dataclasses.asdict(cast(Any, value)), depth + 1)
    if isinstance(value, dict):
        return {
            str(key): "***REDACTED***" if _SECRET_KEY.search(str(key)) else _plain(item, depth + 1)
            for key, item in list(value.items())[:200]
        }
    if isinstance(value, (list, tuple, set)):
        return [_plain(item, depth + 1) for item in list(value)[:200]]
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            return _plain(model_dump(exclude={"raw"}), depth + 1)
        except Exception:
            pass
    for attribute in ("content", "text"):
        item = getattr(value, attribute, None)
        if isinstance(item, str):
            return item
    return f"<{type(value).__module__}.{type(value).__name__}>"


def safe_value(value: Any, config: CollectorConfig) -> tuple[Any, bool, int | None]:
    plain = _plain(value)
    if not config.capture_content:
        return "<content-capture-disabled>", False, None
    if isinstance(plain, str):
        text = plain
    else:
        try:
            text = json.dumps(plain, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError):
            text = str(plain)
    original = len(text)
    if config.max_content_chars and original > config.max_content_chars:
        suffix = f"…<truncated {original - config.max_content_chars} chars>"
        return text[: config.max_content_chars] + suffix, True, original
    return text, False, original


def add_content_attribute(
    attributes: dict[str, Any], key: str, value: Any, config: CollectorConfig
) -> None:
    content, truncated, original = safe_value(value, config)
    attributes[key] = content
    if truncated:
        attributes[f"{key}.truncated"] = True
        attributes[f"{key}.original_chars"] = original


def extract_usage(value: Any) -> dict[str, int]:
    candidates: list[Any] = [value]
    if value is not None:
        candidates.extend(
            [getattr(value, "raw", None), getattr(value, "additional_kwargs", None)]
        )
    for candidate in candidates:
        plain = _plain(candidate)
        if not isinstance(plain, dict):
            continue
        usage = plain.get("usage") or plain.get("usage_metadata") or plain
        if not isinstance(usage, dict):
            continue

        def number(*names: str, _usage: dict[str, Any] = usage) -> int:
            for name in names:
                raw = _usage.get(name)
                if isinstance(raw, (int, float)):
                    return max(0, int(raw))
            return 0

        input_tokens = number("prompt_tokens", "input_tokens", "input")
        output_tokens = number("completion_tokens", "output_tokens", "output")
        total_tokens = number("total_tokens", "total") or input_tokens + output_tokens
        if total_tokens:
            return {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "total_tokens": total_tokens,
            }
    return {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}


def extract_model(model_dict: Any) -> tuple[str | None, str | None]:
    plain = _plain(model_dict)
    if not isinstance(plain, dict):
        return None, None
    model = plain.get("model") or plain.get("model_name") or plain.get("model_id")
    provider = plain.get("provider") or plain.get("class_name") or plain.get("api_type")
    return str(model) if model else None, str(provider) if provider else None


def extract_nodes(nodes: Any, config: CollectorConfig) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for item in list(nodes or [])[:100]:
        node = getattr(item, "node", item)
        score = getattr(item, "score", None)
        metadata = getattr(node, "metadata", None)
        source = None
        if isinstance(metadata, dict):
            source = (
                metadata.get("file_name")
                or metadata.get("file_path")
                or metadata.get("source")
            )
        text = getattr(node, "text", None)
        if text is None:
            getter = getattr(node, "get_content", None)
            if callable(getter):
                try:
                    text = getter()
                except Exception:
                    text = None
        content, truncated, original = safe_value(text or "", config)
        row: dict[str, Any] = {"source": source, "score": score, "content": content}
        if truncated:
            row["content_truncated"] = True
            row["content_original_chars"] = original
        output.append(row)
    return output

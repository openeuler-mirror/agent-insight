"""Message extraction helpers shared by QwenPaw hooks and patches."""

from __future__ import annotations

from typing import Any

USER_ROLES = {"user", "human"}


def _attr_or_key(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _content_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, (list, tuple)):
        return "\n".join(part for part in (_content_text(item).strip() for item in value) if part)

    text = _attr_or_key(value, "text")
    if isinstance(text, str) and text.strip():
        return text

    content = _attr_or_key(value, "content")
    if content is not None and content is not value:
        return _content_text(content)

    return ""


def _message_role(message: Any) -> str:
    role = _attr_or_key(message, "role")
    if role is None:
        role = _attr_or_key(message, "name")
    return str(role or "").strip().lower()


def _is_message_like(value: Any) -> bool:
    return _attr_or_key(value, "role") is not None or _attr_or_key(value, "content") is not None


def extract_user_input(value: Any, *, allow_plain_text: bool = False) -> str:
    """Return the latest explicit user/human message text from QwenPaw input.

    QwenPaw passes provider input as Message objects with TextBlock content.
    The collector must capture only real user turns and avoid promoting system
    prompts, assistant history, tool calls or full prompt arrays into query.
    """
    if value is None:
        return ""

    if isinstance(value, (list, tuple)):
        for message in reversed(value):
            if _message_role(message) not in USER_ROLES:
                continue
            text = _content_text(_attr_or_key(message, "content")).strip()
            if text:
                return text
        return ""

    if isinstance(value, dict):
        for key in ("messages", "input"):
            messages = value.get(key)
            if isinstance(messages, (list, tuple)):
                text = extract_user_input(messages)
                if text:
                    return text
        if _message_role(value) in USER_ROLES:
            return _content_text(value.get("content")).strip()
        if allow_plain_text:
            return _content_text(value).strip()
        return ""

    if _is_message_like(value):
        if _message_role(value) in USER_ROLES:
            return _content_text(_attr_or_key(value, "content")).strip()
        return ""

    if allow_plain_text and isinstance(value, (str, bytes)):
        return _content_text(value).strip()
    return ""

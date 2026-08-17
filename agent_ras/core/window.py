# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Stable hashing for detector comparison (single-Agent)."""
from __future__ import annotations

import hashlib
import json
from typing import Any


def stable_result_hash(result: Any) -> str:
    """Hash a tool result into a stable digest for loop detection.

    Lets repeat detection distinguish "same call, same result" (a real loop)
    from "same call, different result" (legitimate iteration). Prefers a
    Pydantic ``model_dump`` (e.g. ToolOutput), then JSON with sorted keys, and
    falls back to ``str`` so unusual objects never raise. ``default=str``
    tolerates non-serializable values.

    Args:
        result: The tool execution result, or None.

    Returns:
        A hex digest, or "none" when result is None.
    """
    if result is None:
        return "none"
    if isinstance(result, str):
        payload = result
    elif hasattr(result, "model_dump"):
        try:
            payload = json.dumps(result.model_dump(), sort_keys=True, ensure_ascii=False, default=str)
        except Exception:
            payload = str(result)
    else:
        try:
            payload = json.dumps(result, sort_keys=True, ensure_ascii=False, default=str)
        except Exception:
            payload = str(result)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()

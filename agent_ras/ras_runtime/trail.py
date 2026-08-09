# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Optional JSONL trail for diagnosing inproc observe/actions."""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def append_trail(op: str, session_id: str, result: dict[str, Any]) -> None:
    """Append JSONL when RAS_EMBED_E2E_LOG is set, else default inproc trail file."""
    path = os.environ.get("RAS_EMBED_E2E_LOG")
    if not path:
        # Always keep a short trail for diagnosing "didn't work" reports.
        data_dir = os.environ.get("AGENT_INSIGHT_DATA_DIR")
        if data_dir:
            path = str(Path(data_dir) / "ras" / "ras_inproc.jsonl")
        else:
            path = str(Path.home() / ".agent-insight" / "ras" / "ras_inproc.jsonl")
    try:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        # Cap file size roughly (~2MB) by truncating when oversized.
        if p.exists() and p.stat().st_size > 2_000_000:
            p.write_text("", encoding="utf-8")
        line = json.dumps(
            {"op": op, "session_id": session_id, "result": result},
            ensure_ascii=False,
        )
        with p.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        logger.debug("e2e log write failed", exc_info=True)

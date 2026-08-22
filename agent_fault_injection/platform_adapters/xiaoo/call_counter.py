"""Durable per-tool call index for cross-process xiaoO hooks."""

from __future__ import annotations

import json
from pathlib import Path


def next_tool_call_index(counts_file: Path, tool: str) -> int:
    """Bump a durable per-tool call counter (1-based).

    xiaoO invokes the hooker as a fresh process per hook, so counters must
    live on disk under the run's raw/artifacts directory.
    """

    counts_file.parent.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    if counts_file.is_file():
        try:
            loaded = json.loads(counts_file.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                for key, value in loaded.items():
                    if isinstance(value, int) and not isinstance(value, bool):
                        counts[str(key)] = value
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            counts = {}
    index = int(counts.get(tool, 0)) + 1
    counts[tool] = index
    counts_file.write_text(
        json.dumps(counts, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return index

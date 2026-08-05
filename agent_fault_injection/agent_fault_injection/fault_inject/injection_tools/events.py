"""Event helpers for structural injection."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def append_event(events_file: Path, event_type: str, payload: dict[str, Any]) -> None:
    events_file.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "type": event_type,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
    }
    with events_file.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")

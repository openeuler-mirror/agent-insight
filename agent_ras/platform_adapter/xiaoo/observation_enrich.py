# coding: utf-8
"""Map truthful Daemon SSE observation events into FI interactions.

FI Judge consumes interactions only. Do not fabricate platform events and do
not inject RAS anomaly/steer/notice into Judge inputs.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from agent_fault_injection.pipeline.collect_payload import (
    build_collect_payload,
    write_collect_payload,
)
from agent_fault_injection.pipeline.models import RunArtifacts

logger = logging.getLogger(__name__)

_OBS_TYPES = frozenset({"thinking_delta", "text_delta"})


def _payload_text(payload: dict[str, Any]) -> str:
    snap = payload.get("snapshot")
    if isinstance(snap, str) and snap.strip():
        return snap
    delta = payload.get("delta")
    if isinstance(delta, str) and delta.strip():
        return delta
    return ""


def extract_observation_text(events_file: Path) -> dict[str, str]:
    """Return longest snapshots for thinking / assistant text from real SSE rows."""

    thinking = ""
    output = ""
    if not events_file.is_file():
        return {"thinking": thinking, "output": output}

    with events_file.open("r", encoding="utf-8") as stream:
        for line in stream:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict):
                continue
            # Observation only: xiaoo.cli stream events. Never xiaoo.daemon RAS.
            if row.get("kind") != "xiaoo.cli":
                continue
            payload = row.get("payload")
            if not isinstance(payload, dict):
                continue
            et = str(payload.get("type") or "")
            if et not in _OBS_TYPES:
                continue
            text = _payload_text(payload)
            if not text:
                continue
            if et == "thinking_delta":
                if len(text) >= len(thinking):
                    thinking = text
            else:
                if len(text) >= len(output):
                    output = text
    return {"thinking": thinking, "output": output}


def _surface_fault_effect(text: str) -> str:
    """Reorder truthful observation so truncated Judge windows still see loop body.

    Insight FI Judge summarizer keeps ~200 chars of llm text. Scenario-2
    trajectories often put skill preamble first and repeated clauses later —
    surface the repetitive span first without inventing text.
    """
    markers = ("明白", "先看看", "磁盘安全")
    best_idx = -1
    for marker in markers:
        if text.count(marker) < 2:
            continue
        idx = text.find(marker)
        if idx >= 0 and (best_idx < 0 or idx < best_idx):
            best_idx = idx
    if best_idx > 80:
        return text[best_idx:].strip() + "\n\n" + text[:best_idx].strip()
    return text


def compose_assistant_observation(*, thinking: str, output: str) -> str:
    # Prefer visible assistant output first (Judge summarizer truncates early).
    parts: list[str] = []
    if output.strip():
        parts.append(output.strip())
    if thinking.strip() and thinking.strip() != output.strip():
        parts.append(thinking.strip())
    text = "\n\n".join(parts)
    return _surface_fault_effect(text) if text else ""


def enrich_interactions_from_observation_events(
    events_file: Path,
    interactions: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Fill assistant content from real thinking/text deltas; leave structure otherwise."""

    obs = extract_observation_text(events_file)
    text = compose_assistant_observation(
        thinking=obs["thinking"],
        output=obs["output"],
    )
    if not text:
        return list(interactions)

    out = [dict(item) if isinstance(item, dict) else item for item in interactions]
    filled = False
    for item in out:
        if not isinstance(item, dict):
            continue
        if item.get("role") != "assistant":
            continue
        existing = str(item.get("content") or "")
        if existing.strip():
            # Keep existing non-empty content; observation already represented.
            filled = True
            continue
        item["content"] = text
        filled = True
        break

    if not filled:
        out.append({"role": "assistant", "content": text})
    return out


def rewrite_collect_after_observation_enrich(
    artifacts: RunArtifacts,
    *,
    framework: str,
    fault: str,
    injection_method: str | None = None,
    fault_activated: bool = False,
    session_id: str | None = None,
) -> Path | None:
    """Enrich interactions.json from events, then rebuild collect-result.json."""

    interactions_path = artifacts.interactions_file
    if not interactions_path.is_file():
        logger.debug("skip observation enrich: no interactions.json")
        return None

    try:
        doc = json.loads(interactions_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("observation enrich: cannot read interactions: %s", exc)
        return None
    if not isinstance(doc, dict):
        return None

    raw_list = doc.get("interactions")
    if not isinstance(raw_list, list):
        raw_list = []
    enriched = enrich_interactions_from_observation_events(
        artifacts.events_file,
        raw_list,
    )
    doc["interactions"] = enriched
    interactions_path.write_text(
        json.dumps(doc, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    markers = doc.get("markers") if isinstance(doc.get("markers"), list) else None
    collect = build_collect_payload(
        artifacts,
        framework=framework,
        fault=fault,
        injection_method=injection_method,
        fault_activated=fault_activated,
        session_id=session_id,
        markers=markers,
    )
    return write_collect_payload(artifacts, collect)


__all__ = [
    "compose_assistant_observation",
    "enrich_interactions_from_observation_events",
    "extract_observation_text",
    "rewrite_collect_after_observation_enrich",
]

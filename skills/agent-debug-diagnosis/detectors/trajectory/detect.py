#!/usr/bin/env python3
"""Deterministic trajectory loop and no-progress detector."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


def signature_for_turn(turn: dict[str, Any]) -> str:
    tool_calls = turn.get("toolCalls")
    if isinstance(tool_calls, list) and tool_calls:
        return "+".join(
            f"tool:{str(call.get('name') or 'unknown').strip().lower()[:60]}|{normalize_args(call.get('args'))}"
            for call in tool_calls
            if isinstance(call, dict)
        )
    text = str(turn.get("text") or turn.get("reasoningText") or "").strip()
    return f"text:{' '.join(text.lower().split())[:48]}" if text else ""


def normalize_args(value: Any) -> str:
    if value is None:
        rendered = ""
    elif isinstance(value, str):
        rendered = value
    else:
        rendered = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=False)
    return " ".join(rendered.lower().split())[:80]


def max_subarray(weights: list[float]) -> tuple[int, int, float] | None:
    if not weights:
        return None
    best_sum = -math.inf
    best_from = best_to = cur_from = 0
    cur_sum = 0.0
    for index, weight in enumerate(weights):
        if cur_sum <= 0:
            cur_sum = weight
            cur_from = index
        else:
            cur_sum += weight
        if cur_sum > best_sum:
            best_sum = cur_sum
            best_from = cur_from
            best_to = index
    return best_from, best_to, best_sum


def trace_step(turn: dict[str, Any] | None) -> int | None:
    if not turn:
        return None
    value = turn.get("traceStepIndex")
    if isinstance(value, (int, float)):
        return int(value)
    value = turn.get("turnIndex")
    return int(value) if isinstance(value, (int, float)) else None


def human_label(signature: str) -> str:
    if signature.startswith("tool:"):
        body = signature[5:]
        name, _, args = body.partition("|")
        return f"工具 {name} {truncate(args.strip(), 48)}".strip()
    if signature.startswith("text:"):
        return f"助手消息「{truncate(signature[5:].strip(), 32)}…」"
    return truncate(signature, 48)


def truncate(value: str, maximum: int) -> str:
    return value[:maximum] + "…" if len(value) > maximum else value


def pick_anchors(turns: list[dict[str, Any]], signatures: list[str], dominant: str, start: int, end: int) -> list[dict[str, Any]]:
    positions = [index for index in range(start, end + 1) if signatures[index] == dominant]
    if not positions:
        return []
    picks = positions if len(positions) <= 3 else [positions[0], positions[len(positions) // 2], positions[-1]]
    notes = ["首次", "中段", "末次"]
    anchors = []
    for index, position in enumerate(picks):
        turn = turns[position]
        anchors.append({
            "traceStepIndex": trace_step(turn),
            "traceNodeLabel": turn.get("traceNodeLabel"),
            "anchorId": (turn.get("anchorIds") or [None])[0],
            "sourceInteractionIndex": turn.get("sourceInteractionIndex"),
            "note": f"{notes[index] if len(picks) > 1 and index < len(notes) else ''}重复出现",
        })
    return anchors


def build_finding(turns: list[dict[str, Any]], signatures: list[str], repeats: list[bool], start: int, end: int, config: dict[str, Any]) -> dict[str, Any] | None:
    turn_count = end - start + 1
    if turn_count < int(config.get("minRegionTurns", 10)):
        return None
    counts: dict[str, int] = {}
    repeat_count = 0
    for index in range(start, end + 1):
        repeat_count += 1 if repeats[index] else 0
        signature = signatures[index]
        if signature:
            counts[signature] = counts.get(signature, 0) + 1
    ranked = sorted(counts.items(), key=lambda item: -item[1])
    if not ranked:
        return None
    dominant, cycle_count = ranked[0]
    if cycle_count < int(config.get("minRepeats", 4)):
        return None
    ratio = repeat_count / turn_count
    percent = round(ratio * 100)
    label = human_label(dominant)
    from_step = trace_step(turns[start])
    to_step = trace_step(turns[end])
    span_text = f"trace 节点 #{from_step}–#{to_step}" if from_step is not None and to_step is not None else f"约 {turn_count} 个 turn"
    facts = [
        f"区间约 {turn_count} 个 turn，其中约 {percent}% 是对此前已出现动作的重复（无新进展）。",
        f"主导动作「{label}」重复约 {cycle_count} 次。",
    ]
    fault_chain = [f"{human_label(signature)} ×{count}" for signature, count in ranked if count >= 2][:4]
    confidence = max(0.5, min(0.92, 0.5 + min(cycle_count, 20) * 0.02 + max(0, ratio - 0.6) * 0.3))
    return {
        "id": f"trajectory-{start + 1}-{end + 1}",
        "kind": "trajectory",
        "pattern": "non_termination",
        "severity": "high",
        "summary": f"{span_text} 之间疑似未终止循环：主导动作「{label}」重复约 {cycle_count} 次、{percent}% 的 turn 无新进展。",
        "facts": facts,
        "mechanism": f"在 {span_text}（约 {turn_count} 个 turn）范围内，约 {percent}% 的 turn 在重复此前已做过的动作、几乎不产生新进展，主导动作「{label}」重复约 {cycle_count} 次，疑似未终止循环：每一轮单独看都正常，但整体不收敛、不推进到终止条件。",
        "faultChain": fault_chain,
        "anchors": pick_anchors(turns, signatures, dominant, start, end),
        "correctionGuidance": "核查该区间的循环是否缺少终止条件，或是否因外部依赖长期未完成而反复从头执行；加入重复多次仍无进展时中止、上报或强制推进的兜底。",
        "confidence": confidence,
        "details": {
            "span": {
                "fromStep": from_step,
                "toStep": to_step,
                "fromInteractionIndex": turns[start].get("sourceInteractionIndex", start),
                "toInteractionIndex": turns[end].get("sourceInteractionIndex", end),
                "turnCount": turn_count,
            },
            "cycleCount": cycle_count,
            "signature": dominant,
            "noProgressEvidence": "".join(facts),
        },
    }


def detect(turns: list[dict[str, Any]], config: dict[str, Any]) -> list[dict[str, Any]]:
    min_region_turns = int(config.get("minRegionTurns", 10))
    if len(turns) < min_region_turns:
        return []
    dominance_ratio = float(config.get("dominanceRatio", 0.6))
    signatures = [signature_for_turn(turn) for turn in turns]
    seen: set[str] = set()
    repeats: list[bool] = []
    weights: list[float] = []
    for signature in signatures:
        if not signature:
            repeats.append(False)
            weights.append(0)
        elif signature in seen:
            repeats.append(True)
            weights.append(1 - dominance_ratio)
        else:
            seen.add(signature)
            repeats.append(False)
            weights.append(-dominance_ratio)
    masked = list(weights)
    findings = []
    for _ in range(int(config.get("maxFindings", 5))):
        region = max_subarray(masked)
        if not region or region[2] <= 0:
            break
        start, end, _score = region
        for index in range(start, end + 1):
            masked[index] = -math.inf
        finding = build_finding(turns, signatures, repeats, start, end, config)
        if finding:
            findings.append(finding)
    findings.sort(key=lambda finding: -int(finding["details"]["cycleCount"]))
    return findings


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args()
    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    turns = payload.get("turns") if isinstance(payload.get("turns"), list) else []
    print(json.dumps({"findings": detect(turns, manifest.get("config") or {})}, ensure_ascii=False))


if __name__ == "__main__":
    main()

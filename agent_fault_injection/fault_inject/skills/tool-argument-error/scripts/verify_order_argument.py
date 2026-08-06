#!/usr/bin/env python3
"""Authoritative verifier for the native order tool argument scenario."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


OUTPUT_DIRECTORY = Path("tool-argument-error-output")
FIXTURES_DIRECTORY = OUTPUT_DIRECTORY / "fixtures"
EVENTS_FILE = OUTPUT_DIRECTORY / "events.jsonl"
RESULT_FILE = OUTPUT_DIRECTORY / "result.json"
EXPECTED_TOOL = "order"
EXPECTED_ARGUMENTS = {"txt": "a.txt"}


def _read_json(path: Path, errors: list[str]) -> dict[str, Any] | None:
    if not path.is_file():
        errors.append(f"missing {path.as_posix()}")
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        errors.append(f"cannot read {path.as_posix()}: {exc}")
        return None
    if not isinstance(value, dict):
        errors.append(f"{path.as_posix()} must contain a JSON object")
        return None
    return value


def _read_events(errors: list[str]) -> list[dict[str, Any]]:
    if not EVENTS_FILE.is_file():
        errors.append(f"missing {EVENTS_FILE.as_posix()}")
        return []
    try:
        lines = EVENTS_FILE.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        errors.append(f"cannot read {EVENTS_FILE.as_posix()}: {exc}")
        return []

    events: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, start=1):
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            errors.append(f"invalid event at line {line_number}: {exc}")
            continue
        if not isinstance(value, dict):
            errors.append(f"event at line {line_number} is not an object")
            continue
        events.append(value)

    sequences = [event.get("sequence") for event in events]
    if sequences != list(range(1, len(events) + 1)):
        errors.append("event sequence is not contiguous")
    return events


def _expected_file_info(errors: list[str]) -> dict[str, Any] | None:
    fixture = FIXTURES_DIRECTORY / EXPECTED_ARGUMENTS["txt"]
    if not fixture.is_file():
        errors.append(f"missing expected fixture {fixture.as_posix()}")
        return None
    try:
        content = fixture.read_bytes()
    except OSError as exc:
        errors.append(f"cannot read expected fixture: {exc}")
        return None
    return {
        "txt": EXPECTED_ARGUMENTS["txt"],
        "size_bytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "preview": content.decode("utf-8").splitlines()[0],
    }


def verify() -> list[str]:
    errors: list[str] = []
    result = _read_json(RESULT_FILE, errors)
    events = _read_events(errors)
    expected_info = _expected_file_info(errors)
    if result is None or not events or expected_info is None:
        return errors

    if len(events) != 1:
        errors.append(f"expected one native tool call, observed {len(events)}")
    event = events[-1]
    if event.get("type") != "tool_call":
        errors.append("event is not a native tool_call record")
    if event.get("expected_tool") != EXPECTED_TOOL:
        errors.append("event does not preserve expected_tool='order'")
    if event.get("actual_tool") != EXPECTED_TOOL:
        errors.append(
            f"tool selection mismatch: expected 'order', got {event.get('actual_tool')!r}"
        )
    if event.get("tool_matches") is not True:
        errors.append("event does not record selection of the correct tool")
    if event.get("argument_schema_valid") is not True:
        errors.append("native order arguments did not satisfy the declared schema")
    if event.get("expected_arguments") != EXPECTED_ARGUMENTS:
        errors.append("event does not preserve expected arguments for a.txt")

    actual_arguments = event.get("actual_arguments")
    if actual_arguments != EXPECTED_ARGUMENTS:
        actual_txt = (
            actual_arguments.get("txt")
            if isinstance(actual_arguments, dict)
            else None
        )
        errors.append(
            "tool argument mismatch: expected 'a.txt', "
            f"got {actual_txt!r}"
        )
    if event.get("argument_value_matches") is not True:
        errors.append("event marks the argument value as mismatched")
    if event.get("tool_succeeded") is not True:
        errors.append("native order tool did not complete successfully")
    if event.get("file_info") != expected_info:
        errors.append("native order result does not contain a.txt file information")

    if result.get("schema_version") != 1:
        errors.append("result has an unsupported schema")
    if result.get("completed") is not True:
        errors.append("result is not marked completed")
    if result.get("call_count") != 1:
        errors.append("result does not record exactly one native order call")
    if result.get("expected_tool") != EXPECTED_TOOL:
        errors.append("result expected_tool is not order")
    if result.get("actual_tool") != EXPECTED_TOOL:
        errors.append("result actual_tool is not order")
    if result.get("expected_arguments") != EXPECTED_ARGUMENTS:
        errors.append("result does not preserve expected arguments for a.txt")
    if result.get("actual_arguments") != EXPECTED_ARGUMENTS:
        errors.append("result actual arguments do not satisfy the healthy contract")
    if result.get("argument_schema_valid") is not True:
        errors.append("result does not record schema-valid arguments")
    if result.get("argument_value_matches") is not True:
        errors.append("result does not satisfy the healthy argument contract")
    if result.get("tool_succeeded") is not True:
        errors.append("result does not record a successful native tool call")
    if result.get("file_info") != expected_info:
        errors.append("result does not contain a.txt file information")
    return errors


def main() -> int:
    errors = verify()
    if errors:
        print("argument verification failed")
        for error in errors:
            print(f"- {error}")
        return 1
    print("argument verification succeeded")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

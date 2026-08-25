"""Parity fixtures: every capability_api runtime op is exercised by rewrite_engine."""

from __future__ import annotations

from agent_fault_injection.fault_inject.catalog.capability_api import allowed_ops, load_capability_api
from agent_fault_injection.fault_inject.injection import (
    apply_assistant_text_rewrite,
    apply_assistant_tool_call_rewrite,
    apply_messages_rewrite,
    apply_system_rewrite,
    apply_tool_result_rewrite,
)

# (op, apply callable result extractor) — SoT expectations for OpenCode thin layer.
_FIXTURES = [
    (
        "tool_result.replace_text",
        lambda: apply_tool_result_rewrite(
            [
                {
                    "op": "tool_result.replace_text",
                    "when": {"tool": "read"},
                    "args": {"from": "OK", "to": "FAULT"},
                }
            ],
            tool="read",
            call_index=1,
            output="prefix OK suffix",
        ),
        ("prefix FAULT suffix", True),
    ),
    (
        "tool_result.replace_all",
        lambda: apply_tool_result_rewrite(
            [
                {
                    "op": "tool_result.replace_all",
                    "when": {"tool": "read"},
                    "args": {"from": "a", "to": "b"},
                }
            ],
            tool="read",
            call_index=1,
            output="a-a",
        ),
        ("b-b", True),
    ),
    (
        "system.append",
        lambda: apply_system_rewrite(
            [{"op": "system.append", "args": {"text": "INJECT"}}],
            system_parts=["base"],
        ),
        (["base", "INJECT"], True),
    ),
    (
        "system.replace_text",
        lambda: apply_system_rewrite(
            [
                {
                    "op": "system.replace_text",
                    "args": {"from": "base", "to": "new"},
                }
            ],
            system_parts=["base"],
        ),
        (["new"], True),
    ),
    (
        "assistant.replace_text",
        lambda: apply_assistant_text_rewrite(
            [
                {
                    "op": "assistant.replace_text",
                    "args": {"from": "good", "to": "bad"},
                }
            ],
            text="all good here",
        ),
        ("all bad here", True),
    ),
    (
        "assistant.truncate",
        lambda: apply_assistant_text_rewrite(
            [{"op": "assistant.truncate", "args": {"max_chars": 4}}],
            text="abcdef",
        ),
        ("abcd", True),
    ),
    (
        "assistant.tool_call.replace_argument",
        lambda: apply_assistant_tool_call_rewrite(
            [
                {
                    "op": "assistant.tool_call.replace_argument",
                    "when": {"tool": "skill", "call_index": 1},
                    "args": {
                        "path": "name",
                        "from": "ras-code-review",
                        "to": "ras-code-format",
                    },
                }
            ],
            tool="skill",
            call_index=1,
            arguments={"name": "ras-code-review"},
        ),
        ({"name": "ras-code-format"}, True),
    ),
    (
        "messages.history.drop",
        lambda: apply_messages_rewrite(
            [{"op": "messages.history.drop", "args": {"count": 1}}],
            messages=[
                {"role": "system", "content": "s"},
                {"role": "user", "content": "u1"},
                {"role": "assistant", "content": "a1"},
            ],
        ),
        (2, True),  # length after drop
    ),
    (
        "messages.inject",
        lambda: apply_messages_rewrite(
            [
                {
                    "op": "messages.inject",
                    "args": {
                        "role": "user",
                        "text": "NOISE",
                        "position": "merge_user",
                    },
                }
            ],
            messages=[{"role": "user", "content": "hello"}],
        ),
        (True, True),  # content contains NOISE
    ),
]


def test_capability_runtime_ops_all_have_fixtures() -> None:
    api = load_capability_api()
    runtime_ops = {str(op) for op in api["runtime_ops"]}
    covered = {name for name, *_ in _FIXTURES}
    assert runtime_ops == covered, (
        f"missing fixtures for {sorted(runtime_ops - covered)}; "
        f"extra {sorted(covered - runtime_ops)}"
    )


def test_rewrite_engine_matches_fixture_expectations() -> None:
    for op, runner, expected in _FIXTURES:
        result = runner()
        if op.startswith("tool_result."):
            output, meta = result
            assert output == expected[0], op
            assert bool(meta.get("applied")) is expected[1], op
        elif op.startswith("system."):
            parts, meta = result
            assert parts == expected[0], op
            assert bool(meta.get("applied")) is expected[1], op
        elif op.startswith("assistant."):
            value, meta = result
            assert value == expected[0], op
            assert bool(meta.get("applied")) is expected[1], op
        elif op == "messages.history.drop":
            messages, meta = result
            assert len(messages) == expected[0], op
            assert bool(meta.get("applied")) is expected[1], op
        elif op == "messages.inject":
            messages, meta = result
            blob = str(messages)
            assert ("NOISE" in blob) is expected[0], op
            assert bool(meta.get("applied")) is expected[1], op
        else:
            raise AssertionError(op)


def test_runtime_ops_subset_of_allowed_ops() -> None:
    api = load_capability_api()
    assert set(api["runtime_ops"]).issubset(allowed_ops(api))

# coding: utf-8
"""Sliding-window trigger-count gate unit tests for analysis paralysis (no Skill)."""
from __future__ import annotations

from detectors.analysis_paralysis import (
    RefrainGate,
    TriggerVocabConfig,
    count_phrase_hits,
    count_phrase_in_text,
    phrase_in_text,
    split_complete_steps,
)


def test_phrase_short_token_does_not_match_inside_word() -> None:
    assert phrase_in_text("wait, let me check", "wait")
    assert not phrase_in_text("await the result", "wait")


def test_phrase_chinese_substring() -> None:
    assert phrase_in_text("等一下，我需要再想想", "等一下")
    assert not phrase_in_text("继续推进搜索范围", "等一下")


def test_split_prefers_blank_lines() -> None:
    buf = "step one is ready.\n\nwait, let me check the answer.\n\npartial"
    steps, rest = split_complete_steps(buf)
    assert steps == ["step one is ready.", "wait, let me check the answer."]
    assert rest == "partial"


def test_split_sentence_fallback_on_long_buffer() -> None:
    first = "A" * 360 + "。 "
    second = "B" * 50
    buf = first + second
    steps, rest = split_complete_steps(buf)
    assert any("A" * 20 in s for s in steps)
    assert rest.startswith("B")


def test_count_phrase_in_text_short_token_multiple() -> None:
    text = "wait, hmm, wait again — wait is repeated"
    assert count_phrase_in_text(text, "wait") == 3


def test_count_phrase_in_text_long_phrase_multiple() -> None:
    text = "let me check. let me check again. let me check once more."
    assert count_phrase_in_text(text, "let me check") == 3


def test_count_phrase_in_text_chinese() -> None:
    text = "等一下，让我再确认。等一下，让我再确认。"
    assert count_phrase_in_text(text, "等一下") == 2


def test_count_phrase_hits_sums_across_phrases() -> None:
    text = "wait, let me check. wait again."
    phrases = ["wait", "let me check"]
    assert count_phrase_hits(text, phrases) == 3


def test_count_phrase_hits_zero_on_no_match() -> None:
    assert count_phrase_hits("nothing here", ("wait", "hold on")) == 0


def test_multi_category_step_counts_all() -> None:
    gate = RefrainGate(threshold=10)
    text = "Wait, let me check. Perhaps not sure. Wait again."
    hit = gate.observe_step(text)
    assert hit.step_hit_count >= 3
    assert hit.trigger_hits["self_check"] >= 2
    assert hit.trigger_hits["uncertainty"] >= 1


def test_below_threshold_no_gate() -> None:
    gate = RefrainGate(threshold=10)
    hit = gate.observe_step("Wait, let me check.")
    assert hit.gated is False
    assert hit.step_hit_count < 10
    assert hit.window_hit_count < 10


def test_threshold_reached_gates() -> None:
    gate = RefrainGate(threshold=10)
    for _ in range(5):
        gate.observe_step("Wait, let me check. Wait, hold on.")
    hit = gate.observe_step("Wait, let me check. Wait, hold on.")
    assert hit.gated is True
    assert hit.window_hit_count >= 10


def test_sliding_window_evicts_old_steps() -> None:
    gate = RefrainGate(window_size=2, threshold=999)
    gate.observe_step("wait, let me check, wait, hold on")
    gate.observe_step("wait, let me check, wait, hold on")
    # window now has 2 entries; adding a zero-hit step should evict oldest
    hit = gate.observe_step("no triggers here at all")
    assert hit.window_hit_count < 20


def test_reset_count_after_skill() -> None:
    gate = RefrainGate(threshold=5)
    for _ in range(3):
        gate.observe_step("Wait, let me check. Wait, hold on.")
    assert gate.observe_step("Wait, hold on.").gated is True
    gate.reset_count()
    hit = gate.observe_step("Wait, let me check. Wait, hold on.")
    assert hit.gated is False
    assert hit.window_hit_count < 5


def test_custom_threshold() -> None:
    gate = RefrainGate(threshold=2)
    hit = gate.observe_step("Wait, let me check.")
    assert hit.gated is True
    assert hit.window_hit_count >= 2


def test_custom_vocab_only_counts_provided_category() -> None:
    vocab = TriggerVocabConfig(
        self_check=["zzz-trigger"],
        strategy_shift=[],
        uncertainty=[],
        retrospective=[],
    )
    gate = RefrainGate(vocab=vocab, threshold=2)
    hit = gate.observe_step("zzz-trigger zzz-trigger")
    assert hit.trigger_hits["self_check"] == 2
    assert hit.trigger_hits["uncertainty"] == 0
    assert hit.gated is True


def test_chinese_localization_counts() -> None:
    gate = RefrainGate(threshold=3)
    text = "等一下，让我检查。等一下，让我检查。也许不太确定。"
    hit = gate.observe_step(text)
    assert hit.trigger_hits["self_check"] >= 4
    assert hit.trigger_hits["uncertainty"] >= 1
    assert hit.gated is True

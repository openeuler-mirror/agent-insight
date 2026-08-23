"""Overhead benchmark for the CoPaw collector (AC24-AC26).

Usage:
    python benchmarks/bench_overhead.py [--iterations 20000]

Measures:
* per-span start/finish overhead (should be << 5% of a typical LLM call)
* peak memory of collecting N spans with a no-op exporter
"""
from __future__ import annotations

import argparse
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path

# Allow running directly: python benchmarks/bench_overhead.py
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_insight_copaw.collector import Collector
from agent_insight_copaw.config import CollectorConfig


class NullExporter:
    def __init__(self) -> None:
        self.submits = 0

    def submit(self, item_id: str, payload: dict) -> None:
        self.submits += 1

    def flush(self, timeout: float = 3.0) -> None:
        pass

    def close(self) -> None:
        pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=20_000)
    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        config = CollectorConfig(
            endpoint="",
            spool_dir=str(Path(tmp) / "spool"),
            log_file=str(Path(tmp) / "plugin.log"),
        )
        collector = Collector(config, exporter=NullExporter())
        collector.start_agent(
            session_id="bench",
            root_session_id="bench",
            agent_id="assistant",
            root_agent_id="assistant",
            query="benchmark query",
        )

        # Warm-up
        for _ in range(500):
            span = collector.start_llm(model="qwen3", provider="bench", input="x" * 100)
            collector.finish_llm(span, output="y" * 100, usage={"input_tokens": 5, "output_tokens": 3, "total_tokens": 8})

        count = args.iterations
        tracemalloc.start()
        start = time.perf_counter()
        for _ in range(count):
            span = collector.start_llm(model="qwen3", provider="bench", input="x" * 100)
            collector.finish_llm(span, output="y" * 100, usage={"input_tokens": 5, "output_tokens": 3, "total_tokens": 8})
        elapsed = time.perf_counter() - start
        _current, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        collector.close()

        per_span_us = elapsed / count * 1_000_000
        print(f"iterations           : {count}")
        print(f"total time           : {elapsed:.3f}s")
        print(f"per span (start+fin) : {per_span_us:.2f} us")
        print(f"peak memory          : {peak / 1024 / 1024:.2f} MiB")
        print("budget check         : LLM call is typically >= 100 ms, so")
        print("                       <5% overhead means < 5000 us/span.")


if __name__ == "__main__":
    main()

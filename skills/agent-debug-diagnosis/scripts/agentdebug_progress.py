#!/usr/bin/env python3
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="记录可公开的诊断阶段摘要，不影响最终报告")
    parser.add_argument("--module", required=True, choices=["memory", "reflection", "planning", "action", "system", "overall"], help="实际检查维度；跨模块任务活动使用 overall，不得归到 system")
    parser.add_argument("--state", default="update", choices=["started", "update", "completed", "skipped"])
    parser.add_argument("--title", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--steps", nargs="*", type=int, default=[])
    args = parser.parse_args()
    try:
        directory = Path(".agent-insight")
        context = json.loads((directory / "agent-debug-progress-context.json").read_text())
        output = directory / "agent-debug-progress.jsonl"
        if output.exists() and output.stat().st_size > 240 * 1024:
            print("Progress limit reached; continue diagnosis.")
            return
        record = dict(runId=context["runId"], module=args.module, state=args.state,
                      title=args.title[:160], summary=args.summary[:1000], steps=args.steps[:12])
        with output.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        print("Progress recorded; continue diagnosis.")
    except (OSError, ValueError, KeyError):
        print("Progress unavailable; continue diagnosis and produce the final report.")


if __name__ == "__main__":
    main()

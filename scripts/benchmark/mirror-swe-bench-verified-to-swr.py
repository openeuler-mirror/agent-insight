#!/usr/bin/env python3

import argparse
import fcntl
import json
import os
import re
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path


TAG_PATTERN = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Mirror the 500 SWE-bench Verified x86-64 images to two SWR repositories."
    )
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--loader", required=True)
    parser.add_argument("--loader-python", required=True)
    parser.add_argument("--registry", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--repo-a", default="swebench-verified-x86-64-a")
    parser.add_argument("--repo-b", default="swebench-verified-x86-64-b")
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--retries", type=int, default=4)
    parser.add_argument("--pull-timeout", type=int, default=900)
    parser.add_argument("--push-timeout", type=int, default=900)
    parser.add_argument("--verify-timeout", type=int, default=120)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def load_cases(args: argparse.Namespace) -> list[dict]:
    completed = subprocess.run(
        [args.loader_python, args.loader, args.dataset],
        check=True,
        capture_output=True,
        text=True,
    )
    cases = json.loads(completed.stdout)["cases"]
    cases.sort(key=lambda case: case["instance_id"])
    instance_ids = [case["instance_id"] for case in cases]
    if len(cases) != 500 or len(set(instance_ids)) != 500:
        raise RuntimeError(
            f"expected 500 unique SWE-bench Verified cases, got {len(cases)} rows "
            f"and {len(set(instance_ids))} unique instance IDs"
        )
    for case in cases:
        image = str(case.get("image") or "")
        instance_id = str(case["instance_id"])
        if not image.startswith("swebench/sweb.eval.x86_64."):
            raise RuntimeError(f"unexpected x86-64 image for {instance_id}: {image}")
        if not TAG_PATTERN.fullmatch(instance_id):
            raise RuntimeError(f"instance ID is not a valid Docker tag: {instance_id}")
    return cases


def build_mapping(args: argparse.Namespace, cases: list[dict]) -> list[dict]:
    mapping = []
    for offset, case in enumerate(cases):
        repository = args.repo_a if offset < 250 else args.repo_b
        mapping.append(
            {
                "index": offset + 1,
                "instance_id": case["instance_id"],
                "source": case["image"],
                "target": (
                    f"{args.registry}/{args.namespace}/{repository}:"
                    f"{case['instance_id']}"
                ),
                "bucket": "a" if offset < 250 else "b",
            }
        )
    # Create both repositories near the beginning of the run so they can be made public early.
    return [mapping[0], mapping[250], *mapping[1:250], *mapping[251:]]


def write_mapping(path: Path, mapping: list[dict]) -> None:
    ordered = sorted(mapping, key=lambda item: item["index"])
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        handle.write("index\tinstance_id\tbucket\tsource\ttarget\n")
        for item in ordered:
            handle.write(
                f"{item['index']}\t{item['instance_id']}\t{item['bucket']}\t"
                f"{item['source']}\t{item['target']}\n"
            )
    temporary.replace(path)


def completed_instances(results_path: Path) -> set[str]:
    completed = set()
    if not results_path.exists():
        return completed
    for line in results_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        if record.get("status") == "success":
            completed.add(record["instance_id"])
    return completed


def append_result(results_path: Path, record: dict) -> None:
    record = {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **record}
    with results_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def run_streaming(command: list[str], timeout: int, log_handle) -> tuple[int, str]:
    log_handle.write(f"$ {' '.join(command)}\n")
    log_handle.flush()
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,
    )
    selector = selectors.DefaultSelector()
    assert process.stdout is not None
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    output_tail: list[str] = []
    try:
        while True:
            if time.monotonic() >= deadline:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                message = f"TIMEOUT after {timeout}s"
                print(message, flush=True)
                log_handle.write(message + "\n")
                log_handle.flush()
                return 124, "\n".join([*output_tail, message])
            events = selector.select(timeout=1)
            for key, _ in events:
                line = key.fileobj.readline()
                if line:
                    text = line.rstrip("\n")
                    print(text, flush=True)
                    log_handle.write(line)
                    log_handle.flush()
                    output_tail.append(text)
                    output_tail = output_tail[-40:]
            if process.poll() is not None:
                remainder = process.stdout.read()
                if remainder:
                    print(remainder, end="", flush=True)
                    log_handle.write(remainder)
                    output_tail.extend(remainder.splitlines())
                    output_tail = output_tail[-40:]
                return process.returncode, "\n".join(output_tail)
    finally:
        selector.close()


def image_exists(image: str) -> bool:
    return (
        subprocess.run(
            ["docker", "image", "inspect", image],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode
        == 0
    )


def remove_local_image(image: str) -> None:
    subprocess.run(
        ["docker", "image", "rm", image],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def mirror_one(args: argparse.Namespace, item: dict, log_handle) -> dict:
    source = item["source"]
    target = item["target"]
    source_preexisting = image_exists(source)
    target_preexisting = image_exists(target)
    started = time.monotonic()
    last_error = ""
    try:
        for attempt in range(1, args.retries + 1):
            print(
                f"[{item['index']}/500] {item['instance_id']} attempt "
                f"{attempt}/{args.retries}",
                flush=True,
            )
            pull_rc, pull_output = run_streaming(
                ["docker", "pull", "--platform", "linux/amd64", source],
                args.pull_timeout,
                log_handle,
            )
            if pull_rc != 0:
                last_error = f"pull rc={pull_rc}: {pull_output[-2000:]}"
            else:
                tag_rc = subprocess.run(["docker", "tag", source, target]).returncode
                if tag_rc != 0:
                    last_error = f"docker tag failed with rc={tag_rc}"
                else:
                    push_rc, push_output = run_streaming(
                        ["docker", "push", target], args.push_timeout, log_handle
                    )
                    if push_rc == 0:
                        verify_rc, verify_output = run_streaming(
                            ["docker", "manifest", "inspect", target],
                            args.verify_timeout,
                            log_handle,
                        )
                        if verify_rc == 0:
                            digest_match = re.search(
                                r"digest:\s+(sha256:[0-9a-f]{64})", push_output
                            )
                            return {
                                **item,
                                "status": "success",
                                "attempt": attempt,
                                "duration_seconds": round(time.monotonic() - started, 1),
                                "target_digest": (
                                    digest_match.group(1) if digest_match else None
                                ),
                            }
                        last_error = (
                            f"remote manifest verification rc={verify_rc}: "
                            f"{verify_output[-2000:]}"
                        )
                    else:
                        last_error = f"push rc={push_rc}: {push_output[-2000:]}"
            if attempt < args.retries:
                delay = min(30 * (2 ** (attempt - 1)), 240)
                print(f"retrying after {delay}s", flush=True)
                time.sleep(delay)
        return {
            **item,
            "status": "failed",
            "attempt": args.retries,
            "duration_seconds": round(time.monotonic() - started, 1),
            "error": last_error,
        }
    finally:
        if not target_preexisting:
            remove_local_image(target)
        if not source_preexisting:
            remove_local_image(source)


def write_summary(path: Path, mapping: list[dict], results_path: Path) -> dict:
    latest: dict[str, dict] = {}
    if results_path.exists():
        for line in results_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                record = json.loads(line)
                latest[record["instance_id"]] = record
    success = sum(record.get("status") == "success" for record in latest.values())
    failed = sum(record.get("status") == "failed" for record in latest.values())
    summary = {
        "total": len(mapping),
        "success": success,
        "failed": failed,
        "pending": len(mapping) - success - failed,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(path)
    return summary


def main() -> int:
    args = parse_args()
    if args.retries < 1:
        raise ValueError("--retries must be at least 1")
    state_dir = Path(args.state_dir).resolve()
    state_dir.mkdir(parents=True, exist_ok=True)
    lock_handle = (state_dir / "mirror.lock").open("w")
    try:
        fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(f"another mirror process holds {state_dir / 'mirror.lock'}", file=sys.stderr)
        return 2

    cases = load_cases(args)
    mapping = build_mapping(args, cases)
    write_mapping(state_dir / "mapping.tsv", mapping)
    if args.limit is not None:
        mapping = mapping[: args.limit]
    print(
        f"validated 500 cases; run contains {len(mapping)} items; "
        f"repositories={args.repo_a},{args.repo_b}",
        flush=True,
    )
    if args.dry_run:
        for item in mapping:
            print(
                f"{item['index']}\t{item['instance_id']}\t{item['source']}\t{item['target']}"
            )
        return 0

    results_path = state_dir / "results.jsonl"
    log_path = state_dir / "docker.log"
    completed = completed_instances(results_path)
    with log_path.open("a", encoding="utf-8") as log_handle:
        for item in mapping:
            if item["instance_id"] in completed:
                print(f"SKIP success {item['instance_id']}", flush=True)
                continue
            result = mirror_one(args, item, log_handle)
            append_result(results_path, result)
            summary = write_summary(
                state_dir / "summary.json", build_mapping(args, cases), results_path
            )
            print(f"RESULT {json.dumps(result, ensure_ascii=False)}", flush=True)
            print(f"SUMMARY {json.dumps(summary, ensure_ascii=False)}", flush=True)

    summary = write_summary(
        state_dir / "summary.json", build_mapping(args, cases), results_path
    )
    print(f"FINAL {json.dumps(summary, ensure_ascii=False)}", flush=True)
    return 0 if summary["failed"] == 0 and summary["pending"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Skill-local detector discovery, matching and execution runtime."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


SKILL_ROOT = Path(__file__).resolve().parent.parent
DETECTORS_ROOT = SKILL_ROOT / "detectors"
SUPPORTED_MODES = {"one_click", "targeted"}


def load_manifests() -> list[dict[str, Any]]:
    manifests: list[dict[str, Any]] = []
    names: set[str] = set()
    for manifest_path in sorted(DETECTORS_ROOT.glob("*/detector.json")):
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        name = str(data.get("name") or "").strip()
        entrypoint = str(data.get("entrypoint") or "").strip()
        modes = data.get("modes")
        if not name or not entrypoint or not isinstance(modes, list) or not modes:
            raise ValueError(f"invalid detector manifest: {manifest_path}")
        if name in names:
            raise ValueError(f"duplicate detector name: {name}")
        invalid_modes = set(str(mode) for mode in modes) - SUPPORTED_MODES
        if invalid_modes:
            raise ValueError(f"unsupported modes in {manifest_path}: {sorted(invalid_modes)}")
        detector_dir = manifest_path.parent.resolve()
        entrypoint_path = (detector_dir / entrypoint).resolve()
        if detector_dir not in entrypoint_path.parents or not entrypoint_path.is_file():
            raise ValueError(f"invalid detector entrypoint: {entrypoint_path}")
        data["manifestPath"] = str(manifest_path)
        data["detectorDir"] = str(detector_dir)
        data["entrypointPath"] = str(entrypoint_path)
        manifests.append(data)
        names.add(name)
    return manifests


def public_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in manifest.items() if key not in {"manifestPath", "detectorDir", "entrypointPath"}}


def score_manifest(manifest: dict[str, Any], query: str) -> tuple[int, list[str]]:
    normalized = query.strip().lower()
    matched: list[str] = []
    for intent in manifest.get("intents") or []:
        for keyword in intent.get("keywords") or []:
            token = str(keyword).strip().lower()
            if token and token in normalized:
                matched.append(str(keyword))
    return len(set(matched)), sorted(set(matched))


def select_manifests(manifests: list[dict[str, Any]], mode: str, query: str) -> list[dict[str, Any]]:
    eligible = [item for item in manifests if item.get("enabled", True) and mode in item.get("modes", [])]
    if mode == "one_click":
        return eligible
    scored = []
    for item in eligible:
        score, keywords = score_manifest(item, query)
        if score > 0:
            scored.append((score, str(item["name"]), keywords, item))
    scored.sort(key=lambda row: (-row[0], row[1]))
    for score, _name, keywords, item in scored:
        item["match"] = {"score": score, "keywords": keywords}
    return [row[3] for row in scored]


def query_from_input(query: str, input_path: str) -> str:
    if query.strip():
        return query
    payload = json.loads(Path(input_path).read_text(encoding="utf-8"))
    value = payload.get("query")
    return value if isinstance(value, str) else ""


def run_detector(manifest: dict[str, Any], input_path: str) -> dict[str, Any]:
    proc = subprocess.run(
        [sys.executable, manifest["entrypointPath"], "--input", input_path, "--manifest", manifest["manifestPath"]],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"detector {manifest['name']} failed: {proc.stderr.strip() or proc.stdout.strip()}")
    payload = json.loads(proc.stdout or "{}")
    findings = payload.get("findings")
    if not isinstance(findings, list):
        raise ValueError(f"detector {manifest['name']} returned invalid findings")
    for finding in findings:
        if isinstance(finding, dict):
            finding.setdefault("detector", f"{manifest['name']}@{manifest.get('version', '0')}")
    return {"detector": public_manifest(manifest), "findings": findings}


def write_result(payload: dict[str, Any], output_path: str | None) -> None:
    rendered = json.dumps(payload, ensure_ascii=False, indent=2)
    if output_path:
        target = Path(output_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list")
    list_parser.add_argument("--mode", choices=sorted(SUPPORTED_MODES))

    match_parser = subparsers.add_parser("match")
    match_parser.add_argument("--mode", choices=sorted(SUPPORTED_MODES), default="targeted")
    match_parser.add_argument("--query", required=True)

    run_parser = subparsers.add_parser("run")
    run_parser.add_argument("--name", required=True)
    run_parser.add_argument("--input", required=True)
    run_parser.add_argument("--output")

    all_parser = subparsers.add_parser("run-all")
    all_parser.add_argument("--mode", choices=sorted(SUPPORTED_MODES), required=True)
    all_parser.add_argument("--query", default="")
    all_parser.add_argument("--input", required=True)
    all_parser.add_argument("--output")

    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--output")

    args = parser.parse_args()
    manifests = load_manifests()
    if args.command == "list":
        selected = manifests if not args.mode else select_manifests(manifests, args.mode, "")
        write_result({"detectors": [public_manifest(item) for item in selected]}, None)
        return 0
    if args.command == "match":
        selected = select_manifests(manifests, args.mode, args.query)
        write_result({"detectors": [{**public_manifest(item), "match": item.get("match")} for item in selected]}, None)
        return 0
    if args.command == "validate":
        write_result({"valid": True, "detectors": [public_manifest(item) for item in manifests]}, args.output)
        return 0
    if args.command == "run":
        manifest = next((item for item in manifests if item["name"] == args.name and item.get("enabled", True)), None)
        if not manifest:
            raise ValueError(f"unknown or disabled detector: {args.name}")
        result = run_detector(manifest, args.input)
        write_result({"findings": result["findings"], "runs": [result]}, args.output)
        return 0
    query = query_from_input(args.query, args.input) if args.mode == "targeted" else args.query
    selected = select_manifests(manifests, args.mode, query)
    runs = []
    errors = []
    for item in selected:
        try:
            runs.append(run_detector(item, args.input))
        except Exception as exc:
            errors.append({"detector": item["name"], "error": str(exc)})
    findings = [finding for run in runs for finding in run["findings"]]
    write_result({"findings": findings, "runs": runs, "errors": errors}, args.output)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)

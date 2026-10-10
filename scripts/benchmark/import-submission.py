#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Import existing PoCs into the platform evaluation queue")
    parser.add_argument("--platform", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--name", default="ZSoft PoC evaluation")
    parser.add_argument("--idempotency-key", required=True)
    parser.add_argument("--case", action="append", required=True, metavar="CASE_ID=POC_PATH")
    args = parser.parse_args()
    url = urllib.parse.urlsplit(args.platform)
    if url.scheme not in ("http", "https") or not url.netloc or url.username or url.password or url.query or url.fragment:
        parser.error("--platform must be an HTTP(S) base URL without credentials or query")
    api_key = os.environ.get("AGENT_INSIGHT_API_KEY", "")
    if not api_key:
        parser.error("set AGENT_INSIGHT_API_KEY in the environment")
    if len(args.case) > 30:
        parser.error("at most 30 cases per request")
    cases = []
    total = 0
    for item in args.case:
        case_id, separator, filename = item.partition("=")
        if not separator or not case_id:
            parser.error("--case requires CASE_ID=POC_PATH")
        source = Path(filename)
        if not source.is_file() or not 1 <= source.stat().st_size <= 1048576:
            parser.error("PoC must be a nonempty file of at most 1 MiB")
        content = source.read_bytes()
        total += len(content)
        if total > 32 * 1024 * 1024:
            parser.error("total submission size exceeds 32 MiB")
        cases.append({"caseId": case_id, "artifacts": [{"name": "poc", "contentBase64": base64.b64encode(content).decode("ascii")}]})
    body = json.dumps({"datasetId": args.dataset, "name": args.name, "idempotencyKey": args.idempotency_key, "cases": cases}).encode()
    request = urllib.request.Request(args.platform.rstrip("/") + "/api/benchmark/v1/submissions/import", data=body, headers={"content-type": "application/json", "x-witty-api-key": api_key}, method="POST")

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            return None

    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=120) as response:
            print(response.read(65536).decode())
    except urllib.error.HTTPError as error:
        try:
            body = json.loads(error.read(65536))
            message = body.get("error", {}).get("message", "Import failed")
        except Exception:
            message = "Import failed"
        print(f"HTTP {error.code}: {message}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError:
        print("Platform connection failed; retry with the same idempotency key", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

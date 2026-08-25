#!/usr/bin/env python3
from pathlib import Path


output = Path("two-condition-test-output")
expected = {
    "alpha.txt": "ALPHA\n",
    "beta.txt": "BETA\n",
}

for filename, content in expected.items():
    artifact = output / filename
    if not artifact.is_file():
        print("结果执行失败")
        raise SystemExit(1)
    if artifact.read_text(encoding="utf-8") != content:
        print("结果执行失败")
        raise SystemExit(1)

print("结果执行成功")

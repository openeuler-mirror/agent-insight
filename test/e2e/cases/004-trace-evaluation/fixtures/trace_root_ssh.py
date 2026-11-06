import collections
import json
import re
import sys


def analyze(filename):
    counts = collections.Counter()
    total_lines = 0
    evidence = []
    with open(filename, encoding="utf-8", errors="replace") as source:
        for line in source:
            total_lines += 1
            if "authentication failure;" not in line or not re.search(r"(?:^|\s)user=root(?:\s|$)", line):
                continue
            host = re.search(r"(?:^|\s)rhost=(\S*)", line)
            address = host.group(1) if host else ""
            counts[address] += 1
            evidence.append((address, line.rstrip()))
    address = sorted(counts, key=lambda value: (-counts[value], value))[0] if counts else ""
    return {
        "total_lines": total_lines,
        "root_ssh_failures": sum(counts.values()),
        "top_source": address,
        "top_source_failures": counts[address],
        "evidence": [line for host, line in evidence if host == address][:3],
    }


def main():
    if len(sys.argv) != 2:
        print("Usage: python3 analyze_logs.py LOG_FILE", file=sys.stderr)
        return 2
    try:
        result = analyze(sys.argv[1])
    except OSError as error:
        print("Cannot read log: " + str(error) + "; check the supplied path and read permissions.", file=sys.stderr)
        return 3
    if not result["evidence"]:
        print("No root authentication failure matched; verify that the supplied file contains root SSH authentication-failure logs.", file=sys.stderr)
        return 4
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())

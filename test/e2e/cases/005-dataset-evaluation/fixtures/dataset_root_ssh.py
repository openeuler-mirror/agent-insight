import collections
import json
import os
import re
import sys


def analyze(filename):
    counts = collections.Counter()
    samples = {}
    total_lines = 0
    with open(os.path.expanduser(filename), encoding="utf-8") as source:
        for line in source:
            total_lines += 1
            if "authentication failure;" not in line or not re.search(r"(?:^|\s)user=root(?:\s|$)", line):
                continue
            match = re.search(r"(?:^|\s)rhost=(\S+)", line)
            address = match.group(1) if match else "(missing rhost)"
            counts[address] += 1
            evidence = samples.setdefault(address, [])
            if len(evidence) < 3:
                evidence.append(line.rstrip("\r\n"))
    top = counts.most_common(5)
    address, count = top[0] if top else ("", 0)
    return {
        "total_lines": total_lines,
        "root_ssh_failures": sum(counts.values()),
        "top_source": address,
        "top_source_failures": count,
        "top_sources": [{"source": host, "count": n} for host, n in top],
        "evidence": samples.get(address, []),
        "evidence_by_source": {host: samples[host] for host, _ in top},
    }


def main():
    if len(sys.argv) != 2:
        print("Usage: python3 analyze_logs.py LOG_FILE", file=sys.stderr)
        return 2
    try:
        result = analyze(sys.argv[1])
    except (OSError, UnicodeError) as error:
        print("Cannot read UTF-8 log: " + str(error) + "; check the supplied path, read permissions and UTF-8 encoding.", file=sys.stderr)
        return 3
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

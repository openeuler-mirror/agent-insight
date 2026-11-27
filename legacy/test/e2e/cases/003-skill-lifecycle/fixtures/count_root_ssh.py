import collections
import json
import re
import sys


def analyze(filename):
    counts = collections.Counter()
    evidence = []
    with open(filename, encoding="utf-8", errors="replace") as source:
        for line in source:
            if "authentication failure;" not in line or not re.search(r"(?:^|\s)user=root(?:\s|$)", line):
                continue
            host = re.search(r"(?:^|\s)rhost=(\S*)", line)
            address = host.group(1) if host else ""
            counts[address] += 1
            evidence.append((address, line.rstrip()))
    address = sorted(counts, key=lambda value: (-counts[value], value))[0] if counts else ""
    return {
        "root_ssh_failures": sum(counts.values()),
        "top_source": address,
        "top_source_failures": counts[address],
        "evidence": [line for host, line in evidence if host == address][:3],
    }


def main():
    if len(sys.argv) != 2:
        print("Usage: python3 count_root_ssh.py LOG_FILE", file=sys.stderr)
        return 2
    try:
        result = analyze(sys.argv[1])
    except OSError as error:
        print("Cannot read log: " + str(error), file=sys.stderr)
        return 3
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

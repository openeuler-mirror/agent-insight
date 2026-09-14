import argparse
import json
import sys

from swebench.harness.utils import load_swebench_dataset


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset_path")
    args = parser.parse_args()
    cases = load_swebench_dataset(args.dataset_path)
    json.dump({"cases": cases}, sys.stdout, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()

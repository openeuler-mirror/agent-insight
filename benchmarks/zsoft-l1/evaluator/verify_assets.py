from __future__ import annotations

import json
import sys
from pathlib import Path

from assets import load_inventory, verify_task


def verify(root: Path, release: str, bundle_digest: str) -> None:
    metadata = json.loads((root / "zsoft-release.json").read_text())
    inventory = load_inventory(root)
    if (metadata.get("schemaVersion") != "zsoft-release/v1"
            or metadata.get("releaseId") != release
            or metadata.get("assetSchema") != "zsoft-assets/v1"
            or metadata.get("bundleDigest") != bundle_digest
            or inventory.get("bundleDigest") != bundle_digest
            or metadata.get("revision") != inventory.get("revision")
            or metadata.get("taskIds") != sorted(inventory["tasks"])
            or metadata.get("taskCount") != len(inventory["tasks"])):
        raise ValueError("ZSOFT_BUNDLE_MISMATCH")
    for task_id in inventory["tasks"]:
        verify_task(root, inventory, task_id)


if __name__ == "__main__":
    verify(Path(sys.argv[1]), sys.argv[2], sys.argv[3])

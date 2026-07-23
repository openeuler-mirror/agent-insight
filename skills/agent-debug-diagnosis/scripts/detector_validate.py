#!/usr/bin/env python3
"""Validate every Skill-local detector manifest and entrypoint."""

from detector_runner import load_manifests, public_manifest, write_result


if __name__ == "__main__":
    manifests = load_manifests()
    write_result({"valid": True, "detectors": [public_manifest(item) for item in manifests]}, None)

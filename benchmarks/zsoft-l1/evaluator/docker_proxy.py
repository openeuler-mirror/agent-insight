#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from assets import AssetError

REAL_DOCKER = "/usr/local/bin/docker"


def host_path(source: str, policy: dict) -> str:
    local = Path(source).resolve()
    if not any(local.is_relative_to(Path(root).resolve()) for root in policy["allowedRoots"]):
        raise AssetError("ZSOFT_BIND_PATH_FORBIDDEN")
    for mount in sorted(policy["mounts"], key=lambda item: len(item["Destination"]), reverse=True):
        destination = Path(mount["Destination"])
        if local.is_relative_to(destination):
            return str(Path(mount["Source"]) / local.relative_to(destination))
    raise AssetError("ZSOFT_SHARED_MOUNT_MISSING")


def constrained_compose(config: dict, policy: dict) -> dict:
    services = config.get("services", {})
    if not services or len(services) > 8:
        raise AssetError("ZSOFT_COMPOSE_INVALID")
    labels = {
        "agent-insight.evaluation-id": policy["evaluationId"],
        "agent-insight.benchmark-key": "zsoft-l1",
        "agent-insight.evaluator-key": "zsoft-l1",
        "agent-insight.evaluator-instance": policy["instanceId"],
        "agent-insight.role": "zsoft-task",
    }
    for service in services.values():
        image = service.get("image")
        if image not in policy["images"] or service.get("build"):
            raise AssetError("ZSOFT_IMAGE_NOT_PINNED")
        kvm = policy.get("track") == "kernel" and policy.get("kernelAcceleration") == "kvm"
        devices = service.get("devices", [])
        if devices and (not kvm or not isinstance(devices, list) or len(devices) != 1 or not isinstance(devices[0], dict)
                        or devices[0].get("source") != "/dev/kvm" or devices[0].get("target") != "/dev/kvm"
                        or devices[0].get("permissions", "rwm") not in ("rw", "rwm")):
            raise AssetError("ZSOFT_COMPOSE_PRIVILEGE_FORBIDDEN")
        if service.get("privileged") or service.get("pid") == "host" or service.get("ipc") == "host" or service.get("network_mode") == "host" or service.get("ports") or service.get("volumes_from") or service.get("use_api_socket"):
            raise AssetError("ZSOFT_COMPOSE_PRIVILEGE_FORBIDDEN")
        if policy.get("track") == "kernel":
            if set(services) != {"vuln", "fix"} or service.get("network_mode") != "none" or not service.get("read_only"):
                raise AssetError("ZSOFT_COMPOSE_INVALID")
            service.setdefault("environment", {})["KERNEL_ACCEL"] = policy["kernelAcceleration"]
            if kvm:
                service["devices"] = [{"source": "/dev/kvm", "target": "/dev/kvm", "permissions": "rw"}]
        service["image"] = policy["images"][image]
        service["pull_policy"] = "never"
        service.pop("container_name", None)
        service["labels"] = {**service.get("labels", {}), **labels}
        service["cpus"] = policy["cpu"] / len(services)
        service["mem_limit"] = policy["memoryMiB"] * 1024 * 1024 // len(services)
        service["pids_limit"] = 256
        service["logging"] = {"driver": "local", "options": {"max-size": "8m", "max-file": "2"}}
        service.pop("deploy", None)
        for volume in service.get("volumes", []):
            if not isinstance(volume, dict) or volume.get("type") != "bind":
                raise AssetError("ZSOFT_COMPOSE_VOLUME_FORBIDDEN")
            local_source = Path(volume["source"]).resolve()
            volume["source"] = host_path(volume["source"], policy)
            if local_source.is_relative_to(Path(policy["assetRoot"])):
                volume["read_only"] = True
            volume.setdefault("bind", {})["create_host_path"] = False
    for kind in ("secrets", "configs"):
        if config.get(kind):
            raise AssetError("ZSOFT_COMPOSE_VOLUME_FORBIDDEN")
    if config.get("volumes"):
        raise AssetError("ZSOFT_COMPOSE_VOLUME_FORBIDDEN")
    for name, network in config.get("networks", {}).items():
        if network.get("external"):
            raise AssetError("ZSOFT_EXTERNAL_NETWORK_FORBIDDEN")
        network["name"] = f"{policy['projectName']}_{name}"
        network["internal"] = True
        network["labels"] = {**network.get("labels", {}), **labels}
    config["name"] = policy["projectName"]
    return config


def main(args: list[str]) -> int:
    if not args or args[0] != "compose":
        raise AssetError("ZSOFT_DOCKER_COMMAND_FORBIDDEN")
    index = 1
    paired = {"--project-directory", "--env-file", "-f", "--file", "-p", "--project-name", "--profile"}
    while index < len(args) and args[index] in paired:
        index += 2
    if index >= len(args) or args[index] not in {"up", "run", "down"}:
        raise AssetError("ZSOFT_DOCKER_COMMAND_FORBIDDEN")
    policy = json.loads(Path(os.environ["ZSOFT_PROXY_POLICY"]).read_text())
    original = subprocess.run([REAL_DOCKER, *args[:index], "config", "--format", "json"], capture_output=True, text=True, timeout=30)
    if original.returncode or len(original.stdout) > 2 * 1024 * 1024:
        raise AssetError("ZSOFT_COMPOSE_CONFIG_FAILED")
    config = constrained_compose(json.loads(original.stdout), policy)
    filename = "compose-" + hashlib.sha256(original.stdout.encode()).hexdigest()[:20] + ".json"
    config_path = Path(policy["workDir"]) / filename
    config_path.write_text(json.dumps(config))
    return subprocess.call([REAL_DOCKER, "compose", "--project-directory", policy["assetRoot"], "-p", policy["projectName"], "-f", str(config_path), *args[index:]])


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as error:
        code = str(error)
        print(code if re.fullmatch(r"ZSOFT_[A-Z0-9_]+", code) else "ZSOFT_DOCKER_POLICY_FAILED", file=sys.stderr)
        sys.exit(1)

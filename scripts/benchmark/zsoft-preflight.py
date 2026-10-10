#!/usr/bin/env python3
"""Inspect ZSoft worker prerequisites without installing or downloading anything."""

import argparse
import datetime
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile


def command(argv, timeout=20):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except (OSError, subprocess.TimeoutExpired) as error:
        return -1, "", str(error)


def inspect(args):
    checks = []

    def add(key, status, detail):
        checks.append({"key": key, "status": status, "detail": detail})

    def required_command(name):
        found = shutil.which(name)
        add("command." + name, "pass" if found else "blocked", found or "not found")

    add("host", "pass" if platform.system() == "Linux" and platform.machine() in ("x86_64", "amd64") else "blocked",
        {"system": platform.system(), "arch": platform.machine(), "cpu_count": os.cpu_count()})
    add("python", "pass" if sys.version_info >= (3, 11) else "blocked", platform.python_version())
    for name in ("docker", "git", "curl", "tar"):
        required_command(name)
    code, out, err = command(["docker", "info", "--format", "{{.DockerRootDir}}"])
    add("docker.daemon", "pass" if code == 0 else "blocked", out if code == 0 else err[:600])
    docker_root = Path(out) if code == 0 else None
    code, out, err = command(["docker", "compose", "version"])
    add("docker.compose", "pass" if code == 0 else "blocked", out if code == 0 else err[:600])
    disk_paths = {str(Path(args.work_root).resolve())}
    if docker_root:
        disk_paths.add(str(docker_root))
    for raw in sorted(disk_paths):
        path = Path(raw)
        while not path.exists() and path != path.parent:
            path = path.parent
        usage = shutil.disk_usage(path)
        free_gib = usage.free / 1024 ** 3
        add("disk." + raw, "pass" if free_gib >= args.minimum_free_gib else "blocked",
            {"checked_path": str(path), "free_gib": round(free_gib, 2), "minimum_free_gib": args.minimum_free_gib,
             "note": "minimum smoke-test headroom; not a full-suite capacity guarantee"})
    memory = {}
    meminfo = Path("/proc/meminfo")
    if meminfo.exists():
        for line in meminfo.read_text().splitlines():
            key, value = line.split(":", 1)
            if key in ("MemTotal", "MemAvailable", "SwapTotal"):
                memory[key + "_gib"] = round(int(value.split()[0]) / 1024 ** 2, 2)
    add("memory", "pass" if memory.get("MemAvailable_gib", 0) >= 4 else "warn", memory)
    if args.profile in ("kernel", "all"):
        for name in ("gcc", "make", "patch", "rsync", "bc", "bison", "flex", "pahole", "pkg-config"):
            required_command(name)
        with tempfile.TemporaryDirectory(prefix="zsoft-preflight-") as temp:
            source = Path(temp) / "probe.c"
            source.write_text("#include <libelf.h>\n#include <openssl/crypto.h>\nint main(void) { return elf_version(EV_CURRENT) == EV_NONE || OPENSSL_init_crypto(0, 0) == 0; }\n")
            code, _, err = command(["gcc", str(source), "-lelf", "-lcrypto", "-o", str(Path(temp) / "probe")])
            add("kernel.devlibs", "pass" if code == 0 else "blocked", "libelf/OpenSSL compile-link succeeded" if code == 0 else err[:800])
        add("kernel.acceleration", "pass" if Path("/dev/kvm").exists() else "warn",
            "KVM device exists; guest use still requires validation" if Path("/dev/kvm").exists() else "no /dev/kvm; TCG fallback requires real timeout validation")
        add("kernel.qemu.location", "info", "QEMU and BusyBox belong to the task runner image; host binaries are not required")
    mcts = Path(args.mcts_root)
    code, out, err = command(["git", "-C", str(mcts), "rev-parse", "HEAD"])
    add("mcts.checkout", "pass" if code == 0 else "blocked", out if code == 0 else err[:600])
    for relative in ("testcases_union/run_union.sh", "testcases_union/config.env", "testcases_union/res/task_plugins/zsoft/plugin.py", ".venv/bin/python"):
        add("mcts.file." + relative, "pass" if (mcts / relative).is_file() else "blocked", str(mcts / relative))
    if (mcts / ".venv/bin/python").is_file():
        code, out, err = command([str(mcts / ".venv/bin/python"), "--version"])
        add("mcts.python", "pass" if code == 0 else "blocked", out or err[:600])
    bench = Path(args.bench_root) if args.bench_root else None
    if bench is None or not (bench / "tasks").is_dir():
        add("zsoft.tasks", "blocked", "provide --bench-root containing tasks/, src/ and source-locks/")
    else:
        tasks = sorted(p for p in (bench / "tasks").glob("*/task.json") if not p.parent.name.startswith("sample-"))
        add("zsoft.tasks", "pass" if len(tasks) == 30 else "blocked", {"root": str(bench), "formal_count": len(tasks)})
        add("zsoft.cache", "pass" if (bench / ".cache/sources").is_dir() else "warn", "source cache exists; locks require strict validation" if (bench / ".cache/sources").is_dir() else "locked sources not fetched")
    binary = args.zsoft_bin or shutil.which("zsoft-poc")
    add("zsoft.cli", "pass" if binary else "blocked", binary or "zsoft-poc not on PATH; use a dedicated environment")
    if binary:
        code, _, err = command([binary, "--help"])
        add("zsoft.cli_usable", "pass" if code == 0 else "blocked", "CLI imports and starts" if code == 0 else err[:800])
    if args.run_container_smoke:
        code, image_id, err = command(["docker", "image", "inspect", "busybox:latest", "--format", "{{.Id}}"])
        if code == 0:
            code, _, err = command(["docker", "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", image_id, "true"])
            add("docker.container_smoke", "pass" if code == 0 else "blocked", "existing image executed successfully" if code == 0 else err[:600])
        else:
            add("docker.container_smoke", "warn", "BusyBox image absent; no image was downloaded")
    blockers = [item["key"] for item in checks if item["status"] == "blocked"]
    return {"schema_version": 1, "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "profile": args.profile, "ready_for_p1": not blockers, "blockers": blockers, "checks": checks,
            "validation_limits": "Prerequisite inspection only. No ZSoft prepare, reference/negative verdict, model call or E2B session was executed."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mcts-root", required=True)
    parser.add_argument("--work-root", required=True)
    parser.add_argument("--bench-root")
    parser.add_argument("--zsoft-bin")
    parser.add_argument("--profile", choices=("userspace", "kernel", "all"), default="all")
    parser.add_argument("--minimum-free-gib", type=float, default=20)
    parser.add_argument("--run-container-smoke", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.minimum_free_gib <= 0:
        parser.error("--minimum-free-gib must be positive")
    result = inspect(args)
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text)
    print(text, end="")
    return 0 if result["ready_for_p1"] else 2


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env bash
# Smoke: bun:ffi → ras_embed.call without LD_PRELOAD (RTLD_GLOBAL in bridge).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="${RAS_LIBPYTHON:-/home/iceory/miniconda3/lib/libpython3.13.so}"
# Explicitly clear preload to prove bridge does not need it.
unset LD_PRELOAD || true
export PYTHONHOME="${PYTHONHOME:-/home/iceory/miniconda3}"
export PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"
export AGENT_RAS_ROOT="$ROOT"
export RAS_LIBPYTHON="$LIB"
export AGENT_INSIGHT_RAS_HOME="${AGENT_INSIGHT_RAS_HOME:-$HOME/.agent-insight/ras}"

cd "$ROOT"
exec bun -e '
import { embedReady, embedCall } from "./platform_adapter/common/python_bridge.js";
const svc = {
  libpython: process.env.RAS_LIBPYTHON,
  python_home: process.env.PYTHONHOME,
  repo_root: process.env.AGENT_RAS_ROOT,
};
if (process.env.LD_PRELOAD) {
  console.error("unexpected LD_PRELOAD", process.env.LD_PRELOAD);
  process.exit(3);
}
if (!embedReady(svc)) {
  console.error("embedReady failed");
  process.exit(1);
}
const h = embedCall("health", "", {});
console.log("health", h);
const hello = embedCall("hello", "opencode:smoke", { platform: "opencode", config: { detection_start_chars: 50 } });
console.log("hello", hello?.type, hello?.session_id);
const obs = embedCall("observe", "opencode:smoke", {
  kind: "assistant_text",
  channel: "llm_reasoning",
  mode: "snapshot",
  text: "x".repeat(20),
  platform: "opencode",
});
console.log("observe", obs?.session_id, "actions", obs?.actions?.length ?? 0);
if (!h?.status || h.status !== "ok") process.exit(2);
console.log("SMOKE_OK");
'

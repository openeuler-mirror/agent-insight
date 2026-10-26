#!/usr/bin/env bash
# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Smoke: bun:ffi → ras_runtime.call without LD_PRELOAD (RTLD_GLOBAL in bridge).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -z "${RAS_LIBPYTHON:-}" ]]; then
  echo "RAS_LIBPYTHON is required (path to shared libpython, e.g. libpython3.X.so)" >&2
  echo "Also set PYTHONHOME to the Python prefix if needed." >&2
  exit 1
fi
if [[ -z "${PYTHONHOME:-}" ]]; then
  echo "PYTHONHOME is required (Python prefix directory)" >&2
  exit 1
fi

LIB="$RAS_LIBPYTHON"
# Explicitly clear preload to prove bridge does not need it.
unset LD_PRELOAD || true
export PYTHONHOME
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

#!/usr/bin/env python3
# coding: utf-8
"""E2E harness for the pi platform adapter (PRD §9).

Runs the real TypeScript extension under `node --experimental-strip-types`
against a test-only bridge emulator (no koffi / no live pi binary needed),
plus in-process ras_runtime checks for the pi platform contract.

Coverage:
  - lifecycle: /new /resume /fork replay (shutdown+start) resets state
  - two concurrent sessions stay isolated
  - D-003: observations continue inside the abort window
  - wire contract: hello lazily, observe snapshot/tool payloads,
    abort/notice delivery + action_result reporting
  - Insight visibility: ras_runtime hello echoes platform=pi

Optional latency probe (needs installed pi extension with koffi):
  AGENT_INSIGHT_PI_EXTENSIONS_DIR=~/.pi/agent/extensions

Run: PYTHONPATH=. python scripts/e2e_pi_harness.py
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PI_DIR = REPO_ROOT / "platform_adapter" / "pi"
COMMON_DIR = REPO_ROOT / "platform_adapter" / "common"

SUPPORT_FILES = [
    "host_control.ts",
    "ras_client.ts",
    "config_sync.ts",
    "runtime_root.ts",
]

FAKE_BRIDGE_TS = '''\
// Test-only bridge emulator (same interface as koffi_bridge.ts).
// Emulates the SessionHub wire contract deterministically.
import { appendFileSync } from "node:fs"

export const log: any[] = []
let seq = 0
const state = {
  hello: new Set<string>(),
  tools: new Map<string, number>(),
  aborts: new Set<string>(),
  texts: new Map<string, number>(),
}

function record(op: string, sessionId: string, payload: any) {
  log.push({ seq: seq++, op, sessionId, payload })
  const path = process.env.RAS_E2E_LOG
  if (path) {
    try {
      const summary = payload && payload.kind === "assistant_text"
        ? { kind: payload.kind, channel: payload.channel, len: (payload.text || "").length }
        : payload && payload.kind === "tool"
          ? { kind: "tool", name: payload.tool?.name, isError: Boolean(payload.tool?.error) }
          : {}
      appendFileSync(path, `${JSON.stringify({ seq, op, sessionId, ...summary })}\\n`)
    } catch {}
  }
}

export function embedReady(): boolean {
  return true
}

export function embedInitError(): string | null {
  return null
}

export function embedCall(op: string, sessionId: string, payload: any) {
  record(op, sessionId, payload)
  if (op === "hello") {
    state.hello.add(sessionId)
    return {
      protocol_version: "e2e",
      type: "welcome",
      session_id: sessionId,
      platform: payload?.platform,
      locale: "en",
      host_messages: [],
    }
  }
  if (op === "observe") {
    if (payload?.kind === "tool") {
      const key = `${sessionId}|${payload.tool?.name}|${JSON.stringify(payload.tool?.args || {})}`
      const n = (state.tools.get(key) || 0) + 1
      state.tools.set(key, n)
      if (n >= 8 && !state.aborts.has(sessionId)) {
        state.aborts.add(sessionId)
        return {
          session_id: sessionId,
          actions: [
            { type: "abort_stream", ok: true, channel: "e2e.repeat_tool" },
          ],
          anomaly: {
            id: "anomaly.repeat_tool",
            severity: "critical",
            trace_anchor: payload.trace_anchor,
          },
        }
      }
      return { session_id: sessionId, actions: [] }
    }
    if (payload?.kind === "assistant_text") {
      const n = (state.texts.get(sessionId) || 0) + 1
      state.texts.set(sessionId, n)
      if (n >= 3) {
        return {
          session_id: sessionId,
          actions: [
            {
              type: "emit_notice",
              ok: true,
              message: "检测到文本循环，请注意",
              channel: "e2e.notice",
            },
          ],
          anomaly: {
            id: "anomaly.text_loop",
            severity: "warning",
            trace_anchor: payload.trace_anchor,
          },
        }
      }
    }
    return { session_id: sessionId, actions: [] }
  }
  if (op === "action_result") return { ok: true }
  return { ok: true }
}

export const snapshot = () => JSON.parse(JSON.stringify(log))
'''

DRIVER_TS = '''\
// Drives the real pi extension against the emulator bridge.
import entry from "./extension.ts"
import { snapshot } from "./bridge/koffi_bridge.ts"

const handlers: Record<string, any> = {}
const piCalls = { abort: 0, notify: [] as any[], send: [] as any[] }
const pi = {
  on: (event: string, handler: any) => {
    handlers[event] = handler
  },
  sendUserMessage: (message: string, options?: any) => {
    piCalls.send.push([message, options])
  },
}

await entry(pi)

let currentSessionId = "s1"
const mkCtx = () => ({
  sessionManager: { getSessionId: () => currentSessionId },
  hasUI: true,
  isIdle: () => false,
  abort: () => {
    piCalls.abort += 1
  },
  ui: {
    notify: (message: string, level?: string) => {
      piCalls.notify.push([message, level])
    },
  },
})

const emit = (event: string, payload: any) => {
  const handler = handlers[event]
  if (handler) handler(payload, mkCtx())
}

async function drain() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
}

const results: Record<string, any> = {}

// 1. startup + lazy hello
emit("session_start", { reason: "startup" })

// 2. repeat tool -> abort_stream delivered through host_control
for (let i = 0; i < 10; i++) {
  emit("tool_execution_end", {
    toolCallId: `t${i}`,
    toolName: "bash",
    args: { cmd: "echo hi" },
    result: "hi",
    isError: false,
  })
}
await drain()
results.abortDelivered = piCalls.abort >= 1

// 3. D-003: observations continue after the abort wire
const logAfterAbort = snapshot().length
const chunk = "x".repeat(40)
emit("message_update", {
  message: { role: "assistant", id: "m1" },
  assistantMessageEvent: { type: "text_delta", delta: chunk },
})
emit("message_update", {
  message: { role: "assistant", id: "m1" },
  assistantMessageEvent: { type: "text_delta", delta: chunk },
})
await drain()
emit("message_update", {
  message: { role: "assistant", id: "m1" },
  assistantMessageEvent: { type: "text_delta", delta: chunk },
})
await drain()
const log = snapshot()
const observesAfterAbort = log
  .slice(logAfterAbort)
  .filter((e: any) => e.op === "observe")
results.abortKeepObserving = observesAfterAbort.length >= 2

// 4. snapshot semantics: last text observe carries the accumulated buffer
const textObserves = log.filter(
  (e: any) => e.op === "observe" && e.payload?.kind === "assistant_text"
    && e.payload?.channel === "llm_output",
)
results.textObserved = textObserves.length >= 2
results.snapshotAccumulated =
  textObserves.length > 0
  && textObserves[textObserves.length - 1].payload.text.length >= 120
  && textObserves[textObserves.length - 1].payload.mode === "snapshot"
results.traceAnchorOk =
  textObserves.length > 0
  && textObserves[textObserves.length - 1].payload.trace_anchor?.message_id === "m1"

// 5. thinking deltas produce llm_reasoning observes
const thinkChunk = "思考内容。".repeat(16)
emit("message_update", {
  message: { role: "assistant", id: "m1" },
  assistantMessageEvent: { type: "thinking_delta", delta: thinkChunk },
})
emit("message_update", {
  message: { role: "assistant", id: "m1" },
  assistantMessageEvent: { type: "thinking_delta", delta: thinkChunk },
})
await drain()
const thinkObserves = snapshot().filter(
  (e: any) => e.op === "observe" && e.payload?.channel === "llm_reasoning",
)
results.thinkingObserved = thinkObserves.length >= 1

// 6. role filter: user-role message_update must not observe
const beforeUser = snapshot().filter((e: any) => e.op === "observe").length
emit("message_update", {
  message: { role: "user", id: "u1" },
  assistantMessageEvent: { type: "text_delta", delta: chunk },
})
emit("message_update", {
  message: { role: "user", id: "u1" },
  assistantMessageEvent: { type: "text_delta", delta: "y".repeat(500) },
})
await drain()
const afterUser = snapshot().filter((e: any) => e.op === "observe").length
results.userRoleFiltered = beforeUser === afterUser

// 7. notice wire delivered via ctx.ui.notify
results.noticeDelivered = piCalls.notify.length >= 1

// 8. action_result reported back for the abort wire
results.actionResultReported = snapshot().some(
  (e: any) =>
    e.op === "action_result"
    && e.payload?.action === "abort_stream"
    && e.payload?.ok === true,
)

// 9. turn boundary resets accumulators: fresh short text re-observes
const preBoundary = snapshot().length
emit("turn_end", { turnIndex: 0 })
emit("message_update", {
  message: { role: "assistant", id: "m2" },
  assistantMessageEvent: { type: "text_delta", delta: "z".repeat(80) },
})
await drain()
const boundaryObserves = snapshot()
  .slice(preBoundary)
  .filter((e: any) => e.op === "observe")
results.turnBoundaryReset =
  boundaryObserves.length === 1
  && boundaryObserves[0].payload.text === "z".repeat(80)

// 10. lifecycle replay: shutdown -> start re-greets the same session
emit("session_shutdown", { reason: "new" })
await drain()
results.byeSeen = snapshot().some(
  (e: any) => e.op === "bye" && e.sessionId === "pi:s1",
)
emit("session_start", { reason: "new" })
const hellosBefore = snapshot().filter(
  (e: any) => e.op === "hello" && e.sessionId === "pi:s1",
).length
emit("message_update", {
  message: { role: "assistant", id: "m3" },
  assistantMessageEvent: { type: "text_delta", delta: chunk.repeat(2) },
})
await drain()
const hellosAfter = snapshot().filter(
  (e: any) => e.op === "hello" && e.sessionId === "pi:s1",
).length
results.replayRegreets = hellosBefore === 1 && hellosAfter === 2
results.helloPayloadOk = snapshot().some(
  (e: any) => e.op === "hello" && e.payload?.platform === "pi"
    && typeof e.payload?.config === "object",
)

// 11. concurrent session isolation
currentSessionId = "s2"
emit("session_start", { reason: "resume" })
for (let i = 0; i < 10; i++) {
  emit("tool_execution_end", {
    toolCallId: `u${i}`,
    toolName: "bash",
    args: { cmd: "echo hi" },
    result: "hi",
    isError: false,
  })
}
await drain()
results.isolatedSessions = piCalls.abort === 2
const s2ErrorTool = (() => {
  currentSessionId = "s3"
  emit("session_start", { reason: "fork" })
  emit("tool_execution_end", {
    toolCallId: "e1",
    toolName: "bash",
    args: { cmd: "false" },
    result: "command failed",
    isError: true,
  })
  return drain().then(() =>
    snapshot().some(
      (e: any) =>
        e.sessionId === "pi:s3" && e.payload?.tool?.error === "command failed",
    ),
  )
})()
results.toolErrorSemantics = await s2ErrorTool

// 12. steering delivery is covered by test_pi_host_control.mjs (needs
// controlled isIdle/streaming fakes, not reachable from real wires here).
results.helloPerSid = [...new Set(snapshot().map((e: any) => e.sessionId))]

const outPath = process.env.RAS_E2E_OUT
if (outPath) {
  const { writeFileSync } = await import("node:fs")
  writeFileSync(outPath, JSON.stringify(results, null, 2))
}
console.log(JSON.stringify(results, null, 2))
'''


def build_driver_dir(tmp: Path) -> Path:
    driver_dir = tmp / "driver"
    (driver_dir / "bridge").mkdir(parents=True)
    for name in SUPPORT_FILES:
        shutil.copyfile(PI_DIR / name, driver_dir / name)
    shutil.copyfile(COMMON_DIR / "host_actions.js", driver_dir / "host_actions.js")
    entry = (PI_DIR / "extension.ts").read_text(encoding="utf-8")
    entry = entry.replace('"../common/host_actions.js"', '"./host_actions.js"')
    (driver_dir / "extension.ts").write_text(entry, encoding="utf-8")
    (driver_dir / "bridge" / "koffi_bridge.ts").write_text(FAKE_BRIDGE_TS, encoding="utf-8")
    (driver_dir / "driver.ts").write_text(DRIVER_TS, encoding="utf-8")
    return driver_dir


def run_node_driver(tmp: Path) -> dict:
    driver_dir = build_driver_dir(tmp)
    ras_home = tmp / "ras-home"
    (ras_home / "calls").mkdir(parents=True)
    config = {
        "agent_ras": {
            "enabled": True,
            "detectors": {
                "llm_thinking_loop": {
                    "detection_start_chars": 1,
                    "window_max_chars": 200,
                    "loop_repeat_threshold": 3,
                    "semantic_content_enabled": False,
                },
            },
            "recovery": {"notify_user_on_warning": True},
        }
    }
    (ras_home / "config.json").write_text(json.dumps(config), encoding="utf-8")

    env = dict(os.environ)
    env.update(
        {
            "AGENT_INSIGHT_RAS_HOME": str(ras_home),
            "RAS_E2E_LOG": str(tmp / "bridge-log.jsonl"),
            "RAS_E2E_OUT": str(tmp / "results.json"),
        }
    )
    proc = subprocess.run(
        [os.environ.get("RAS_NODE", "node"), "--experimental-strip-types", "driver.ts"],
        cwd=driver_dir,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        print(proc.stdout, file=sys.stderr)
        print(proc.stderr, file=sys.stderr)
        raise AssertionError(f"node driver exited {proc.returncode}")
    out_path = tmp / "results.json"
    if not out_path.exists():
        raise AssertionError(f"driver wrote no results: {proc.stdout} {proc.stderr}")
    return json.loads(out_path.read_text(encoding="utf-8"))


def check_core_pi_contract() -> None:
    """In-process ras_runtime checks for the pi platform (Insight visibility)."""
    from ras_runtime import call, reset_runtime_for_tests

    reset_runtime_for_tests()
    sid = "pi:e2e_py_core"
    welcome = call("hello", sid, json.dumps({"platform": "pi", "config": {}}))
    data = json.loads(welcome)
    assert data.get("type") == "welcome", data
    assert data.get("platform") == "pi", data
    assert data.get("session_id") == sid, data
    health = json.loads(call("health", sid, "{}"))
    assert health.get("status") == "ok", health
    bye = json.loads(call("bye", sid, "{}"))
    assert bye.get("ok") is True, bye
    # join-key convention: Insight taskId = sessionId minus first ':' prefix
    assert sid.split(":", 1)[1] == "e2e_py_core"


def optional_latency_probe() -> str:
    ext_dir = os.environ.get("AGENT_INSIGHT_PI_EXTENSIONS_DIR")
    if not ext_dir or not Path(ext_dir, "node_modules", "koffi").exists():
        return "SKIP (set AGENT_INSIGHT_PI_EXTENSIONS_DIR with installed koffi)"
    script = (
        "const m = await import(process.argv[1] + '/bridge/koffi_bridge.ts');"
        "if (!m.embedReady()) { console.log('SKIP (embed not ready)'); process.exit(0); }"
        "const t = [];"
        "for (let i = 0; i < 20; i++) {"
        "  const s = performance.now(); m.embedCall('health', 'pi:latency', {});"
        "  t.push(performance.now() - s);"
        "}"
        "t.sort((a, b) => a - b);"
        "console.log(JSON.stringify({ p50: t[9], p95: t[18] }));"
    )
    proc = subprocess.run(
        ["node", "--experimental-strip-types", "-e", script, ext_dir],
        capture_output=True,
        text=True,
        timeout=120,
    )
    return (proc.stdout or proc.stderr).strip() or "SKIP (probe failed)"


def main() -> int:
    results = run_node_driver(Path(tempfile.mkdtemp(prefix="ras-pi-e2e-")))
    expected_true = [
        "abortDelivered",
        "abortKeepObserving",
        "textObserved",
        "snapshotAccumulated",
        "traceAnchorOk",
        "thinkingObserved",
        "userRoleFiltered",
        "noticeDelivered",
        "actionResultReported",
        "turnBoundaryReset",
        "byeSeen",
        "replayRegreets",
        "helloPayloadOk",
        "isolatedSessions",
        "toolErrorSemantics",
    ]
    failed = [key for key in expected_true if results.get(key) is not True]
    if failed:
        print("FAIL:", failed, json.dumps(results, ensure_ascii=False, indent=2))
        return 1

    check_core_pi_contract()
    latency = optional_latency_probe()

    print("OK: pi e2e harness —", len(expected_true), "checks passed")
    print("latency probe:", latency)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

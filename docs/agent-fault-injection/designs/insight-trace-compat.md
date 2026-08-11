# Agent Insight Trace Compatibility

> **Insight 拓扑说明**：编排与 Judge 在 agent-insight 服务端；本机 FI Worker + [`agent_fault_injection/`](../../../agent_fault_injection/) 负责注入与采集。 独立 FastAPI/Vite 不纳入产品路径。见 [server-client-split.md](server-client-split.md) · [ras-fi-insight-relationship.md](ras-fi-insight-relationship.md)。


This document is the join contract for `agent-fault-injection` artifacts with
[agent-insight](https://gitcode.com/openeuler/agent-insight) Trace IDs and
`Session.interactions` / `RawInteraction` (⓪). FI collect **does not** rebuild or
overwrite the Session dialogue tree.

## Primary artifact

| File | Role |
|------|------|
| `interactions.json` | Markers + Trace ID (`taskId`); `interactions` is always `[]` |
| `trajectory.jsonl` | Eval-side event log (run/fault/phase). Not the Session merge format |
| `manifest.json` | Run status + insight-aligned identifiers |

## Trace API shape

`GET /api/runs/{run_id}/trace` returns an observe-session subset:

```json
{
  "taskId": "<platform session id when aligned; null when unaligned>",
  "sessionAligned": true,
  "framework": "opencode",
  "runId": "ras-...",
  "interactions": [ /* RawInteraction[] */ ],
  "markers": [ /* optional eval / fault markers */ ]
}
```

`taskId` is the **Trace ID** (bare platform session: OpenCode `ses_…`, xiaoo gateway UUID). Product UI labels this **Trace ID**; Prisma column `FaultInjectionRun.sessionTaskId` stores the same value when aligned. The same session id may appear on both FI Run and reliability pages when real RAS events exist, but **FI markers and RAS events are different sources** — FI UI must not re-label FI as RAS, and FI collect must not synthesize `RasAnomalyEvent`.

`runId` identifies the FI experiment only. **Do not** silently fall back to `runId` as `taskId` — that breaks reliability join. When the platform session cannot be resolved, set `sessionAligned: false` and leave `taskId` null.

`raw/session.json` is **not** part of the Trace ID contract. OpenCode FI does not write it; Trace ID comes only from platform capture / `interactions.json.taskId`.

## `RawInteraction` subset (V1)

Field names match
`agent-insight/src/lib/engine/observability/agent-trace.ts`.

```ts
{
  messageID?: string
  role: "user" | "assistant" | "opencode" | "subagent" | "system" | string
  content?: string
  timestamp?: number | string
  timeInfo?: { created?: number | string; completed?: number | string }
  agent?: string
  modelID?: string
  providerID?: string
  parts?: Array<{
    type: string
    id?: string
    text?: string
    tool?: string
    callID?: string
    state?: { status?: string; input?: unknown; output?: unknown }
  }>
  tool_calls?: Array<{
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
    state?: string
    output?: unknown
  }>
  usage?: {
    input?: number
    output?: number
    reasoning?: number
    total?: number
    cache?: { read?: number; write?: number }
  }
}
```

## Markers (non-interaction)

Markers annotate the timeline without mutating interaction semantics:

```ts
{
  id: string
  kind: "fault_activation" | "evaluation" | string
  label: string
  timestamp?: number | string
  severity?: "critical" | "warning" | "info"
  payload?: object
}
```

## Manifest identifiers for join

```json
{
  "schema_version": "1",
  "framework": "opencode",
  "taskId": "<session_id>",
  "interactions": "interactions.json"
}
```

`interactions.json.taskId` joins `FaultInjectionRun.sessionTaskId` → Prisma `Session`
(⓪). Collect ingress must **not** upsert `Session.interactions` from this file;
Judge / Run UI load the dialogue tree from Session when present.

# Agent Insight Trace Compatibility

> **Insight 拓扑说明**：编排与 Judge 在 agent-insight 服务端；本机 FI Worker + [`agent_fault_injection/`](../../../agent_fault_injection/) 负责注入与采集。 独立 FastAPI/Vite 不纳入产品路径。见 [server-client-split.md](server-client-split.md) · [ras-fi-insight-relationship.md](ras-fi-insight-relationship.md)。


This document is the merge contract for `agent-fault-injection` artifacts that must
align with [agent-insight](https://gitcode.com/openeuler/agent-insight)
`Session.interactions` / `RawInteraction`.

## Primary artifact

| File | Role |
|------|------|
| `interactions.json` | **Canonical** insight-compatible interaction list |
| `trajectory.jsonl` | Eval-side event log (run/fault/phase). Not the merge format |
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

`taskId` is the **Trace ID** / FI↔reliability join key (bare platform session: OpenCode `ses_…`, xiaoo gateway UUID). It must match `RasAnomalyEvent.taskId` / `Execution.taskId` / OTel `session.id`. Product UI labels this **Trace ID**; Prisma column `FaultInjectionRun.sessionTaskId` stores the same value.

`runId` identifies the FI experiment only. **Do not** silently fall back to `runId` as `taskId` — that breaks reliability join. When the platform session cannot be resolved, set `sessionAligned: false` and leave `taskId` null.

`raw/session.json` (when present) is an **OpenCode plugin session snapshot** used to rebuild interactions. It is an internal capture artifact, **not** a public association key and must not be introduced as a separate “session id file” join contract. Trace ID resolution prefers platform capture / `interactions.json.taskId`, then falls back to the snapshot’s `session_id` if needed.

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

## Manifest identifiers for future ingest

```json
{
  "schema_version": "1",
  "framework": "opencode",
  "taskId": "<session_id>",
  "interactions": "interactions.json"
}
```

When merged into agent-insight, `interactions.json` should be storable as
`Session.interactions` and renderable by `AgentTraceView` without a second
adapter.

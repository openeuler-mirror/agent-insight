---
title: "Execution-environment preparation API"
description: "Preparation tasks, idempotent context, and readiness checks."
keywords: ["Agent Insight", "execution environments", "environment preparation", "idempotency"]
changefreq: "monthly"
---

See [HTTP identity conventions](../platform/http-api.md) for platform user resolution. Preparing an environment does not create or start an experiment.

## Endpoints and inputs

| Endpoint or contract | Input and output |
| --- | --- |
| `POST /api/experiments/environment-preparations` | Ordinary preparation accepts `requestId/datasetId/clientId/platform/agent/model/caseIds/mode/timeoutSeconds/concurrency` and optional `agentOptions`; returns `202` and a task |
| Same-configuration preparation | Send only `requestId/sourceExperimentId`; do not combine it with target overrides. The server restores frozen settings and Case selection |
| `GET /api/experiments/environment-preparations/:taskId` | Queries the current user's task while client ownership remains valid |
| Task response | `{ taskId, contextDigest, state, message, issues, durationHint? }` |
| `execution-environment/v1` | Strict context and digest validation in `packages/benchmark-protocol/environment.cjs` and `.d.cts` |
| Executor integration | `checkEnvironment(context, services)` returns `{ issues, prepare }`; `prepareEnvironment(context, services, reportProgress)` performs preparation, followed by another check |

The POST returns `401` without user identity and `413` when the declared content length exceeds 256 KiB. An ordinary `requestId` uses `8`–`100` letters, digits, underscores, or hyphens. `mode` is `generate/skill-ab/trigger`; `timeoutSeconds` is an integer `30`–`3600`; `concurrency` is an integer `1`–`1024`; `caseIds` contains at most 500 items. `datasetId` can be null, but a dataset is required except for `skill-ab`. The schema is strict and does not silently ignore unknown fields.

## State and reuse

Task states are `checking/preparing/needs_action/ready/failed`. Only `ready` passes the readiness gate. A command marked `SUCCEEDED` can still produce `needs_action`; command completion is not equivalent to environment readiness.

For reuse, the server checks ownership and restores Benchmark bindings and Case choices, ordinary/reliability dataset bindings for active Cases, or Skill snapshots and cancellation records. Older records without trustworthy bindings require wizard confirmation rather than guessed targets or a complete capability scan. Existing-Trace/LLM-only reuse can return `{ state: "skipped" }` without creating a task. Client-executed Skill A/B does not skip. `skipped` is a no-task POST response, not an executor protocol state.

Generate `requestId` through the existing `safeUUID()` path, including browsers without `crypto.randomUUID()` over LAN HTTP. Reuse the ID when transport outcome is uncertain; after a definitively finished task, a new attempt uses a new ID. A successful wizard check refreshes and revalidates the original host and Agent before moving to the next step. It does not reload or navigate the page. Host polling pauses during the gate, stale responses cannot override newer ones, and page reload resets in-memory wizard steps; checking the same configuration can restore its task.

The design step and every generate-Trace step refresh execution targets every 10 seconds and on window focus, including ordinary and Skill experiments. Recovered capabilities can appear without reloading the wizard. Refresh remains paused during environment checks and preparation, and the original target is revalidated before advancing.

JiuwenSwarm probing and execution support Node.js 20 without experimental WebSocket flags, using the bundled connection implementation when a global WebSocket is unavailable. The JiuwenSwarm client reads configured model names through Gateway WebSocket `/ws` `models.list`, then reports ordinary `RUN_EXPERIMENT_CASE` capability for `jiuwenswarm/main_agent` and those model choices. The client uses `ws://127.0.0.1:19000/ws` by default; `AGENT_INSIGHT_JIUWEN_WS_URL` overrides it in the client service environment. Each Case creates a new session and sends the original input. When a specific model is selected, the client checks the catalog again and sends it as `chat.send.model_name`. The receipt carries the session ID; the server resolves one Trace ID through the Jiuwen OTLP spool session index and binds the Case after the matching Execution is ingested. Missing, ambiguous, or late Traces are never bound by guessing from input. Skill snapshots, Benchmarks, and fault injection are outside this capability.

JiuwenSwarm readiness uses the same Gateway model catalog probe for both capability reporting and environment preparation. `agent-runtime/jiuwenswarm/v1` is ready when the catalog can be read. Ordinary experiment preparation does not require a same-named CLI on the client host and rejects agents other than `main_agent` or models absent from the catalog. Catalog checks do not verify model credentials or inference access.

## OpenCode and capabilities

Model discovery follows the client's OpenCode version. V1 combines JSON model definitions with the CLI catalog and resolves its authentication file under `XDG_DATA_HOME`. V2 reports enabled `providerID/id` entries from `api --standalone model.list` and marks the default returned by `model.default`. The native API resolves JSON configuration and `/connect` credentials.

OpenCode checks share version-aware logic. v1 retains `debug config`, authentication-source, and `models` checks. v2 uses `api --standalone model.list`, or `model.default` when no model was selected, and checks native `providerID/id` and `enabled`. It does not reuse v1 authentication-file parsing or infer availability from v2 config-source arrays. These checks do not perform model inference.

Errors distinguish `MODEL_CONFIGURATION_UNREADABLE`, `MODEL_UNAVAILABLE`, and `MODEL_CONFIGURATION_MISSING`. CLI output stays in temporary mode-`0600` files and is not returned as raw configuration or provider errors. Ready v1/v2 profiles report `skillSnapshotVersion: 4`. Skill generation and A/B require `supportsSkillSnapshot`; trigger analysis additionally requires `supportsTriggerRouting`. Missing fields prompt checking the resident client and reported capabilities, rather than assuming the OpenCode binary alone is too old.

## Dispatch and recovery

Preparation reuses `ReliabilityCommand` with the allowlisted `PREPARE_EXECUTION_ENVIRONMENT` action. Its deadline is 45 minutes; delivery ACK deadlines and other actions retain their own rules. Requests and receipts do not contain model secrets, arbitrary script paths, or Shell commands. `agentOptions` supplies execution context rather than installation commands.

Checks and recovery avoid a full capability scan. The executor merges verified platform/component/Profile facts through `PUT /api/reliability/client/v1/capabilities` with `partial: true`, retaining other Agents, models, and components. Changed Profile digests invalidate unchecked Runtime readiness. Reliability dataset Worker heartbeats similarly merge selected-platform inventory using `partial: true`. Incremental synchronization must succeed before `ready` is returned.

HTTP confirmation handles terminal environment state. Unconfirmed results recover from the environment task record instead of replaying stale `ready` via a generic receipt queue. Recovery checks the original context read-only; expired or missing context requires another check. Conditional receipt updates prevent late ACK/progress from overwriting terminal state, and readiness queries recheck dataset identity and host health.

Implementation: [preparation logic](https://gitcode.com/openeuler/agent-insight/blob/master/src/lib/engine/experiment/environment-preparation.ts).

### OpenCode generation and optimization completion

The engine anchors completion to the current root user message. Metadata updates to that same message ID, including summary or diff updates arriving after idle, preserve completion state; a different user message still invalidates the old completion candidate. Completion still requires a persisted final assistant reply and finished tools. Partial output cannot pass, and cancellation and model errors retain priority.

[中文权威版本](../../../zh/reference/evaluation/execution-environment.md)

### JiuwenSwarm Enterprise: local credentials and Agent selection

Before running the installation command, create `$AGENT_INSIGHT_HOME/client/jiuwen-enterprise.json` on the client host (default `~/.agent-insight/client/jiuwen-enterprise.json`):

```json
{"baseUrl":"https://jiuwen.example.com","username":"experiment-user","password":"replace-with-your-password"}
```

Use an editor, `umask 077`, and file mode `600` on Unix; keep the file in a persistent user volume. Do not place passwords in URLs or command arguments. Optional `AGENT_INSIGHT_JIUWEN_ENTERPRISE_CONFIG` selects another local file; both installer and resident service must see it. HTTPS is required except for loopback testing. The file belongs in the actual AgentServer client environment, not the Agent Insight server.

Configure enterprise Agents/models and grant the account access, then run the current Agent Insight account's curl installation command with JiuwenSwarm selected. Installation logs in and discovers authorized Agents and their own model catalogs. Restart AgentServer to load a newly installed Trace extension, and confirm that the resident client is online. In an ordinary experiment choose the Agent, client, model, dataset and evaluator, complete the environment check, then inspect the Case Trace and score. Agent labels include instance/group; stable identities distinguish duplicate names. No manual bot/user/group IDs or Gateway URL are needed, and browser selection does not control dispatch.

The client logs in through `/idp/v1/auth/token`, reads `/api/v1/user-console/agent-contexts`, and authenticates to the manager's `/ws` proxy with the instance cookie. Dispatch retains #588 WebSocket `session.create` / `chat.send`; no HTTP/SSE task adapter is used. Tokens stay in client memory, refresh before expiry, and are reacquired after restart. Permissions and models are checked again before each execution. Authentication, permission, network and empty-model errors stop execution without choosing another Agent. Native session IDs correlate uploaded Traces. Credentials are never uploaded to Agent Insight.

Ordinary experiments only: this does not add Skill snapshot isolation, Benchmark, FI, or interactive SSO/MFA support. Install private CAs as trusted certificates; TLS verification is never disabled. A background process works without systemd; container restart still requires the deployment lifecycle to start the client again.

---
title: "Execution-environment preparation API"
description: "Preparation tasks, idempotent context, and readiness checks."
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

## OpenCode and capabilities

OpenCode checks share version-aware logic. v1 retains `debug config`, authentication-source, and `models` checks. v2 uses `api --standalone model.list`, or `model.default` when no model was selected, and checks native `providerID/id` and `enabled`. It does not reuse v1 authentication-file parsing or infer availability from v2 config-source arrays. These checks do not perform model inference.

Errors distinguish `MODEL_CONFIGURATION_UNREADABLE`, `MODEL_UNAVAILABLE`, and `MODEL_CONFIGURATION_MISSING`. CLI output stays in temporary mode-`0600` files and is not returned as raw configuration or provider errors. Ready v1/v2 profiles report `skillSnapshotVersion: 4`. Skill generation and A/B require `supportsSkillSnapshot`; trigger analysis additionally requires `supportsTriggerRouting`. Missing fields prompt checking the resident client and reported capabilities, rather than assuming the OpenCode binary alone is too old.

## Dispatch and recovery

Preparation reuses `ReliabilityCommand` with the allowlisted `PREPARE_EXECUTION_ENVIRONMENT` action. Its deadline is 45 minutes; delivery ACK deadlines and other actions retain their own rules. Requests and receipts do not contain model secrets, arbitrary script paths, or Shell commands. `agentOptions` supplies execution context rather than installation commands.

Checks and recovery avoid a full capability scan. The executor merges verified platform/component/Profile facts through `PUT /api/reliability/client/v1/capabilities` with `partial: true`, retaining other Agents, models, and components. Changed Profile digests invalidate unchecked Runtime readiness. Reliability dataset Worker heartbeats similarly merge selected-platform inventory using `partial: true`. Incremental synchronization must succeed before `ready` is returned.

HTTP confirmation handles terminal environment state. Unconfirmed results recover from the environment task record instead of replaying stale `ready` via a generic receipt queue. Recovery checks the original context read-only; expired or missing context requires another check. Conditional receipt updates prevent late ACK/progress from overwriting terminal state, and readiness queries recheck dataset identity and host health.

Implementation: [preparation logic](https://gitcode.com/openeuler/agent-insight/blob/master/src/lib/engine/experiment/environment-preparation.ts).

[中文权威版本](../../../zh/reference/evaluation/execution-environment.md)

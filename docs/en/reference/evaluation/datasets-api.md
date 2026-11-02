---
title: "Evaluation dataset HTTP API"
description: "Dataset reads and writes, Trace backflow, historical Trace generation, cancellation, and deletion."
---

This page covers all 13 HTTP methods in the nine route files under `/api/agent-datasets`. Datasets are addressed by `id`; `targetSkill` uses the Skill name. For UI operations, see [evaluation datasets, Chinese](../../../zh/how-to/evaluation/datasets.md); to create an experiment, see the [experiment API](./experiments-api.md). Skill-based sample drafting and Benchmark administration commands are outside this prefix.

## Identity and response forms

These routes do not uniformly use `resolveUser`:

| Entry point | Current identity behavior |
| --- | --- |
| Ordinary listing, creation, updates, details, deletion, Trace drafts, and backflow | Read a nonempty `user` from the query or JSON body. Ordinary branches do not verify it as a credential. Storage filters by that username and visibility of public system Benchmark datasets; a successful lookup does not prove caller authentication |
| Trace generation, generation options/progress, cancellation, and deletion progress | `traceIdentity` verifies only the `x-witty-api-key` header. Query `apiKey` and explicit `user` cannot replace it; missing or invalid credentials return `401` |
| Ordinary routes accessing Trace-generated datasets | Additionally require the valid Key account, `user`, and dataset owner to match. Mismatches return `404`, deletion in progress returns `409`, and writes require publication. Lists include these datasets only when the Key account matches query `user` |

Integrations should always send the current account's Key and, where required, the same account as `user`. Compatibility parameters on ordinary routes are not proof of security isolation. See [HTTP identity](../platform/http-api.md) for deployment boundaries. Successful responses below are `200` unless noted otherwise.

## Queries and ordinary writes

| Method and path | Request | Successful response and constraints |
| --- | --- | --- |
| `GET /api/agent-datasets` | Required query `user`; optional `targetSkill=<name>`, `targetSkill=__none__` for unbound datasets, and `view=summary` or `view=reference` | Returns an array directly, without pagination wrapping. Default: full datasets; `summary`: metadata and `caseCount` without `cases`; `reference`: additionally includes reference Case projections without trajectories. The default full list is ordered by update time descending |
| `POST /api/agent-datasets` | JSON requires `user/name`; optional `description/targetAgent/targetSkill/tags/datasetKind/fields/cases` | `{ success: true, dataset, warnings }`, with a generated dataset UUID. Explicit `benchmark` creation returns `403`. Ordinary kinds are `ideal_output/trajectory/reliability`; unknown values normalize to `ideal_output` |
| `PATCH /api/agent-datasets` | JSON requires `user/id`; other writable fields are as for creation | `{ success: true, dataset, warnings }`. Only supplied properties change; supplied `cases` replace the entire sample array, and supplied `fields` replace field definitions. This is not a per-case append. No revision or general conditional-update guarantee is provided |
| `GET /api/agent-datasets/:id` | Required query `user`; optional `view=items` or `view=case&caseId=<Case ID>` | Default: full dataset. `items` truncates trajectory values to the first 600 characters plus an ellipsis; `case` returns one complete Case. Do not write `items` previews back as full data |
| `DELETE /api/agent-datasets/:id` | Required query `user` | Ordinary datasets return `{ success: true }`, or `404` if absent. Trace-generated datasets may return `202 { deletionId, status }` or a bodyless `204`; follow deletion status as described below |

For ordinary creation and updates, trimmed `name` must be nonempty. Each `fields` item has `key/label/type`, with optional `id/path/displayType/width/format/truncate/description/system`. Keys must match `^[A-Za-z][A-Za-z0-9_]*$` and be unique; labels are unique case-insensitively. Types are `text/number/boolean/json`. Missing or empty field arrays use the dataset kind's defaults. Reliability datasets restore required system fields.

A Case uses `id/input/expectedOutput/evaluationFocus/tags/trajectory/values`. Ordinary Cases without an `id` receive a UUID. Custom fields live in `values`; the canonical expected-output key is `reference_output`. Ordinary samples do not require nonempty reference answers. Reliability Cases require nonempty `input` and a registered `values.fault_injection_type`; validation failures return `422` and `details: [{ caseId, field }]`. Saving does not itself invoke a model to extract key points; relevant evaluations compute the cache when needed.

Existing built-in reliability and Benchmark datasets return `403` in ordinary `PATCH/DELETE` branches. Maintain Benchmarks through the [controlled administrator workflow, Chinese](../../../zh/how-to/evaluation/datasets.md#管理员导入-benchmark-数据集). Do not generalize one branch's checks to every write entry point.

```json
{
  "user": "example-user",
  "name": "Arithmetic regression",
  "datasetKind": "ideal_output",
  "cases": [{
    "id": "case-1",
    "input": "Return the sum of 1 and 1",
    "expectedOutput": "2"
  }]
}
```

This is an ordinary `POST` body. It neither executes an Agent nor creates an experiment. Creation has no general idempotency key; if the response is lost, inspect the list before creating again.

## Build a draft and backflow an existing Trace

| Method and path | Request | Successful response and limits |
| --- | --- | --- |
| `POST /api/agent-datasets/trace-drafts` | JSON requires `user` and either `executionId` or `taskId`; `executionId` takes precedence when both are supplied | `{ draft: { values: { input, output, trace }, traceSource: { taskId, executionId?, capturedAt } }, warnings }`. Reads the user's Execution and Session and extracts original interactions into a draft without saving a dataset. Missing Trace/Session: `404`; invalid interactions JSON: `422` |
| `POST /api/agent-datasets/backflow` | JSON `user`, `mode: "existing"/"new"`, and `cases: [{ values, traceSource? }]`; existing mode needs `datasetId`, new mode needs `datasetName`, with optional `datasetDescription` | `{ success: true, datasetId, caseId?, caseIds, inserted, skippedDuplicates, addedFields }`. For compatibility, omitted `mode` is inferred from the target ID/name, and single-row `values/traceSource` bodies remain accepted |

New datasets accept `fields`; existing datasets accept `newFields`. At least one field is required overall. Keys must be valid and unique, labels nonempty and unique case-insensitively, and types one of the four supported types. When new-dataset `fields` are omitted, legacy fields are inferred from candidate `values`. Each row may contain only defined keys. Nonempty strings in JSON fields must parse as JSON.

`fieldMappings` is `[{ key, source }]`, where `source` is one of `input/output/trace/none`. Omission uses default mappings for standard fields. Mappings identify which submitted values become canonical input, reference output, and trajectory; they do not fetch source Trace content again. New datasets with a `trace` or `trajectory` key use kind `trajectory`; otherwise they use `ideal_output`.

Backflow deduplicates by `traceSource.taskId` against existing Cases and the current batch. Samples lacking that source identifier have no such deduplication guarantee. When every row is duplicate, new fields are not saved either. Built-in reliability datasets reject backflow. Trace-generated datasets require fixed two-field imports from their detail page; this backflow entry point returns `422`. Deduplication is not general POST idempotency and does not prove that a source answer has been reviewed for correctness.

## Generate asynchronously from historical Traces

These interfaces extract and sample standalone text question/answer pairs from existing Traces. They do not launch Agents or call models. Reference answers come from historical output, so successful generation does not prove factual correctness. The service currently needs SQLite and resident Node Workers. Startup pending returns `503 FEATURE_INITIALIZING`; unavailability returns `503 FEATURE_UNAVAILABLE`, with `Retry-After: 2/30` respectively and `Cache-Control: no-store`.

| Method and path | Request | Successful response |
| --- | --- | --- |
| `GET /api/agent-datasets/generation-options` | Optional query `platform/from/to`. Omitted dates use the last seven days; providing either date requires both | `{ platforms: [{ id, label }], agents: [{ agentKey, name, traceCount }] }`. Platforms come from this account's historical frameworks; selecting a platform returns Agents in the window. Use the returned `agentKey`, not its display name |
| `POST /api/agent-datasets/trace-generation` | JSON configuration below; do not use `user` to override the Key account | `202 { datasetId, jobId }` means acceptance or replay of an existing job. Query progress next |
| `GET /api/agent-datasets/:id/generation` | Dataset ID in the path | `{ datasetId, jobId, status, stage, stageIndex, totalStages, generatedCount, summary, error, generationConfig, canCancel, canReturn, canFinish }` |
| `DELETE /api/agent-datasets/:id/generation` | Dataset ID in the path | Bodyless `204`; releases temporary filtering-summary cache for this viewer. It does not delete the dataset or stop generation |
| `POST /api/agent-datasets/:id/generation/cancel` | Dataset ID in the path | `202 { deletionId, status }` or bodyless `204`. Cancellation cleans up the job and its dataset rather than pausing it for resumption. Published datasets return `409 ALREADY_COMPLETED` |
| `GET /api/agent-datasets/deletions/:deletionId` | ID returned by cancellation or deletion | `{ deletionId, status: "deleting"/"cleanup_failed"/"deleted", error }`. Cleanup failures use `CLEANUP_FAILED`; unknown records or another owner's record return `404` |

| Generation field | Validation |
| --- | --- |
| `name` | Trimmed length 1–50 characters |
| `description` | Optional string, at most 200 characters |
| `platform/agentKey` | Strings; the Agent must be accessible to the account on the selected platform in the window. Missing source returns `422 SOURCE_NOT_AVAILABLE` |
| `from/to` | UTC ISO timestamps ending in `Z`, with seconds or three-digit milliseconds. The window must be exactly 24 hours, seven days, or 30 days; its end cannot exceed server time by more than five minutes |
| `limit` | Required integer 1–500; not a promised output count |
| `requestId` | Caller-generated UUIDv7. A new request's timestamp must be within the past 24 hours and no more than five minutes in the future |

The same account, `requestId`, and normalized configuration replay the same `datasetId/jobId`. Reusing the ID with different configuration returns `409 IDEMPOTENCY_CONFLICT`. Deleted jobs, completed receipts without a replayable result, or expired new requests return `410 REQUEST_EXPIRED`. Successful jobs remain replayable while their valid receipts allow it; “24 hours” is not a fixed replay duration for every state. When the global pending queue, including cleanup, reaches 20 jobs, creation returns `429 QUEUE_LIMIT`.

Progress `status` is `generating/failed/published`, distinct from internal queue status. `stage` can be `queued/read/dedup/stratify/sample/convert/save/complete/failed`. Use returned `stageIndex/totalStages` rather than counting stage names. Failures include `error: { code, message }` and `generationConfig` for editing. `summary` is temporary filtering detail, may be `null`, and is not guaranteed to survive restarts or closing the progress viewer.

Published generated datasets are fixed to `ideal_output` and the two text fields `input/reference_output`. Updated Cases require unique nonempty `id` values and nonempty text in both columns, without extra value keys. Generating or failed datasets cannot be edited through ordinary PATCH. For `202` deletion/cancellation responses, inspect body `status` and query cleanup progress; the HTTP status alone does not prove that work is still running or deletion is complete. Repeating completed Trace deletion may return `204`. Removing a dataset does not remove its original Traces.

## Errors and implementation sources

Ordinary routes commonly return `{ error: "message" }`; reliability validation also includes `details`. Trace-generation errors use `{ error: { code, message, details? } }`, with `deletionId` in details when deletion is in progress. The Trace error handler maps malformed JSON to `400 INVALID_CONFIG`; do not assume ordinary branches share that shape. Ordinary parameter failures use `400`, lookup failures `404`, and storage or unknown service failures may use `500`.

This page was checked against local baseline `ccf6bcf8`; it does not claim identical behavior across every deployment or future release:

- [Collection routes](https://gitcode.com/openeuler/agent-insight/blob/ccf6bcf80fe7c4831d20448b329f137ed5285edd/src/app/api/agent-datasets/route.ts), [details and deletion](https://gitcode.com/openeuler/agent-insight/blob/ccf6bcf80fe7c4831d20448b329f137ed5285edd/src/app/api/agent-datasets/%5Bid%5D/route.ts)
- [Backflow route](https://gitcode.com/openeuler/agent-insight/blob/ccf6bcf80fe7c4831d20448b329f137ed5285edd/src/app/api/agent-datasets/backflow/route.ts), [dataset fields and persistence](https://gitcode.com/openeuler/agent-insight/blob/ccf6bcf80fe7c4831d20448b329f137ed5285edd/src/server/agent_datasets_storage.ts)
- [Trace identity and errors](https://gitcode.com/openeuler/agent-insight/blob/ccf6bcf80fe7c4831d20448b329f137ed5285edd/src/server/trace-datasets/http.ts), [configuration contracts](https://gitcode.com/openeuler/agent-insight/blob/ccf6bcf80fe7c4831d20448b329f137ed5285edd/src/lib/trace-datasets/contracts.ts), [generation, replay, and cleanup](https://gitcode.com/openeuler/agent-insight/blob/ccf6bcf80fe7c4831d20448b329f137ed5285edd/src/server/trace-datasets/manager.ts)

[中文权威版本](../../../zh/reference/evaluation/datasets-api.md)

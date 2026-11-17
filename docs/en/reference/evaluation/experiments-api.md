---
title: "Experiment HTTP API"
description: "Create, start, query, rename, cancel, and delete ordinary experiments."
keywords: ["Agent Insight", "experiment API", "evaluation tasks", "asynchronous execution"]
changefreq: "monthly"
---

This reference covers common ordinary-experiment calls and asynchronous behavior. Benchmark, Skill, and LLM comparison experiments use different branches, so requests and responses are not interchangeable. See the [experiment guide, Chinese](../../../zh/how-to/evaluation/experiments.md) and [HTTP identity conventions](../platform/http-api.md).

## Queries

| Endpoint | Parameters and response |
| --- | --- |
| `GET /api/experiments` | `limit` defaults to `20`, bounded to `1`–`100`; `offset` defaults to `0`; optional `skillName`. Returns `{ items, total, limit, offset }`. The ordinary list excludes deleted records, drafts, and several Skill-specific scopes |
| `GET /api/experiments/:id` | Experiment details, Cases, results, and phase information; fields vary by experiment type, so a list-item type cannot describe every detail response |
| `GET /api/experiments/cancellations` | Up to 100 current-user `pending` cancellation records as `{ cancellations }`, not the complete cancellation history |

Send the current account Key instead of relying on the overriding `user` selector. An ordinary list with no identity can have a broader scope, so its success is not proof of credential validation. Writes and detail branches apply their own ownership handling.

Execution progress in experiment details is read through a consistent transaction snapshot using only required fields. A transaction is limited to 30 seconds, with a shared 35-second wait budget across at most two attempts. Only `P1008/P2028/P2034` trigger one retry, logged with its code and elapsed time. Persistent failures still return errors; retries do not rerun Agents or evaluators or rewrite experiment records. When a background refresh succeeds, the UI exits the full-page loading state and displays the result.

## Create an ordinary single-group experiment

`POST /api/experiments` accepts JSON. This example supplies existing input/output; it does not ask an Agent to generate a Trace:

```json
{
  "name": "Example experiment",
  "type": "single",
  "evaluatorIds": ["preset-agent-task-completion"],
  "cases": [{
    "input": "Return the sum of 1 and 1",
    "actualOutput": "2",
    "referenceOutput": "2"
  }]
}
```

`name` must be nonempty after trimming, and `evaluatorIds` must contain at least one item. Non-watch mode needs at least one Case. Watch mode uses `watchMode: true` and a nonempty `agentName`. Cases can reference `executionId` / `taskId`, and support `datasetInput`, reference output, and evaluator context. Reference-answer requirements depend on evaluator metadata. The ordinary branch returns `200` with `{ id }`; the new record is a draft, not a completed evaluation.

The Benchmark dataset branch has its own binding, Case selection, and execution settings and can return `201`. Ordinary experiments cannot select `benchmark:` evaluators. Do not apply the ordinary payload to a Benchmark or frozen Skill-snapshot experiment. See [evaluator output and runtime settings](./evaluator-output.md) and [environment preparation](./execution-environment.md).

## Start and completion

`POST /api/experiments/:id/run` starts an existing experiment. An ordinary response normally contains `{ status: "running" }`; an already-running task includes `alreadyRunning: true`. Benchmark returns `202` and can include `runId`. Other branches can include Trace-generation or fault-injection information. The response acknowledges start or acceptance; query details for progress.

| State layer | Interpretation |
| --- | --- |
| Experiment | Detail `status`, commonly `draft/running/done/failed`; inspect additional fields for watch and cancellation flows |
| Result row | Case × evaluator `status`, such as `pending/running/done/failed/cancelled`. A failed evaluation execution differs from a valid `verdict: fail` result |
| Trace generation | Agent exit can be followed by waiting for collection and ingestion. Retain the Trace ID and inspect the failure stage |
| Cancellation | Inspect the cancellation record and actual exit confirmations. A delete marker or successful command receipt does not prove process exit |

After an interrupted request, query state before retrying. Creation does not promise a general client idempotency key; repeated creates can produce multiple experiments. Evaluation timeouts and retries are distinct from model-connection test timeouts.

## Rename and stop watching

`PATCH /api/experiments/:id` changes one field per request:

- `{ "name": "New name" }`: trimmed length `1`–`120`; returns `{ success: true, name }`. Status, frozen configuration, and historical results are unchanged.
- `{ "watchMode": false }`: stops watching for new Traces; returns `{ success: true, watchMode: false }`. It does not terminate already running work.

Do not combine both fields. `watchMode: true` is not supported by this PATCH.

## Stop and logically delete

| Endpoint | Semantics |
| --- | --- |
| `DELETE /api/experiments/:id?stop=true` | Request cancellation and logically delete the experiment. Returns `{ deleted: true, cancellation }`, with `200` if confirmed or `202` if pending |
| `DELETE /api/experiments/:id` | Retains draft rollback deletion. An experiment that has started can return `409`; this is not a substitute for stopping it |
| `DELETE /api/experiments/:id/cases/:caseId` | Deletes an owned Case and returns `experimentDeleted`; deleting the final active Case also logically deletes its experiment. Skill use-case/A/B flows additionally accept `dataset:<sourceCaseId>` |

Pending cancellations persist and retry; late results cannot revive deleted records. Cancelling an HTTP request only stops local waiting. Use server-side cancellation state to confirm termination.

## Errors and implementation

Common statuses include `400` for invalid parameters or missing identity, `404` for a missing or differently owned target, `409` for state conflicts, `503` when a Trace-generation task cannot be created, and `500` for service failure. Environment, Benchmark, and Trace-generation errors may add `code`; read the [relevant protocol](./benchmark-protocol.md). Preserve the response rather than decoding every branch as `{ id }`.

Sources: [experiment routes](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/experiments/route.ts), [start](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/experiments/%5Bid%5D/run/route.ts), and [details/control](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/experiments/%5Bid%5D/route.ts).

[中文权威版本](../../../zh/reference/evaluation/experiments-api.md)


## Viewing Benchmark evidence

Benchmark Case details expose the original evaluation files for preview and download. Relative folders and Unicode filenames are retained in the platform; individual downloads use the original basename and do not preserve a directory tree. Source labels distinguish integration-declared official files/API returns, runtime output, platform diagnostics and undeclared historical sources. Labels alone do not prove scoring correctness. Text previews show the stored original content; Markdown files (identified by `text/markdown`, `.md` or `.markdown`) default to a formatted preview with a source toggle, without enabling raw HTML. Downloads always return the original bytes; summaries and scores do not replace attachments. Collection failures must remain explicit rather than being hidden behind a successful score.

### Diagnosis runs and optimization inputs

Single-group experiment creation computes a dataset Case contentHash on the server from the original input, expected output, values (including evaluator catalogs), and evaluationFocus. Matching may normalize whitespace, but stored inputs and reference answers retain their original text. Diagnosis retests check exact text and fingerprints for new records. Legacy records accept only the original text or its historical trim-and-collapse-whitespace transformation, without rewriting baseline answers. Changes to frozen diagnosis inputs, answers, executions, or scores remain blocking and produce specific errors.

Use an authenticated API key. POST selected resultIds to `/api/experiments/:id/cases/:caseId/diagnoses` with preview=true. Confirm with requestKey and expectedInputHash to receive a runId. A new requestKey creates a new run even for identical evidence; retries with the same requestKey and input return the same run. The force field remains accepted for compatibility but is no longer required to start a new run. Changed evidence returns 409 and insufficient execution evidence returns 422. GET the same collection for recent runs, or GET `/api/diagnosis-runs/:runId` for the immutable input summary, progress and report. The snapshot limit is 16 MiB.

POST executionId and generatedAt to `/api/diagnosis-runs/from-trace` to freeze an existing final Trace report. GET `/api/skills/by-name/:name/diagnosis-inputs?version=N` for the baseline. POST to the same path with runId, findingIds, baseVersion, expectedContentHash, constraints and skillRelevanceConfirmed. baseVersion must equal the recorded execution version, and expectedContentHash must match both the execution snapshot and historical version. Missing execution versions or hashes return 409; baselineVerified cannot bypass validation. The returned sessionId opens the draft plan in the workbench.

The UI opens a returned runId at `/fault?runId=…`. This view reads the selected run through GET `/api/diagnosis-runs/:runId`, independently of Trace-only reports. Legacy `/diagnosis-runs/:runId` page links redirect to this view.

Final diagnosis files are parsed as complete JSON and validated for required fields and finding references. Module values in phase1Grid and issues accept memory, reflection, planning, action, system, and others, matching the Skill report contract. Other-module issues retain their evidence and references without adding a sixth cognitive module. Read, parse, or validation failures produce a failed run with errorMessage, rather than a successful empty report. A valid empty findings array does not establish that the execution is problem-free. Historical repairs require separate review and confirmation.

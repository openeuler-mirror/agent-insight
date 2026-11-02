---
title: "Independent Benchmark evaluation protocol"
description: "Dispatch, idempotency, cancellation, and result normalization between the platform and Evaluator."
---

The independent Evaluator runs official Benchmark judging. This is a separate layer from the platform's built-in LLM Judge [output contract](./evaluator-output.md). See the [service deployment guide, Chinese](../../../zh/how-to/evaluation/benchmarks/deploy-services.md). This reference supports integration development; ordinary users should use the platform workflow instead of manually dispatching formal jobs.

## Dispatch

`POST /api/v1/evaluations` is served by the independent Evaluator; its health endpoint is `GET /health`. Ordinary dispatch includes:

| Field | Contract |
| --- | --- |
| `runId` | `1`–`160` letters, digits, underscores, or hyphens; must equal `evaluationJob.evaluationId` |
| `requestDigest` | `sha256:` followed by 64 hexadecimal characters; computed from canonical JSON of the dispatch object excluding this field |
| `evaluationJob` | The `benchmark-evaluation/v1` Job below |
| `platformBaseUrl` | HTTP(S) URL without URL credentials, query, or fragment |
| `callbackBaseUrl` | Same origin as the platform; path matches its `/api/benchmark/v1/evaluations/:runId` |
| `timeoutSeconds` | Integer `1`–`86400`, equal to the Job limits timeout |

Header `x-agent-insight-request-digest` must match the digest, and `Idempotency-Key` must match `runId`. Digest validation provides consistency and idempotency, not identity authentication. The service relies on its controlled deployment network; do not treat its port or cancellation route as a public anonymous management interface.

Success returns `202` with `{ runId, requestDigest, status: "accepted", state }`. The same ID and digest reuse an existing job; the same ID with a different digest returns `409 RUN_ID_CONFLICT`. Acceptance does not prove successful Harness execution.

## Job and results

| Job field | Value |
| --- | --- |
| `protocolVersion` | `benchmark-evaluation/v1` |
| `evaluationId` / `executionRunId` | Judging-run identity and original execution-run identity; they are not interchangeable |
| `context` | `experimentId/caseId/datasetContentHash` |
| `benchmark.key` / `evaluator.key` | Benchmark protocol and registered evaluator keys |
| `artifacts` | Each descriptor includes `artifactId/executionRunId/name/mediaType/sha256/sizeBytes` for submission validation |
| `payload` | Defined by the Benchmark Adapter; a generic empty object is not a replacement |
| `limits` | `timeoutSeconds/cpu/memoryMiB` |

Progress stages include `downloading_artifacts/preparing_runtime/resolving_image/running_harness/collecting_evidence/uploading_evidence/cleaning`. These are judging stages, not platform experiment terminal states.

A completion contains `status` (`completed/submission_invalid/failed`), `rawResult`, `evidenceArtifactIds`, `runtimeFacts`, and `cleanup`; an error can contain `{ code, message, retryable }`. The Adapter's `normalizeResult()` produces `status: done|failed`, `summary`, nullable `score`, optional `verdict`, `points`, `evidence`, `nativeMetrics`, and optional `primaryMetric`. Raw Harness fields are not a universal UI format.

`primaryMetric.aggregation` is `boolean-rate` or `mean`. Preserve the distinction between native pass rates, Boolean success, and a displayed `0`–`100` score. A display score alone does not establish an official result. Container exit, evidence upload, and resource cleanup also require separate confirmation.

## Cancellation and errors

The same POST endpoint accepts `{ operation: "cancel", runId, requestDigest }`, using the original digest. It returns `202` with cancellation state. An existing job's mismatched digest returns `409`; a missing digest returns `422 CANCEL_INVALID`. An unknown but valid run ID can be cancelled before dispatch arrives, preventing late execution. Cancellation acceptance does not confirm process or container exit.

| Error | Status and meaning |
| --- | --- |
| `EVALUATION_REQUEST_INVALID` | `400`, invalid dispatch object or fields |
| `CALLBACK_URL_FORBIDDEN` | `403`, callback does not match this platform job |
| `RUN_ID_CONFLICT` | `409`, a run ID has another digest |
| `SERVICE_BUSY` | `409`, capacity unavailable; response can mark `retryable: true` |
| `REQUEST_DIGEST_MISMATCH` | `422`, object digest, header, or idempotency key mismatch |

Service errors use `{ error: { code, message, retryable } }`. Preserve the same request and idempotency identity after uncertain transport failures. A changed task needs a new identity rather than a fabricated old digest.

## Implementation

- [Dispatch and EvaluationJob types](https://gitcode.com/openeuler/agent-insight/blob/master/packages/benchmark-protocol/src/evaluation-contracts.ts)
- [Progress, completion, and normalized result types](https://gitcode.com/openeuler/agent-insight/blob/master/packages/benchmark-protocol/src/evaluator-contracts.ts)
- [Service validation and handler](https://gitcode.com/openeuler/agent-insight/blob/master/services/evaluator/src/service.cjs)

[中文权威版本](../../../zh/reference/evaluation/benchmark-protocol.md)

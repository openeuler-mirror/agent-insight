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

## Native evaluation evidence

Determine scope from the official documentation for the pinned version first, then verify it against the official scoring entrypoint and actual parameters. Where documentation is missing or incomplete, trace same-version file outputs, return values and diagnostics. If documentation and code disagree, check versions and parameters, record the discrepancy and resolution, and never silently choose a side or fabricate missing files. Resolve material uncertainty affecting scoring or evidence scope with the user before dependent work.

A program's files are not all evaluation evidence: caches, input copies, dependencies and intermediate files must not be exposed solely because they exist in an output directory. Record documentation links/locations, versions/sections, code-based additions and inclusion/exclusion decisions in the existing integration plan. The integration must stage only selected original outputs into the controlled output directory, retaining original names, relative paths and bytes. Common scanning prevents missing uploads; it does not classify business relevance, and `evidenceRoot` does not filter siblings in the output directory. Necessary platform diagnostics remain clearly labeled supplements.

Preserve the names, relative directories and bytes actually produced by the scoring entrypoint. Normalized summaries and platform metadata do not replace original artifacts. File Entrypoints collect undeclared regular files from their output directory, excluding the top-level protocol `result.json`. Optional `evidenceRoot` identifies an official output subdirectory (`.` means the output directory); names inside it must match their original relative paths. Unicode and internal spaces are supported subject to safe path and size checks. Inputs, credentials and caches must stay outside the output directory.

Optional evidence `source` is `official-file`, `official-return`, `runtime-output` (default), or `platform`. Official provenance remains an integration claim requiring dedicated tests, not an attestation inferred from `kind`. `runtimeFacts.evidenceCollection` records scope, completeness, issues, file names, digests, sizes and uploaded Artifact IDs. Completion validates that inventory against referenced artifacts; incomplete successful collections are rejected. Historical callbacks without an inventory remain compatible and do not prove the new acceptance requirements.

The shared previewer selects a view from the filename and MIME type. CSV opens as a table, while JSON and JSONL open as plain text. HTML opens in a sandboxed frame where inline scripts can render report content and controls. The frame restricts external scripts and resource loading.

Nonzero exits and timeouts retain partial outputs and full stdout/stderr files alongside platform diagnostics. Oversized or unsupported artifacts are reported explicitly without silent truncation. Cancellation follows its existing lifecycle and does not guarantee upload. Download supports Unicode basenames; individual downloads cannot preserve a directory tree. No new archive endpoint is introduced.

All attachments retain byte-integrity checks. Malformed JSON diagnostics remain downloadable with `jsonParseError`; an Adapter relying on their parsed content must reject missing `jsonContent`. Native result Schema validation remains strict. The [Chinese development contract](../../../zh/how-to/evaluation/benchmarks/develop-benchmark.md#原始产物交付与来源) is authoritative.

## Implementation

- [Dispatch and EvaluationJob types](https://gitcode.com/openeuler/agent-insight/blob/master/packages/benchmark-protocol/src/evaluation-contracts.ts)
- [Progress, completion, and normalized result types](https://gitcode.com/openeuler/agent-insight/blob/master/packages/benchmark-protocol/src/evaluator-contracts.ts)
- [Service validation and handler](https://gitcode.com/openeuler/agent-insight/blob/master/services/evaluator/src/service.cjs)

[中文权威版本](../../../zh/reference/evaluation/benchmark-protocol.md)

Execution Profile identity and environment structure are validated by the shared protocol; each backend validates actual policy support. The existing OCI environment remains supported, and `workspace` uses the task workspace for native local execution. Resource limits are declared only when enforced. Clients report explicit execution bindings; missing required Profiles do not silently fall back. See the [Chinese development contract](../../../zh/how-to/evaluation/benchmarks/develop-benchmark.md).


The bundled benchmark-onboarding Skill validates original-output to platform-download mappings within its existing scoring-service and runtime checks. It compares coverage, evaluation/submission identity, original names, provenance and bytes without additional model or scoring invocations. API downloads and browser verification are reported separately. Dedicated integration tests still verify the official call and return-value serialization; hashes and labels alone do not establish authenticity. See the [Skill acceptance contract](../../../../skills/benchmark-onboarding/references/acceptance.md#评测产物核对).

---
title: "Trace HTTP ingestion"
description: "Inputs, identity handling, and receipt semantics for OTLP and legacy JSON uploads."
keywords: ["Agent Insight", "OTLP", "trace ingestion", "authentication"]
changefreq: "monthly"
---

Use the framework's client installation flow where possible. This reference supports exporter integration and troubleshooting. OTLP bodies and legacy upload JSON are different formats.

## OTLP/HTTP Traces

`POST /api/ingest/otel/v1/traces` receives OTLP Trace requests. `POST /api/public/otel/v1/traces` exports the same handler; the word `public` does not mean every source can write anonymously. Field mapping is documented in the [OTLP attribute contract, Chinese](../../../zh/reference/observability/otlp-attribute-contract.md).

| Item | Contract |
| --- | --- |
| JSON | `Content-Type: application/json`, with the OTLP `resourceSpans` structure |
| Protobuf | `Content-Type: application/x-protobuf`, with OTLP Trace encoding; the decoder determines other supported types and returns `415` for unsupported types |
| Platform Key | `x-witty-api-key`; an explicitly supplied unmatched Key returns `401`, without falling back to resource-level user attribution |
| Langfuse-compatible source | Without an already validated platform Key, Basic `publicKey:secretKey` or `x-langfuse-public-key` / `x-langfuse-secret-key` is checked against the username and that user's API Key |
| LlamaIndex | Requires a validated platform Key; `resource.user.id` cannot select an arbitrary owner |
| Other sources | Some adapters retain source-attribute attribution paths. These are not credential verification; configure a Key as required by the framework guide |

A general success response looks like this. Counts refer to normalized events and need not equal the input Span count:

```json
{
  "status": "accepted",
  "received": 2,
  "persisted": 1,
  "deduplicated": 1,
  "sessions": ["example-session"]
}
```

`persisted` counts newly appended spool events, `deduplicated` counts recognized duplicates, and `sessions` identifies sessions requiring later processing. Framework-specific branches may return different fields such as `framework`. A request containing only ignored CodeAgent resources returns `ignored: true` and `received: 0`. HTTP `200` does not establish that a business Trace is already visible.

| Status | Meaning |
| --- | --- |
| `200` | Accepted; consumption, aggregation, and projection still follow |
| `400` | Invalid request or undecodable JSON/Protobuf |
| `401` | An explicit Key is invalid, or a source requiring credentials has none |
| `413` with `status: partial` | The Goal Plus session identity limit was reached; some events may have been accepted. Inspect `received` and `rejected.spool` |
| `415` | Unsupported content type |
| `500` | Processing failed; retain unacknowledged data for the collector's retry policy |

Receipt ACK, spool persistence, consumer storage of Execution/Session, and UI visibility are separate stages. Check them in sequence. Preserve the collector's existing event identity on retries instead of inventing a new ID for the same event.

## Legacy JSON upload

`POST /api/ingest/upload` receives the execution-record object used by existing collectors. Common fields include `framework`, `task_id`, `query`, `final_result`, `interactions`, and lifecycle fields. Follow the collector's framework contract; this list is not a universal replacement for the OTLP schema.

Identity behavior differs from OTLP:

- A valid `x-witty-api-key` identifies the account. OpenCode can also use its registered-device Bearer credential and `x-agent-insight-client-id`; clients manage that flow.
- If both credentials are valid, they must belong to the same account or the request returns `403`. One valid credential can allow receipt when the other is invalid, but the invalid credential is not used to bind the client. Two invalid credentials are rejected.
- Older clients can retain body `user` attribution, or use an explicitly configured `AGENT_INSIGHT_DEFAULT_INGEST_USER` shared account. Without any identity source, the response is `400`. An explicitly invalid Key does not silently fall back to the shared account.

Successful responses include `success: true`, `upload_id`, `auto_evaluation`, and `background_analysis`. In-progress OpenCode snapshots also include `in_progress: true`. `auto_evaluation: false` does not mean upload failure. Initial record persistence failure returns `500`; the client must not advance its uploaded checkpoint. `background_analysis: true` does not prove that background analysis has finished.

## Jiuwen duration units

Jiuwen tool spans join inference turns through explicit parent spans or tool call IDs. Unmatched tools remain visible independently without adding an LLM call.

All OpenCode session detail API views recalculate effective duration from the original interactions and return it as `execution.latency`, falling back to the stored value when timing evidence is unavailable. Reads do not modify historical records.

Jiuwen OTLP aggregation converts nanosecond boundaries to milliseconds before storing `Execution.latency`. Trace lists and detail headers format this value as milliseconds. Legacy Jiuwen Trace Bundles are converted from seconds only when interaction timestamps corroborate the unit; values already in milliseconds or lacking timing evidence remain unchanged. Spans of one millisecond or less remain unchanged because timestamp rounding makes the unit ambiguous. The supplied bundle and original Session are preserved.

Back up the SQLite database before history correction. Run `node --import tsx scripts/repair_trace_latency.ts --framework jiuwenswarm --report /path/to/preview.jsonl` to preview, then use `--apply` with a different report path. The `0600` JSONL journal durably records original and corrected values as `planned` before each update and `applied` after commit, followed by a final `summary`. Partial failures retain the journal; compare the current database value with the last plan when checking commit status. Repeated runs do not multiply corrected values again. Without `--framework`, the command retains its OpenCode behavior. See the [Chinese procedure](../../../zh/how-to/observability/view-traces.md#jiuwen-历史耗时单位校正).

## Implementation

- [OTLP Trace handler](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/ingest/otel/v1/traces/route.ts) and [decoder](https://gitcode.com/openeuler/agent-insight/blob/master/src/lib/ingest/otel/decode.ts)
- [Legacy upload handler](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/ingest/upload/route.ts)
- [Viewing Traces, Chinese](../../../zh/how-to/observability/view-traces.md)

[中文权威版本](../../../zh/reference/observability/trace-ingestion.md)

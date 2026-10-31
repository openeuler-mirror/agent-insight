---
title: "Trace HTTP ingestion"
description: "Inputs, identity handling, and receipt semantics for OTLP and legacy JSON uploads."
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

## Implementation

- [OTLP Trace handler](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/ingest/otel/v1/traces/route.ts) and [decoder](https://gitcode.com/openeuler/agent-insight/blob/master/src/lib/ingest/otel/decode.ts)
- [Legacy upload handler](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/ingest/upload/route.ts)
- [Viewing Traces, Chinese](../../../zh/how-to/observability/view-traces.md)

[中文权威版本](../../../zh/reference/observability/trace-ingestion.md)

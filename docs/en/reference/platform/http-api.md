---
title: "HTTP APIs and user identity"
description: "API families, user resolution, responses, and integration boundaries."
---

This page is the entry point for existing HTTP interfaces. Identity handling and response shapes vary by endpoint. The documentation describes the current implementation; it does not promise uniform authentication, a universal error envelope, or versioned stability for every route.

## API families

| Interface | Purpose | Reference |
| --- | --- | --- |
| Platform APIs | Query, create, and control experiments | [Experiment HTTP API](../evaluation/experiments-api.md) |
| Trace ingestion | Receive collector or OTel exporter data | [Trace HTTP ingestion](../observability/trace-ingestion.md) |
| Built-in evaluators | Return one evaluation result to the platform | [Evaluator output](../evaluation/evaluator-output.md) |
| Independent Benchmark Evaluator | Execute official Benchmark judging jobs dispatched by the platform | [Benchmark evaluation protocol](../evaluation/benchmark-protocol.md) |
| Engine functions and data models | Repository development and extension | [Internal contracts, Chinese](../../../zh/reference/platform/api-and-contracts.md) |

Prefix URLs with the deployment address, including any configured subpath. The platform's default port `3000` is separate from the independent Evaluator port. See [runtime configuration](./configuration.md).

## Platform user resolution

Routes using `resolveUser(request, explicitUser)` resolve identity in this order:

1. A nonempty `explicitUser` supplied by the route is used directly. Some routes obtain it from a `user` body field or query parameter.
2. Otherwise, `x-witty-api-key` is looked up against platform users.
3. Only when that header is absent, the `apiKey` query parameter is considered.
4. An unresolved user produces an empty identity, which each route handles separately. An invalid header Key does not fall through to the query Key.

An explicit `user` is a compatibility selector, not a verified credential or proof of access isolation. Integrations should send the target account's `x-witty-api-key` and avoid simultaneously supplying an overriding `user`. Obtain the Key from that account's client installation instructions. Browser login, IDaaS, and individual collectors have their own flows; this function does not describe every route.

A read-only experiment list may omit its user filter when identity is empty, while other routes can return `400`, `401`, or `404`. A successful list response does not prove that a Key was validated. Detail and write operations apply their branch-specific ownership checks. Configure external access boundaries for the actual deployment.

```bash
# Read-only example. Supply the address and Key through your environment.
curl --fail-with-body \
  -H "x-witty-api-key: $AGENT_INSIGHT_API_KEY" \
  "$AGENT_INSIGHT_BASE_URL/api/experiments?limit=20&offset=0"
```

## Responses and retries

| Response | Caller action |
| --- | --- |
| `200` / `201` | Read the endpoint-specific body. Creation, receipt, and execution completion are distinct events |
| `202` | An asynchronous task was accepted, or cancellation is awaiting confirmation; query its state |
| `400` / `401` / `403` / `404` | Check parameters, credentials, ownership, and target; do not retry indefinitely |
| `409` | Inspect the existing task or state before resolving an identity, idempotency, or lifecycle conflict |
| `413` / `415` / `422` | Check size, content type, and protocol validation; an ingestion response may already have accepted some data |
| `5xx` / network interruption | Retain request context and check endpoint idempotency before retrying; not every POST is idempotent |

Platform errors commonly contain `{ "error": "message" }`; some add `code`, `detail`, or `hint`. Benchmark services use structured errors. Handle both HTTP status and body instead of forcing all errors into one shape. Cancelling an HTTP request also does not prove that a remote process has stopped.

## Implementation

- [User resolution](https://gitcode.com/openeuler/agent-insight/blob/master/src/lib/auth/auth.ts)
- [Experiment listing and creation](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/experiments/route.ts)
- [Client installation, Chinese](../../../zh/how-to/platform/settings/access-control.md)

[中文权威版本](../../../zh/reference/platform/http-api.md)

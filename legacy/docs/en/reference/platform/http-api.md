---
title: "HTTP APIs and user identity"
description: "API families, user resolution, responses, and integration boundaries."
keywords: ["Agent Insight", "HTTP APIs", "user identity", "platform integration"]
changefreq: "monthly"
---

This page is the entry point for existing HTTP interfaces. Identity handling and response shapes vary by endpoint. The documentation describes the current implementation; it does not promise uniform authentication, a universal error envelope, or versioned stability for every route.

## API families

| Interface | Purpose | Reference |
| --- | --- | --- |
| Platform APIs | Query, create, and control experiments | [Experiment HTTP API](../evaluation/experiments-api.md) |
| Dataset APIs | Definitions, cases, historical Trace generation, and deletion progress | [Dataset HTTP API](../evaluation/datasets-api.md) |
| Skill management | Assets, versions, files, publishing, and imports | [Skill management HTTP API](../optimization/skills-api.md) |
| Reliability clients | Registration, device credentials, configuration, and control receipts | [Reliability client and control API](../reliability/client-control-api.md) |
| Trace ingestion | Receive collector or OTel exporter data | [Trace HTTP ingestion](../observability/trace-ingestion.md) |
| Built-in evaluators | Return one evaluation result to the platform | [Evaluator output](../evaluation/evaluator-output.md) |
| Independent Benchmark Evaluator | Execute official Benchmark judging jobs dispatched by the platform | [Benchmark evaluation protocol](../evaluation/benchmark-protocol.md) |
| Engine functions and data models | Repository development and extension | [Internal contracts, Chinese](../../../zh/reference/platform/api-and-contracts.md) |

Prefix URLs with the deployment address, including any configured subpath. The platform's default port `3000` is separate from the independent Evaluator port. See [runtime configuration](./configuration.md).

## Platform user resolution

Routes using `resolveUser(request, explicitUser)` resolve identity in this order:

1. Look up `x-witty-api-key` against platform users.
2. Only when that header has no nonempty value, consider the `apiKey` query parameter.
3. If the route supplies an explicit `user` from its body or query, it is only an assertion and must exactly match the Key's user.
4. An invalid Key, a Key/user mismatch, or an explicit `user` without a Key produces an empty identity. An invalid header Key does not fall through to the query Key.

The browser `apiFetch` helper adds the local API Key to business `/api/*` requests but explicitly skips `/api/auth/*`, so login and account switching do not carry a stale Key into authentication endpoints. Integrations must likewise send the account's `x-witty-api-key`; a query `user` alone is never an identity or a data-isolation credential. Browser login, IDaaS, and individual collectors have their own flows.

Private-resource endpoints fail closed when identity is empty; resources explicitly defined as public, such as public Skills, may still return limited anonymous data. Anonymous public Skill version lists omit execution content belonging to other users. A few read-only status endpoints, such as enterprise synchronization process state, may remain unauthenticated, so one successful response does not prove the whole page or service is isolated. Detail and write operations also check ownership.

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

Client configuration reads initialize one record per client and platform. Concurrent first reads reuse the winning record without resetting its revision or overrides. Other database failures still propagate. See [client configuration, Chinese](../../../zh/how-to/platform/settings/access-control.md).

- [User resolution](https://gitcode.com/openeuler/agent-insight/blob/master/src/lib/auth/auth.ts)
- [Experiment listing and creation](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/experiments/route.ts)
- [Client installation, Chinese](../../../zh/how-to/platform/settings/access-control.md)

[中文权威版本](../../../zh/reference/platform/http-api.md)

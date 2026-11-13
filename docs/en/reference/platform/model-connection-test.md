---
title: "Model-connection test API"
description: "Test inputs, deadline, responses, and error categories."
keywords: ["Agent Insight", "model connectivity", "timeouts", "error handling"]
changefreq: "monthly"
---

See [HTTP identity and scope](./http-api.md). `POST /api/eval/settings/test` sends one real, small request to the configured model provider. This test does not evaluate a Trace or change an experiment's timeout.

## Request

The JSON body accepts `provider/protocol/apiKey/baseUrl/model/testTimeoutMs` and legacy aliases `evalProvider/evalApiKey/evalBaseUrl/evalModel`. All providers can include validated `headers`. `user/configId` can recover masked keys and headers from saved settings; this is not a new common authentication mechanism. Restrict invocation according to the deployment.

`protocol` accepts `openai-compatible` or `anthropic` and is stored in existing user-settings JSON. Invalid values return `400`. New Anthropic configurations preselect Messages; other new configurations preselect OpenAI Compatible. Missing protocol fields keep legacy behavior and are not silently rewritten. Explicit protocols apply to tests and business calls. No Prisma migration is needed.

API keys are optional. Empty keys generate no default authentication headers and do not inherit provider environment credentials. Custom headers override standard headers case-insensitively. Masked keys recover stored values; an explicit empty string clears the key.

`ModelConfig.testTimeoutMs` is stored in existing user-settings JSON. It defaults to `60000` ms and must be an integer between `10000` and `300000`. Saving settings and testing both validate it; invalid values return `400`. Evaluation, generation, and optimization timeouts remain separate.

Before saving, the form's value is used; health checks use the stored value. The test executes one Chat Completions or Anthropic Messages request according to the protocol, with `Reply with OK.`, `max_tokens: 128`, and `maxRetries: 0`.

Single-response evaluation and diagnosis calls adapt to native Messages while preserving system instructions, structured output and token usage. Agent generation and tool streams use the native Anthropic client. OpenCode statically registers each explicit connection independently and refreshes when any connection changes. Invalid JSON or protocol responses are classified as `invalid_response`.

## Response and cancellation

The response includes `{ success, elapsedMs, timeoutMs, code?, error? }`. Failure `code` is one of:

```text
timeout | cancelled | authentication | rate_limit | network |
invalid_request | server | invalid_response | unknown
```

Provider authentication failure maps to `422`, rather than masquerading as expired platform login. Raw provider exceptions are not returned because they can expose URLs, credentials, or headers.

An independent deadline covers both the request and response-body parsing. Timeout or client cancellation aborts the local transport and releases timers/listeners. Cancellation does not guarantee that the provider immediately stops inference.

## UI behavior

The form is saved only after a successful, non-cancelled test. It is frozen during testing to avoid duplicate submission. Saving itself is not cancellable, avoiding an incorrect “not saved” report. Health checks distinguish timeout, cancellation, and other failures and keep the error visible until dismissal or retry.

Implementation: [model test route](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/eval/settings/test/route.ts).

[中文权威版本](../../../zh/reference/platform/model-connection-test.md)

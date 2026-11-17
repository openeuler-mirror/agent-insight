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

## Server diagnostics

Probes emit structured records with `scope: "ModelConnectionTest"` to the server console and the existing `agent-insight.log`. `AGENT_INSIGHT_LOG_DIR` selects the directory (default `/var/log/agent-insight`); console output remains available if file logging is unavailable. Failures use `error`, visible at the default level. Successes use `info`; set `AGENT_INSIGHT_LOG_LEVEL=info` and restart to include them. Browser responses retain the existing generic errors.

- `testId/result/elapsedMs/timeoutMs` identify each probe and its outcome.
- `attempts` describe the actual endpoint after protocol adaptation, method, header names, and `authorizationPresent/apiKeyHeaderPresent`. Header values, request bodies, and model output are omitted.
- `attempts[].proxy.mode` is `direct` or `proxy`; `env` identifies the selected environment variable and `endpoint` includes only proxy scheme, host, and port. `noProxyConfigured` indicates exclusion rules exist; `bypassed` indicates an actual match. Diagnostics and dispatch share the same cached configuration and matching logic. An explicitly injected transport is marked `custom`.
- `upstream` retains the HTTP status, Content-Type, request ID, sanitized authentication challenge and error reason. Supported JSON formats include `error.code/type/message`, top-level `code/message`, and gateway `error_code/error_msg/request_id`. Only diagnostic JSON fields are retained. Plain-text/HTML errors are sanitized, with HTML tags removed. Missing reasons require gateway-side investigation.
- `proxyTunnelStatus/causeCodes` distinguish proxy CONNECT rejection from a model HTTP response and preserve transport error codes. A rejected tunnel does not expose its error body as a model response.

Error-body observation is limited to 8192 bytes, and reasons to 2048 characters. Oversized bodies are omitted entirely with `bodyTruncated`; incomplete bodies on timeout or cancellation are omitted with `bodyIncomplete`. Observation follows SDK stream consumption without additional reads, retries, or deadline extensions. API keys, all custom-header values, URL credentials and query values are redacted when echoed. Endpoint URLs omit credentials and queries; cookies, full response headers and arbitrary JSON fields are never logged.

After reproducing the failure, filter container logs for the relevant time window:

```bash
docker logs --since 10m <container> 2>&1 | grep '"scope":"ModelConnectionTest"'
```

Compare `testId`, `attempts[].proxy.mode/bypassed`, and `upstream.status/errorCode/reason/requestId` against the successful curl request. Upstream HTTP `401` still maps to API `422`; diagnostics preserve the upstream status.

Implementation: [model test route](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/eval/settings/test/route.ts).

[中文权威版本](../../../zh/reference/platform/model-connection-test.md)

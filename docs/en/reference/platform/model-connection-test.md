---
title: "Model-connection test API"
description: "Test inputs, deadline, responses, and error categories."
---

See [HTTP identity and scope](./http-api.md). `POST /api/eval/settings/test` sends one real, small request to the configured model provider. This test does not evaluate a Trace or change an experiment's timeout.

## Request

The JSON body accepts `provider/apiKey/baseUrl/model/testTimeoutMs` and legacy aliases `evalProvider/evalApiKey/evalBaseUrl/evalModel`. Custom models can include validated `headers`. `user/configId` can recover masked keys and headers from saved settings; this is not a new common authentication mechanism. Restrict invocation according to the deployment.

`ModelConfig.testTimeoutMs` is stored in existing user-settings JSON. It defaults to `60000` ms and must be an integer between `10000` and `300000`. Saving settings and testing both validate it; invalid values return `400`. Evaluation, generation, and optimization timeouts remain separate.

Before saving, the form's value is used; health checks use the stored value. The test executes one `chat.completions` request with `Hi`, `max_tokens: 5`, and `maxRetries: 0`.

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

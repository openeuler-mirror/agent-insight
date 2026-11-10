---
title: "Inference request correlation contract"
description: "Uniform X-Request-Id delivery and Trace/LLM ownership."
---

# Inference request correlation contract

The local client gateway forwards each supported model HTTP request with a fresh UUID v4 in **`X-Request-Id`**, replacing any incoming value. Each retry gets a different ID. This identifies an HTTP attempt, not a Trace or logical LLM span.

Inference services read and persist this header with each inference record, including errors, and provide `/model-performance?GlobalTrackNO=<UUID>` for one selected request. Intermediate proxies must preserve it. No Agent-specific logic is required. HTTP errors retain the same header contract. A request that never reaches the service cannot deliver its ID there; gateway-local failures remain locally observable. The gateway does not retry automatically.

OpenCode 1.x uses message/fetch evidence; 2.x uses native model/http hooks and delayed step events. Only explicitly enrolled endpoints are intercepted. Qoder CN CLI uses the session header and a unique genuine response ID; synthetic local error IDs are excluded. Desktop/JetBrains response identities are unverified.

Internal `x-agent-insight-*` and Qoder session headers are removed before forwarding. Responses to the Agent include `X-Request-Id` and a legacy local alias `x-agent-insight-call-id`; the alias is not sent downstream.

Existing interaction metadata stores `inference_call_ids`, `inference_attempts` and Trace-only `inference_unassigned_calls`; no new database tables are required. Local journals are account-scoped and contain IDs/timing/status, not prompts or model credentials. OpenCode rechecks changed journals and retries failed uploads. Parent Traces aggregate child calls; LLMs only receive proven IDs. Unknown ownership stays Trace-only. The UI lists retries separately and recommends a latest attempt only if timestamps establish one uniquely.

See [setup](../../how-to/observability/inference-gateway.md) and the [canonical contract](../../../zh/reference/observability/inference-correlation.md).

---
title: "Explicit inference gateway setup"
description: "Opt OpenCode and Qoder CN CLI into local forwarding and inference analysis."
---

# Explicit inference gateway setup

The Unix collector installer stages optional components without changing model URLs.

Gateway components are optional. Download or preparation failures warn and allow collector installation to continue; downloads have connection and total time limits. Existing collection remains usable. Rerun setup when the platform connection is available before explicitly enabling forwarding.

On the Agent machine, install from the client installation page, close the Agent, enter its project directory and run:

```sh
sh ~/.agent-insight/model-proxy.sh opencode
# Or: qoder / opencode,qoder
```

Requires curl, sh and Node.js 20+. Use your configured `AGENT_INSIGHT_HOME` if customized. Windows has no Shell integration yet. The command backs up config, registers original upstreams, starts a loopback-only daemon and rewrites supported URLs. It prints backup paths and unsupported fields. Backups may contain credentials: protect them. `original.jsonc` stays immutable; `latest.jsonc` preserves later edits with original upstream URLs restored.

OpenCode 1.x supports `provider.*.options.baseURL`; 2.x supports `providers.*.settings.baseURL`. OpenAI compatible, Responses and Anthropic Messages HTTP are supported. Providers without explicit URLs, remote or inline-only config, and explicit non-HTTP transports such as WebSocket are not enrolled. Qoder CN CLI uses `providers.*.baseUrl`; pass its matching config flags, for example `--config-dir /path/to/config`. Desktop/JetBrains collection remains supported, but model takeover and response identity are unverified; their stores and executables are not rewritten.

Restart the Agent. Model switching under an enrolled provider keeps the same route. Rerun this command for new providers, changed upstreams or new project config. Already managed URLs are recognized; there is no automatic background enrollment. OpenCode hooks restart the daemon for known routes. After reboot or manually stopping the daemon, Qoder CN CLI users must rerun the explicit command before use.

To disable forwarding, close the Agent, manually restore each printed `latest.jsonc`, review later edits, then restart. There is no automatic uninstall/rollback; existing Trace data remains.

Set `AGENT_INSIGHT_INFERENCE_ANALYSIS_ORIGIN=http://192.0.2.20:8080` in the platform/container environment and restart the platform; no rebuild is needed. Use scheme, host and port only. Trace and LLM details offer inference analysis. Each link uses one `/model-performance?GlobalTrackNO=<UUID>`; retries are listed separately. IDs remain visible if the origin is unset.

Unknown or conflicting ownership stays Trace-only. Qoder failures or duplicate/missing response IDs cannot be assigned to a specific LLM. Historical data without gateway IDs receives no fabricated IDs. See the [contract](../../reference/observability/inference-correlation.md) and [canonical Chinese guide](../../../zh/how-to/observability/inference-gateway.md).

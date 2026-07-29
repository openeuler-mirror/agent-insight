# Codex Trace server adapter verification

This branch validates the server-side Codex Adapter and OTel aggregation layer.
Collector installation, relay, IDE extension, and soak checks are intentionally
kept in the companion client PR, where the corresponding scripts are present.

## Automated tests

```bash
node --import tsx --test \
  test/codex-adapter.test.ts \
  test/framework-adapter-registry.test.ts \
  test/otel-trace-aggregator.test.ts
```

The tests cover adapter selection, Agent/Skill/LLM/Tool/MCP mapping, cache token
projection, latest-snapshot retention, deterministic output, failed SubAgent
spawns, and both direct and tool-mediated nested SubAgent ancestry. The tests
run only against fixtures committed in this branch and require no collector or
editor installation.

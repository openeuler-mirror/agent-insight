# Qwen Code Native OTLP Integration

This integration enables Qwen Code's built-in OpenTelemetry exporter and sends
its native OTLP traces directly to Agent Insight.

## Install

From the Agent Insight repository:

```powershell
node scripts/qwencode-collector/install.mjs
```

The installer configures only Qwen-native telemetry variables in `~/.qwen/.env`:
`QWEN_TELEMETRY_ENABLED`, HTTP trace endpoint, OTLP authentication header, and
service name. It also removes only legacy `agent-insight-qwencode-*` hooks from
older collector versions; unrelated Qwen settings and hooks are preserved.

Restart Qwen Code after installation. The same hook configuration works for:

- interactive terminal sessions;
- Headless runs, for example `qwen -p "read package.json"`;
- Qwen Code IDE/Desktop integrations that use the same Qwen settings directory;
- daemon-backed sessions.

## Runtime data flow

```text
Qwen Code native Telemetry -> OTLP/HTTP
                             -> /api/ingest/otel/v1/traces
                             -> Qwen OTLP Adapter
                             -> Agent Insight trace view
```

Qwen handles OTLP batching and retry as its native telemetry exporter. Agent
Insight authenticates the OTLP request, isolates Qwen sessions from other
frameworks, and aggregates native interaction, LLM, Tool, and SubAgent spans.

## Configure endpoint and credentials

The default endpoint is the local Agent Insight service:

```text
http://127.0.0.1:3000/api/ingest/otel/v1/traces
```

Optional environment variables (put them in `~/.qwen/.env` or the process
environment):

```text
QWEN_TELEMETRY_ENABLED=true
QWEN_TELEMETRY_OTLP_PROTOCOL=http
QWEN_TELEMETRY_OTLP_TRACES_ENDPOINT=http://127.0.0.1:3000/api/ingest/otel/v1/traces
QWEN_TELEMETRY_OTLP_LOGS_ENDPOINT=http://127.0.0.1:3000/api/ingest/otel/v1/logs
QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES=true
OTEL_EXPORTER_OTLP_HEADERS=x-witty-api-key=your-agent-insight-key
OTEL_SERVICE_NAME=qwencode
```

The collector also reads your existing `DASHSCOPE_API_KEY` and `QWEN_MODEL`
from `~/.qwen/.env` through Qwen Code; they are not uploaded as trace content.

## Validate

1. Start Agent Insight.
2. Run a Qwen prompt that reads a file or invokes a tool.
3. Open `http://localhost:3000/trace` and filter the main Agent to
   `qwen-code`.
4. Inspect the timeline for Agent, LLM, Tool, Skill, MCP, Plan, Team, and
   SubAgent spans as applicable.

For a quick Headless check:

```powershell
qwen -p "Read package.json and report its name and version."
```

## MCP validation helper

`test-mcp-server.mjs` is a deterministic local stdio MCP server used only for
validating collector coverage. It exposes `get_project_metadata` and does not
read files, access the network, or modify the workspace. Register it at project
scope with:

```powershell
qwen.cmd mcp add agent-insight-test-mcp node "D:\agent-insight\scripts\qwencode-collector\test-mcp-server.mjs" --scope project --transport stdio
```

## Uninstall

```powershell
node scripts/qwencode-collector/uninstall.mjs
```

This removes only the native telemetry variables managed by Agent Insight and
legacy Agent Insight Qwen hooks. It does not delete Qwen conversations or other
collector configuration.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import { GET } from "@/app/api/ingest/setup/hermes-plugin/route"

test("Hermes plugin distribution serves the first-party standard-library plugin", async () => {
  const response = await GET()
  const source = await response.text()

  assert.equal(response.status, 200)
  assert.match(source, /def register\(ctx:/)
  assert.match(source, /"post_api_request"/)
  assert.match(source, /"api_request_error"/)
  assert.match(source, /"subagent_start"/)
  assert.match(source, /"subagent_stop"/)
  assert.match(source, /resourceSpans/)
  assert.match(source, /hermes-otel-spool/)
  assert.match(source, /hermes-plugin\.log/)
  assert.match(source, /os\.replace\(temp_path, path\)/)
  assert.match(source, /retry_base_seconds/)
  assert.doesNotMatch(source, /import opentelemetry/)
})

test("Hermes setup paths install the first-party plugin without GitHub or venv dependencies", () => {
  const files = [
    "src/app/api/ingest/setup/auto/route.ts",
  ]

  for (const file of files) {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8")
    assert.match(source, /api\/ingest\/setup\/hermes-plugin/)
    assert.match(source, /plugins[\\/]agent_insight_hermes/)
    assert.doesNotMatch(source, /briancaffey\/hermes-otel/)
    assert.doesNotMatch(source, /opentelemetry-exporter-otlp-proto-http/)
  }
})

test("Hermes plugin source imports and extracts normalized provider text", () => {
  const pluginPath = path.join(process.cwd(), "scripts/hermes_agent_insight_plugin.py")
  const script = [
    "import importlib.util",
    "import os",
    `spec = importlib.util.spec_from_file_location('agent_insight_hermes_test', ${JSON.stringify(pluginPath)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "assert module._response_text({'assistant_message': {'content': [{'type': 'text', 'text': 'canonical'}]}}) == 'canonical'",
    "assert module._response_text({'response': {'candidates': [{'content': {'parts': [{'text': 'candidate'}]}}]}}) == 'candidate'",
  ].join("\n")
  const result = spawnSync("python3", ["-c", script], { encoding: "utf8" })

  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test("Hermes plugin derives root agent name from active Hermes profile", () => {
  const pluginPath = path.join(process.cwd(), "scripts/hermes_agent_insight_plugin.py")
  const script = [
    "import importlib.util",
    "import os",
    "import sys",
    "import types",
    "hermes_cli = types.ModuleType(\"hermes_cli\")",
    "hermes_cli.__path__ = []",
    "profiles = types.ModuleType(\"hermes_cli.profiles\")",
    "profiles.get_active_profile_name = lambda: \"build\"",
    "sys.modules[\"hermes_cli\"] = hermes_cli",
    "sys.modules[\"hermes_cli.profiles\"] = profiles",
    `spec = importlib.util.spec_from_file_location("agent_insight_hermes_profile_test", ${JSON.stringify(pluginPath)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "os.environ.pop(\"HERMES_PROFILE\", None)",
    "os.environ[\"HERMES_HOME\"] = \"/tmp/hermes-root/profiles/demo\"",
    "assert module._profile_name_from_home_path(\"/tmp/hermes-root/profiles/demo\") == \"demo\"",
    "assert module._resolve_active_profile_name() == \"demo\"",
    "os.environ.pop(\"HERMES_HOME\", None)",
    "assert module._resolve_active_profile_name() == \"build\"",
    "assert module._agent_name_from_profile(\"default\") == \"hermes\"",
    "assert module._agent_name_from_profile(\"build\") == \"build\"",
    "collector = module._Collector.__new__(module._Collector)",
    "collector.config = {\"service_name\": \"hermes\"}",
    "collector.root_profile_name = \"build\"",
    "collector.root_agent_name = \"build\"",
    "collector.sessions = {\"root\": {\"root_session_id\": \"root\", \"role\": \"root\", \"agent_name\": \"build\", \"profile_name\": \"build\"}}",
    "attrs = collector._base_attributes(\"root\")",
    "assert attrs[\"hermes.agent.name\"] == \"build\"",
    "assert attrs[\"hermes.profile.name\"] == \"build\"",
    "collector.root_profile_name = \"default\"",
    "collector.root_agent_name = \"hermes\"",
    "collector.sessions = {\"root\": {\"root_session_id\": \"root\", \"role\": \"root\"}}",
    "attrs = collector._base_attributes(\"root\")",
    "assert attrs[\"hermes.agent.name\"] == \"hermes\"",
    "assert attrs[\"hermes.profile.name\"] == \"default\"",
  ].join("\n")
  const result = spawnSync("python3", ["-c", script], { encoding: "utf8" })

  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test("Hermes plugin retains root snapshots until all subagents finish", () => {
  const pluginPath = path.join(process.cwd(), "scripts/hermes_agent_insight_plugin.py")
  const script = [
    "import importlib.util",
    "import threading",
    `spec = importlib.util.spec_from_file_location('agent_insight_hermes_lifecycle_test', ${JSON.stringify(pluginPath)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "class Logger:",
    "    def write(self, level, message): pass",
    "class Exporter:",
    "    def __init__(self): self.logger = Logger(); self.flushes = 0; self.submissions = []",
    "    def flush(self): self.flushes += 1",
    "    def submit(self, root_id, payload): self.submissions.append((root_id, payload))",
    "collector = module._Collector.__new__(module._Collector)",
    "collector.config = {'service_name': 'hermes'}",
    "collector.max_chars = module.DEFAULT_MAX_CONTENT_CHARS",
    "collector.exporter = Exporter()",
    "collector.lock = threading.RLock()",
    "collector.sessions = {'root': {'root_session_id': 'root', 'role': 'root'}, 'child': {'root_session_id': 'root', 'parent_session_id': 'root', 'role': 'leaf'}}",
    "collector.turns = {}",
    "collector.current_turn = {}",
    "collector.api_spans = {}",
    "collector.tool_spans = {}",
    "existing_span = collector._new_span('api.test', 'root', '0000000000000000', None, {})",
    "collector.completed_by_root = {'root': {'existing': existing_span}}",
    "collector.ended_roots = set()",
    "task_span = collector._new_span('tool.task', 'root', '0000000000000001', None, {})",
    "agent_span = collector._new_span('agent.subagent.leaf', 'child', '0000000000000002', task_span['spanId'], {})",
    "collector.subagents = {'child': {'parent_session_id': 'root', 'task_span': task_span, 'agent_span': agent_span}}",
    "collector.on_session_end(session_id='child')",
    "assert 'root' in collector.completed_by_root",
    "assert 'child' in collector.subagents",
    "collector.on_session_end(session_id='root')",
    "assert 'root' in collector.completed_by_root",
    "assert 'root' in collector.ended_roots",
    "collector.subagent_stop(child_session_id='child', child_summary='done', child_status='completed')",
    "assert collector.exporter.submissions",
    "assert 'root' not in collector.completed_by_root",
    "assert 'root' not in collector.sessions",
    "assert 'child' not in collector.sessions",
    "assert 'root' not in collector.ended_roots",
  ].join("\n")
  const result = spawnSync("python3", ["-c", script], { encoding: "utf8" })

  assert.equal(result.status, 0, result.stderr || result.stdout)
})

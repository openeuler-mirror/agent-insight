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
    "src/app/api/ingest/setup/route.ts",
    "src/app/api/ingest/setup/auto/route.ts",
  ]

  for (const file of files) {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8")
    assert.match(source, /api\/setup\/hermes-plugin/)
    assert.match(source, /plugins[\\/]agent_insight_hermes/)
    assert.doesNotMatch(source, /briancaffey\/hermes-otel/)
    assert.doesNotMatch(source, /opentelemetry-exporter-otlp-proto-http/)
  }
})

test("Hermes plugin source imports and extracts normalized provider text", () => {
  const pluginPath = path.join(process.cwd(), "scripts/hermes_agent_insight_plugin.py")
  const script = [
    "import importlib.util",
    `spec = importlib.util.spec_from_file_location('agent_insight_hermes_test', ${JSON.stringify(pluginPath)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "assert module._response_text({'assistant_message': {'content': [{'type': 'text', 'text': 'canonical'}]}}) == 'canonical'",
    "assert module._response_text({'response': {'candidates': [{'content': {'parts': [{'text': 'candidate'}]}}]}}) == 'candidate'",
  ].join("\n")
  const result = spawnSync("python3", ["-c", script], { encoding: "utf8" })

  assert.equal(result.status, 0, result.stderr || result.stdout)
})

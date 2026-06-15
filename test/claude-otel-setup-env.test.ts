import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const SETUP_ROUTES = [
  'src/app/api/ingest/setup/route.ts',
  'src/app/api/ingest/setup/auto/route.ts',
];

test('Claude Code OTel setup preserves tool output sources in shell and PowerShell wrappers', () => {
  for (const route of SETUP_ROUTES) {
    const source = readFileSync(route, 'utf8');

    assert.match(
      source,
      /OTEL_LOG_TOOL_DETAILS=1[\s\S]*OTEL_LOG_TOOL_CONTENT=1[\s\S]*OTEL_LOG_RAW_API_BODIES/,
      `${route} should enable tool content in the shell wrapper`,
    );
    assert.match(
      source,
      /\$env:OTEL_LOG_TOOL_DETAILS = "1"[\s\S]*\$env:OTEL_LOG_TOOL_CONTENT = "1"[\s\S]*\$env:OTEL_LOG_RAW_API_BODIES/,
      `${route} should enable tool content in the PowerShell wrapper`,
    );
    assert.match(
      source,
      /AGENT_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES=file:[^\n]+claude_raw_bodies/,
      `${route} should default raw API bodies to file mode`,
    );
    assert.ok(
      source.includes('mkdir -p "$HOME/.agent-insight/claude_raw_bodies"'),
      `${route} should create and use the shell raw body directory`,
    );
    assert.match(
      source,
      /OTEL_LOG_RAW_API_BODIES="\\?\$\{AGENT_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES:-file:\$HOME\/\.agent-insight\/claude_raw_bodies\}"/,
      `${route} should default the shell wrapper to raw body file mode`,
    );
    assert.ok(
      source.includes('$rawBodyDir = Join-Path $env:USERPROFILE ".agent-insight\\\\claude_raw_bodies"') &&
        source.includes('AGENT_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES = "file:$rawBodyDir"'),
      `${route} should create and use the PowerShell raw body directory`,
    );
  }
});

test('setup scripts install the first-party Hermes plugin without GitHub or venv dependencies', () => {
  for (const route of SETUP_ROUTES) {
    const source = readFileSync(route, 'utf8');

    assert.ok(
      source.includes("{ name: 'Hermes', value: 'hermes' }") ||
        source.includes("{ name: \\'Hermes\\', value: \\'hermes\\' }"),
      `${route} should offer Hermes in the setup framework selector`,
    );
    assert.ok(source.includes('/api/setup/hermes-plugin'), `${route} should download the first-party plugin`);
    assert.ok(source.includes('plugins enable agent_insight_hermes'), `${route} should enable the first-party plugin`);
    assert.ok(
      !source.includes('plugins disable hermes_otel'),
      `${route} should leave independently configured Hermes plugins untouched`,
    );
    assert.match(
      source,
      /HERMES_HOME="\\?\$\{HERMES_HOME:-\$HOME\/\.hermes\}"/,
      `${route} should center Unix Hermes discovery on HERMES_HOME`,
    );
    assert.ok(
      source.includes('HERMES_PLUGIN_DIR="$HERMES_HOME/plugins/agent_insight_hermes"'),
      `${route} should install the Unix plugin under HERMES_HOME`,
    );
    assert.ok(
      source.includes('$hermesPluginDir = Join-Path $hermesHome "plugins\\\\agent_insight_hermes"'),
      `${route} should install the PowerShell plugin under HERMES_HOME`,
    );
    assert.ok(
      !source.includes('briancaffey/hermes-otel') &&
        !source.includes('opentelemetry-exporter-otlp-proto-http'),
      `${route} should not depend on GitHub or the OTel Python runtime`,
    );
    assert.ok(
      source.includes('plugin.yaml') && source.includes('config.json'),
      `${route} should write the Hermes manifest and JSON config`,
    );
    assert.ok(
      source.includes('"max_content_chars": 200000') ||
        source.includes('max_content_chars = 200000'),
      `${route} should configure high-fidelity Hermes content capture`,
    );
    assert.ok(source.includes('api_request_error'), `${route} should register Hermes API error telemetry`);
    assert.ok(
      source.includes('hermes-otel-spool'),
      `${route} should configure a durable Hermes snapshot spool`,
    );
    assert.ok(
      source.includes('hermes-plugin.log'),
      `${route} should configure the Hermes plugin log path`,
    );
    assert.ok(
      source.includes('"api_key":') || source.includes('api_key ='),
      `${route} should pass the platform API key to the plugin config`,
    );
  }
});

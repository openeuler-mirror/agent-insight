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

test('setup scripts include Hermes OTel plugin installation and high-fidelity config', () => {
  for (const route of SETUP_ROUTES) {
    const source = readFileSync(route, 'utf8');

    assert.ok(
      source.includes("{ name: 'Hermes', value: 'hermes' }") ||
        source.includes("{ name: \\'Hermes\\', value: \\'hermes\\' }"),
      `${route} should offer Hermes in the setup framework selector`,
    );
    assert.ok(
      source.includes('hermes plugins install briancaffey/hermes-otel --enable'),
      `${route} should install and enable the upstream hermes-otel plugin`,
    );
    assert.match(
      source,
      /HERMES_HOME="\\?\$\{HERMES_HOME:-\$HOME\/\.hermes\}"/,
      `${route} should center Unix Hermes discovery on HERMES_HOME`,
    );
    assert.ok(
      source.includes('HERMES_AGENT_DIR="$HERMES_HOME/hermes-agent"') &&
        source.includes('HERMES_OTEL_PLUGIN_DIR="$HERMES_HOME/plugins/hermes_otel"'),
      `${route} should use HERMES_HOME for Hermes agent and plugin paths`,
    );
    assert.ok(
      source.includes('$hermesAgentDir = Join-Path $hermesHome "hermes-agent"') &&
        source.includes('$hermesOtelPluginDir = Join-Path $hermesHome "plugins\\\\hermes_otel"'),
      `${route} should use HERMES_HOME for PowerShell Hermes agent and plugin paths`,
    );
    assert.ok(
      source.includes('opentelemetry-exporter-otlp-proto-http pyyaml'),
      `${route} should install OTel runtime dependencies into the Hermes runtime`,
    );
    assert.ok(
      source.includes('install -e "$HERMES_OTEL_PLUGIN_DIR"') ||
        source.includes('install -e $hermesOtelPluginDir'),
      `${route} should install the plugin package in editable mode into the Hermes runtime`,
    );
    assert.ok(
      source.includes('capture_full_responses: true') &&
        source.includes('capture_conversation_history: true') &&
        source.includes('preview_max_chars: 4000'),
      `${route} should write high-fidelity Hermes capture settings`,
    );
    assert.ok(
      source.includes('/api/ingest/otel/v1/traces') &&
        source.includes('x-witty-api-key'),
      `${route} should point Hermes OTel to the platform trace endpoint with API key header`,
    );
  }
});

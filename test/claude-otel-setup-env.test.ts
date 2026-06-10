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

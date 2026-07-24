import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { GET as getSetup } from '@/app/api/ingest/setup/route';
import { GET as getAutoSetup } from '@/app/api/ingest/setup/auto/route';

type SetupRoute = {
  name: string;
  get: (request: Request) => Promise<Response>;
  url: string;
};

const routes: SetupRoute[] = [
  {
    name: 'setup',
    get: getSetup,
    url: 'http://localhost/api/ingest/setup?key=test-key',
  },
  {
    name: 'auto setup',
    get: getAutoSetup,
    url: 'http://localhost/api/setup/auto?apiKey=test-key&host=http%3A%2F%2Flocalhost%3A3000',
  },
];

function codeAgentSection(script: string, startMarker: string, endMarker: string): string {
  const start = script.indexOf(startMarker);
  assert.ok(start >= 0, `CodeAgent wrapper marker should exist: ${startMarker}`);
  const end = script.indexOf(endMarker, start);
  assert.ok(end > start, `CodeAgent wrapper should end with ${endMarker}`);
  return script.slice(start, end);
}

test('curl setup scripts offer CodeAgent and generate a valid Unix wrapper', async () => {
  for (const route of routes) {
    const response = await route.get(new Request(route.url, {
      headers: { 'x-platform': 'unix', host: 'localhost:3000' },
    }));
    const script = await response.text();
    const section = codeAgentSection(script, '# Agent-Insight CodeAgent OpenTelemetry integration', 'CODEAGENT_OTEL_EOF');

    assert.equal(response.status, 200, route.name);
    assert.match(script, /CodeAgent[^\n]+codeagent/);
    assert.match(script, /INSTALL_CODEAGENT=false/);
    assert.match(script, /AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR=.*otel_data\/codeagent/);
    assert.match(section, /codeagent_insight\(\)/);
    assert.match(section, /CODEAGENT3_ENABLE_TELEMETRY=1/);
    assert.match(section, /OTEL_EXPORTER_OTLP_ENDPOINT="\$_si_host\/api\/ingest\/otel"/);
    assert.match(section, /OTEL_EXPORTER_OTLP_PROTOCOL=http\/json/);
    assert.match(section, /OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http\/json/);
    assert.doesNotMatch(section, /OTEL_(?:TRACES|METRICS)_EXPORTER/);

    const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    assert.equal(syntax.status, 0, `${route.name}: ${syntax.stderr}`);
  }
});

test('curl setup scripts generate the equivalent CodeAgent PowerShell wrapper', async () => {
  for (const route of routes) {
    const response = await route.get(new Request(route.url, {
      headers: { 'x-platform': 'windows', host: 'localhost:3000' },
    }));
    const script = await response.text();
    const section = codeAgentSection(script, 'function Invoke-AgentInsightCodeAgent', 'Set-Alias codeagent-insight');

    assert.equal(response.status, 200, route.name);
    assert.match(script, /CodeAgent[^\n]+codeagent/);
    assert.match(script, /\$INSTALL_CODEAGENT = \$false/);
    assert.match(script, /AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR=.*otel_data\\codeagent/);
    assert.match(section, /function Invoke-AgentInsightCodeAgent/);
    assert.match(section, /\$env:CODEAGENT3_ENABLE_TELEMETRY = "1"/);
    assert.match(section, /\$env:OTEL_EXPORTER_OTLP_ENDPOINT = "\$siHost\/api\/ingest\/otel"/);
    assert.match(section, /\$env:OTEL_EXPORTER_OTLP_PROTOCOL = "http\/json"/);
    assert.match(section, /\$env:OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http\/json"/);
    assert.doesNotMatch(section, /OTEL_(?:TRACES|METRICS)_EXPORTER/);
  }
});

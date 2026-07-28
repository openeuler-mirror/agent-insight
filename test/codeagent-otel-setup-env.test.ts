import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('curl setup scripts offer CodeAgent and generate a valid same-name Unix wrapper', async () => {
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
    assert.match(section, /codeagent\(\)/);
    assert.match(section, /    codeagent "\$@"/);
    assert.doesNotMatch(section, /codeagent_insight/);
    assert.match(section, /CODEAGENT3_ENABLE_TELEMETRY=1/);
    assert.match(section, /OTEL_EXPORTER_OTLP_ENDPOINT="\$_si_host\/api\/ingest\/otel"/);
    assert.match(section, /OTEL_EXPORTER_OTLP_PROTOCOL=http\/json/);
    assert.match(section, /OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http\/json/);
    assert.doesNotMatch(section, /OTEL_(?:TRACES|METRICS)_EXPORTER/);

    const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    assert.equal(syntax.status, 0, `${route.name}: ${syntax.stderr}`);
  }
});

test('Unix wrapper injects OTel into the original codeagent command only', async (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), 'codeagent-otel-wrapper-'));
  const binDir = join(homeDir, 'bin');
  const configDir = join(homeDir, '.agent-insight');
  const codeAgentBin = join(binDir, 'codeagent');

  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(binDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, '.env'), 'AGENT_INSIGHT_HOST=collector.example:4318\nAGENT_INSIGHT_API_KEY=runtime-key\n');
  writeFileSync(codeAgentBin, [
    '#!/usr/bin/env bash',
    'printf "ENABLED=%s\\n" "$CODEAGENT3_ENABLE_TELEMETRY"',
    'printf "ENDPOINT=%s\\n" "$OTEL_EXPORTER_OTLP_ENDPOINT"',
    'printf "HEADERS=%s\\n" "$OTEL_EXPORTER_OTLP_HEADERS"',
    'printf "ARGS=%s\\n" "$*"',
  ].join('\n'));
  chmodSync(codeAgentBin, 0o755);

  for (const route of routes) {
    const response = await route.get(new Request(route.url, {
      headers: { 'x-platform': 'unix', host: 'localhost:3000' },
    }));
    const script = await response.text();
    const section = codeAgentSection(script, '# Agent-Insight CodeAgent OpenTelemetry integration', 'CODEAGENT_OTEL_EOF');
    const probe = spawnSync('bash', ['-c', `${section}\ncodeagent probe\nprintf "PARENT=%s\\n" "\${CODEAGENT3_ENABLE_TELEMETRY-}"`], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: homeDir,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
    });

    assert.equal(probe.status, 0, `${route.name}: ${probe.stderr}`);
    assert.match(probe.stdout, /ENABLED=1/);
    assert.match(probe.stdout, /ENDPOINT=http:\/\/collector\.example:4318\/api\/ingest\/otel/);
    assert.match(probe.stdout, /HEADERS=x-witty-api-key=runtime-key/);
    assert.match(probe.stdout, /ARGS=probe/);
    assert.match(probe.stdout, /PARENT=$/m);
  }
});

test('curl setup scripts generate the equivalent CodeAgent PowerShell wrapper', async () => {
  for (const route of routes) {
    const response = await route.get(new Request(route.url, {
      headers: { 'x-platform': 'windows', host: 'localhost:3000' },
    }));
    const script = await response.text();
    const section = codeAgentSection(script, 'function Invoke-AgentInsightCodeAgent', 'Set-Alias codeagent');

    assert.equal(response.status, 200, route.name);
    assert.match(script, /CodeAgent[^\n]+codeagent/);
    assert.match(script, /\$INSTALL_CODEAGENT = \$false/);
    assert.match(script, /AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR=.*otel_data\\codeagent/);
    assert.match(section, /function Invoke-AgentInsightCodeAgent/);
    assert.match(script, /Set-Alias codeagent Invoke-AgentInsightCodeAgent/);
    assert.doesNotMatch(section, /codeagent-insight/);
    assert.match(section, /\$env:CODEAGENT3_ENABLE_TELEMETRY = "1"/);
    assert.match(section, /\$env:OTEL_EXPORTER_OTLP_ENDPOINT = "\$siHost\/api\/ingest\/otel"/);
    assert.match(section, /\$env:OTEL_EXPORTER_OTLP_PROTOCOL = "http\/json"/);
    assert.match(section, /\$env:OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http\/json"/);
    assert.doesNotMatch(section, /OTEL_(?:TRACES|METRICS)_EXPORTER/);
  }
});

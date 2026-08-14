import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GET as getSetup } from '@/app/api/ingest/setup/route';
import { GET as getAutoSetup } from '@/app/api/ingest/setup/auto/route';
import { ACTRAIL_UNIX_SETUP_BLOCK } from '@/app/api/ingest/setup/actrail-setup';

const routes = [
  {
    name: 'setup',
    get: getSetup,
    url: 'http://localhost/api/ingest/setup?yes=1&frameworks=actrail&key=test-key',
  },
  {
    name: 'auto setup',
    get: getAutoSetup,
    url: 'http://localhost/api/ingest/setup/auto?apiKey=test-key&host=http%3A%2F%2Flocalhost%3A3000',
  },
];

test('Unix curl setup configures AcTrail otel-http without installing AcTrail', async () => {
  for (const route of routes) {
    const response = await route.get(new Request(route.url, {
      headers: { 'x-platform': 'unix', host: 'localhost:3000' },
    }));
    const script = await response.text();

    assert.equal(response.status, 200, route.name);
    assert.match(script, /AcTrail[^\n]+actrail/);
    assert.match(script, /INSTALL_ACTRAIL=false/);
    assert.match(script, /attribute_mode = "full"/);
    assert.match(script, /encoding = "protobuf"/);
    assert.match(script, /name = "x-witty-api-key"/);
    assert.match(script, /api\/ingest\/otel\/v1\/traces/);
    assert.match(script, /plugin load/);
    assert.match(script, /--persist/);
    assert.match(script, /otel-http\.plugin\.toml/);
    assert.match(script, /ACTRAIL_OPERATOR_CONFIG/);
    assert.doesNotMatch(script, /install-release\.sh/);
    assert.doesNotMatch(script, /cargo install[^\n]*actrail/i);

    const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    assert.equal(syntax.status, 0, `${route.name}: ${syntax.stderr}`);
  }
});

test('AcTrail Unix setup writes a full authenticated config and persistently loads the plugin', (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), 'actrail-setup-'));
  const binDir = join(homeDir, 'bin');
  const pluginRoot = join(homeDir, '.actrail', 'plugins');
  const manifestDir = join(pluginRoot, 'otel-http');
  const operatorConfig = join(homeDir, 'actraild.conf');
  const commandLog = join(homeDir, 'actraild.log');
  const actraild = join(binDir, 'actraild');
  const sudo = join(binDir, 'sudo');

  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(binDir, { recursive: true });
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(operatorConfig, '[general]\n');
  writeFileSync(join(manifestDir, 'otel-http.plugin.toml'), '[general]\nid = "otel-http"\n');
  writeFileSync(actraild, [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "$ACTRAIL_TEST_LOG"',
    'case "$*" in *"plugin status"*) exit 1 ;; esac',
    'exit 0',
  ].join('\n'));
  writeFileSync(sudo, '#!/usr/bin/env bash\nexec "$@"\n');
  chmodSync(actraild, 0o755);
  chmodSync(sudo, 0o755);

  const run = spawnSync('bash', ['-c', ACTRAIL_UNIX_SETUP_BLOCK], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      INSTALL_ACTRAIL: 'true',
      FINAL_HOST: 'https://collector.example/base',
      FINAL_KEY: 'test-"key',
      ACTRAIL_OPERATOR_CONFIG: operatorConfig,
      ACTRAIL_PLUGIN_DIR: pluginRoot,
      ACTRAIL_TEST_LOG: commandLog,
    },
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /已完成 AcTrail 数据对接配置/);
  const configPath = join(homeDir, '.agent-insight', 'actrail', 'otel-http.config.toml');
  const config = readFileSync(configPath, 'utf8');
  assert.match(config, /^endpoint = "https:\/\/collector\.example\/base\/api\/ingest\/otel\/v1\/traces"$/m);
  assert.match(config, /^allow_insecure = false$/m);
  assert.match(config, /^attribute_mode = "full"$/m);
  assert.match(config, /^name = "x-witty-api-key"$/m);
  assert.equal(
    config.split('\n').find(line => line.startsWith('value = ')),
    'value = ' + JSON.stringify('test-"key'),
  );
  assert.equal(statSync(configPath).mode & 0o777, 0o600);

  const commands = readFileSync(commandLog, 'utf8');
  assert.match(commands, /plugin load/);
  assert.match(commands, /--manifest .*otel-http\.plugin\.toml/);
  assert.match(commands, /--plugin-config .*otel-http\.config\.toml/);
  assert.match(commands, /--instance agent-insight\.otel-http/);
  assert.match(commands, /--persist/);
});

test('PowerShell curl setup directs AcTrail users to WSL', async () => {
  for (const route of routes) {
    const response = await route.get(new Request(route.url, {
      headers: { 'x-platform': 'windows', host: 'localhost:3000' },
    }));
    const script = await response.text();

    assert.equal(response.status, 200, route.name);
    assert.match(script, /AcTrail[^\n]+actrail/);
    assert.match(script, /\$INSTALL_ACTRAIL = \$false/);
    assert.match(script, /AcTrail 仅支持 Linux\/WSL/);
    assert.match(script, /Unix curl setup/);
  }
});

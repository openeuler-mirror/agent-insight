/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GET as setup } from '@/app/api/ingest/setup/route';
import { GET as autoSetup } from '@/app/api/ingest/setup/auto/route';
import { FRAMEWORK_OPTIONS, parseFrameworks } from '@/lib/ingest/setup/install-profile';
import * as installProfile from '@/lib/ingest/setup/install-profile';

const endpoint = 'https://insight.example/prefix/api/ingest/otel/v1/traces';
const apiKey = "fake'key,with=$dollar";

async function script(auto = false, frameworks = 'dify', platform = 'unix') {
  const query = new URLSearchParams({ frameworks, key: apiKey, apiKey, yes: '1', nokey: '1', host: 'insight.example' });
  const handler = auto ? autoSetup : setup;
  const response = await handler(new Request(`https://insight.example/prefix/api/ingest/setup${auto ? '/auto' : ''}?${query}`, {
    headers: { host: 'insight.example', 'x-forwarded-proto': 'https', 'x-platform': platform },
  }));
  assert.equal(response.status, 200);
  return response.text();
}

function fixture(options: { agent?: boolean; ignoreConfig?: boolean; failUp?: boolean; failProbe?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-dify-setup-'));
  const project = path.join(root, 'dify', 'docker');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(project, 'docker-compose.yaml'), 'services: {}\n');
  const originalEnv = 'DATABASE_PASSWORD=keep-private-value\nENABLE_OTEL=false\n# user comment\n';
  fs.writeFileSync(path.join(project, '.env'), originalEnv);
  const docker = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require(${JSON.stringify(require.resolve('dotenv'))});
const args = process.argv.slice(2);
const root = process.env.DIFY_FIXTURE_ROOT;
const envFile = path.join(root, 'dify/docker/.env');
const values = Object.fromEntries(Object.entries(dotenv.parse(fs.readFileSync(envFile)))
  .map(([k,v]) => [k, v.replace(/\\'/g, "'").replace(/\\\\/g, '\\')]));
const names = ['api', 'worker', ${options.agent === false ? '' : "'agent_backend'"}].filter(Boolean);
const services = Object.fromEntries(names.map(name => [name, {
  image: name === 'agent_backend' ? 'langgenius/dify-agent-backend:1.18.0' : 'langgenius/dify-api:1.18.0',
  environment: {...values, MODE: name, ${options.ignoreConfig ? "ENABLE_OTEL: 'false'," : ''}},
}]));
if (args[0] === 'info') console.log('Docker Desktop');
else if (args.includes('config')) {
  for (const service of Object.values(services)) {
    service.environment = Object.fromEntries(Object.entries(service.environment).map(([k,v]) => [k,v.replaceAll('$','$$')]));
  }
  console.log(JSON.stringify({services}));
}
else if (args.includes('up')) {
  fs.appendFileSync(path.join(root, 'up.jsonl'), JSON.stringify(args) + '\n');
  process.exit(${options.failUp ? 1 : 0});
} else if (args.includes('ps')) console.log('container-' + args[args.length-1]);
else if (args[0] === 'inspect') {
  const name = args[args.length-1].replace('container-', '');
  console.log(JSON.stringify([{State: {Running: true}, Config: {Env: Object.entries(services[name].environment).map(([k,v]) => k+'='+v)}}]));
} else if (args.includes('exec')) {
  fs.readFileSync(0, 'utf8');
  process.exit(${options.failProbe ? 1 : 0});
} else process.exit(2);
`;
  fs.writeFileSync(path.join(bin, 'docker'), docker, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DIFY_FIXTURE_ROOT: root,
    AGENT_INSIGHT_DIFY_ENDPOINT: endpoint, AGENT_INSIGHT_DIFY_DIR: project };
  delete env.AGENT_INSIGHT_DATA_DIR;
  const run = (body: string) => {
    assert.match(body, /agent_insight_setup_dify/, 'Dify must use its own configuration stage before executing a generated installer');
    return spawnSync('bash', ['-c', body], { cwd: path.dirname(project), env, encoding: 'utf8', timeout: 30_000 });
  };
  return { root, project, originalEnv, env, run, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('Dify is a unified framework selection and never falls back to OpenCode', async () => {
  assert.deepEqual(parseFrameworks('dify'), [{ value: 'dify', label: 'Dify' }]);
  assert.ok(FRAMEWORK_OPTIONS.some(f => f.value === 'dify'));
  for (const auto of [false, true]) {
    const bash = await script(auto);
    assert.match(bash, /agent_insight_setup_dify/);
    assert.doesNotMatch(bash, /npm install|Registering resident client|INSTALL_OPENCODE=true/);
    assert.equal(spawnSync('bash', ['-n'], { input: bash, encoding: 'utf8' }).status, 0);
    const windows = await script(auto, 'dify', 'windows');
    assert.match(windows, /throw .*Dify.*WSL/);
    assert.doesNotMatch(windows, /INSTALL_OPENCODE = \$true/);
  }
});

test('mixed framework installs include the same Dify stage and fail closed if it fails', async () => {
  for (const auto of [false, true]) {
    const bash = await script(auto, 'dify,opencode');
    assert.match(bash, /INSTALL_DIFY=true/);
    assert.match(bash, /agent_insight_setup_dify.*(?:FINAL_HOST|AGENT_INSIGHT_HOST|https:\/\/insight.example)/);
    assert.match(bash, /agent_insight_setup_dify[^\n]*\|\| exit 1/);
    assert.equal(spawnSync('bash', ['-n'], { input: bash, encoding: 'utf8' }).status, 0);
  }
});

test('Dify setup backs up configuration, configures both pipelines and recreates only their services idempotently', async () => {
  const f = fixture();
  try {
    const bash = await script();
    const first = f.run(bash);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const content = fs.readFileSync(path.join(f.project, '.env'), 'utf8');
    assert.ok(content.startsWith(f.originalEnv));
    assert.match(content, /DIFY_AGENT_TRAJECTORY_ENABLED=/);
    assert.match(content, /OTEL_EXPORTER_OTLP_TRACES_HEADERS=/);
    assert.doesNotMatch(first.stdout + first.stderr, /keep-private-value|fake'key/);
    const backups = fs.readdirSync(f.project).filter(name => name.startsWith('.env.agent-insight-backup-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(f.project, backups[0]), 'utf8'), f.originalEnv);
    assert.equal(fs.statSync(path.join(f.project, backups[0])).mode & 0o777, 0o600);
    const calls = fs.readFileSync(path.join(f.root, 'up.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls[0].slice(-3), ['api', 'worker', 'agent_backend']);
    assert.ok(calls[0].includes('--no-deps'));
    assert.match(first.stdout, /运行.*任务|run.*task/i);
    assert.equal(f.run(bash).status, 0);
    assert.equal(fs.readFileSync(path.join(f.project, '.env'), 'utf8'), content);
    assert.equal(fs.readdirSync(f.project).filter(name => name.startsWith('.env.agent-insight-backup-')).length, 1);
  } finally { f.dispose(); }
});

for (const [name, options] of [
  ['configuration not injected', { ignoreConfig: true }],
  ['container recreation failed', { failUp: true }],
  ['receiver probe failed', { failProbe: true }],
] as const) test(`Dify setup does not claim readiness when ${name}`, async () => {
  const f = fixture(options);
  try {
    const result = f.run(await script());
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /Telemetry: READY|接入配置已生效/);
    assert.doesNotMatch(result.stdout + result.stderr, /keep-private-value|fake'key/);
    if (options.ignoreConfig) {
      assert.equal(fs.readFileSync(path.join(f.project, '.env'), 'utf8'), f.originalEnv);
      assert.equal(fs.existsSync(path.join(f.root, 'up.jsonl')), false);
    }
  } finally { f.dispose(); }
});

test('Workflow-only deployments report the missing native Agent pipeline explicitly', async () => {
  const f = fixture({ agent: false });
  try {
    const result = f.run(await script(true));
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /未发现.*Agent|Agent.*not found/i);
    assert.doesNotMatch(result.stdout, /Workflow.*Agent.*均已/);
  } finally { f.dispose(); }
});

test('unsupported deployment paths are not silently configured', async () => {
  const f = fixture();
  try {
    f.env.AGENT_INSIGHT_DIFY_DIR = path.join(f.root, 'missing');
    const result = f.run(await script());
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(path.join(f.project, '.env'), 'utf8'), f.originalEnv);
    assert.equal(fs.existsSync(path.join(f.root, 'up.jsonl')), false);
  } finally { f.dispose(); }
});

test('Dify endpoint overrides reject credentials and script injection without changing other install commands', () => {
  const { isDifyOtlpEndpoint, withDifyEndpoint } = installProfile as any;
  assert.equal(typeof withDifyEndpoint, 'function');
  assert.equal(isDifyOtlpEndpoint('https://user:secret@insight.example/traces'), false);
  assert.equal(isDifyOtlpEndpoint('https://insight.example/traces\nexit 0'), false);
  assert.equal(withDifyEndpoint('curl test | bash', ''), 'curl test | bash');
  assert.equal(withDifyEndpoint('curl test | bash', 'file:///etc/passwd'), '');
  assert.match(withDifyEndpoint('curl test | EXISTING=x bash', endpoint), /EXISTING=x AGENT_INSIGHT_DIFY_ENDPOINT=/);
  for (const part of ['$&', '$$', "$'", '$`']) {
    const url = `https://insight.example/path${part}/traces`;
    const quoted = `'${url.replaceAll("'", "'\\''")}'`;
    assert.equal(withDifyEndpoint('curl test | bash', url), `curl test | AGENT_INSIGHT_DIFY_ENDPOINT=${quoted} bash`);
  }
});

test('Dify discovery retains the original deployment directory after an interactive selector changes cwd', async () => {
  const f = fixture();
  try {
    delete f.env.AGENT_INSIGHT_DIFY_DIR;
    f.env.SETUP_WORKING_DIR = path.dirname(f.project);
    const result = spawnSync('bash', ['-c', await script()], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally { f.dispose(); }
});

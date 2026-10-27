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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const { inspectOpencodeRuntime } = require('../scripts/opencode-runtime.cjs');
const { prepareOpencodeEventChannel } = require('../scripts/opencode-experiment-events.cjs');
const client = require('../scripts/reliability-client.cjs');

function fixture(version: string, flags: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-opencode-runtime-'));
  const bin = path.join(root, 'opencode');
  fs.writeFileSync(bin, `#!${process.execPath}\nif(process.argv.includes('--version')) console.log(${JSON.stringify(version)});else console.error(${JSON.stringify(flags)});`, { mode: 0o755 });
  return { root, bin, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('OpenCode readiness validates native flags, stderr help, missing binaries and unsupported versions', () => {
  const flags = 'run --format json --agent --model --title --command';
  for (const [version, help, ready] of [['1.14.39', flags, true], ['opencode v2.1.4', flags + ' --standalone --session', true],
    ['opencode v2.1.4', flags, false], ['3.0.0', flags, false], ['unknown', flags, false]]) {
    const f = fixture(String(version), String(help));
    try { assert.equal(inspectOpencodeRuntime(f.bin).ready, ready); }
    finally { f.close(); }
  }
  assert.equal(inspectOpencodeRuntime('/missing/opencode').canResolveTraceId, false);
});

test('v2 invocations isolate the server and preallocate a unique session; v1 keeps native slash commands', () => {
  const input = { platform: 'opencode', agent: 'build', model: 'local/model', input: '/command preserve input', correlation: { caseRunId: 'case-1' } };
  for (const major of [1, 2]) {
    const f = fixture(`${major}.1.4`, 'run --format json --agent --model --title --command --standalone --session');
    try {
      const a = client.buildExperimentCaseInvocation(f.bin, input);
      const b = client.buildExperimentCaseInvocation(f.bin, input);
      assert.equal(a.args.includes('--standalone'), major === 2);
      if (major === 2) {
        assert.notEqual(a.sessionId, b.sessionId);
        assert.equal(a.args[a.args.indexOf('--session') + 1], a.sessionId);
        assert.equal(a.stdin, input.input);
        assert.equal(a.args.includes('--command'), false);
      } else {
        assert.equal(a.stdin, null);
        assert.equal(a.args.includes('--command'), true);
      }
    } finally { f.close(); }
  }
});

test('v2 event channel packages a private plugin directory, preserves user config and cleans up', () => {
  const config = { plugins: ['custom-plugin'], provider: { local: {} } };
  const channel = prepareOpencodeEventChannel({ OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, 2);
  const merged = JSON.parse(channel.env.OPENCODE_CONFIG_CONTENT);
  const directory = merged.plugins.at(-1);
  try {
    assert.equal(merged.plugins[0], 'custom-plugin');
    assert.deepEqual(merged.provider, config.provider);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(channel.eventFile).mode & 0o777, 0o600);
    assert.ok(fs.existsSync(path.join(directory, 'index.js')));
  } finally { channel.cleanup(); }
  assert.equal(fs.existsSync(directory), false);
});

test('capabilities require discovered Agents and separate ordinary v2 execution from v1 Skill modes', () => {
  const previousPath = process.env.PATH;
  for (const major of [1, 2]) {
    const f = fixture(`${major}.1.4`, 'run --format json --agent --model --title --standalone --session');
    process.env.PATH = `${f.root}:/usr/bin:/bin`;
    try {
      const capabilities = (agents: string[]) => client.buildCapabilities({ maxParallelFi: 1 }, {
        probe: { ready: true, platforms: { opencode: { agents, models: [] } } },
      }).platforms.find((item: { id: string }) => item.id === 'opencode').runExperimentCase;
      assert.equal(capabilities(['build']).ready, true);
      assert.equal(capabilities(['build']).skillSnapshotVersion, major === 1 ? 4 : undefined);
      assert.equal(capabilities([]).ready, false);
      assert.match(capabilities([]).unavailableReason, /Agent/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      f.close();
    }
  }
});

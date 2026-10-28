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
import { createServer } from 'node:http';
import test from 'node:test';
const cli = process.env.OPENCODE_V2_SKILL_TEST_CLI;
const client = require('../scripts/reliability-client.cjs');
const workspace = require('../scripts/skill-experiment-workspace.cjs');

test('native OpenCode v2 isolates A/B and baseline, emits real Skill routing and preserves read-only tools', { skip: !cli, timeout: 180_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-v2-skill-native-'));
  const previous = { ...process.env };
  let mode = 'case', requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); requests.push(input);
    const main = Array.isArray(input.tools);
    const loaded = input.messages?.some((m: any) => m.role === 'tool');
    const call = main && !loaded && mode !== 'baseline';
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_target', type: 'function', function: { name: 'skill', arguments: JSON.stringify({ id: 'target' }) } }] }
      : { role: 'assistant', content: 'VERIFIED' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }]) {
      res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: input.model, choices: [{ index: 0, ...choice }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    Object.assign(process.env, {
      HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root, PWD: root,
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
      OPENCODE_CONFIG_DIR: path.join(root, 'config/opencode'), OPENCODE_DISABLE_MODELS_FETCH: 'true',
      AGENT_INSIGHT_HOME: path.join(root, 'insight'), PATH: `${root}:${previous.PATH}`,
    });
    fs.symlinkSync(cli!, path.join(root, 'opencode'));
    fs.mkdirSync(process.env.OPENCODE_CONFIG_DIR!, { recursive: true });
    fs.writeFileSync(path.join(process.env.OPENCODE_CONFIG_DIR!, 'opencode.json'), JSON.stringify({ providers: { mock: {
      package: '@opencode/ai/providers/openai-compatible', settings: { apiKey: 'native-fixture-key', baseURL: `http://127.0.0.1:${(server.address() as any).port}/v1` },
      models: { mock: { name: 'Mock', limit: { context: 16384, output: 512 } } },
    } }, model: 'mock/mock' }));
    for (const source of ['config/opencode/skills/target', '.claude/skills/foreign', '.agents/skills/foreign']) {
      fs.mkdirSync(path.join(root, source), { recursive: true });
      fs.writeFileSync(path.join(root, source, 'SKILL.md'), '---\nname: foreign\ndescription: HOST_POISON\n---\nHOST_POISON');
    }
    const payload = { platform: 'opencode', agent: 'build', model: 'mock/mock', input: 'Perform this evaluation.', timeoutSeconds: 30, startupTimeoutSeconds: 60 };
    const skill = (version: number) => ({ name: 'target', version, files: { 'SKILL.md': `---\nname: target\ndescription: Frozen evaluation skill\n---\nFROZEN_VERSION_${version}` } });
    for (const version of [2, 3]) {
      requests = []; mode = 'case';
      const result = await client.runExperimentCase({ clientId: 'native-fixture', workspaceBase: root }, { ...payload, skillExecution: { version: 1, skill: skill(version) } });
      assert.ok(result.traceId);
      const transcript = JSON.stringify(requests);
      assert.match(transcript, new RegExp(`FROZEN_VERSION_${version}`));
      assert.doesNotMatch(transcript, /HOST_POISON/);
      assert.doesNotMatch(transcript, new RegExp(`FROZEN_VERSION_${version === 2 ? 3 : 2}`));
    }
    mode = 'baseline'; requests = [];
    await client.runExperimentCase({ clientId: 'native-fixture', workspaceBase: root }, { ...payload, skillExecution: { version: 1, skill: null } });
    assert.doesNotMatch(JSON.stringify(requests), /HOST_POISON|FROZEN_VERSION/);
    mode = 'trigger'; requests = [];
    const hit = await client.runExperimentCase({ clientId: 'native-fixture', workspaceBase: root }, { ...payload, skillExecution: { version: 2, mode: 'trigger', targetSkillName: 'target', skills: [skill(2)] } });
    assert.equal(hit.triggerDecision.triggered, true);
    const tools = requests.flatMap(r => r.tools || []).map((tool: any) => tool.function.name);
    assert.ok(tools.includes('skill'));
    for (const denied of ['shell', 'write', 'edit', 'subagent', 'webfetch', 'websearch']) assert.ok(!tools.includes(denied), denied);
    t.diagnostic('Real v2 CLI, local model fixture: distinct A/B snapshots, host Skill exclusion, empty baseline and native id-based trigger verified.');
  } finally {
    workspace.clearTriggerWorkspaces();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

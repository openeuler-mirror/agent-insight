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
import { isTraceGenerationFailureRetryable } from '../src/lib/engine/experiment/trace-retry-policy';
import { skillExecutionCapabilityIssue } from '../src/lib/skill-workbench/experiment-policy';
const { prepareSkillExperimentWorkspace: prepare } = require('../scripts/skill-experiment-workspace.cjs');
const { loadOpenCodeV2ConnectionConfig: load } = require('../scripts/opencode-connection-config.cjs');
const { prepareOpencodeEventChannel } = require('../scripts/opencode-experiment-events.cjs');
const skill = { name: 'target', version: 2, files: { 'SKILL.md': '---\nname: target\ndescription: test\n---\nFrozen version two' } };

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-skill-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'opencode');
  const data = path.join(root, 'fixture.json');
  fs.writeFileSync(data, JSON.stringify({ entries: [{ type: 'document', info: {
    providers: { local: { settings: { apiKey: 'fixture-secret' } } }, agents: { custom: { system: 'Original prompt', model: { providerID: 'local', model: 'model' } } },
  } }] }));
  fs.writeFileSync(bin, `#!${process.execPath}
const fs=require('fs'), input=JSON.parse(fs.readFileSync(${JSON.stringify(data)}));
const args=process.argv.slice(2);
if(args[0]==='--version') console.log('opencode v2.1.4');
else if(args.includes('--help')) console.log('run --format json --agent --model --title --standalone --session');
else if(args.includes('config.get')) console.log(JSON.stringify(process.env.OPENCODE_CONFIG_CONTENT
 ? [{type:'document',info:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)},...(input.external ? [{type:'directory',path:'/outside/config'}]:[])] : input.entries));
else if(args.includes('model.list')) console.log(JSON.stringify({data:[{id:'model',providerID:'local',enabled:true}]}));
else if(args.includes('agent.list')) console.log(JSON.stringify({data:[]}));
else process.exit(1);
`, { mode: 0o700 });
  return { root, bin, data };
}

test('v2 native source parsing preserves resolved connection config, and rejects masked values', t => {
  const f = fixture(t);
  const config = load(f.bin, { agent: 'custom', model: 'local/model' });
  assert.equal(config.providers.local.settings.apiKey, 'fixture-secret');
  assert.equal(config.agents.custom.system, 'Original prompt');
  assert.equal(config.model, 'local/model');
  assert.equal(load(f.bin, { agent: 'custom' }).model, 'local/model');
  const input = JSON.parse(fs.readFileSync(f.data, 'utf8'));
  input.entries[0].info.providers.local.settings.apiKey = '***';
  fs.writeFileSync(f.data, JSON.stringify(input));
  assert.throws(() => load(f.bin, { agent: 'custom', model: 'local/model' }), /脱敏占位符/);
});

test('v2 A/B and baseline isolate files, permissions, project discovery and model settings', t => {
  const f = fixture(t);
  const workspaces: any[] = [];
  t.after(() => workspaces.forEach(w => w.cleanup(true)));
  const config = { providers: { local: {} }, agents: { build: { system: 'Keep system', permissions: [{ action: '*', resource: '*', effect: 'allow' }] } } };
  for (const snapshot of [skill, { ...skill, version: 3, files: { 'SKILL.md': 'version three' } }, null]) {
    const w = prepare(f.bin, { platform: 'opencode', agent: 'build', model: 'local/model', skillExecution: { version: 1, skill: snapshot } }, config);
    workspaces.push(w);
    const c = JSON.parse(w.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(w.env.PWD, w.cwd);
    assert.equal(w.env.OPENCODE_CONFIG_PROJECT_DISABLE, 'true');
    assert.equal(fs.existsSync(path.join(path.dirname(w.env.OPENCODE_CONFIG), 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(w.cwd, '.opencode', 'node_modules')), false);
    assert.equal(c.model, 'local/model');
    assert.match(c.agents.build.system, /Keep system/);
    assert.equal(c.permission, undefined);
    assert.equal(c.agent, undefined);
    assert.deepEqual(c.permissions.filter((r: any) => r.action === 'skill'), snapshot ? [{ action: 'skill', resource: 'target', effect: 'allow' }] : []);
    assert.deepEqual(c.agents.build.permissions, c.permissions);
    assert.deepEqual(c.policies[0], { action: 'integration.use', resource: 'skill:*', effect: 'deny' });
    assert.deepEqual(c.skills, [path.join(w.cwd, '.opencode/skills')]);
    assert.equal(fs.existsSync(path.join(w.cwd, '.opencode/skills/target/SKILL.md')), !!snapshot);
  }
  assert.equal(new Set(workspaces.map(w => w.cwd)).size, 3);
  assert.equal(fs.readFileSync(path.join(workspaces[0].cwd, '.opencode/skills/target/SKILL.md'), 'utf8'), skill.files['SKILL.md']);
  assert.equal(fs.readFileSync(path.join(workspaces[1].cwd, '.opencode/skills/target/SKILL.md'), 'utf8'), 'version three');
});

test('v2 trigger allows only frozen candidates and rejects external configuration sources', t => {
  const f = fixture(t);
  const payload = { platform: 'opencode', agent: 'build', model: 'local/model', skillExecution: {
    version: 2, mode: 'trigger', skills: [skill, { ...skill, name: 'competitor' }], targetSkillName: 'target',
  } };
  const w = prepare(f.bin, payload, { providers: {}, mcp: { servers: { unsafe: {} } } });
  try {
    const c = JSON.parse(w.env.OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(c.mcp, { servers: {} });
    assert.doesNotMatch(c.agents.build.system, /先加载该 Skill/);
    assert.deepEqual(c.permissions.filter((r: any) => r.effect === 'allow').map((r: any) => r.action), ['read', 'glob', 'grep', 'list', 'skill', 'skill']);
    assert.ok(c.policies.some((r: any) => r.resource === 'mcp:*' && r.effect === 'deny'));
  } finally { w.cleanup(true); }
  const input = JSON.parse(fs.readFileSync(f.data, 'utf8'));
  input.external = true; fs.writeFileSync(f.data, JSON.stringify(input));
  assert.throws(() => prepare(f.bin, payload, { providers: {} }), { code: 'SKILL_ISOLATION_UNAVAILABLE' });
});

test('frontend/backend share mode-specific capability requirements and actionable errors', () => {
  assert.equal(isTraceGenerationFailureRetryable('SKILL_ISOLATION_UNAVAILABLE'), false);
  const generic = { platform: 'opencode', supportsSkillSnapshot: false, supportsTriggerRouting: false };
  assert.equal(skillExecutionCapabilityIssue(generic)?.code, 'skill_execution_unsupported');
  assert.doesNotMatch(skillExecutionCapabilityIssue(generic)!.message, /升级.*重试/);
  const snapshot = { ...generic, supportsSkillSnapshot: true };
  assert.equal(skillExecutionCapabilityIssue(snapshot), null);
  assert.equal(skillExecutionCapabilityIssue(snapshot, true)?.code, 'trigger_execution_unsupported');
  assert.equal(skillExecutionCapabilityIssue({ ...snapshot, supportsTriggerRouting: true }, true), null);
  assert.match(skillExecutionCapabilityIssue({ ...snapshot, platform: 'xiaoo' })!.message, /请选择 OpenCode/);
});

test('v2 event adapter records id-based Skill loads only after successful root-session calls', async t => {
  const channel = prepareOpencodeEventChannel({}, 2);
  t.after(() => channel.cleanup());
  const pluginDirectory = JSON.parse(channel.env.OPENCODE_CONFIG_CONTENT).plugins[0];
  const previous = { ...process.env };
  Object.assign(process.env, channel.env, { AGENT_INSIGHT_EXPERIMENT_SESSION_ID: 'root' });
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  const plugin = await import(require('node:url').pathToFileURL(path.join(pluginDirectory, 'plugin.mjs')).href);
  const close = await plugin.setup({ event: { subscribe: async function* () {
    for (const [sessionID, id, success] of [['root', 'hit', true], ['child', 'foreign', true], ['root', 'failed', false]]) {
      yield { type: 'session.tool.input.started', data: { sessionID, id, name: 'skill' } };
      yield { type: 'session.tool.called', data: { sessionID, id, input: { id: 'target' } } };
      yield { type: success ? 'session.tool.success' : 'session.tool.failed', data: { sessionID, id } };
    }
    yield { type: 'session.execution.succeeded', data: { sessionID: 'root' } };
  } } });
  await close();
  const frames = fs.readFileSync(channel.eventFile, 'utf8').trim().split('\n').map((line: string) => JSON.parse(line));
  assert.deepEqual(frames.filter((f: any) => f.kind === 'trigger').map((f: any) => f.skillName), ['target']);
  assert.ok(frames.some((f: any) => f.kind === 'finished'));
});

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
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';
import { activateIsolatedHome } from './helpers/isolated-home';
import { writeOpenCodePluginDependencies } from './fixtures/opencode-plugin-dependencies';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-concurrency-test-'));
const restore = activateIsolatedHome(root);
const require = createRequire(import.meta.url);
const client = require('../scripts/reliability-client.cjs');
test.after(() => { restore(); fs.rmSync(root, { recursive: true, force: true }); });

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('长轮询在普通或 Skill Case 未完成时继续领取环境准备和取消指令', async () => {
  const source = fs.readFileSync('scripts/reliability-client.cjs', 'utf8');
  const start = source.indexOf('async function pollOnce(cfg) {');
  const pollSource = source.slice(start, source.indexOf('\n/**', start));
  for (const skillExecution of [undefined, { version: 1 }, { version: 2 }]) {
    const execution = gate();
    const commands = [
      { action: 'RUN_EXPERIMENT_CASE', payload: { skillExecution } },
      { action: 'PREPARE_EXECUTION_ENVIRONMENT' },
      { action: 'CANCEL_EXPERIMENT_RUN' },
    ];
    const processed: string[] = [];
    const context = vm.createContext({
      api: async () => commands.shift(),
      handleCommand: async (_cfg: unknown, frame: { action: string }) => {
        processed.push(frame.action);
        if (frame.action === 'RUN_EXPERIMENT_CASE') await execution.promise;
      },
      sendCommandStatus: async () => {}, logErr: () => {},
      pollWaitSeconds: client.pollWaitSeconds, AbortSignal,
    });
    vm.runInContext(`${pollSource}\nthis.pollOnce = pollOnce;`, context);
    let completed = false;
    const polling = (async () => {
      for (let i = 0; i < 3; i++) await context.pollOnce({});
      completed = true;
    })();
    await new Promise(resolve => setImmediate(resolve));
    try {
      assert.equal(completed, true, '取指令不能等待 Case 执行结束');
      assert.deepEqual(processed, ['RUN_EXPERIMENT_CASE', 'PREPARE_EXECUTION_ENVIRONMENT', 'CANCEL_EXPERIMENT_RUN']);
    } finally { execution.release(); await polling; }
  }
});

test('Skill 与普通 Case 共用并行槽，重复指令和故障注入独占仍受保护', () => {
  assert.equal(client.tryAcquireExecutionSlot('skill', 'skill-a'), true);
  assert.equal(client.tryAcquireExecutionSlot('skill', 'skill-b'), true);
  assert.equal(client.tryAcquireExecutionSlot('ordinary', 'ordinary'), true);
  try {
    assert.equal(client.tryAcquireExecutionSlot('skill', 'skill-a'), false);
    assert.equal(client.tryAcquireExecutionSlot('reliability', 'fi'), false);
    client.releaseExecutionSlot('skill', 'skill-a');
    assert.equal(client.tryAcquireExecutionSlot('reliability', 'fi'), false);
  } finally {
    client.releaseExecutionSlot('skill', 'skill-a');
    client.releaseExecutionSlot('skill', 'skill-b');
    client.releaseExecutionSlot('ordinary', 'ordinary');
  }
  assert.equal(client.tryAcquireExecutionSlot('reliability', 'fi'), true);
  try { assert.equal(client.tryAcquireExecutionSlot('skill', 'blocked'), false); }
  finally { client.releaseExecutionSlot('reliability', 'fi'); }
});

test('同机 Skill 命令同时启动并隔离快照，取消一条不会终止另一条', { timeout: 20000 }, async () => {
  writeOpenCodePluginDependencies(path.join(root, '.config', 'opencode'));
  const executable = path.join(root, 'opencode');
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('1.14.39'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('opencode run --format json --agent --model --title --command'); process.exit(0); }
if (process.argv.includes('debug')) { console.log(JSON.stringify({provider:{fixture:{options:{apiKey:'fixture-key'}}},model:'fixture/model'})); process.exit(0); }
if (process.argv[2] === 'models') { console.log('fixture/model'); process.exit(0); }
let query=''; process.stdin.on('data', data => query += data); process.stdin.on('end', () => {
 const sessionId='session-'+query;
 const send = (kind, extra={}) => fs.writeSync(3, JSON.stringify({protocol:1,token:process.env.AGENT_INSIGHT_EVENT_TOKEN,kind,sessionId,...extra})+'\\n');
 send('ready'); send('session'); send('model', {model:'fixture/model'});
 console.log(JSON.stringify({type:'step_start',sessionID:sessionId,part:{type:'step-start'}}));
 fs.writeFileSync(${JSON.stringify(root)}+'/'+query+'.json', JSON.stringify({cwd:process.cwd(),snapshot:fs.readFileSync('.opencode/skills/test-skill/SKILL.md','utf8')}));
 const timer=setInterval(()=>{
  if (!fs.existsSync(${JSON.stringify(root)}+'/'+query+'.release')) return;
  clearInterval(timer);
  console.log(JSON.stringify({type:'text',sessionID:sessionId,part:{type:'text',text:'output-'+query}}));
  send('finished');
 }, 10);
});
`, { mode: 0o700 });
  const priorPath = process.env.PATH;
  process.env.PATH = `${root}:${priorPath || ''}`;
  const statuses = new Map<string, Array<{ status: string; extra: { error?: { code: string }; result?: { traceId: string } } }>>();
  const cfg = { clientId: 'fixture-client', insightBaseUrl: 'http://fixture.invalid', workspaceBase: root };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).endsWith('/status'), 'Only authoritative command receipts reach the fixture');
    const body = JSON.parse(String(options?.body));
    assert.equal(body.status, 'RECEIVED');
    return new Response('{"ok":true}');
  };
  const start = (query: string, version: number) => client.handleCommand(cfg, {
    commandId: `cmd_concurrent_${query}`, action: 'RUN_EXPERIMENT_CASE',
    payload: { platform: 'opencode', agent: 'build', model: 'fixture/model', input: query, timeoutSeconds: 15,
      skillExecution: { version: 1, skill: { name: 'test-skill', version, files: { 'SKILL.md': `snapshot-${version}` } } } },
  }, async (id: string, status: string, extra: { error?: { code: string }; result?: { traceId: string } }) => {
    statuses.set(id, [...statuses.get(id) || [], { status, extra }]);
  });
  const first = start('first', 1), second = start('second', 2);
  try {
    const deadline = Date.now() + 10000;
    while (!['first', 'second'].every(name => fs.existsSync(path.join(root, name + '.json')))) {
      assert.ok(Date.now() < deadline, JSON.stringify([...statuses]));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const a = JSON.parse(fs.readFileSync(path.join(root, 'first.json'), 'utf8'));
    const b = JSON.parse(fs.readFileSync(path.join(root, 'second.json'), 'utf8'));
    assert.notEqual(a.cwd, b.cwd);
    assert.equal(a.snapshot, 'snapshot-1'); assert.equal(b.snapshot, 'snapshot-2');
    await client.executeAction(cfg, { action: 'CANCEL_EXPERIMENT_RUN', payload: { kind: 'ordinary', runId: 'cmd_concurrent_first' } }, async () => {});
    await first;
    assert.equal(statuses.get('cmd_concurrent_first')?.at(-1)?.extra.error?.code, 'EXECUTION_CANCELLED');
    assert.equal(fs.existsSync(a.cwd), false);
    assert.equal(fs.existsSync(b.cwd), true);
    fs.writeFileSync(path.join(root, 'second.release'), '');
    await second;
    assert.equal(statuses.get('cmd_concurrent_second')?.at(-1)?.status, 'SUCCEEDED');
    assert.equal(statuses.get('cmd_concurrent_second')?.at(-1)?.extra.result?.traceId, 'session-second');
    assert.equal(fs.existsSync(b.cwd), false);
  } finally {
    for (const query of ['first', 'second']) fs.writeFileSync(path.join(root, query+'.release'), '');
    await Promise.allSettled([first, second]);
    globalThis.fetch = previousFetch;
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
  }
});

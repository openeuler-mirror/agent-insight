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
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { flushOpencodeTrace } = require('../scripts/reliability-client.cjs');
const uploader = path.resolve('scripts/opencode_uploader_client.js');

function records(sid: string, pid: number) {
  const now = Date.now();
  return [
    { kind: 'plugin.start', payload: { pid } },
    { kind: 'chat.message', sessionID: sid, payload: { messageID: `${sid}_user`, text: 'test' } },
    { kind: 'event', sessionID: sid, payload: { type: 'message.updated', event: { properties: { info: {
      id: `${sid}_assistant`, sessionID: sid, role: 'assistant', modelID: 'test-model',
      time: { created: now, completed: now },
    } } } } },
    { kind: 'event', sessionID: sid, payload: { type: 'message.part.updated', event: { properties: { part: {
      id: `${sid}_text`, messageID: `${sid}_assistant`, sessionID: sid, type: 'text', text: 'final answer',
    } } } } },
  ];
}

test('OpenCode 退出且 spool 未变化：补报结束、失败可重试、成功后不重复上传', { timeout: 30_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-finalization-'));
  const spool = path.join(root, 'otel_data/opencode', new Date().toISOString().slice(0, 10));
  fs.mkdirSync(spool, { recursive: true });
  const agent = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const exited = new Promise<void>(resolve => agent.once('exit', () => resolve()));
  let fail = false;
  const received: Array<{ task_id: string; opencode_cli_completed: boolean; final_result: string }> = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body));
    res.writeHead(fail ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: !fail }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    agent.kill();
    await exited;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(spool, 'current.jsonl');
  const checkpoint = path.join(root, 'checkpoint.json');
  fs.writeFileSync(file, records('ses_target', agent.pid!).map(r => JSON.stringify(r)).join('\n'));
  const mtime = fs.statSync(file).mtimeMs;
  const run = (extra = {}) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [uploader], {
      env: { ...process.env, HOME: root, AGENT_INSIGHT_HOME: root,
        AGENT_INSIGHT_HOST: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        AGENT_INSIGHT_API_KEY: 'fixture', AGENT_INSIGHT_UPLOADER_NO_MAIN: '0',
        AGENT_INSIGHT_OPENCODE_SPOOL_DIR: path.dirname(spool), AGENT_INSIGHT_OPENCODE_CHECKPOINT: checkpoint,
        AGENT_INSIGHT_OPENCODE_UPLOAD_SINCE_MS: '0', AGENT_INSIGHT_UPLOADER_FORCE: '0',
        AGENT_INSIGHT_UPLOADER_RECHECK_ONLY: '0',
        AGENT_INSIGHT_UPLOADER_FORCE_SESSION: '', AGENT_INSIGHT_UPLOADER_SPOOL_FILE: '',
        NO_PROXY: '*', no_proxy: '*', ...extra }, stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`uploader exit ${code}`)));
  });
  const pending = () => JSON.parse(fs.readFileSync(checkpoint, 'utf8')).__pendingSessions;
  await run();
  assert.equal(received.length, 1);
  assert.equal(received[0].opencode_cli_completed, false);
  assert.equal(received[0].final_result, 'final answer');
  assert.ok(pending().ses_target.includes(file));
  await run();
  assert.equal(received.length, 1, 'living idle process must not be reported completed or uploaded again');
  agent.kill();
  await exited;
  fail = true;
  await run();
  assert.equal(received.length, 2);
  assert.equal(received[1].opencode_cli_completed, true);
  assert.ok(pending().ses_target, 'failed final upload remains eligible without new spool writes');
  fail = false;
  await run();
  assert.equal(received.length, 3);
  assert.equal(received[2].opencode_cli_completed, true);
  assert.equal(pending().ses_target, undefined);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  await run();
  assert.equal(received.length, 3, 'completed trace must not be replayed');
  fs.appendFileSync(file, '\n' + records('ses_unrelated', agent.pid!).map(r => JSON.stringify(r)).join('\n'));
  await run({ AGENT_INSIGHT_UPLOADER_FORCE_SESSION: 'ses_target' });
  assert.deepEqual(received.map(r => r.task_id), Array(4).fill('ses_target'));
  await run({ AGENT_INSIGHT_UPLOADER_FORCE_SESSION: 'ses_target', AGENT_INSIGHT_UPLOADER_RECHECK_ONLY: '1' });
  assert.equal(received.length, 4, 'client exit after plugin final upload must not replay the completed trace');
});

test('客户端收尾补报只选择本次会话、使用客户端 home，且上传挂起有超时', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-final-flush-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const script = path.join(home, 'opencode_uploader_client.js');
  const result = path.join(home, 'result.json');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(result)},JSON.stringify({
    home:process.env.AGENT_INSIGHT_HOME,session:process.env.AGENT_INSIGHT_UPLOADER_FORCE_SESSION,
    spool:process.env.AGENT_INSIGHT_UPLOADER_SPOOL_FILE,force:process.env.AGENT_INSIGHT_UPLOADER_FORCE
  }))`);
  assert.equal(await flushOpencodeTrace('ses_selected', { home }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(result, 'utf8')), { home, session: 'ses_selected', spool: '', force: '1' });
  assert.equal(await flushOpencodeTrace('invalid', { home }), false);
  fs.writeFileSync(script, 'setInterval(()=>{},1000)');
  assert.equal(await flushOpencodeTrace('ses_selected', { home, timeoutMs: 100 }), false);
});

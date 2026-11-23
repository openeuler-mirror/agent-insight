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
import test from 'node:test';
import { createIsolatedDatabase } from './helpers/isolated-database';

const cli = process.env.OPENCODE_TRACE_TEST_CLI;
const major = Number(process.env.OPENCODE_TRACE_TEST_MAJOR || 2);

test('native OpenCode generates, uploads and binds the exact Trace to its experiment Case', { skip: !cli, timeout: 120_000 }, async (t) => {
  const database = createIsolatedDatabase();
  const { prisma } = require('../src/lib/storage/prisma');
  const { POST } = require('../src/app/api/ingest/upload/route');
  const { GET: pluginArtifact } = require('../src/app/api/ingest/setup/opencode/route');
  const { findExecutionByTraceId, reconcileGeneratedTraceCase } = require('../src/lib/engine/experiment/trace-generation');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-native-trace-'));
  const home = path.join(root, 'insight');
  fs.mkdirSync(home);
  const user = 'native-opencode-fixture';
  const key = 'wi_native_opencode_fixture';
  let clientId = '';
  const { createInstallToken, registerClient } = require('../src/lib/reliability/client-registry');
  const uploads: string[] = [];
  const errors: string[] = [];
  let mode = 'success';
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      if (req.url === '/api/ingest/upload') {
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
        const response = await POST(new Request(`http://localhost${req.url}`, { method: 'POST', headers, body }));
        const text = await response.text();
        if (!response.ok) errors.push(`${response.status}: ${text}`);
        else uploads.push(JSON.parse(body).task_id);
        res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(text); return;
      }
      if (mode === 'hang') return;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const choice of [{ delta: { role: 'assistant', content: 'TRACE_FIXTURE_OK' }, finish_reason: null }, { delta: {}, finish_reason: 'stop' }]) {
        res.write(`data: ${JSON.stringify({ id: 'fixture-answer', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, ...choice }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    } catch (error) { errors.push(String(error)); res.writeHead(500); res.end('fixture error'); }
  });
  try {
    await prisma.user.create({ data: { username: user, apiKey: key } });
    await prisma.userSettings.create({ data: { user, settingsJson: JSON.stringify({ autoEvaluationEnabled: false }) } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const token = await createInstallToken({ user });
    const registration = await registerClient({ installToken: token.installToken, hostname: 'native-test-host' });
    clientId = registration.clientId;
    fs.mkdirSync(path.join(home, 'client'));
    fs.writeFileSync(path.join(home, 'client/config.json'), JSON.stringify({ ...registration, insightBaseUrl: `http://127.0.0.1:${port}` }));
    const pluginDir = path.join(root, 'collector'); fs.mkdirSync(pluginDir);
    const pluginFile = path.join(pluginDir, 'index.ts');
    fs.writeFileSync(pluginFile, await (await pluginArtifact(new Request(`http://fixture/api/ingest/setup/opencode?apiVersion=${major}`))).text());
    if (major === 2) {
      const installedPlugins = path.join(root, 'config', 'opencode', 'plugins');
      fs.mkdirSync(installedPlugins, { recursive: true });
      fs.copyFileSync(pluginFile, path.join(installedPlugins, 'Witty-Skill-Insight.ts'));
    }
    const uploader = path.resolve('scripts/opencode_uploader_client.js');
    fs.writeFileSync(path.join(home, 'opencode_uploader_client.js'), `require(${JSON.stringify(uploader)});`);
    const config = { model: 'mock/mock', small_model: 'mock/mock', permission: { '*': 'deny' },
      ...(major === 2 ? {} : { plugin: [pluginFile] }),
      provider: { mock: { npm: '@ai-sdk/openai-compatible', name: 'Mock', options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test-only' }, models: { mock: { name: 'Mock', limit: { context: 8192, output: 128 } } } } } };
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: `${path.dirname(cli!)}:${process.env.PATH}`, HOME: root, USERPROFILE: root,
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
      AGENT_INSIGHT_HOME: home, AGENT_INSIGHT_HOST: `http://127.0.0.1:${port}`, AGENT_INSIGHT_API_KEY: key,
      AGENT_INSIGHT_OPENCODE_UPLOADER: uploader, AGENT_INSIGHT_OPENCODE_UPLOAD_COOLDOWN_MS: '0',
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
    const runner = path.resolve('scripts/reliability-client.cjs');
    const servicesFile = path.resolve('services/executor/src/environment/services.cjs');
    if (major === 1) {
      // A fresh v1 config directory installs its plugin SDK before debug config can finish.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(cli!, ['debug', 'config'], { cwd: root, env, stdio: 'ignore', timeout: 60_000 });
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error(`OpenCode v1 fixture initialization failed: ${code}`)));
      });
    }
    const run = async (cancel = false, skill = false) => {
      const code = `const c=require(${JSON.stringify(runner)});const a=new AbortController();let timer;
const services=require(${JSON.stringify(servicesFile)}).createServices({cfg:{},client:c});
services.checkAgent({platform:'opencode',agent:'build',model:'mock/mock'}).then(issues=>{
require('node:assert/strict').deepEqual(issues,[]);
c.runExperimentCase({clientId:${JSON.stringify(clientId)},workspaceBase:process.cwd()},{platform:'opencode',agent:'build',model:'mock/mock',input:'Reply TRACE_FIXTURE_OK.',timeoutSeconds:60,signal:a.signal,${skill ? `skillExecution:{version:1,skill:{name:'fixture',version:1,files:{'SKILL.md':'---\\nname: fixture\\ndescription: fixture\\n---\\nReply TRACE_FIXTURE_OK.'}}}` : ''}},()=>{${cancel ? "timer=setTimeout(()=>a.abort(),500)" : ''}}).then(r=>console.log(JSON.stringify({ok:true,...r})),e=>console.log(JSON.stringify({ok:false,code:e.code,...e.runFacts}))).finally(()=>clearTimeout(timer));
});`;
      return await new Promise<any>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', code], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', stderr = '';
        child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject); child.once('close', code => {
          try { assert.equal(code, 0, stderr); resolve(JSON.parse(output.trim().split('\n').at(-1)!)); } catch (error) { reject(error); }
        });
      });
    };
    const result = await run();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.eventMonitorReady, true);
    let execution;
    for (let i = 0; i < 60; i++) {
      execution = await findExecutionByTraceId({ user, traceId: result.traceId });
      if (execution?.finalResult?.includes('TRACE_FIXTURE_OK') && uploads.includes(result.traceId)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!execution?.finalResult) {
      for (const file of ['opencode_plugin.log', 'opencode_uploader.log']) {
        const log = path.join(home, 'logs', file); if (fs.existsSync(log)) t.diagnostic(fs.readFileSync(log, 'utf8').slice(-4000));
      }
      t.diagnostic(JSON.stringify(execution).slice(-6000));
    }
    assert.deepEqual(errors, []);
    assert.ok(uploads.includes(result.traceId), 'uploader used the returned session ID');
    assert.ok(execution, 'completed Trace reached the database');
    assert.match(execution.finalResult, /TRACE_FIXTURE_OK/);
    assert.equal(execution.clientId, clientId);
    assert.equal(execution.user, user);
    assert.equal(require('../src/lib/skill-workbench/execution-model').executionModelMatches('mock/mock', execution.model), true);
    assert.equal(await findExecutionByTraceId({ user: 'different-user', traceId: result.traceId }), null);
    const experiment = await prisma.experiment.create({ data: { user, name: 'native Trace', agentName: 'build', cases: { create: { input: 'Reply TRACE_FIXTURE_OK.' } } }, include: { cases: true } });
    const item = experiment.cases[0];
    await prisma.experimentTraceAttempt.create({ data: { experimentId: experiment.id, caseId: item.id, attemptNo: 1, workerId: clientId, platform: 'opencode', agent: 'build', traceId: result.traceId, status: 'waiting_trace' } });
    assert.equal(await reconcileGeneratedTraceCase({ user, caseId: item.id }), true);
    assert.equal((await prisma.experimentCase.findUnique({ where: { id: item.id } })).executionId, execution.id);
    if (major === 2) {
      const isolated = await run(false, true);
      assert.equal(isolated.ok, true, JSON.stringify(isolated));
      let isolatedTrace;
      for (let i = 0; i < 60; i++) {
        isolatedTrace = await findExecutionByTraceId({ user, traceId: isolated.traceId });
        if (isolatedTrace?.finalResult?.includes('TRACE_FIXTURE_OK')) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.ok(uploads.includes(isolated.traceId), 'isolated Skill execution uploads its Trace through the installed collector');
      assert.match(isolatedTrace?.finalResult || '', /TRACE_FIXTURE_OK/);
      assert.equal(isolatedTrace.clientId, clientId);
    }
    mode = 'hang';
    const cancelled = await run(true);
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.code, 'EXECUTION_CANCELLED');
    assert.notEqual(cancelled.traceId, result.traceId);
    t.diagnostic(`OpenCode v${major}: Trace uploaded, account/client/model verified, Case bound, cancellation verified`);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.$disconnect(); database.dispose(); fs.rmSync(root, { recursive: true, force: true });
  }
});

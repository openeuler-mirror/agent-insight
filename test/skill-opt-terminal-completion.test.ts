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
import test from 'node:test';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-opt-completion-'));
let agent: (options: any) => Promise<any>;
let bridge: typeof import('@/lib/skill-opt-bridge');
type VerifyVerdict = { ok: boolean; structural: { ok: boolean; failures: string[] }; failures: string[] };
let selfVerify: () => Promise<VerifyVerdict>;
const previous = { verify: process.env.SKILL_OPT_NO_VERIFY, protect: process.env.SKILL_OPT_NO_PROTECT };
test.before(async () => {
  process.env.SKILL_OPT_NO_VERIFY = '1';
  process.env.SKILL_OPT_NO_PROTECT = '1';
  selfVerify = async () => ({ ok: true, structural: { ok: true, failures: [] }, failures: [] });
  const stubs: Record<string, unknown> = {
    '@/lib/engine/general-agent': { runGeneralAgent: (options: any) => agent(options) },
    '@/lib/engine/general-agent/concurrency-limiter': { withBackgroundOpencodeSlot: (fn: () => unknown) => fn() },
    '@/lib/storage/server-config': { getUserSettings: async () => ({ configs: [] }) },
    '@/lib/engine/general-agent/server-model-config': {},
    '@/lib/engine/general-agent/workspace': { ensureUserWorkspace: () => directory, ensureSessionWorkspace: () => directory },
    '@/lib/engine/general-agent/skill-resolver': { resolveSkill: async () => null },
    '@/lib/env': {},
    '@/lib/skill-opt-storage': { ensureSkillFilesInWorkspace: () => ({ copied: 0 }) },
    '@/lib/engine/general-agent/skill-opt-prompt': { buildSkillOptSystemPrompt: () => 'test' },
    '@/lib/skill-generator-opencode-bridge': { scanWorkspaceFiles: () => ({ '/workspace/SKILL.md': { content: ['---', 'name: test', '---', 'complete candidate'] } }) },
    '@/lib/engine/skill-opt/edit-scope-guard': {},
    '@/lib/engine/skill-opt/self-verify': { runSelfVerification: async () => selfVerify() },
    '@/lib/engine/skill-opt/optimization-context': { installOptimizationOutputLimit: () => {}, optimizationContinuity: async () => '' },
    '@/lib/skill-workbench/optimization-candidate': {},
    '@/lib/skill-generator/skill-files': { findSkillMd: () => ({ path: '/workspace/SKILL.md', content: 'candidate', folder: null }) },
  };
  const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
  const load = loader._load;
  loader._load = function (id, ...args) { return id in stubs ? stubs[id] : load.call(this, id, ...args); };
  try { bridge = await import('@/lib/skill-opt-bridge'); }
  finally { loader._load = load; }
});
test.after(() => {
  for (const [name, value] of [['SKILL_OPT_NO_VERIFY', previous.verify], ['SKILL_OPT_NO_PROTECT', previous.protect]]) {
    if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
  }
  fs.rmSync(directory, { recursive: true, force: true });
});
const options = (threadId: string, signal?: AbortSignal, send = (_mode: string, _value: unknown) => {}) => ({ user: 'test', threadId, skillName: 'test', baseVersion: 0, checkedIssues: [], userFeedback: 'add computed summary', signal, send });

test('terminal event followed by SDK cleanup must not become a user cancellation', async () => {
  for (const terminal of ['assistant', 'idle']) {
    agent = async (run) => {
      run.handlers.onText?.({ messageID: 'answer', delta: 'candidate complete', fullText: 'candidate complete' });
      if (terminal === 'assistant') run.handlers.onAssistantMessage?.({ status: 'completed', info: { finish: 'stop' } });
      else run.handlers.onSession?.({ phase: 'idle' });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 700);
        const abort = () => { clearTimeout(timer); reject(Object.assign(new Error('opencode 执行已中止'), { code: 'EXECUTION_CANCELLED' })); };
        if (run.chatOptions.signal?.aborted) abort();
        else run.chatOptions.signal?.addEventListener('abort', abort, { once: true });
      });
      return { workspaceDir: directory, sessionId: 'finished', output: 'candidate complete' };
    };
    const events: string[] = [];
    await assert.doesNotReject(() => bridge.streamSkillOptOpencode(options('terminal-'+terminal, undefined, mode => events.push(mode))));
    assert.ok(events.includes('done'));
  }
});

test('external cancellation still rejects and cannot emit a successful candidate', async () => {
  const controller = new AbortController();
  agent = async (run) => {
    const reason = new Error('explicit test cancellation');
    controller.abort(reason);
    assert.equal(run.cancelSignal.aborted, true);
    run.cancelSignal.throwIfAborted();
  };
  const events: string[] = [];
  await assert.rejects(() => bridge.streamSkillOptOpencode(options('external-cancel', controller.signal, mode => events.push(mode))), /explicit test cancellation/);
  assert.ok(!events.includes('done'));
});

test('a model pause longer than thirty seconds is not an internal cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: () => void, ready!: () => void, runOptions: any;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const controller = new AbortController();
  agent = async run => {
    runOptions = run;run.handlers.onText?.({ messageID: 'working', delta: 'working', fullText: 'working' });
    ready();await new Promise<void>((resolve, reject) => {
      release = resolve;
      run.chatOptions.signal?.addEventListener('abort', () => reject(new Error('internal pause cancellation')), { once: true });
    });
    return { workspaceDir: directory, sessionId: 'finished-after-pause', output: 'complete' };
  };
  const pending = bridge.streamSkillOptOpencode(options('long-pause', controller.signal));pending.catch(() => {});
  await started;
  try { t.mock.timers.tick(31000);assert.notEqual(runOptions.chatOptions.signal?.aborted, true);assert.equal(runOptions.chatOptions.idleTimeoutMs, 0);assert.equal(runOptions.chatOptions.streamTimeoutMs, 900000); }
  finally { release(); }
  await assert.doesNotReject(pending);
});

test('the repair turn keeps the main turn deadline and cancellation contract', async () => {
  delete process.env.SKILL_OPT_NO_VERIFY;
  let verifyCalls = 0;
  selfVerify = async () => ++verifyCalls === 1
    ? { ok: false, structural: { ok: false, failures: ['missing script'] }, failures: ['missing script'] }
    : { ok: true, structural: { ok: true, failures: [] }, failures: [] };
  const controller = new AbortController();
  let repair: {
    chatOptions?: { idleTimeoutMs?: number; streamTimeoutMs?: number; signal?: AbortSignal };
    cancelSignal?: AbortSignal;
  } | undefined = undefined;
  agent = async run => {
    if (!run.sessionTitle?.startsWith('skill-opt repair')) {
      return { workspaceDir: directory, sessionId: 'main', output: 'candidate' };
    }
    repair = run;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 50);
      run.chatOptions.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('opencode 执行已中止'), { code: 'EXECUTION_CANCELLED' }));
      }, { once: true });
    });
    return { workspaceDir: directory, sessionId: 'repair', output: 'repaired' };
  };
  const events: string[] = [];
  try {
    await assert.doesNotReject(() => bridge.streamSkillOptOpencode(options('repair-contract', controller.signal, mode => events.push(mode))));
  } finally {
    process.env.SKILL_OPT_NO_VERIFY = '1';
  }
  assert.equal(repair?.chatOptions?.idleTimeoutMs, 0);
  assert.equal(repair?.chatOptions?.streamTimeoutMs, 900000);
  assert.equal(repair?.chatOptions?.signal, controller.signal);
  assert.equal(repair?.cancelSignal, controller.signal);
  assert.ok(events.includes('done'));
});

test('an explicit deadline is surfaced as a timeout, never as a user cancellation', async () => {
  const controller = new AbortController();
  agent = async () => { throw Object.assign(new Error('opencode 执行超过 900000ms'), { code: 'AGENT_TIMEOUT' }); };
  const events: string[] = [];
  await assert.rejects(
    () => bridge.streamSkillOptOpencode(options('deadline', controller.signal, mode => events.push(mode))),
    /opencode 执行超过 900000ms/,
  );
  assert.equal(controller.signal.aborted, false);
  assert.ok(!events.includes('done'));
});

test('external cancellation during a repair turn still rejects', async () => {
  delete process.env.SKILL_OPT_NO_VERIFY;
  selfVerify = async () => ({ ok: false, structural: { ok: false, failures: ['missing script'] }, failures: ['missing script'] });
  const controller = new AbortController();
  agent = async run => {
    if (run.sessionTitle?.startsWith('skill-opt repair')) {
      controller.abort(new Error('explicit repair cancellation'));
      run.cancelSignal.throwIfAborted();
    }
    return { workspaceDir: directory, sessionId: 'main', output: 'candidate' };
  };
  const events: string[] = [];
  try {
    await assert.rejects(
      () => bridge.streamSkillOptOpencode(options('repair-cancel', controller.signal, mode => events.push(mode))),
      /explicit repair cancellation/,
    );
  } finally {
    process.env.SKILL_OPT_NO_VERIFY = '1';
  }
  assert.ok(!events.includes('done'));
});

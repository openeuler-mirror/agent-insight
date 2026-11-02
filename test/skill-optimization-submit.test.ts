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
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { hasOptimizationInput } from '@/lib/skill-workbench/optimization-request';

const conversation = 'src/components/skill-workbench/OptimizationConversation.tsx';
const shell = 'src/components/skill-workbench/SkillWorkbenchShell.tsx';

function handler(file: string, name: string, context: Record<string, unknown>) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) {
      expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(expression, `missing production handler: ${name}`);
  const code = ts.transpileModule(`(${expression.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(code, context);
}

interface Message { role: string; content: string; blocks: Record<string, unknown>[]; streaming?: boolean }
interface Plan { id: string; status: string; items: { route: string; status: string; title: string }[] }

function submissionFixture(plan: Plan | null = null, issues: { id: string; summary: string }[] = []) {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  const errors: string[] = [];
  const state = { messages: [] as Message[] };
  const context: Record<string, unknown> = {
    Error, DOMException, AbortController, TextDecoder, hasOptimizationInput,
    busy: false, user: 'owner', skillName: 'test', baseVersion: 0,
    optSessionId: 'opt', workbenchSessionId: 'session', baselineFiles: { 'SKILL.md': 'baseline' }, issues,
    ownsStreamRef: { current: false }, snapshotRequestRef: { current: 0 }, stopRequestedRef: { current: false },
    runTaskIdRef: { current: null }, planningControllerRef: { current: null }, safeUUID: () => 'run',
    setPlanning: () => {}, setStopping: () => {}, setRunning: () => {}, setFeedback: () => {}, setLocalStep: () => {},
    onError: (message: string) => { errors.push(message); }, onSynced: () => {}, publishWorkbenchSync: () => {},
    displayOptimizationError: (message: string) => message,
    settleProcessBlocks: (blocks: unknown) => blocks,
    hydrateOptimizationMessages: (messages: Message[]) => messages,
    patchAgent: (patch: (message: Message) => void) => { patch(state.messages.at(-1)!); },
    setMessages: (update: Message[] | ((current: Message[]) => Message[])) => {
      state.messages = typeof update === 'function' ? update(state.messages) : update;
    },
    apiFetch: async (url: string, options?: { body?: string }) => {
      calls.push({ url, body: options?.body ? JSON.parse(options.body) : undefined });
      if (url === '/api/skill-opt/plan') return Response.json({ plan });
      if (url === '/api/skill-opt/chat') return new Response('data: {"mode":"done"}\n\n');
      return Response.json({ session: { id: 'session' }, optimization: { messages: state.messages } });
    },
  };
  context.prepareMergePlan = handler(conversation, 'prepareMergePlan', context);
  const submit = handler(conversation, 'runRequest', context) as (text: string, options?: { mergeIssues?: boolean }) => Promise<void>;
  return { calls, errors, context, submit };
}

test('点击优化携带当前诉求，不归并问题；第二次提交保留新的诉求', async () => {
  const f = submissionFixture();
  await f.submit('  保留脚本，只补充 FTP 分析步骤  ', { mergeIssues: false });
  await f.submit('再补充失败退出条件', { mergeIssues: false });
  const requests = f.calls.filter(call => call.url === '/api/skill-opt/chat');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body?.userFeedback, '保留脚本，只补充 FTP 分析步骤');
  assert.equal(requests[1].body?.userFeedback, '再补充失败退出条件');
  assert.equal(requests[0].body?.optimizationScope, 'targeted');
  assert.deepEqual(requests[0].body?.checkedIssues, []);
  assert.deepEqual(requests[0].body?.baselineFiles, { 'SKILL.md': 'baseline' });
  assert.equal(f.calls.some(call => call.url === '/api/skill-opt/plan'), false);
  assert.equal(f.errors.some(Boolean), false);
});

test('无诉求时归并正式版本已有问题，并用真实计划启动优化', async () => {
  const f = submissionFixture({ id: 'plan', status: 'draft', items: [{ route: 'core', status: 'pending', title: '修复失败退出条件' }] });
  await f.submit('', { mergeIssues: true });
  assert.equal(f.calls[0].url, '/api/skill-opt/plan');
  const request = f.calls.find(call => call.url === '/api/skill-opt/chat');
  assert.equal(request?.body?.planId, 'plan');
  assert.equal(request?.body?.userFeedback, '');
  assert.equal(f.errors.some(Boolean), false);
});

test('没有计划或仅有冲突项时明确反馈，不回退到旧静态问题或构造占位诉求', async () => {
  for (const plan of [null, { id: 'conflict', status: 'draft', items: [{ route: 'conflict', status: 'pending', title: '待仲裁' }] }]) {
    const f = submissionFixture(plan, [{ id: 'old', summary: '以前已解决的静态问题' }]);
    await f.submit('', { mergeIssues: true });
    assert.equal(f.calls.some(call => call.url === '/api/skill-opt/chat'), false);
    assert.match(f.errors.at(-1)!, /没有待优化问题|没有可自动执行的优化点/);
  }
  const draft = submissionFixture();
  await draft.submit(' \n ', { mergeIssues: false });
  assert.equal(draft.calls.length, 0);
  assert.match(draft.errors.at(-1)!, /补充优化诉求/);
});

test('同一事件周期重复提交只发出一次优化请求', async () => {
  const f = submissionFixture();
  await Promise.all([f.submit('修复退出条件'), f.submit('重复点击')]);
  assert.equal(f.calls.filter(call => call.url === '/api/skill-opt/chat').length, 1);
});

test('快捷操作在恢复资产期间就锁定，保留输入诉求并在异常后解锁', async () => {
  let release!: () => void;
  let preparations = 0;
  const requests: unknown[] = [];
  const errors: string[] = [];
  const context = {
    Error, active: { id: 'session' }, optimizationQuickActionRef: { current: false }, startingOptimizationRef: { current: false },
    setStartingOptimization: () => {}, setError: (message: string) => errors.push(message),
    showSessionAsset: async () => {
      preparations += 1;
      await new Promise<void>(resolve => { release = resolve; });
      return { kind: 'formal', skillName: 'test', version: 0 };
    },
    startOptimization: async (request: unknown) => { requests.push(request); },
  };
  const click = handler(shell, 'startActiveSessionOptimization', context) as (text: string) => Promise<void>;
  const first = click('保留现有脚本');
  await click('重复点击');
  assert.equal(preparations, 1);
  release();
  await first;
  assert.deepEqual(requests.map(request => JSON.parse(JSON.stringify(request))), [{ targetAsset: { kind: 'formal', skillName: 'test', version: 0 }, feedback: '保留现有脚本' }]);
  context.showSessionAsset = async () => { throw new Error('读取资产失败'); };
  await click('继续');
  assert.equal(context.optimizationQuickActionRef.current, false);
  assert.match(errors.at(-1)!, /读取资产失败/);
});

test('准备优化会话成功后才启动，准备中的重复点击不会发送第二个请求', async () => {
  let release!: (response: Response) => void;
  let requests = 0;
  const automatic: boolean[] = [];
  const feedback: string[] = [];
  const context = {
    Error, user: 'owner', selectedAsset: { kind: 'formal', skillName: 'test', version: 0 },
    startingOptimizationRef: { current: false },
    setStartingOptimization: () => {}, setAutoStartOptimization: (value: boolean) => automatic.push(value),
    setOptimizationFeedback: (value: string) => feedback.push(value),
    setUseOptimizationPlan: () => {}, setOptimizationIssueOverride: () => {}, setOptimizationBaselineOverride: () => {},
    setError: () => {}, setActive: () => {}, setSessions: () => {}, updateSessionUrl: () => {},
    ensureManagementProcessSession: async () => ({ id: 'session' }),
    apiFetch: () => { requests += 1; return new Promise<Response>(resolve => { release = resolve; }); },
  };
  const prepare = handler(shell, 'startOptimization', context) as (options: { feedback: string }) => Promise<void>;
  const pending = prepare({ feedback: '补齐失败路径' });
  await Promise.resolve();
  await prepare({ feedback: '重复点击' });
  assert.equal(requests, 1);
  assert.deepEqual(automatic, [false]);
  release(Response.json({ session: { id: 'session', optSessionId: 'opt' } }));
  await pending;
  assert.deepEqual(automatic, [false, true]);
  assert.deepEqual(feedback, ['补齐失败路径']);
  assert.equal(context.startingOptimizationRef.current, false);
});

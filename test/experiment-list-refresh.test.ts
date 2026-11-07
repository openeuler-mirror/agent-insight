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
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const hookSource = readFileSync('src/lib/client/use-experiment-list-refresh.ts', 'utf8');
const skillSource = readFileSync('src/components/skill-workbench/ExperimentPanel.tsx', 'utf8');
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('普通与 Skill 实验列表使用相同轮询入口，Skill 向导与详情不轮询列表', () => {
  const ordinary = readFileSync('src/app/(main)/experiments/page.tsx', 'utf8');
  assert.match(ordinary, /useExperimentListRefresh\(rows, load\)/);
  assert.match(skillSource, /useExperimentListRefresh\(rows, load, !loading && !detailId && !preset\)/);
});

function pollingHarness(load: (silent?: boolean) => Promise<void>) {
  const timers = new Map<number, { callback: () => Promise<void>; delay: number }>();
  let nextId = 0;
  let cleanup: (() => void) | undefined;
  const exports: { useExperimentListRefresh?: (rows: Array<{ status: string }>, load: (silent?: boolean) => Promise<void>, enabled: boolean) => void } = {};
  const context = vm.createContext({
    exports,
    require: () => ({ useEffect: (effect: () => (() => void) | undefined) => { cleanup = effect(); } }),
    window: {
      setTimeout: (callback: () => Promise<void>, delay: number) => { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
      clearTimeout: (id: number) => { timers.delete(id); },
    },
  });
  vm.runInContext(ts.transpileModule(hookSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
  return {
    timers,
    render: (status: string, enabled = true) => {
      cleanup?.();
      exports.useExperimentListRefresh!([{ status }], load, enabled);
    },
    tick: () => {
      assert.equal(timers.size, 1);
      const [id, timer] = [...timers][0]; timers.delete(id);
      assert.equal(timer.delay, 5000);
      return timer.callback();
    },
    dispose: () => cleanup?.(),
  };
}

test('运行中记录每 5 秒静默刷新，草稿也刷新，全部终态后停止', async () => {
  const calls: Array<boolean | undefined> = [];
  const h = pollingHarness(async silent => { calls.push(silent); });
  try {
    h.render('running'); await h.tick();
    h.render('draft'); await h.tick();
    assert.deepEqual(calls, [true, true]);
    for (const status of ['done', 'failed', 'cancelled', 'partial']) {
      h.render(status); assert.equal(h.timers.size, 0);
    }
    h.render('running', false); assert.equal(h.timers.size, 0);
  } finally { h.dispose(); }
});

test('慢请求不会重叠轮询，离开页面后在途请求完成也不重建定时器', async () => {
  let release!: () => void;
  let calls = 0;
  const h = pollingHarness(async () => {
    calls++;
    await new Promise<void>(resolve => { release = resolve; });
  });
  h.render('running');
  const pending = h.tick();
  assert.equal(calls, 1); assert.equal(h.timers.size, 0);
  h.dispose(); release(); await pending;
  assert.equal(h.timers.size, 0);
});

function skillLoadHarness() {
  const source = ts.createSourceFile('panel.tsx', skillSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'load') initializer = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source); assert.ok(initializer);
  type Row = { id: string; status: string };
  let rows: Row[] = [{ id: 'original', status: 'running' }];
  let loading = false;
  const errors: string[] = [];
  const sequence = { current: 0 };
  const pending: Array<{ resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
  const scope = {
    useCallback: (fn: unknown) => fn,
    loadSequence: sequence,
    user: 'user', skillName: 'skill', version: 1,
    apiFetch: () => new Promise<Response>((resolve, reject) => { pending.push({ resolve, reject }); }),
    setLoading: (value: boolean) => { loading = value; },
    setVersions: () => {}, setRows: (value: Row[]) => { rows = value; },
    onError: (message: string) => { errors.push(message); },
  };
  const js = ts.transpileModule(`const callback = ${initializer.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const load = new Function(...Object.keys(scope), `${js}\nreturn callback;`)(...Object.values(scope)) as (silent?: boolean) => Promise<void>;
  return {
    load, rows: () => rows, loading: () => loading, errors,
    invalidate: () => { sequence.current++; },
    resolve: (index: number, row: Row) => pending[index].resolve(new Response(JSON.stringify({ versions: [], experiments: [row] }))),
    reject: (index: number) => pending[index].reject(new Error('network failed')),
  };
}

test('Skill 静默刷新失败保留已有记录并继续轮询，恢复后更新为已完成', async () => {
  const data = skillLoadHarness();
  const h = pollingHarness(data.load);
  try {
    h.render('running'); const failed = h.tick();
    data.reject(0); await failed;
    assert.deepEqual(data.rows(), [{ id: 'original', status: 'running' }]);
    assert.equal(data.loading(), false); assert.deepEqual(data.errors, []);
    assert.equal(h.timers.size, 1);
    const recovered = h.tick(); data.resolve(1, { id: 'original', status: 'done' }); await recovered;
    assert.equal(data.rows()[0].status, 'done');
    h.render(data.rows()[0].status); assert.equal(h.timers.size, 0);
  } finally { h.dispose(); }
});

test('切换 Skill 或版本后，旧响应及旧失败不能覆盖最新列表', async () => {
  const h = skillLoadHarness();
  const old = h.load(); assert.equal(h.loading(), true);
  h.invalidate();
  const current = h.load();
  h.resolve(0, { id: 'old-skill', status: 'done' }); await old;
  assert.equal(h.loading(), true);
  assert.equal(h.rows()[0].id, 'original');
  h.resolve(1, { id: 'new-skill', status: 'running' }); await current;
  assert.equal(h.loading(), false); assert.equal(h.rows()[0].id, 'new-skill');
  const staleFailure = h.load(); h.invalidate();
  const next = h.load(); h.resolve(3, { id: 'latest-version', status: 'done' }); await next;
  h.reject(2); await staleFailure;
  assert.equal(h.rows()[0].id, 'latest-version'); assert.deepEqual(h.errors, []);
});

test('首次加载失败仍展示错误并结束加载状态', async () => {
  const h = skillLoadHarness();
  const request = h.load(); h.reject(0); await request; await flush();
  assert.deepEqual(h.rows(), []); assert.equal(h.loading(), false);
  assert.deepEqual(h.errors, ['network failed']);
});

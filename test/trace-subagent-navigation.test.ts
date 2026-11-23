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
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/app/(main)/trace/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('trace.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Node | undefined;
function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
        && node.arguments[0]?.getText(ast).includes('++executionLookupRequestRef.current')) callback = node.arguments[0];
    ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(callback);
const js = ts.transpileModule(`const run = ${callback.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
    const root = { task_id: 'root', upload_id: 'root-execution' }, child = { task_id: 'child' }, other = { task_id: 'other' };
    const requestRef = { current: 0 };
    let selected: unknown = root;
    let error: string | null = null;
    let cleanup: (() => void) | undefined;
    const pending: Array<{ resolve: (value: unknown) => void; signal: AbortSignal; url: string }> = [];
    const scope = { data: [root], executionLookupRequestRef: requestRef,
        setSelectedExecution: (value: unknown) => { selected = value; },
        setExecutionLookupError: (value: string | null) => { error = value; }, locale: 'zh', AbortController,
        apiFetch: (url: string, options: { signal: AbortSignal }) => new Promise(resolve => pending.push({ resolve, url, signal: options.signal })),
    };
    return { root, child, other, selected: () => selected, error: () => error, requests: () => pending.length,
        url: (index: number) => pending[index].url,
        navigate: (taskIdParam: string | null, executionIdParam: string | null = null) => {
            cleanup?.();
            const args = { ...scope, taskIdParam, executionIdParam, selectedExecution: selected };
            cleanup = new Function(...Object.keys(args), `${js}; return run();`)(...Object.values(args));
        },
        aborted: (index: number) => pending[index].signal.aborted,
        resolve: async (index: number, records: unknown = [child], status = 200) => {
            pending[index].resolve({ ok: status < 400, status, json: async () => records });
            await new Promise(resolve => setImmediate(resolve));
        },
    };
}
test('thirty parent/child round trips load the target and never leave old content selected while loading', async () => {
    const h = harness();
    for (let i = 0; i < 30; i++) {
        h.navigate('child'); assert.equal(h.requests(), i + 1); assert.equal(h.selected(), null);
        await h.resolve(i); assert.equal(h.selected(), h.child);
        h.navigate('root'); assert.equal(h.selected(), h.root);
    }
});
test('late child response cannot replace a parent selected from the list', async () => {
    const h = harness(); h.navigate('child'); h.navigate('root'); await h.resolve(0);
    assert.equal(h.selected(), h.root);
    assert.equal(h.aborted(0), true);
});
test('child -> parent -> same child rejects the first visit response even when taskId matches again', async () => {
    const h = harness(); h.navigate('child'); h.navigate('root'); h.navigate('child');
    await h.resolve(1, [{ ...h.child, query: 'new' }]);
    await h.resolve(0, [{ ...h.child, query: 'old' }]);
    assert.deepEqual(h.selected(), { ...h.child, query: 'new' });
});
test('switching workers and returning to the list discard outstanding responses', async () => {
    const h = harness(); h.navigate('child'); h.navigate('other');
    await h.resolve(1, [h.other]); await h.resolve(0); assert.equal(h.selected(), h.other);
    h.navigate('child'); h.navigate(null); await h.resolve(2); assert.equal(h.selected(), null);
});
test('failed target lookup shows an error and can retry instead of retaining the parent trace', async () => {
    const h = harness(); h.navigate('child'); await h.resolve(0, {}, 500);
    assert.equal(h.selected(), null); assert.match(h.error()!, /加载失败/);
    h.navigate('child'); assert.equal(h.error(), null); await h.resolve(1); assert.equal(h.selected(), h.child);
});
test('missing or mismatched target is not displayed as the requested trace', async () => {
    const h = harness(); h.navigate('child'); await h.resolve(0, [h.root]);
    assert.equal(h.selected(), null); assert.match(h.error()!, /未找到/);
});

test('exact execution identity wins over a matching task ID and cannot fall back to an older record', async () => {
    const h = harness();
    h.navigate('root', 'new-execution');
    assert.equal(h.selected(), null);
    assert.match(h.url(0), /executionId=new-execution/);
    assert.doesNotMatch(h.url(0), /taskId=/);
    await h.resolve(0, [h.root]);
    assert.equal(h.selected(), null);
    assert.match(h.error()!, /未找到/);
    h.navigate('root', 'new-execution');
    const current = { task_id: 'root', upload_id: 'new-execution' };
    await h.resolve(1, [current]);
    assert.deepEqual(h.selected(), current);
});

function detailNavigation(query: string, current = 'dify:workflow', framework = 'dify', linkedTraces = 2) {
    let declaration: ts.VariableDeclaration | undefined;
    function find(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'navigateToTaskId') declaration = node;
        ts.forEachChild(node, find);
    }
    find(ast);
    assert.ok(declaration);
    const fn = (declaration.initializer as ts.CallExpression).arguments[0];
    const code = ts.transpileModule(`const navigate = ${fn.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    let url = '';
    const scope = {
        taskId: current, execution: { framework }, session: { taskId: current, difyProjection: { linkedTraces } },
        searchParams: new URLSearchParams(query), URLSearchParams, window: { location: { pathname: '/trace' } },
        router: { push: (value: string) => { url = value; } },
    };
    const navigate = new Function(...Object.keys(scope), `${code}; return navigate;`)(...Object.values(scope));
    return (target: string) => { navigate(target); return new URL(url, 'http://localhost'); };
}

test('Dify child navigation preserves the Workflow origin across reload and clears an old execution target', () => {
    const child = detailNavigation('framework=dify&taskId=dify:workflow&executionId=outer-execution&page=3')('dify:planner');
    assert.equal(child.searchParams.get('workflowTaskId'), 'dify:workflow');
    assert.equal(child.searchParams.get('taskId'), 'dify:planner');
    assert.equal(child.searchParams.get('executionId'), null);
    assert.equal(child.searchParams.get('page'), '3');
    const returned = detailNavigation(child.search, 'dify:planner', 'dify', 0)('dify:workflow');
    assert.equal(returned.searchParams.get('taskId'), 'dify:workflow');
    assert.equal(returned.searchParams.get('workflowTaskId'), null);
});

test('Dify origin survives another child jump without being invented for an independent Trace', () => {
    const next = detailNavigation('framework=dify&workflowTaskId=dify:workflow', 'dify:planner', 'dify', 0)('dify:reviewer');
    assert.equal(next.searchParams.get('workflowTaskId'), 'dify:workflow');
    assert.equal(detailNavigation('', 'dify:planner', 'dify', 0)('dify:reviewer').searchParams.get('workflowTaskId'), null);
    assert.equal(detailNavigation('', 'opencode-task', 'opencode', 2)('opencode-child').searchParams.get('workflowTaskId'), null);
});

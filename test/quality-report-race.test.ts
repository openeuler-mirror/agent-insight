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

const target = 'src/app/(main)/quality/page.tsx';
const source = fs.readFileSync(new URL('../src/app/(main)/quality/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('quality-page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findNode<T extends ts.Node>(predicate: (node: ts.Node) => boolean, why: string): T {
    let result: T | undefined;
    (function visit(node: ts.Node) {
        if (!result && predicate(node)) result = node as T;
        if (!result) ts.forEachChild(node, visit);
    })(ast);
    assert.ok(result, `${target} 必须存在${why}`);
    return result as T;
}

function expression(node: ts.Node, scope: Record<string, unknown>): unknown {
    const js = ts.transpileModule(`const value = ${node.getText(ast)};`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return new Function(...Object.keys(scope), `${js}; return value;`)(...Object.values(scope));
}

const loadReportDecl = findNode<ts.VariableDeclaration>(
    node => ts.isVariableDeclaration(node) && node.name.getText(ast) === 'loadReport',
    'loadReport 声明',
);
const loadReportInit = loadReportDecl.initializer;
assert.ok(loadReportInit && ts.isCallExpression(loadReportInit)
    && ts.isIdentifier(loadReportInit.expression)
    && loadReportInit.expression.text === 'useCallback', 'loadReport 必须由 useCallback 创建');
const loadReportCall = loadReportInit as ts.CallExpression;

const reportEffect = findNode<ts.CallExpression>(
    node => ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'useEffect'
        && Boolean(node.arguments[0]?.getText(ast).includes('loadReport(')),
    '驱动报表请求的 useEffect',
);
const reportEffectBody = reportEffect.arguments[0];
assert.ok(reportEffectBody, '报表 useEffect 必须带回调');

// 代际守卫的 useRef 计数器（组件顶层声明）由生产源码自身提供；基线缺失时下面两条竞态用例必须失败。
const guardRefs: Array<{ name: string; initial: number }> = [];
(function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && node.initializer && ts.isCallExpression(node.initializer)
        && ts.isIdentifier(node.initializer.expression)
        && node.initializer.expression.text === 'useRef') {
        const literal = node.initializer.arguments[0];
        guardRefs.push({
            name: node.name.text,
            initial: literal && ts.isNumericLiteral(literal) ? Number(literal.getText(ast)) : 0,
        });
    }
    ts.forEachChild(node, collect);
})(ast);

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

type FakeRequest = {
    url: string;
    resolve: (response: { json: () => Promise<unknown> }) => void;
    reject: (reason: unknown) => void;
};

type HarnessConfig = { agent: string; window: string; skill: string };

function harness() {
    let report: unknown = null;
    let loading = false;
    let bucketClears = 0;
    const requests: FakeRequest[] = [];
    const config: HarnessConfig = { agent: 'agent-A', window: '1w', skill: 'all' };
    const scope: Record<string, unknown> = {
        useCallback: (fn: unknown) => fn,
        useRef: (initial: number) => ({ current: initial }),
        user: 'owner-1',
        config,
        URLSearchParams,
        setReport: (value: unknown) => { report = value; },
        setLoading: (value: boolean) => { loading = value; },
        setBucketSel: () => { bucketClears += 1; },
        apiFetch: (url: string) => new Promise((resolve, reject) => {
            requests.push({ url, resolve: resolve as FakeRequest['resolve'], reject: reject as FakeRequest['reject'] });
        }),
    };
    for (const ref of guardRefs) scope[ref.name] = { current: ref.initial };

    const loadReport = expression(loadReportCall, scope) as (agent: string, win: string, skill: string) => void;
    const runEffect = expression(reportEffectBody, { config, loadReport }) as () => void;

    return {
        requests: () => requests,
        report: () => report,
        loading: () => loading,
        bucketClears: () => bucketClears,
        mount: () => runEffect(),
        switch: (patch: Partial<HarnessConfig>) => { Object.assign(config, patch); runEffect(); },
        resolve: async (index: number, payload: unknown) => {
            requests[index].resolve({ json: async () => payload });
            await flush();
        },
        reject: async (index: number) => {
            requests[index].reject(new Error('network failed'));
            await flush();
        },
    };
}

const reportA = { agent: 'agent-A', verdict: 'A 的结论' };
const reportB = { agent: 'agent-B', verdict: 'B 的结论' };

test('迟到的旧 Agent 响应不得覆盖已到达的新报表', async () => {
    const h = harness();
    h.mount();
    h.switch({ agent: 'agent-B' });
    assert.equal(h.requests().length, 2, '切 Agent 必须重发报表请求');
    assert.match(h.requests()[0].url, /agent=agent-A&window=1w&user=owner-1/);
    assert.match(h.requests()[1].url, /agent=agent-B&window=1w&user=owner-1/);
    assert.equal(h.bucketClears(), 2, '每次装载都应重置桶选择');
    assert.equal(h.loading(), true);
    await h.resolve(1, reportB);
    assert.equal(h.report(), reportB);
    await h.resolve(0, reportA);
    assert.equal(h.report(), reportB, 'agent-A 的迟到响应覆盖了 agent-B 的报表');
});

test('旧请求 reject 不得把新报表清成空态，也不得在途误关 loading', async () => {
    const h = harness();
    h.mount();
    h.switch({ agent: 'agent-B' });
    await h.resolve(1, reportB);
    assert.equal(h.report(), reportB);
    assert.equal(h.loading(), false);
    await h.reject(0);
    assert.equal(h.report(), reportB, '旧请求失败把已到达的新报表清成了空态');
    assert.equal(h.loading(), false);

    const h2 = harness();
    h2.mount();
    h2.switch({ agent: 'agent-B' });
    assert.equal(h2.loading(), true);
    await h2.reject(0);
    assert.equal(h2.loading(), true, 'agent-B 请求仍在途时，旧请求失败提前关闭了 loading');
    await h2.resolve(1, reportB);
    assert.equal(h2.report(), reportB);
    assert.equal(h2.loading(), false);
});

test('单发请求路径行为不变：loading 先 true 后 false，报表按载荷落位', async () => {
    const h = harness();
    h.mount();
    assert.equal(h.requests().length, 1);
    assert.match(h.requests()[0].url, /agent=agent-A&window=1w&user=owner-1/);
    assert.doesNotMatch(h.requests()[0].url, /skill=/, 'skill=all 不应出现在查询串');
    assert.equal(h.loading(), true);
    await h.resolve(0, reportA);
    assert.equal(h.report(), reportA);
    assert.equal(h.loading(), false);

    h.switch({ skill: 'pdf' });
    assert.match(h.requests()[1].url, /skill=pdf/);
    await h.resolve(1, reportB);
    assert.equal(h.report(), reportB);
    assert.equal(h.loading(), false);
});

test('清空 Agent 选择走早退分支：不发新请求，在途旧响应不得把报表填回来，loading 也不得卡住', async () => {
    const h = harness();
    h.mount();
    assert.equal(h.requests().length, 1);
    assert.equal(h.loading(), true);

    h.switch({ agent: '' });
    assert.equal(h.report(), null, '清空 Agent 选择应立即清空报表');
    assert.equal(h.requests().length, 1, '早退分支不应发出新请求');

    await h.resolve(0, reportA);
    assert.equal(h.report(), null, '清空选择在先，agent-A 的在途响应不应把报表填回来');
    assert.equal(h.loading(), false, '在途响应被丢弃后，loading 必须由早退分支自己关掉，否则页面永久停在 LoadingState');

    const h2 = harness();
    h2.switch({ agent: '' });
    assert.equal(h2.requests().length, 0, 'mount 即为空 Agent 时不应发请求');
    assert.equal(h2.report(), null);
    assert.equal(h2.loading(), false, '空 Agent 的空态不应显示 loading');
});

test('当前请求自身的 error 载荷与 reject 仍按原语义清空报表', async () => {
    const h = harness();
    h.mount();
    await h.resolve(0, { error: 'boom' });
    assert.equal(h.report(), null, '当前请求返回 error 时报表应清空');
    assert.equal(h.loading(), false);

    const h2 = harness();
    h2.mount();
    await h2.reject(0);
    assert.equal(h2.report(), null, '当前请求失败时报表应清空');
    assert.equal(h2.loading(), false);
});

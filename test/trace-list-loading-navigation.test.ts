import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { parseAsString, useQueryState } from 'nuqs';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/app/(main)/trace/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('trace.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findNode(predicate: (node: ts.Node) => boolean): ts.Node {
    let result: ts.Node | undefined;
    function visit(node: ts.Node) {
        if (!result && predicate(node)) result = node;
        ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(result, 'production callback must exist');
    return result;
}

function expression(node: ts.Node, scope: Record<string, unknown>): any {
    const js = ts.transpileModule(`const value = ${node.getText(ast)};`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return new Function(...Object.keys(scope), `${js}; return value;`)(...Object.values(scope));
}

function effectContaining(text: string): ts.Node {
    const call = findNode(node => ts.isCallExpression(node)
        && node.expression.getText(ast) === 'useEffect'
        && Boolean(node.arguments[0]?.getText(ast).includes(text))) as ts.CallExpression;
    return call.arguments[0];
}

const listEffect = effectContaining('paginated=1&databasePagination=1');
const timerEffect = effectContaining('TRACE_LIST_REFRESH_MS');
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function listHarness() {
    let loading = true;
    let records: unknown[] = [];
    let reloadKey = 0;
    let tick: (() => void) | undefined;
    let cleanup: (() => void) | undefined;
    const pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void; signal?: AbortSignal }> = [];
    const scope: Record<string, any> = {
        user: 'reader', apiKey: null, agentScopeFilter: 'root', skillFilter: 'all',
        selectedUserTagIds: [], search: '', clauses: [], clausesRaw: '',
        frameworkFilter: 'all', agentFilter: 'all', ownershipFilter: 'user',
        anomalyFilter: 'all', reliabilityAnomalyFilter: 'all', timeFilter: 'all',
        sortKey: 'timestamp', sortDir: 'desc', page: 1, pageSize: 20,
        listFilterKey: 'filters', listRequestKey: 'page-1',
        listRequestIdRef: { current: 0 }, listRequestPendingRef: { current: false },
        previousListFilterKeyRef: { current: 'filters' }, previousListRequestKeyRef: { current: null },
        setPage: () => {},
        setData: (value: unknown[]) => { records = value; },
        setTotal: () => {}, setStats: () => {},
        setLoading: (value: boolean) => { loading = value; },
        setReloadKey: (update: (current: number) => number) => { reloadKey = update(reloadKey); },
        TRACE_LIST_REFRESH_MS: 5_000,
        window: { setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => {} },
        document: { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} },
        apiFetch: (_url: string, options: RequestInit) => new Promise((resolve, reject) => {
            pending.push({ resolve, reject, signal: options.signal ?? undefined });
        }),
    };
    function render() {
        cleanup?.();
        cleanup = expression(listEffect, scope)();
    }
    expression(timerEffect, scope)();
    render();
    return {
        pending,
        loading: () => loading,
        records: () => records,
        tick: () => {
            const previous = reloadKey;
            tick!();
            if (previous !== reloadKey) render();
        },
        reload: render,
        changePage: () => { scope.page = 2; scope.listRequestKey = 'page-2'; render(); },
        resolve: async (index: number, id: string) => {
            pending[index].resolve({ json: async () => ({ records: [{ task_id: id }], total: 1 }) });
            await flush();
        },
        reject: async (index: number) => { pending[index].reject(new Error('network failed')); await flush(); },
        unmount: () => cleanup?.(),
    };
}

test('slow initial Trace request survives repeated polling ticks and releases the skeleton', async () => {
    const h = listHarness();
    h.tick();
    h.tick();
    assert.equal(h.pending.length, 1, 'polling must wait for the current request');
    await h.resolve(0, 'initial');
    assert.equal(h.loading(), false);
    assert.deepEqual(h.records(), [{ task_id: 'initial' }]);
    h.tick();
    assert.equal(h.pending.length, 2, 'polling resumes once the request settles');
    assert.equal(h.loading(), false, 'background refresh keeps the populated list visible');
    await h.reject(1);
    assert.deepEqual(h.records(), [{ task_id: 'initial' }], 'a background error preserves the last list');
});

test('a replacement request releases initial loading even when its request key is unchanged', async () => {
    const h = listHarness();
    h.reload();
    await h.resolve(0, 'stale');
    assert.equal(h.loading(), true, 'the obsolete response must not release the active request');
    await h.resolve(1, 'latest');
    assert.deepEqual(h.records(), [{ task_id: 'latest' }]);
    assert.equal(h.loading(), false, 'the latest result must stop the initial skeleton');
});

test('changing Trace pages aborts obsolete transport and ignores its late response', async () => {
    const h = listHarness();
    h.changePage();
    assert.equal(h.pending[0].signal?.aborted, true);
    await h.resolve(1, 'page-2');
    await h.resolve(0, 'page-1');
    assert.deepEqual(h.records(), [{ task_id: 'page-2' }]);
    assert.equal(h.loading(), false);
});

test('unmount aborts the Trace list request and ignores a late completion', async () => {
    const h = listHarness();
    h.unmount();
    assert.equal(h.pending[0].signal?.aborted, true);
    await h.resolve(0, 'unmounted');
    assert.deepEqual(h.records(), []);
});

test('initial errors release loading and permit the next refresh', async () => {
    const h = listHarness();
    h.tick();
    await h.reject(0);
    assert.equal(h.loading(), false);
    h.tick();
    assert.equal(h.pending.length, 2);
    await h.resolve(1, 'recovered');
    assert.deepEqual(h.records(), [{ task_id: 'recovered' }]);
});

const taskIdHook = findNode(node => ts.isCallExpression(node)
    && node.expression.getText(ast) === 'useQueryState'
    && node.arguments[0]?.getText(ast) === "'taskId'");
const selectDeclaration = findNode(node => ts.isVariableDeclaration(node)
    && node.name.getText(ast) === 'handleSelectExecution') as ts.VariableDeclaration;
const selectCallback = (selectDeclaration.initializer as ts.CallExpression).arguments[0];
const importClick = findNode(node => ts.isJsxAttribute(node) && node.name.getText(ast) === 'onClick'
    && Boolean(node.initializer?.getText(ast).includes('importResult?.rootTaskId'))) as ts.JsxAttribute;

async function navigationHarness(run: (scope: Record<string, unknown>) => void, initialQuery = '?page=3&status=failed') {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('http://example.test/trace' + initialQuery) });
    try {
        let setter: (value: string | null, options?: { history?: 'push' | 'replace' }) => Promise<URLSearchParams>;
        const updates: Array<{ queryString: string; options: { history: string } }> = [];
        function Harness() {
            const [, update] = expression(taskIdHook, { useQueryState, parseAsString });
            setter = update;
            return null;
        }
        renderToString(React.createElement(NuqsTestingAdapter, {
            searchParams: initialQuery,
            onUrlUpdate: event => updates.push(event),
            children: React.createElement(Harness),
        }));
        let pending: Promise<URLSearchParams> | undefined;
        run({
            setSelectedExecution: () => {}, reportTraceDetailView: () => {}, setImportResult: () => {},
            importResult: { rootTaskId: 'trace-123' },
            setTaskIdParam: (value: string | null, options?: { history?: 'push' | 'replace' }) => {
                pending = setter(value, options);
                return pending;
            },
        });
        await pending;
        return updates;
    } finally {
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else Reflect.deleteProperty(globalThis, 'window');
        if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
        else Reflect.deleteProperty(globalThis, 'location');
    }
}

test('opening a list Trace adds history so Back and Forward retain list filters', async () => {
    const updates = await navigationHarness(scope => expression(selectCallback, scope)({ task_id: 'trace-123' }));
    assert.equal(updates[0].options.history, 'push');
    assert.equal(updates[0].queryString, '?page=3&status=failed&taskId=trace-123');
    const history = ['/dashboard', '/trace?page=3&status=failed'];
    history.push('/trace' + updates[0].queryString);
    assert.equal(history.at(-2), '/trace?page=3&status=failed');
    assert.equal(history.at(-1), '/trace?page=3&status=failed&taskId=trace-123');
});

test('opening an imported Trace adds a detail history entry', async () => {
    const callback = (importClick.initializer as ts.JsxExpression).expression!;
    const updates = await navigationHarness(scope => expression(callback, scope)());
    assert.equal(updates[0].options.history, 'push');
    assert.equal(updates[0].queryString, '?page=3&status=failed&taskId=trace-123');
});

test('the in-page return-to-list action replaces detail state instead of adding another entry', async () => {
    const updates = await navigationHarness(scope => expression(selectCallback, scope)(null), '?page=3&status=failed&taskId=trace-123');
    assert.equal(updates[0].options.history, 'replace');
    assert.equal(updates[0].queryString, '?page=3&status=failed');
});

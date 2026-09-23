import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/app/(main)/trace/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('trace.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function find(predicate: (node: ts.Node) => boolean) {
    let found: ts.Node | undefined;
    function visit(node: ts.Node) {
        if (!found && predicate(node)) found = node;
        if (!found) ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(found);
    return found;
}

function evaluate<T>(expression: string, scope: Record<string, unknown> = {}): T {
    const js = ts.transpileModule(`const result = (${expression});`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return new Function(...Object.keys(scope), `${js}; return result;`)(...Object.values(scope));
}

test('Trace status preserves timed_out from either API naming convention', () => {
    const node = find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'getExecStatus');
    const status = evaluate<(e: Record<string, unknown>) => string>(node.getText(ast));
    assert.equal(status({ trace_status: 'timed_out' }), 'timed_out');
    assert.equal(status({ traceStatus: 'timed_out' }), 'timed_out');
    assert.equal(status({ trace_status: 'running' }), 'running');
    assert.equal(status({ trace_completed_at: '2026-09-22T00:00:00Z' }), 'success');
});

test('detail refresh updates timeout metadata independently of the pending session', async () => {
    const node = find(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'fetchSession') as ts.VariableDeclaration;
    const callback = (node.initializer as ts.CallExpression).arguments[0];
    const requests: Array<{ url: string; options: any }> = [];
    const metadata = { task_id: 'trace-timeout', trace_status: 'timed_out' };
    const updates: unknown[] = [];
    const refresh = evaluate<(silent: boolean) => void>(callback.getText(ast), {
        taskId: 'trace-timeout', apiKey: 'test-key', sessionRef: { current: {} },
        setLoading() {}, setSession() {}, setSecondsSinceRefresh() {},
        onExecutionRefresh: (value: unknown) => updates.push(value),
        apiFetch: (url: string, options: unknown) => {
            requests.push({ url, options });
            if (url.startsWith('/api/observe/data?')) {
                return Promise.resolve({ ok: true, json: async () => [metadata] });
            }
            return new Promise(() => {});
        },
    });
    refresh(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 2, 'session and lightweight metadata refresh in parallel');
    assert.deepEqual(updates, [metadata]);
    for (const request of requests) {
        assert.equal(request.options.cache, 'no-store');
        assert.equal(request.options.headers['x-witty-api-key'], 'test-key');
    }
    assert.match(requests.find(r => r.url.startsWith('/api/observe/data?'))!.url, /fields=light/);
});

test('running and timed-out detail traces refresh only while visible and remove their listeners', () => {
    const node = find(n => ts.isCallExpression(n) && n.expression.getText(ast) === 'useEffect'
        && n.arguments[0]?.getText(ast).includes('!autoRefresh')) as ts.CallExpression;
    for (const status of ['running', 'timed_out', 'success', 'failed']) {
        const intervals: Array<() => void> = [];
        const listeners = new Map<string, () => void>();
        const visibility = { visibilityState: 'hidden' };
        let requests = 0;
        let cleared = false;
        const timer = {
            setInterval: (callback: () => void, delay: number) => {
                assert.equal(delay, 5_000);
                intervals.push(callback);
                return 1;
            },
            clearInterval: () => { cleared = true; },
        };
        const run = evaluate<() => (() => void) | undefined>(node.arguments[0].getText(ast), {
            autoRefresh: true, execStatus: status, refreshIntervalSec: 5,
            fetchSession: () => { requests++; },
            window: timer, ...timer,
            document: {
                get visibilityState() { return visibility.visibilityState; },
                addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
                removeEventListener: (name: string, listener: () => void) => {
                    assert.equal(listeners.get(name), listener);
                    listeners.delete(name);
                },
            },
        });
        const cleanup = run();
        if (status === 'success' || status === 'failed') {
            assert.equal(intervals.length, 0);
            continue;
        }
        assert.equal(intervals.length, 1, `${status} continues polling`);
        intervals[0]();
        assert.equal(requests, 0, 'hidden tab must not poll');
        visibility.visibilityState = 'visible';
        intervals[0]();
        assert.equal(requests, 1);
        listeners.get('visibilitychange')!();
        assert.equal(requests, 2, 'returning to the tab refreshes immediately');
        cleanup!();
        assert.equal(cleared, true);
        assert.equal(listeners.size, 0);
    }
});

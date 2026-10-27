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
    const root = { task_id: 'root' }, child = { task_id: 'child' }, other = { task_id: 'other' };
    const requestRef = { current: 0 };
    let selected: unknown = root;
    let error: string | null = null;
    let cleanup: (() => void) | undefined;
    const pending: Array<{ resolve: (value: unknown) => void; signal: AbortSignal }> = [];
    const scope = { data: [root], executionLookupRequestRef: requestRef,
        setSelectedExecution: (value: unknown) => { selected = value; },
        setExecutionLookupError: (value: string | null) => { error = value; }, locale: 'zh', AbortController,
        apiFetch: (_: string, options: { signal: AbortSignal }) => new Promise(resolve => pending.push({ resolve, signal: options.signal })),
    };
    return { root, child, other, selected: () => selected, error: () => error, requests: () => pending.length,
        navigate: (taskIdParam: string | null) => {
            cleanup?.();
            const args = { ...scope, taskIdParam, selectedExecution: selected };
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

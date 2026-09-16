import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../src/app/(main)/trace/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('trace.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Node | undefined;
function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
        && node.arguments[0]?.getText(ast).includes('fetchGuardRef.current === taskIdParam')) callback = node.arguments[0];
    ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(callback);
const js = ts.transpileModule(`const run = ${callback.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
    const root = { task_id: 'root' }, child = { task_id: 'child' };
    const guard = { current: null as string | null };
    let selected: unknown = root;
    const pending: Array<(value: unknown) => void> = [];
    let requests = 0;
    const scope = { data: [root], fetchGuardRef: guard,
        setSelectedExecution: (value: unknown) => { selected = value; },
        setTaskIdParam: () => {}, locale: 'zh', toast: { error: () => {} },
        apiFetch: () => { requests++; return new Promise(resolve => pending.push(resolve)); },
    };
    return { root, child, selected: () => selected, requests: () => requests,
        navigate: (taskIdParam: string) => {
            const args = { ...scope, taskIdParam, selectedExecution: selected };
            new Function(...Object.keys(args), `${js}; run();`)(...Object.values(args));
        },
        resolve: async () => { pending.shift()!({ ok: true, status: 200, json: async () => [child] }); await new Promise(resolve => setImmediate(resolve)); },
    };
}
test('parent -> child -> parent -> same child can navigate repeatedly', async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
        h.navigate('child'); assert.equal(h.requests(), i + 1, 'revisiting a child must start a new lookup'); await h.resolve(); assert.equal(h.selected(), h.child);
        h.navigate('root'); assert.equal(h.selected(), h.root);
    }
    assert.equal(h.requests(), 3);
});
test('late child response cannot replace a parent selected from the list', async () => {
    const h = harness(); h.navigate('child'); h.navigate('root'); await h.resolve();
    assert.equal(h.selected(), h.root);
});

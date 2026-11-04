import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import test from 'node:test';
import { buildAgentCallTree, type AgentNode, type AgentEvent } from '../src/lib/engine/observability/agent-trace';

import * as virtualization from '../src/lib/client/trace-span-virtualization';
const api = () => virtualization;
const rowData = () => [{ key: 'agent', height: 34 }, ...Array.from({ length: 1800 }, (_, index) => ({ key: `event-${index}`, height: 30 }))];
const event = (name: string, extra: Partial<AgentEvent> = {}): AgentEvent => ({ kind: 'llm', name, interaction: { role: 'assistant', content: name }, interactionIndex: 0, ...extra });
function node(id: string, events: AgentEvent[], children: AgentNode[] = []): AgentNode {
    return { ...buildAgentCallTree([{ role: 'user', content: 'fixture' }])!, id, agentName: id, events, children };
}
const entries = (events: AgentEvent[]) => events.map((item, eventIndex) => ({ event: item, eventIndex, children: [] }));

test('large virtual windows mount a bounded slice while conserving full scroll geometry', () => {
    const v = api(), layout = v.buildSpanLayout(rowData());
    for (const top of [0, 200, 30_000, 100_000]) {
        const range = v.spanWindow(layout, top, 360);
        assert.ok(range.end - range.start <= 30);
        const mountedHeight = layout.offsets[range.end] - layout.offsets[range.start];
        assert.equal(range.top + mountedHeight + range.bottom, 54_034);
    }
});

test('small traces keep their complete rows without virtual padding', () => {
    const v = api(), layout = v.buildSpanLayout(rowData().slice(0, 151));
    assert.deepEqual(v.spanWindow(layout, 900, 360), { start: 0, end: 151, top: 0, bottom: 0 });
});

test('empty and zero-sized viewports produce finite valid ranges', () => {
    const v = api();
    assert.deepEqual(v.spanWindow(v.buildSpanLayout([]), 500, 0), { start: 0, end: 0, top: 0, bottom: 0 });
    const range = v.spanWindow(v.buildSpanLayout(rowData()), -300, 0);
    assert.equal(range.start, 0); assert.ok(range.end > 0 && range.end < 50);
});

test('a key outside the mounted window can be located using mixed row heights', () => {
    const v = api(), layout = v.buildSpanLayout(rowData());
    assert.equal(v.spanScrollOffset(layout, 'event-1000', 360, 'center', 0), 29_873);
    assert.equal(v.spanScrollOffset(layout, 'removed', 360, 'center', 0), null);
});

test('clearing a filter can restore an offscreen anchor by logical key', () => {
    const v = api(), layout = v.buildSpanLayout(rowData());
    assert.equal(v.spanAnchorOffset(layout, { key: 'event-1000', offset: 38 }), 30_000);
    assert.equal(v.spanAnchorOffset(layout, { key: 'removed', offset: 38 }), null);
});

test('nearest alignment preserves an already-visible target position', () => {
    const v = api(), layout = v.buildSpanLayout(rowData());
    assert.equal(v.spanScrollOffset(layout, 'event-1000', 360, 'nearest', 30_000), 30_000);
});

test('virtual window snapshots only publish when the mounted range changes', () => {
    const v = api(); const viewport = { scrollTop: 0, clientHeight: 360 };
    const store = v.createSpanWindowStore(() => viewport); store.setLayout(v.buildSpanLayout(rowData()));
    let changes = 0; const remove = store.subscribe(() => changes++); const first = store.getSnapshot();
    store.update(); assert.equal(store.getSnapshot(), first); assert.equal(changes, 0);
    viewport.scrollTop = 30_000; store.update(); assert.equal(changes, 1); assert.ok(store.getSnapshot().start > 900);
    remove(); viewport.scrollTop = 0; store.update(); assert.equal(changes, 1);
});

test('shrinking a long list clamps a previously distant virtual window', () => {
    const v = api(), viewport = { scrollTop: 50_000, clientHeight: 360 };
    const store = v.createSpanWindowStore(() => viewport); store.setLayout(v.buildSpanLayout(rowData()));
    store.setLayout(v.buildSpanLayout(rowData().slice(0, 2)));
    assert.deepEqual(store.getSnapshot(), { start: 0, end: 2, top: 0, bottom: 0 });
});

test('flattened rows preserve order, depth, heights and sibling accessibility positions', () => {
    const v = api(), root = node('root', [event('user', { kind: 'user' }), event('reply'), event('tool', { kind: 'tool' })]);
    const rows = v.flattenSpanRows(root, new Map([['root', root]]), new Set(['a:root']), entries, () => true);
    assert.deepEqual(rows.map(row => row.key), ['a:root', 'e:root:0', 'e:root:1', 'e:root:2']);
    assert.deepEqual(rows.map(row => row.height), [34, 30, 30, 30]);
    assert.deepEqual(rows.map(row => row.depth), [0, 1, 1, 1]);
    assert.deepEqual(rows.slice(1).map(row => [row.position, row.size]), [[1, 3], [2, 3], [3, 3]]);
    assert.equal(v.flattenSpanRows(root, new Map([['root', root]]), new Set(), entries, () => true).length, 1);
});

test('task expansion and unanchored child agents retain their original placement', () => {
    const v = api(), child = node('child', [event('nested')]), orphan = node('orphan', [event('last')]);
    const root = node('root', [event('task', { kind: 'task', spawnedChildId: 'child' }), event('after')], [child, orphan]);
    const nodes = new Map([root, child, orphan].map(item => [item.id, item]));
    const expanded = new Set(['a:root', 'e:root:0', 'a:child', 'a:orphan']);
    const rows = v.flattenSpanRows(root, nodes, expanded, entries, () => true);
    assert.deepEqual(rows.map(row => row.key), ['a:root', 'e:root:0', 'a:child', 'e:child:0', 'e:root:1', 'a:orphan', 'e:orphan:0']);
    assert.equal(rows[2].depth, 2);
});

test('hidden wrapping events promote their child agent without adding a duplicate row', () => {
    const v = api(), child = node('child', [event('nested')]);
    const root = node('root', [event('hidden', { treeHidden: true, spawnedChildId: 'child' })], [child]);
    const rows = v.flattenSpanRows(root, new Map([['root', root], ['child', child]]), new Set(['a:root', 'a:child']), entries, () => false);
    assert.deepEqual(rows.map(row => row.key), ['a:root', 'a:child']);
    assert.equal(rows[1].depth, 1);
});

test('nested CHAIN entries retain matched descendants and omit unrelated entries', () => {
    const v = api(), root = node('root', [event('chain', { kind: 'chain' }), event('child'), event('unrelated')]);
    const trees = () => [{ event: root.events[0], eventIndex: 0, children: [{ event: root.events[1], eventIndex: 1, children: [] }] }, { event: root.events[2], eventIndex: 2, children: [] }];
    const rows = v.flattenSpanRows(root, new Map([['root', root]]), new Set(['a:root', 'e:root:0']), trees, entry => entry.event.name !== 'unrelated');
    assert.deepEqual(rows.map(row => row.key), ['a:root', 'e:root:0', 'e:root:1']);
    assert.deepEqual(rows.map(row => row.depth), [0, 1, 2]);
});

function keyboardTarget(key: string, scrollTop = 0, focusedKey: string | null = null) {
    const v = api();
    const source = fs.readFileSync(new URL('../src/components/observe/TraceSpanViewport.tsx', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('viewport.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let expression = '';
    function visit(node: ts.Node) {
        if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'onKeyDown') expression = ((node.initializer as ts.JsxExpression).expression!).getText(ast);
        ts.forEachChild(node, visit);
    }
    visit(ast); assert.ok(expression);
    const rows = rowData().map(row => ({ ...row, hasChildren: false, isExpanded: false }));
    const layout = v.buildSpanLayout(rows);
    const viewport = { scrollTop, clientHeight: 360, scrollHeight: 54086 };
    const pendingFocusRef = { current: null as string | null };
    const scope = {
        userScroll: () => {}, viewportRef: { current: viewport }, rows, layout,
        start: v.spanWindow(layout, scrollTop, 360).start, virtualized: true, onToggleRow: () => {}, pendingFocusRef,
        spanScrollOffset: v.spanScrollOffset, spanKeyboardIndex: v.spanKeyboardIndex,
        contentInset: () => 4, windowStore: { update: () => {} }, focusPending: () => {},
    };
    const js = ts.transpileModule(`const callback = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const callback = new Function(...Object.keys(scope), js + '; return callback;')(...Object.values(scope));
    callback({ key, defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false,
        target: { closest: () => focusedKey ? { getAttribute: () => focusedKey } : null }, preventDefault: () => {} });
    return pendingFocusRef.current;
}

test('first ArrowDown from the tree container enters the first visible row without an overscan offset', () => {
    assert.equal(keyboardTarget('ArrowDown'), 'agent');
});
test('PageDown from the container uses the real visible row rather than the buffered window start', () => {
    assert.equal(keyboardTarget('PageDown'), 'event-11');
});
test('first ArrowDown in the middle of a long list enters its actual first visible row', () => {
    assert.equal(keyboardTarget('ArrowDown', 30_038), 'event-1000');
});
test('ArrowDown from an already-focused row advances exactly one logical row', () => {
    assert.equal(keyboardTarget('ArrowDown', 30_038, 'event-1000'), 'event-1001');
});

test('a delayed subtree inserted above the viewport preserves the same logical reading anchor', () => {
    const v = api(), rows = rowData();
    const before = v.buildSpanLayout(rows);
    const anchor = v.spanModelAnchor(before, 30_038);
    assert.deepEqual(anchor, { key: 'event-1000', offset: 0 });
    const updated = v.buildSpanLayout([...rows.slice(0, 10), { key: 'late-agent', height: 34 }, { key: 'late-reply', height: 30 }, ...rows.slice(10)]);
    assert.equal(v.spanAnchorOffset(updated, anchor!), 30_102);
});

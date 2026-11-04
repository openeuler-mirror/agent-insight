import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const source = fs.readFileSync(new URL('../src/components/observe/AgentTraceView.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('AgentTraceView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

// Execute the component's actual callbacks and JSX without requiring a browser or mounting its data providers.
function findNode(predicate: (node: ts.Node) => boolean): ts.Node {
    let found: ts.Node | undefined;
    function visit(node: ts.Node) {
        if (!found && predicate(node)) found = node;
        if (!found) ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(found, 'production expression must exist');
    return found;
}
function evaluate<T>(expression: string, scope: Record<string, unknown>): T {
    const js = ts.transpileModule(`const result = (${expression});`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
    }).outputText;
    return new Function(...Object.keys(scope), `${js}\nreturn result;`)(...Object.values(scope));
}
function variable<T>(name: string, scope: Record<string, unknown>): T {
    const node = findNode(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === name) as ts.VariableDeclaration;
    return evaluate<T>(node.initializer!.getText(ast), scope);
}
function functionValue<T>(name: string, scope: Record<string, unknown>): T {
    const node = findNode(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    return evaluate<T>(node.getText(ast), scope);
}
function expansion(initial: string[]) {
    let keys = new Set(initial);
    const scope = {
        tree: { id: 'root' }, agentKey: (id: string) => `agent:${id}`,
        allExpandableKeys: new Set(initial),
        setExpandedKeys: (next: Set<string>) => { keys = next; },
    };
    return {
        collapse: variable<() => void>('collapseAll', scope),
        expand: variable<() => void>('expandAll', scope),
        keys: () => [...keys],
    };
}

test('collapse keeps the root expanded when there are no child Agents', () => {
    const state = expansion(['agent:root']);
    state.collapse();
    assert.deepEqual(state.keys(), ['agent:root']);
    state.expand();
    assert.deepEqual(state.keys(), ['agent:root']);
});

test('collapse then expand restores every nested Agent and CHAIN key', () => {
    const keys = ['agent:root', 'event:root:0', 'agent:child', 'event:child:1'];
    const state = expansion(keys);
    state.collapse();
    assert.deepEqual(state.keys(), ['agent:root']);
    state.expand();
    assert.deepEqual(state.keys(), keys);
});

type PillProps = { value: string; disabled?: boolean; options: { value: string; label: string }[]; onChange: (value: string) => void };
function durationPill(slowOnly: boolean, minDurationMs: number, onChange = (_: number) => {}): React.ReactElement<PillProps> {
    const node = findNode(n => ts.isJsxSelfClosingElement(n) && n.tagName.getText(ast) === 'FilterPill'
        && n.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'label'
            && p.initializer?.getText(ast).includes('traceTree.filterDuration')));
    return evaluate(node.getText(ast), {
        React, FilterPill: 'div', tt: (key: string) => key,
        slowOnly, minDurationMs, SLOW_MS: 60_000, setMinDurationMs: onChange, captureSpanContext: () => {},
    });
}

test('slow-only displays its effective >60s duration and does not overwrite the previous duration', () => {
    let stored = 5_000;
    const slow = durationPill(true, stored, value => { stored = value; });
    assert.equal(slow.props.value, '60000');
    assert.equal(slow.props.disabled, true);
    assert.equal(slow.props.options.find(o => o.value === slow.props.value)?.label, '>60s');
    assert.equal(stored, 5_000);
    const restored = durationPill(false, stored, value => { stored = value; });
    assert.equal(restored.props.value, '5000');
    assert.equal(Boolean(restored.props.disabled), false);
    restored.props.onChange('10000');
    assert.equal(stored, 10_000);
});

test('slow-only duration choices render disabled with the >60s choice selected', () => {
    const FilterPill = functionValue<React.ComponentType<PillProps>>('FilterPill', {
        React, cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
    });
    const props = durationPill(true, 0).props;
    const html = renderToStaticMarkup(React.createElement(FilterPill, props));
    const buttons = html.match(/<button\b[^>]*>/g) || [];
    assert.ok(buttons.length > 0);
    assert.ok(buttons.every(button => button.includes('disabled=""')));
    assert.match(html, /aria-pressed="true"[^>]*>&gt;60s<\/button>/);
});

test('manual duration filtering offers >60s without enabling slow-only', () => {
    const pill = durationPill(false, 60_000);
    assert.equal(pill.props.options.find(o => o.value === pill.props.value)?.label, '>60s');
    assert.equal(Boolean(pill.props.disabled), false);
});

function eventVisible(durationMs: number | undefined, slowOnly: boolean, minDurationMs: number) {
    const matches = functionValue<(...args: unknown[]) => boolean>('traceEventMatchesFilters', { eventKey: () => 'event', SLOW_MS: 60_000 });
    return matches({ startedAt: 0, completedAt: durationMs, usage: { total: 0 }, kind: 'tool' }, 0, 'root', new Map(), {
        treeKindFilter: [], minDurationMs, minTokenK: 0, ctxSlowOnly: slowOnly, searchQuery: '', matchedKeys: new Set(),
    });
}

test('slow-only and manual >60s agree at missing, 59999ms, 60000ms and 60001ms boundaries', () => {
    for (const duration of [undefined, 59_999, 60_000, 60_001]) {
        assert.equal(eventVisible(duration, true, 0), duration === 60_001, `slow-only ${duration}`);
        assert.equal(eventVisible(duration, false, 60_000), duration === 60_001, `manual ${duration}`);
    }
});

test('TASK rows use child duration and leave unresolved coordination events without a duration', () => {
    const unresolved = variable<number | undefined>('spanDurationMs', {
        event: { kind: 'task', startedAt: 100, completedAt: 100 }, childNode: undefined,
    });
    const linked = variable<number | undefined>('spanDurationMs', {
        event: { kind: 'task', startedAt: 100, completedAt: 100 }, childNode: { stats: { durationMs: 44_000 } },
    });
    const regular = variable<number | undefined>('spanDurationMs', {
        event: { kind: 'tool', startedAt: 100, completedAt: 350 }, childNode: undefined,
    });
    assert.equal(unresolved, undefined);
    assert.equal(linked, 44_000);
    assert.equal(regular, 250);
});


test('Span type buttons accumulate selections, toggle off and restore all types', () => {
    type MultiPillProps = { multiple: true; label: string; value: string[]; options: { value: string; label: string }[]; onChange: (value: string[]) => void };
    type ButtonProps = { children: string; 'aria-pressed': boolean; onClick: () => void };
    type PillElement = React.ReactElement<{ children: [React.ReactNode, React.ReactElement<{ children: React.ReactNode }>] }>;
    const FilterPill = functionValue<(props: MultiPillProps) => PillElement>('FilterPill', { React, cn: (...values: unknown[]) => values.filter(Boolean).join(' ') });
    const pill = findNode(n => ts.isJsxSelfClosingElement(n) && n.tagName.getText(ast) === 'FilterPill'
        && n.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'label'
            && p.initializer?.getText(ast).includes('traceTree.filterType')));
    let selected: string[] = [];
    const buttons = () => {
        const element = evaluate<React.ReactElement<MultiPillProps>>(pill.getText(ast), {
            React, FilterPill, captureSpanContext: () => {}, treeKindFilter: selected, setTreeKindFilter: (next: string[]) => { selected = next; },
            tt: (key: string) => key, totalStats: { chains: 1 },
            KIND_META: Object.fromEntries(['llm', 'tool', 'task', 'chain', 'skill'].map(kind => [kind, { text: '' }])),
        });
        const rendered = FilterPill(element.props);
        return React.Children.toArray(rendered.props.children[1].props.children) as React.ReactElement<ButtonProps>[];
    };
    const button = (label: string) => buttons().find(b => b.props.children === label)!;
    assert.equal(button('traceTree.filterAll').props['aria-pressed'], true);
    button('User').props.onClick();
    button('LLM').props.onClick();
    assert.deepEqual(selected, ['user', 'llm']);
    assert.equal(button('User').props['aria-pressed'], true);
    assert.equal(button('LLM').props['aria-pressed'], true);
    assert.equal(button('Tool').props['aria-pressed'], false);
    assert.equal(button('traceTree.filterAll').props['aria-pressed'], false);
    button('User').props.onClick();
    assert.deepEqual(selected, ['llm']);
    button('LLM').props.onClick();
    assert.deepEqual(selected, []);
    assert.equal(button('traceTree.filterAll').props['aria-pressed'], true);
    button('Tool').props.onClick();
    button('Skill').props.onClick();
    button('traceTree.filterAll').props.onClick();
    assert.deepEqual(selected, []);
});

test('User plus LLM filtering preserves dialogue order and excludes unrelated event types', () => {
    const matches = functionValue<(...args: unknown[]) => boolean>('traceEventMatchesFilters', { eventKey: (owner: string, index: number) => `${owner}:${index}`, SLOW_MS: 60_000 });
    const events = ['user', 'llm', 'tool', 'skill', 'task', 'chain', 'user', 'llm'].map(kind => ({ kind }));
    const filters = { treeKindFilter: ['user', 'llm'], minDurationMs: 0, minTokenK: 0, ctxSlowOnly: false, searchQuery: '', matchedKeys: new Set() };
    assert.deepEqual(events.filter((event, index) => matches(event, index, 'root', new Map(), filters)), [events[0], events[1], events[6], events[7]]);
    assert.deepEqual(events.filter((event, index) => matches(event, index, 'root', new Map(), { ...filters, treeKindFilter: [] })), events);
    assert.deepEqual(events.filter((event, index) => matches(event, index, 'root', new Map(), { ...filters, treeKindFilter: ['missing'] })), []);
});

test('multiple Span types still combine with search, duration, tokens and slow-only', () => {
    const matches = functionValue<(...args: unknown[]) => boolean>('traceEventMatchesFilters', { eventKey: (owner: string, index: number) => `${owner}:${index}`, SLOW_MS: 60_000 });
    const event = { kind: 'llm', startedAt: 0, completedAt: 60_001, usage: { total: 12_000 } };
    const filters = { treeKindFilter: ['user', 'llm'], minDurationMs: 5_000, minTokenK: 10, ctxSlowOnly: true, searchQuery: 'answer', matchedKeys: new Set(['root:0']) };
    const visible = (changes: object) => matches({ ...event, ...changes }, 0, 'root', new Map(), filters);
    assert.equal(visible({}), true);
    assert.equal(visible({ kind: 'tool' }), false);
    assert.equal(visible({ completedAt: 60_000 }), false);
    assert.equal(visible({ completedAt: 4_999 }), false);
    assert.equal(visible({ usage: { total: 9_999 } }), false);
    assert.equal(matches(event, 1, 'root', new Map(), filters), false);
});

test('multi-type filtering retains structural ancestors for matching nested dialogue', () => {
    const build = functionValue<(...args: unknown[]) => unknown>('buildAgentEventTree', {});
    const contains = functionValue<(...args: unknown[]) => boolean>('agentEventTreeMatches', { buildAgentEventTree: build });
    const matches = functionValue<(...args: unknown[]) => boolean>('traceEventMatchesFilters', { eventKey: () => '', SLOW_MS: 60_000 });
    const child = { id: 'child', events: [{ kind: 'user' }, { kind: 'llm' }, { kind: 'tool' }], children: [] };
    const nodes = new Map([['child', child]]);
    const entry = { event: { kind: 'chain' }, eventIndex: 0, children: [{ event: { kind: 'task', spawnedChildId: 'child' }, eventIndex: 1, children: [] }] };
    const filters = { treeKindFilter: ['user', 'llm'], minDurationMs: 0, minTokenK: 0, ctxSlowOnly: false, searchQuery: '', matchedKeys: new Set() };
    const predicate = (event: { kind: string }, index: number, owner: string) => matches(event, index, owner, nodes, filters);
    assert.equal(predicate(entry.event, 0, 'root'), false);
    assert.equal(contains(entry, 'root', nodes, predicate), true);
    child.events = [{ kind: 'tool' }];
    assert.equal(contains(entry, 'root', nodes, predicate), false);
});

test('reset clears all selected Span types and other filter restrictions', () => {
    const reset = findNode(n => ts.isJsxElement(n) && n.openingElement.tagName.getText(ast) === 'Button'
        && n.children.some(child => ts.isJsxExpression(child) && child.expression?.getText(ast) === "tt('traceTree.resetFilter')")) as ts.JsxElement;
    const attribute = reset.openingElement.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'onClick') as ts.JsxAttribute;
    const expression = attribute.initializer as ts.JsxExpression;
    const state = { treeKindFilter: ['user', 'llm'], minDurationMs: 5_000, minTokenK: 10, slowOnly: true };
    evaluate<() => void>(expression.expression!.getText(ast), {
        captureSpanContext: () => {},
        setTreeKindFilter: (value: string[]) => { state.treeKindFilter = value; },
        setMinDurationMs: (value: number) => { state.minDurationMs = value; },
        setMinTokenK: (value: number) => { state.minTokenK = value; },
        setSlowOnly: (value: boolean) => { state.slowOnly = value; },
    })();
    assert.deepEqual(state, { treeKindFilter: [], minDurationMs: 0, minTokenK: 0, slowOnly: false });
    assert.equal(variable<boolean>('hasActiveFilters', state), false);
    assert.equal(variable<boolean>('hasActiveFilters', { ...state, treeKindFilter: ['user', 'llm'] }), true);
});


test('explicit Span navigation pauses following even when reselecting the same key', () => {
    let pauses = 0;
    let selected = 'event:root:0';
    const jump = variable<(key: string) => void>('onJumpToKey', {
        cancelPendingSpanJump: () => {}, spanJumpTimerRef: { current: null },
        spanFocusKeyRef: { current: null }, allSpans: [], spanViewportRef: { current: { pauseFollowing: () => { pauses++; } } },
        setSelectedKey: (key: string) => { selected = key; }, setTimeout: () => 0,
    });
    jump(selected);
    assert.equal(pauses, 1);
    assert.equal(selected, 'event:root:0');
});

test('Span row selection pauses following before opening details', () => {
    const node = findNode(n => ts.isJsxSelfClosingElement(n) && n.tagName.getText(ast) === 'UnifiedSpanTree') as ts.JsxSelfClosingElement;
    const attr = node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'onSelect') as ts.JsxAttribute;
    const expression = attr.initializer as ts.JsxExpression;
    const calls: string[] = [];
    evaluate<(key: string) => void>(expression.expression!.getText(ast), {
        cancelPendingSpanJump: () => {},
        spanFocusKeyRef: { current: null },
        spanViewportRef: { current: { pauseFollowing: () => { calls.push('pause'); } } },
        setSelectedKey: (key: string) => { calls.push(key); },
    })('event:root:0');
    assert.deepEqual(calls, ['pause', 'event:root:0']);
});


test('TopN navigation to an already expanded Span preserves the expansion reference', () => {
    const current = new Set(['agent:root']);
    let expanded = current;
    const jump = variable<(key: string) => void>('onJumpToKey', {
        cancelPendingSpanJump: () => {}, spanJumpTimerRef: { current: null },
        spanFocusKeyRef: { current: null }, allSpans: [{ key: 'event:root:0', parentKeys: ['agent:root'] }],
        spanViewportRef: { current: { pauseFollowing: () => {} } },
        sameStringSet: functionValue('sameStringSet', {}),
        setExpandedKeys: (update: (value: Set<string>) => Set<string>) => { expanded = update(expanded); },
        setSelectedKey: () => {}, setTimeout: () => 0,
    });
    jump('event:root:0');
    assert.equal(expanded, current);
});

test('search refresh without newly expanded ancestors preserves the expansion reference', () => {
    const call = findNode(n => ts.isCallExpression(n) && n.expression.getText(ast) === 'setExpandedKeys'
        && n.arguments[0]?.getText(ast).includes('searchMatches.forEach')) as ts.CallExpression;
    const update = evaluate<(value: Set<string>) => Set<string>>(call.arguments[0].getText(ast), {
        searchMatches: [{ parentKeys: ['agent:root'] }], sameStringSet: functionValue('sameStringSet', {}),
    });
    const current = new Set(['agent:root']);
    assert.equal(update(current), current);
    const collapsed = new Set<string>();
    assert.deepEqual([...update(collapsed)], ['agent:root']);
    assert.equal(collapsed.size, 0);
});

test('jumping to bottom cancels an older delayed Span navigation', () => {
    const timers = new Map<number, () => void>();
    const spanJumpTimerRef = { current: null as number | null };
    const cancel = variable<() => void>('cancelPendingSpanJump', {
        useCallback: (callback: () => void) => callback, spanJumpTimerRef,
        clearTimeout: (id: number) => timers.delete(id),
    });
    const jump = variable<(key: string) => void>('onJumpToKey', {
        spanFocusKeyRef: { current: null }, allSpans: [], spanViewportRef: { current: { pauseFollowing: () => {} } },
        cancelPendingSpanJump: cancel, spanJumpTimerRef, setSelectedKey: () => {},
        setTimeout: (callback: () => void) => { timers.set(1, callback); return 1; },
    });
    jump('old-span');
    assert.equal(timers.size, 1);
    const node = findNode(n => ts.isJsxOpeningElement(n) && n.tagName.getText(ast) === 'TraceSpanViewport') as ts.JsxOpeningElement;
    const attr = node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'onUserNavigation') as ts.JsxAttribute;
    const expression = attr.initializer as ts.JsxExpression;
    evaluate<() => void>(expression.expression!.getText(ast), { cancelPendingSpanJump: cancel })();
    assert.equal(timers.size, 0);
    assert.equal(spanJumpTimerRef.current, null);
});


test('clearing the search captures the current Span before restoring the full tree', () => {
    const input = findNode(n => ts.isJsxSelfClosingElement(n) && n.tagName.getText(ast) === 'input'
        && n.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'value'
            && p.initializer?.getText(ast) === '{searchQuery}')) as ts.JsxSelfClosingElement;
    const attr = input.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'onChange') as ts.JsxAttribute;
    const expression = attr.initializer as ts.JsxExpression;
    const calls: unknown[] = [];
    const change = evaluate<(event: { target: { value: string } }) => void>(expression.expression!.getText(ast), {
        searchQuery: '第150轮', captureSpanContext: () => { calls.push('anchor'); },
        setSearchQuery: (value: string) => { calls.push(value); }, setSearchMatchIdx: () => {},
    });
    change({ target: { value: '' } });
    assert.deepEqual(calls, ['anchor', '']);
});

test('Span detail timestamps include the date so adjacent days remain distinguishable', () => {
    const format = functionValue<(value?: number) => string | null>('formatClockMs', {});
    assert.equal(format(new Date(2026, 10, 2, 23, 59, 59, 999).getTime()), '2026-11-02 23:59:59.999');
    assert.equal(format(new Date(2026, 10, 3, 0, 0, 0, 1).getTime()), '2026-11-03 00:00:00.001');
    assert.equal(format(), null);
    assert.equal(format(Number.NaN), null);
});

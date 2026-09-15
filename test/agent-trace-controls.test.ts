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

test('collapse hides ordinary events even when the root is the only expandable node', () => {
    const state = expansion(['agent:root']);
    state.collapse();
    assert.deepEqual(state.keys(), []);
    state.expand();
    assert.deepEqual(state.keys(), ['agent:root']);
});

test('collapse then expand restores every nested Agent and CHAIN key', () => {
    const keys = ['agent:root', 'event:root:0', 'agent:child', 'event:child:1'];
    const state = expansion(keys);
    state.collapse();
    assert.deepEqual(state.keys(), []);
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
        slowOnly, minDurationMs, SLOW_MS: 60_000, setMinDurationMs: onChange,
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
    const callback = findNode(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'renderEventEntry') as ts.VariableDeclaration;
    const body = (callback.initializer as ts.ArrowFunction).body as ts.Block;
    const start = body.statements.findIndex(n => ts.isVariableStatement(n)
        && n.declarationList.declarations[0].name.getText(ast) === 'evDur');
    const end = body.statements.findIndex(n => ts.isVariableStatement(n)
        && n.declarationList.declarations[0].name.getText(ast) === 'descendantPrefixBits');
    assert.ok(start >= 0 && end > start);
    const expression = `() => { ${body.statements.slice(start, end).map(n => n.getText(ast)).join('\n')} return true; }`;
    return evaluate<() => boolean | null>(expression, {
        childNode: undefined,
        ev: { startedAt: 0, completedAt: durationMs, usage: { total: 0 }, kind: 'tool' },
        SLOW_MS: 60_000, treeKindFilter: 'all', minDurationMs, minTokenK: 0,
        ctxSlowOnly: slowOnly, searchQuery: '',
    })() === true;
}

test('slow-only and manual >60s agree at missing, 59999ms, 60000ms and 60001ms boundaries', () => {
    for (const duration of [undefined, 59_999, 60_000, 60_001]) {
        assert.equal(eventVisible(duration, true, 0), duration === 60_001, `slow-only ${duration}`);
        assert.equal(eventVisible(duration, false, 60_000), duration === 60_001, `manual ${duration}`);
    }
});

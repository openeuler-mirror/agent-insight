import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const source = fs.readFileSync(new URL('../src/app/(main)/trace/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('trace.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate: (node: ts.Node) => boolean) {
    let result: ts.Node | undefined;
    function visit(node: ts.Node) { if (!result && predicate(node)) result = node; if (!result) ts.forEachChild(node, visit); }
    visit(ast);
    assert.ok(result, 'production compact-list expression exists');
    return result;
}
function evaluate<T>(expression: string, scope: Record<string, unknown>): T {
    const js = ts.transpileModule(`const value = (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
    return new Function(...Object.keys(scope), js + '\nreturn value;')(...Object.values(scope));
}
const empty = {
    ownershipFilter: 'all', agentFilter: 'all', skillFilter: 'all', selectedUserTagIds: [],
    anomalyFilter: 'all', reliabilityAnomalyFilter: 'all', timeFilter: 'all', frameworkFilter: 'all', agentScopeFilter: 'root',
};
function count(overrides: Record<string, unknown> = {}) {
    const node = find(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'compactFilterCount') as ts.VariableDeclaration;
    return evaluate<number>(node.initializer!.getText(ast), { ...empty, ...overrides });
}

test('compact filter indicator includes default ownership and every hidden criterion', () => {
    assert.equal(count(), 0);
    assert.equal(count({ ownershipFilter: 'user' }), 1);
    assert.equal(count({ ownershipFilter: 'user', anomalyFilter: 'failed', frameworkFilter: 'opencode', agentScopeFilter: 'all', selectedUserTagIds: ['a', 'b'] }), 5);
});

test('visible text search and search-bar clauses are not counted as hidden dropdown filters', () => {
    assert.equal(count({ search: 'error', clauses: [{ field: 'tokens', value: 10 }] }), 0);
    assert.equal(count({ skillFilter: 'debug', timeFilter: '24h', agentFilter: 'build', reliabilityAnomalyFilter: 'anomaly' }), 4);
});

function toggle(open: boolean, enabled: number, locale: string, update: (fn: (previous: boolean) => boolean) => void) {
    const node = find(n => ts.isJsxElement(n) && n.openingElement.tagName.getText(ast) === 'Button'
        && n.openingElement.attributes.properties.some(a => ts.isJsxAttribute(a) && a.name.getText(ast) === 'aria-controls' && a.initializer?.getText(ast) === '"trace-list-filters"'));
    return evaluate<React.ReactElement<{ onClick: () => void; 'aria-expanded': boolean; 'aria-controls': string }>>(node.getText(ast), {
        React, Button: 'button', SlidersHorizontal: 'svg', ChevronDown: 'svg',
        styles: new Proxy({}, { get: (_target, key) => String(key) }),
        cn: (...parts: unknown[]) => parts.filter(Boolean).join(' '),
        compactFiltersOpen: open, compactFilterCount: enabled, locale, setCompactFiltersOpen: update,
    });
}

test('compact filter toggle changes only presentation and can be repeatedly opened and closed', () => {
    const filters = { ...empty, frameworkFilter: 'opencode', page: 2, selected: ['trace-1'] };
    const before = JSON.stringify(filters); let open = false;
    const update = (fn: (previous: boolean) => boolean) => { open = fn(open); };
    const closed = toggle(open, 1, 'zh', update);
    assert.equal(closed.props['aria-controls'], 'trace-list-filters');
    assert.equal(closed.props['aria-expanded'], false);
    closed.props.onClick(); assert.equal(open, true);
    const expanded = toggle(open, 1, 'zh', update);
    assert.equal(expanded.props['aria-expanded'], true);
    expanded.props.onClick(); assert.equal(open, false);
    assert.equal(JSON.stringify(filters), before);
});

test('compact toggle exposes active count and supports both interface languages', () => {
    assert.match(renderToStaticMarkup(toggle(false, 3, 'zh', () => {})), /更多筛选/);
    assert.match(renderToStaticMarkup(toggle(false, 3, 'zh', () => {})), />3</);
    assert.match(renderToStaticMarkup(toggle(true, 0, 'en', () => {})), /More filters/);
});

test('compact list layout never changes the Trace detail container', () => {
    const node = find(n => ts.isJsxOpeningElement(n) && n.tagName.getText(ast) === 'PageContainer') as ts.JsxOpeningElement;
    const attr = node.attributes.properties.find(a => ts.isJsxAttribute(a) && a.name.getText(ast) === 'className') as ts.JsxAttribute;
    assert.ok(attr?.initializer && ts.isJsxExpression(attr.initializer), 'layout style is scoped to list mode');
    const expression = attr.initializer.expression!.getText(ast);
    assert.equal(evaluate(expression, { selectedExecution: null, styles: { page: 'compact-list' } }), 'compact-list');
    assert.equal(evaluate(expression, { selectedExecution: { task_id: 'trace-1' }, styles: { page: 'compact-list' } }), undefined);
});

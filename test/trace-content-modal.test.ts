import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import JsonView from 'react18-json-view';

function component(file: string, name: string, scope: Record<string, unknown>) {
    const source = fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)!;
    assert.ok(node);
    const code = ts.transpileModule(node.getText(ast).replace(/^export /, ''), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
    }).outputText;
    return new Function(...Object.keys(scope), `${code}; return ${name};`)(...Object.values(scope));
}

const JsonRenderer = component('components/SmartViewer/renderers/JsonRenderer.tsx', 'JsonRenderer', { React, JsonView });
const SmartViewer = component('components/SmartViewer/index.tsx', 'SmartViewer', {
    React, useState: React.useState, useMemo: React.useMemo,
    useContext: () => ({ jsonCollapsed: 2 }), SmartViewerConfigContext: {},
    unescapeText: (s: string) => s, detect: (s: string) => ({ kind: 'json', data: JSON.parse(s) }),
    JsonRenderer,
});
const Modal = component('components/observe/AgentTraceView.tsx', 'ContentModal', {
    React, useState: React.useState, SmartViewer,
    Dialog: ({ children }: any) => React.createElement(React.Fragment, null, children),
    DialogContent: 'section', DialogHeader: 'header', DialogTitle: 'h2', Button: 'button',
    Check: () => null, CopyIcon: () => null,
});
function render(data: unknown) {
    return renderToStaticMarkup(React.createElement(Modal, { title: 'Input', raw: JSON.stringify(data), onClose: () => {} }));
}

test('view-all initially reveals deeply nested tool input', () => {
    assert.ok(render({ todos: [{ nested: { content: 'DEEP_INPUT_END' } }] }).includes('DEEP_INPUT_END'));
});

test('view-all initially reveals the end of long strings', () => {
    const value = '中文 content '.repeat(40) + 'LONG_STRING_END';
    assert.ok(render({ command: value }).includes(value));
});

test('view-all initially reveals every entry of large arrays', () => {
    const values = Array.from({ length: 150 }, (_, i) => ({ value: `ENTRY_${i}_END` }));
    const html = render({ values });
    for (const item of values) assert.ok(html.includes(item.value), item.value);
});

test('inline preview keeps its existing folding defaults', () => {
    const html = renderToStaticMarkup(React.createElement(SmartViewer, {
        text: JSON.stringify({ todos: [{ nested: { content: 'DEEP_INPUT_END' } }] }), toolbar: false,
    }));
    assert.ok(!html.includes('DEEP_INPUT_END'));
});

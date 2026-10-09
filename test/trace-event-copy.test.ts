import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { detect } from '../src/components/SmartViewer/detector';
import { unescapeText } from '../src/components/SmartViewer/unescape';

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

function buttons(value: unknown) {
    const copied: string[] = [];
    const Viewer = component('components/SmartViewer/index.tsx', 'SmartViewer', {
        React, useState: (v: unknown) => [v, () => {}], useMemo: (fn: () => unknown) => fn(),
        useContext: () => ({ jsonCollapsed: 2 }), SmartViewerConfigContext: {},
        detect, unescapeText, copyText: async (text: string) => { copied.push(text); },
        setTimeout: () => {}, JsonRenderer: 'pre', MarkdownRenderer: 'pre', CodeRenderer: 'pre', PlainRenderer: 'pre',
    });
    const Block = component('components/observe/AgentTraceView.tsx', 'ModalCodeBlock', { React, SmartViewer: Viewer });
    const block = Block({ value });
    const rendered = Viewer(block.props);
    const found: React.ReactElement<any>[] = [];
    function walk(element: any) {
        if (!React.isValidElement(element)) return;
        const item = element as React.ReactElement<any>;
        if (item.type === 'button') found.push(item);
        React.Children.forEach(item.props.children, walk);
    }
    walk(rendered);
    return { found, copied };
}

for (const [name, value] of [
    ['structured input', { command: 'printf test', options: { nested: true } }],
    ['long plain output', '完整输出\n'.repeat(300) + 'OUTPUT_END'],
    ['markdown output', '# Result\n\n**completed**'],
    ['zero output', 0],
    ['false output', false],
] as const) {
    test(`timeline event modal offers full copy for ${name}`, async () => {
        const { found, copied } = buttons(value);
        assert.equal(found.length, 1, 'one visible full-content copy button');
        await found[0].props.onClick();
        assert.deepEqual(copied, [typeof value === 'string' ? value : JSON.stringify(value, null, 2)]);
    });
}

/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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

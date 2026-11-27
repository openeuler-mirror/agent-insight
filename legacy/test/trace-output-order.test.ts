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

// 历史混合记录(跨机采集把前面几轮的工具调用并进了最终回答)的展示顺序:
// 工具确实先于文本执行时先渲染工具调用,正常「过渡语 + 工具」轮次保持 Response 在前。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

function extractFunction(name: string, scope: Record<string, unknown>) {
    const file = 'components/observe/AgentTraceView.tsx';
    const source = fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, `missing function ${name}`);
    const code = ts.transpileModule(node!.getText(ast).replace(/^export /, ''), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
    }).outputText;
    return new Function(...Object.keys(scope), `${code}; return ${name};`)(...Object.values(scope));
}

const passthrough = (name: string) => function StubBlock(props: { label?: string }) {
    return React.createElement('div', { 'data-block': name }, name === 'tools' ? 'Tool calls' : props.label);
};

const KIND_META = {
    agent: { label: 'AGENT', chip: 'agent-chip', bar: '', text: '' },
    tool: { label: 'TOOL', chip: 'tool-chip', bar: '', text: '' },
    llm: { label: 'LLM', chip: 'llm-chip', bar: '', text: '' },
    user: { label: 'USER', chip: 'user-chip', bar: '', text: '' },
};

const SnapshotMessageRow = extractFunction('SnapshotMessageRow', {
    React,
    useState: React.useState,
    cn: (...parts: unknown[]) => parts.filter(Boolean).join(' '),
    KIND_META,
    PREVIEW_CHARS: 300,
    TRACE_DISCLOSURE_PREVIEW_CHARS: 3000,
    truncateForPreview: (text: string) => ({ text, truncated: false, totalChars: text.length }),
    DisclosureBar: passthrough('response'),
    ThinkingBlock: () => null,
    ToolCallList: passthrough('tools'),
    MessageIcon: () => null,
    ChevronRight: () => null,
    Button: 'button',
    ContentModal: () => null,
});

const interactionTimestampMs = extractFunction('interactionTimestampMs', {});
const toolsPrecedeResponse = extractFunction('toolsPrecedeResponse', { interactionTimestampMs });
const summarizePromptArgs = extractFunction('summarizePromptArgs', {});
const interactionToPromptText = extractFunction('interactionToPromptText', { summarizePromptArgs, toolsPrecedeResponse });

// 参考 issue 里的复现现场:工具 01:06:22.470 / 01:06:26.932 开始,记录 01:06:26.500 完成
const mixedInteraction = {
    role: 'assistant',
    content: '项目当前有两个未提交的文件。',
    timeInfo: { created: '2026-05-11T01:06:20.000Z', completed: '2026-05-11T01:06:26.500Z' },
    tool_calls: [
        { name: 'mcp_tool', timing: { started_at: '2026-05-11T01:06:22.470Z', completed_at: '2026-05-11T01:06:23.000Z' } },
        { name: 'mcp_tool', timing: { started_at: '2026-05-11T01:06:26.932Z', completed_at: '2026-05-11T01:06:27.100Z' } },
    ],
};

const normalInteraction = {
    role: 'assistant',
    content: '我先看一下 git 状态。',
    timeInfo: { created: '2026-05-11T01:06:20.000Z', completed: '2026-05-11T01:06:22.000Z' },
    tool_calls: [
        { name: 'Bash', timing: { started_at: '2026-05-11T01:06:22.400Z', completed_at: '2026-05-11T01:06:22.800Z' } },
    ],
};

test('mixed historical record renders tool calls before the final answer', () => {
    const html = renderToStaticMarkup(React.createElement(SnapshotMessageRow, {
        message: {
            role: 'assistant',
            content: mixedInteraction.content,
            toolCalls: [{ name: 'mcp_tool', args: '', output: '' }, { name: 'mcp_tool', args: '', output: '' }],
            toolsFirst: true,
            source: 'history',
            position: 1,
        },
        defaultExpanded: true,
        modalTitle: 'Output',
    }));
    const toolsAt = html.indexOf('data-block="tools"');
    const responseAt = html.indexOf('data-block="response"');
    assert.ok(toolsAt >= 0 && responseAt >= 0);
    assert.ok(toolsAt < responseAt, 'tools should render before the response');
});

test('normal transition-text turn keeps the response before its tool calls', () => {
    const html = renderToStaticMarkup(React.createElement(SnapshotMessageRow, {
        message: {
            role: 'assistant',
            content: normalInteraction.content,
            toolCalls: [{ name: 'Bash', args: '', output: '' }],
            toolsFirst: false,
            source: 'history',
            position: 1,
        },
        defaultExpanded: true,
        modalTitle: 'Output',
    }));
    const toolsAt = html.indexOf('data-block="tools"');
    const responseAt = html.indexOf('data-block="response"');
    assert.ok(responseAt < toolsAt, 'response should render before tools');
});

test('tools-count-as-preceding only when a tool started before the turn completed', () => {
    assert.equal(toolsPrecedeResponse(mixedInteraction), true);
    assert.equal(toolsPrecedeResponse(normalInteraction), false);
    assert.equal(toolsPrecedeResponse({ role: 'assistant', content: 'x', tool_calls: [] }), false);
    assert.equal(toolsPrecedeResponse({ role: 'assistant', content: 'x', tool_calls: [{ name: 'a' }] }), false);
});

test('prompt snapshot text keeps both the response text and its tool calls', () => {
    const mixed = interactionToPromptText(mixedInteraction);
    assert.ok(mixed.includes('项目当前有两个未提交的文件。'));
    assert.ok(mixed.includes('[tool calls x 2]'));
    assert.ok(mixed.indexOf('[tool calls x 2]') < mixed.indexOf('项目当前有两个未提交的文件。'));
    const normal = interactionToPromptText(normalInteraction);
    assert.ok(normal.includes('我先看一下 git 状态。'));
    assert.ok(normal.includes('[tool calls x 1]'));
});

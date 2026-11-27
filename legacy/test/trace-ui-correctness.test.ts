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
import { renderToStaticMarkup } from 'react-dom/server';
import * as traceEngine from '../src/lib/engine/observability/agent-trace';

function productionFunction(file: string, names: string[], scope: Record<string, unknown>) {
    const source = fs.readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text || ''));
    assert.equal(functions.length, names.length);
    const code = ts.transpileModule(functions.map(node => node.getText(ast)).join('\n'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
    }).outputText;
    return new Function(...Object.keys(scope), code + '\nreturn ' + names[0])(...Object.values(scope));
}

test('Trace status exposes failed work in the current Agent and descendants before slow status', () => {
    const status = productionFunction('src/components/observe/AgentTraceView.tsx', ['getStatus', 'isErrorToolStatus'], { ...traceEngine, SLOW_MS: 60000 });
    const leaf = (toolStatus: string) => ({ events: [{ toolStatus }], children: [], stats: { durationMs: 120000 } });
    assert.equal(status(leaf('error')), 'error');
    assert.equal(status({ events: [], children: [leaf('failed')], stats: { durationMs: 120000 } }), 'error');
    assert.equal(status(leaf('completed')), 'slow');
    assert.equal(status({ events: [], children: [], stats: { durationMs: 1000 } }), 'ok');
    assert.equal(status({ events: [], children: [], stats: { durationMs: 3_650_000, activeDurationMs: 50_000 } }), 'ok');
    assert.equal(status({ ...leaf('error'), stats: { durationMs: 3_650_000, activeDurationMs: 50_000 } }), 'error');
});

test('Histogram merges percentile labels when they fall in the same bucket', () => {
    const element = (name: string) => function FixtureElement(props: { children?: React.ReactNode }) { return React.createElement(name, null, props.children); };
    const histogram = productionFunction('src/app/(main)/dashboard/page.tsx', ['Histogram'], {
        React, useThemeColors: () => ({ fgMuted: 'var(--foreground-muted)' }),
        ResponsiveContainer: element('section'), BarChart: element('div'), CartesianGrid: () => null,
        XAxis: () => null, YAxis: () => null, Tooltip: () => null, Bar: () => null,
        ReferenceLine: (props: { label: { value: string } }) => React.createElement('i', null, props.label.value),
        CHART_H: 200, mgn: {}, ax: {}, tipStyle: {},
    });
    const html = renderToStaticMarkup(histogram({ data: [], color: 'var(--primary)', marks: [
        { label: 'same-bin', text: 'P50', color: 'var(--primary)' },
        { label: 'same-bin', text: 'P95', color: 'var(--warning)' },
    ] }));
    assert.equal((html.match(/<i>/g) || []).length, 1);
    assert.match(html, /P50 \/ P95/);
});

for (const locale of ['zh', 'en']) {
    test(`Completed child summary describes failed calls without claiming a failed session (${locale})`, () => {
        const summary = productionFunction('src/components/observe/AgentTraceView.tsx', ['SpawnedChildSummary', 'getStatus', 'isErrorToolStatus'], {
            ...traceEngine, React, TraceCtx: React.createContext({}), SLOW_MS: 60000,
            useLocale: () => ({ locale }), STATUS_DOT: { error: 'text-error' },
            cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
            KindBadge: () => null, getAgentNodeDisplayLabel: () => 'explore',
            formatDuration: () => '1s', exactTokens: (value: number) => String(value),
        });
        const child = {
            id: 'completed-child', agentName: 'explore', children: [],
            events: [{ kind: 'tool', toolStatus: 'failed' }, { kind: 'llm', summary: 'Completed successfully' }],
            stats: { durationMs: 1000, totalTokens: 0, llmCalls: 1, toolCalls: 1, skillCalls: 0 },
        };
        const html = renderToStaticMarkup(React.createElement(summary, { child }));
        assert.match(html, locale === 'zh' ? /含失败调用/ : /Contains failed calls/);
        assert.doesNotMatch(html, />失败<\/b>|>Failed<\/b>/);
    });
}

for (const theme of ['light', 'dark']) {
    test(`Full text modal follows the active ${theme} theme`, () => {
        const box = (tag: string) => function Box(props: { children?: React.ReactNode }) { return React.createElement(tag, null, props.children); };
        const Modal = productionFunction('src/components/observe/AgentTraceView.tsx', ['ContentModal'], {
            React, useState: React.useState, useTheme: () => ({ theme }),
            Dialog: box('section'), DialogContent: box('div'), DialogHeader: box('header'), DialogTitle: box('h2'),
            Button: box('button'), Check: () => null, CopyIcon: () => null,
            SmartViewer: (props: { theme: string; text: string }) => React.createElement('pre', { 'data-theme': props.theme }, props.text),
        });
        const html = renderToStaticMarkup(React.createElement(Modal, { title: 'full input', raw: 'TAIL_MARKER', onClose() {} }));
        assert.match(html, new RegExp(`data-theme="${theme}"`));
        assert.match(html, /TAIL_MARKER/);
    });
}

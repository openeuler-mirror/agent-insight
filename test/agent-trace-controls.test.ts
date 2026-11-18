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
import { getAgentActiveDurationMs } from '../src/lib/engine/observability/agent-trace';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildAgentCallTree } from '@/lib/engine/observability/agent-trace';
import { createSpanScrollController } from '@/lib/client/trace-span-scroll';
import { resolveEventRenderCount, TRACE_EVENT_RENDER_BATCH } from '@/lib/client/trace-render-budget';

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
    return evaluate<T>(node.initializer!.getText(ast), { getAgentActiveDurationMs, ...scope });
}
function functionValue<T>(name: string, scope: Record<string, unknown>): T {
    const node = findNode(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    return evaluate<T>(node.getText(ast), { getAgentActiveDurationMs, ...scope });
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
        React, FilterPill: 'div', captureSpanContext: () => {}, tt: (key: string) => key,
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
    const matches = functionValue<any>('traceEventMatchesFilters', { eventKey: () => 'event', SLOW_MS: 60_000 });
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
    assert.equal(variable<number>('spanDurationMs', { event: { kind: 'task' },
        childNode: { stats: { activeDurationMs: 50_000, elapsedDurationMs: 3_650_000, durationMs: 3_650_000 } } }), 50_000);
    assert.equal(regular, 250);
});

function eventDetailMarkup(status: string, output: string, exitCode?: number, reason?: string, kind: 'tool' | 'skill' = 'tool') {
    const SpanErrorBlock = functionValue<React.ComponentType>('SpanErrorBlock', {
        React, useState: React.useState, useLocale: () => ({ locale: 'zh' }),
        copyText: async () => {},
    });
    const EventDetailPanel = functionValue<React.ComponentType<Record<string, unknown>>>('EventDetailPanel', {
        React, useLocale: () => ({ locale: 'zh' }), TraceCtx: React.createContext({}),
        isErrorToolStatus: functionValue('isErrorToolStatus', {}),
        KIND_META: { tool: { label: 'TOOL' }, skill: { label: 'SKILL' } }, formatClockMs: () => null,
        firstMeaningfulLine: (value: string) => value, formatDuration: () => '',
        KindBadge: () => null, CopyableId: () => null, RasReliabilityDetails: () => null,
        eventDetailIdentifier: (event: any) => event.toolCallId ? { label: 'Tool Call ID', value: event.toolCallId } : null,
        getAgentNodeDisplayLabel: () => 'Default', SpanErrorBlock,
        CompactSection: ({ label, raw }: { label: string; raw: string }) => React.createElement('section', { 'data-section': label }, raw),
        EmptyDetail: () => null,
    });
    return renderToStaticMarkup(React.createElement(EventDetailPanel, {
        event: { kind, name: kind === 'skill' ? 'docx' : 'execute_shell_command', toolStatus: status,
            toolExitCode: exitCode, toolError: reason, output, args: { command: 'node doc.js' } },
        node: { agentName: 'Default', children: [] }, interactions: [],
    }));
}

test('failed tool details retain a separate Output section and explain the exit code', () => {
    const html = eventDetailMarkup('error', 'partial file content\nError: Cannot find module docx', 1, 'tool exited with code 1');
    assert.match(html, /退出码[\s\S]*1/);
    assert.match(html, /data-section="Output"/);
    assert.match(html, /partial file content/);
    assert.doesNotMatch(html, /toolStatus:/);
});

test('successful tool output containing error words does not render a failure block', () => {
    const html = eventDetailMarkup('success', 'Skill instructions: how to handle Error messages');
    assert.match(html, /data-section="Output"/);
    assert.doesNotMatch(html, /执行失败/);
});

test('successful Skill instructions remain in Output without a failure block', () => {
    const html = eventDetailMarkup('success', '# DOCX creation\nReport missing dependencies as errors.', undefined, undefined, 'skill');
    assert.match(html, /data-section="Output"/);
    assert.match(html, /DOCX creation/);
    assert.doesNotMatch(html, /执行失败/);
});

test('legacy failed tool output remains inspectable without structured error metadata', () => {
    const html = eventDetailMarkup('error', 'legacy error and partial result');
    assert.match(html, /执行失败/);
    assert.match(html, /data-section="Output"/);
    assert.match(html, /legacy error and partial result/);
});

test('cancelled and denied tool calls are not shown as successful', () => {
    assert.match(eventDetailMarkup('cancelled', 'partial result'), /执行已中断/);
    assert.match(eventDetailMarkup('interrupted', 'partial result'), /执行已中断/);
    assert.match(eventDetailMarkup('denied', 'Permission denied'), /调用被拒绝/);
});

test('opening the current Trace from a nested Agent resets to the root and still delegates standalone navigation', () => {
    const opened: string[] = [];
    let selected = 'a:worker', tab = 'timeline';
    let expanded = new Set(['worker']);
    const defaults = new Set(['root']);
    const navigate = variable<(id: string) => void>('navigateToAgentTrace', {
        useCallback: (callback: unknown) => callback,
        rootSessionId: 'parent-task', tree: { id: 'virtual' }, nodeMap: new Map([
            ['root', { id: 'root', sessionId: 'parent-task' }], ['child', { id: 'child', sessionId: 'child-task' }],
        ]), defaultExpandedKeys: defaults,
        setSelectedKey: (key: string) => { selected = key; },
        setExpandedKeys: (keys: Set<string>) => { expanded = keys; },
        setActiveDetailTab: (value: string) => { tab = value; },
        agentKey: (id: string) => `a:${id}`,
        onSubagentNavigate: (id: string) => { opened.push(id); },
    });
    navigate('parent-task');
    assert.equal(selected, 'a:root');
    assert.equal(tab, 'overview');
    assert.equal(expanded, defaults);
    assert.deepEqual(opened, ['parent-task']);
    navigate('child-task');
    assert.deepEqual(opened, ['parent-task', 'child-task']);
});

test('Jiuwen child Trace links use shared standalone navigation for both children', () => {
    const opened: string[] = [];
    const navigate = variable<(id: string) => void>('navigateToAgentTrace', {
        useCallback: (callback: unknown) => callback,
        rootSessionId: 'parent-task', tree: { id: 'root' },
        nodeMap: new Map(['child-1', 'child-2'].map(id => [id, { id, sessionId: id, agentName: 'worker' }])),
        defaultExpandedKeys: new Set(), setSelectedKey: () => {}, setExpandedKeys: () => {}, setActiveDetailTab: () => {},
        agentKey: (id: string) => `a:${id}`, onSubagentNavigate: (id: string) => { opened.push(id); },
    });
    navigate('child-1');
    navigate('child-2');
    assert.deepEqual(opened, ['child-1', 'child-2']);
});

test('nested Workflow containers survive Tool filtering when their linked Agent contains a matching tool', () => {
    const matches = functionValue<(event: any, index: number, owner: string, nodes: Map<string, any>, filters: any) => boolean>('traceEventMatchesFilters', { eventKey: (owner: string, index: number) => `${owner}:${index}`, SLOW_MS: 60_000 });
    const build = functionValue<any>('buildAgentEventTree', {});
    const contains = functionValue<any>('agentEventTreeMatches', { buildAgentEventTree: build });
    const child = { id: 'child', events: [{ kind: 'tool', name: 'lookup', startedAt: 1, completedAt: 2 }], children: [] };
    const nodes = new Map([['child', child]]);
    const entry = { event: { kind: 'chain' }, eventIndex: 0, children: [{ event: { kind: 'task', treeHidden: true, spawnedChildId: 'child' }, eventIndex: 1, children: [] }] };
    const predicate = (event: any, index: number, owner: string) => matches(event, index, owner, nodes, { treeKindFilter: ['tool'], minDurationMs: 0, minTokenK: 0, ctxSlowOnly: false, searchQuery: '', matchedKeys: new Set() });
    assert.equal(contains(entry, 'root', nodes, predicate), true);
    child.events = [];
    assert.equal(contains(entry, 'root', nodes, predicate), false);
});

test('searching only a linked Agent name retains its Workflow ancestor without bypassing Tool filters', () => {
    const key = (id: string) => `a:${id}`;
    const matchAgent = functionValue<any>('traceAgentMatchesFilters', { agentKey: key, aggregateSubtreeStats: (n: any) => n.stats, SLOW_MS: 60_000 });
    const contains = functionValue<any>('agentEventTreeMatches', { buildAgentEventTree: functionValue<any>('buildAgentEventTree', {}) });
    const agent = { id: 'child', events: [], children: [], stats: { totalTokens: 2000, durationMs: 3000 } };
    const nodes = new Map([['child', agent]]);
    const entry = { event: { kind: 'chain' }, eventIndex: 0, children: [{ event: { kind: 'task', spawnedChildId: 'child' }, eventIndex: 1, children: [] }] };
    const filters = { treeKindFilter: [], minDurationMs: 0, minTokenK: 0, ctxSlowOnly: false, searchQuery: 'child name', matchedKeys: new Set(['a:child']) };
    assert.equal(contains(entry, 'root', nodes, () => false, (node: any) => matchAgent(node, filters)), true);
    assert.equal(contains(entry, 'root', nodes, () => false, (node: any) => matchAgent(node, { ...filters, treeKindFilter: ['tool'] })), false);
});

const displayEvents = (events: any[]) => functionValue<any>('buildAgentEventTree', {})(events);
const responseCall = (id: string, name = 'read') => ({ id, function: { name, arguments: '{}' }, state: 'success' });
function messageEvents(proof: 'parts' | 'content_blocks' | 'none' = 'parts') {
    const calls = [responseCall('read-call'), responseCall('bash-call', 'bash')];
    const interaction = {
        role: 'assistant', content: 'Inspect the files', tool_calls: calls, usage: { input: 5, output: 2, total: 7 },
        ...(proof === 'parts' ? { parts: calls.map(call => ({ type: 'tool', callID: call.id, tool: call.function.name })) } : {}),
        ...(proof === 'content_blocks' ? { content_blocks: calls.map(call => ({ type: 'tool_use', id: call.id, name: call.function.name, input: {} })) } : {}),
    };
    return buildAgentCallTree([interaction])!.events;
}

test('ordinary OpenCode tools nest under their own model response without changing events, counters or selection indexes', () => {
    const events = messageEvents();
    const before = structuredClone(events);
    const entries = displayEvents(events);
    assert.deepEqual(entries.map((entry: any) => entry.event.kind), ['llm']);
    assert.deepEqual(entries[0].children.map((entry: any) => entry.event.name), ['read', 'bash']);
    assert.deepEqual(entries[0].children.map((entry: any) => entry.eventIndex), [1, 2]);
    assert.equal(entries[0].event, events[0]);
    assert.equal(entries[0].children[0].event, events[1]);
    assert.deepEqual(events, before);
});

test('Claude response tool_use blocks prove the same model-tool relationship', () => {
    const entries = displayEvents(messageEvents('content_blocks'));
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].children.map((entry: any) => entry.event.toolCallId), ['read-call', 'bash-call']);
});

test('tools grouped by an adapter without original response evidence remain at their current level', () => {
    const events = messageEvents('none');
    assert.deepEqual(displayEvents(events).map((entry: any) => entry.eventIndex), [0, 1, 2]);
});

test('Skill, TASK and child Agent anchors keep their original positions beside newly nested ordinary tools', () => {
    const calls = [responseCall('read-call'), responseCall('skill-call', 'skill'), {
        ...responseCall('task-call', 'task'), function: { name: 'task', arguments: JSON.stringify({ subagent_type: 'worker', subagent_session_id: 'child-session' }) },
    }];
    const tree = buildAgentCallTree([
        { role: 'assistant', content: '', tool_calls: calls, parts: calls.map(call => ({ type: 'tool', callID: call.id, tool: call.function.name })), usage: { total: 7 } },
        { role: 'subagent', agent: 'worker', subagent_session_id: 'child-session', content: 'done', usage: { total: 3 } },
    ])!;
    const before = structuredClone(tree);
    const entries = displayEvents(tree.events);
    assert.deepEqual(entries.map((entry: any) => entry.event.kind), ['llm', 'skill', 'task']);
    assert.deepEqual(entries[0].children.map((entry: any) => entry.event.kind), ['tool']);
    assert.equal(entries[2].event.spawnedChildId, tree.children[0].id);
    assert.equal(entries[2].eventIndex, 3);
    assert.equal(tree.stats.totalTokens, 7);
    assert.equal(tree.stats.llmCalls, 1);
    assert.equal(tree.stats.toolCalls, 1);
    assert.equal(tree.stats.skillCalls, 1);
    assert.equal(tree.stats.taskCalls, 1);
    assert.deepEqual(tree, before);
});

test('independent OTLP tools use an exact parent span in the same trace even when they arrive before the model event', () => {
    const events = [
        { kind: 'tool', name: 'read', toolCallId: 'call', interactionIndex: 0, interaction: { traceId: 'trace', spanId: 'tool', parentSpanId: 'model' } },
        { kind: 'llm', interactionIndex: 1, interaction: { traceId: 'trace', spanId: 'model' } },
    ];
    const entries = displayEvents(events);
    assert.deepEqual(entries.map((entry: any) => entry.eventIndex), [1]);
    assert.equal(entries[0].children[0].eventIndex, 0);
    events[0].interaction.traceId = 'another-trace';
    assert.equal(displayEvents(events).length, 2);
});

test('tool call IDs from projected model outputs can link independent failed or running tools without touching status or timing', () => {
    const events = [
        { kind: 'llm', sourceSpanId: 'model', interactionIndex: 0, interaction: { tool_calls: [responseCall('call')] } },
        { kind: 'tool', name: 'read', toolCallId: 'call', toolStatus: 'error', startedAt: 20, completedAt: 30, interactionIndex: 1, interaction: {} },
        { kind: 'tool', name: 'unrelated', toolCallId: 'unknown', toolStatus: 'running', interactionIndex: 2, interaction: {} },
    ];
    const before = structuredClone(events);
    const entries = displayEvents(events);
    assert.deepEqual(entries.map((entry: any) => entry.eventIndex), [0, 2]);
    assert.equal(entries[0].children[0].event.toolStatus, 'error');
    assert.deepEqual(events, before);
});

test('ambiguous call IDs, tool-name conflicts and conflicting parent evidence do not create a guessed LLM parent', () => {
    const model = (spanId: string) => ({ kind: 'llm', sourceSpanId: spanId, interactionIndex: spanId === 'a' ? 0 : 1, interaction: { tool_calls: [responseCall('reused')] } });
    const tool = { kind: 'tool', name: 'read', toolCallId: 'reused', interactionIndex: 2, interaction: {} };
    assert.equal(displayEvents([model('a'), model('b'), tool]).length, 3);
    assert.equal(displayEvents([model('a'), { ...tool, name: 'write' }]).length, 2);
    const events = [model('a'), { ...model('b'), interaction: {} }, { ...tool, parentSourceSpanId: 'b' }];
    const entries = displayEvents(events);
    assert.equal(entries.find((entry: any) => entry.event.sourceSpanId === 'b').children[0].event, events[2]);
    assert.equal(entries.find((entry: any) => entry.event.sourceSpanId === 'a').children.length, 0);
});

test('a native message resolves a reused call ID locally while unrelated traces remain isolated', () => {
    const events = [...messageEvents(), ...messageEvents()];
    events.slice(3).forEach(event => { event.interactionIndex += 1; });
    const entries = displayEvents(events);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((entry: any) => entry.children.map((child: any) => child.eventIndex)), [[1, 2], [4, 5]]);
});

test('an absent or synthetic model response never becomes a new tool parent', () => {
    const events = messageEvents();
    assert.equal(displayEvents(events.slice(1)).length, 2);
    events[0].interaction.trace_synthetic = true;
    assert.equal(displayEvents(events).length, 3);
});

test('display-only linking cannot introduce a cycle into an existing span hierarchy', () => {
    const events = [
        { kind: 'tool', name: 'read', sourceSpanId: 'tool', toolCallId: 'call', interactionIndex: 0, interaction: {} },
        { kind: 'llm', sourceSpanId: 'model', parentSourceSpanId: 'tool', interactionIndex: 1, interaction: { tool_calls: [responseCall('call')] } },
    ];
    const entries = displayEvents(events);
    assert.equal(entries[0].event, events[0]);
    assert.equal(entries[0].children[0].event, events[1]);
});

test('Tool filtering and tool-name search retain the new model ancestor without changing the selected tool key', () => {
    const entries = displayEvents(messageEvents());
    const matches = functionValue<any>('traceEventMatchesFilters', { eventKey: (owner: string, index: number) => `${owner}:${index}`, SLOW_MS: 60_000 });
    const contains = functionValue<any>('agentEventTreeMatches', { buildAgentEventTree: functionValue<any>('buildAgentEventTree', {}) });
    const filters = { treeKindFilter: ['tool'], minDurationMs: 0, minTokenK: 0, ctxSlowOnly: false, searchQuery: 'read', matchedKeys: new Set(['root:1']) };
    assert.equal(contains(entries[0], 'root', new Map(), (event: any, index: number, owner: string) => matches(event, index, owner, new Map(), filters)), true);
    assert.equal(entries[0].children[0].eventIndex, 1);
});

test('a tool that already anchors a child Agent is not moved below an LLM', () => {
    const events = messageEvents();
    events[1].spawnedChildId = 'worker';
    const entries = displayEvents(events);
    assert.deepEqual(entries.map((entry: any) => entry.eventIndex), [0, 1]);
    assert.deepEqual(entries[0].children.map((entry: any) => entry.eventIndex), [2]);
    assert.equal(entries[1].event.spawnedChildId, 'worker');
});

test('duplicate parent spans and missing tool IDs stay flat instead of relying on time order', () => {
    const interaction = { traceId: 't', spanId: 'same' };
    const tool = { kind: 'tool', name: 'read', startedAt: 2, interactionIndex: 2, interaction: { traceId: 't', parentSpanId: 'same' } };
    assert.equal(displayEvents([
        { kind: 'llm', startedAt: 1, interactionIndex: 0, interaction },
        { kind: 'llm', startedAt: 1, interactionIndex: 1, interaction: { ...interaction } },
        tool,
    ]).length, 3);
    const events = messageEvents();
    events[1].toolCallId = undefined;
    assert.deepEqual(displayEvents(events).map((entry: any) => entry.eventIndex), [0, 1]);
});

test('the new nesting is expanded by default and collapse/expand still covers the parent model', () => {
    const tree = buildAgentCallTree([{ role: 'assistant', content: '', tool_calls: [responseCall('read-call')], parts: [{ type: 'tool', callID: 'read-call', tool: 'read' }] }])!;
    const defaults = functionValue<any>('buildDefaultExpandedKeys', {
        getAgentEventTree: functionValue<any>('getAgentEventTree', {
            eventTreeCache: new WeakMap(), buildAgentEventTree: functionValue<any>('buildAgentEventTree', {}),
        }),
        agentKey: (id: string) => `a:${id}`, eventKey: (id: string, index: number) => `e:${id}:${index}`,
    })(tree);
    assert.ok(defaults.has(`a:${tree.id}`));
    assert.ok(defaults.has(`e:${tree.id}:0`));
});

test('an exact raw parent does not override a conflicting tool name in the model response', () => {
    const events = [
        { kind: 'llm', sourceSpanId: 'model', interactionIndex: 0, interaction: { traceId: 't', spanId: 'model', tool_calls: [responseCall('call', 'write')] } },
        { kind: 'tool', name: 'read', toolCallId: 'call', interactionIndex: 1, interaction: { traceId: 't', spanId: 'tool', parentSpanId: 'model' } },
    ];
    assert.deepEqual(displayEvents(events).map((entry: any) => entry.eventIndex), [0, 1]);
});

test('an assistant-like tool wrapper is not accepted as a new model parent for another tool span', () => {
    const events = buildAgentCallTree([
        { role: 'assistant', content: '', traceId: 't', spanId: 'wrapper', tool_calls: [responseCall('outer', 'delegate')] },
        { role: 'assistant', content: '', traceId: 't', spanId: 'child', parentSpanId: 'wrapper', tool_calls: [responseCall('inner')] },
    ] as any)!.events;
    assert.deepEqual(displayEvents(events).map((entry: any) => entry.eventIndex), [0, 1, 2, 3]);
});

test('LLM details identify the original Span ID rather than a tool call, including qualified Dify display IDs', () => {
    const identifier = functionValue<any>('eventDetailIdentifier', {});
    assert.deepEqual(identifier({ kind: 'llm', sourceSpanId: 'trace:model', sourceTraceId: 'trace', toolCallId: 'legacy-wrong-label' }), { label: 'Span ID', value: 'model' });
    assert.deepEqual(identifier({ kind: 'llm', interaction: { spanId: 'native-model' } }), { label: 'Span ID', value: 'native-model' });
    assert.equal(identifier({ kind: 'llm', toolCallId: 'not-model-evidence' }), null);
    assert.deepEqual(identifier({ kind: 'tool', toolCallId: 'call-1', sourceSpanId: 'tool-span' }), { label: 'Tool Call ID', value: 'call-1' });
    assert.deepEqual(identifier({ kind: 'tool', sourceSpanId: 'tool-span' }), { label: 'Span ID', value: 'tool-span' });
    assert.deepEqual(identifier({ kind: 'chain', sourceSpanId: 'workflow-span', toolCallId: 'legacy' }), { label: 'Span ID', value: 'workflow-span' });
});


test('recursive Agent and TASK duration filters use active time while preserving legacy fallback', () => {
    type NodeFixture = { id: string; stats: { durationMs: number; activeDurationMs?: number; totalTokens: number } };
    type FilterFixture = { treeKindFilter: string[]; minDurationMs: number; minTokenK: number;
        ctxSlowOnly: boolean; searchQuery: string; matchedKeys: Set<string> };
    const matchAgent = functionValue<(node: NodeFixture, filters: FilterFixture) => boolean>('traceAgentMatchesFilters', {
        agentKey: (id: string) => `a:${id}`, aggregateSubtreeStats: (n: NodeFixture) => n.stats, SLOW_MS: 60_000,
    });
    const matchEvent = functionValue<(event: { kind: string; spawnedChildId: string }, index: number,
        owner: string, nodes: ReadonlyMap<string, NodeFixture>, filters: FilterFixture) => boolean>(
        'traceEventMatchesFilters', { eventKey: () => 'task:0', SLOW_MS: 60_000 });
    const child = { id: 'child', stats: { durationMs: 3_650_000, activeDurationMs: 50_000, totalTokens: 0 } };
    const nodes = new Map([['child', child]]);
    const event = { kind: 'task', spawnedChildId: 'child' };
    for (const ctxSlowOnly of [false, true]) {
        const filters = { treeKindFilter: [], minDurationMs: ctxSlowOnly ? 0 : 60_000,
            minTokenK: 0, ctxSlowOnly, searchQuery: 'child', matchedKeys: new Set(['a:child', 'task:0']) };
        assert.equal(matchAgent(child, filters), false, 'user idle must not make an Agent match a slow filter');
        assert.equal(matchEvent(event, 0, 'root', nodes, filters), false, 'TASK uses its child active time');
        child.stats.activeDurationMs = 60_001;
        assert.equal(matchAgent(child, filters), true);
        assert.equal(matchEvent(event, 0, 'root', nodes, filters), true);
        child.stats.activeDurationMs = 50_000;
    }
    const legacy = { ...child, stats: { durationMs: 61_000, totalTokens: 0 } };
    const filters = { treeKindFilter: [], minDurationMs: 60_000, minTokenK: 0,
        ctxSlowOnly: true, searchQuery: 'child', matchedKeys: new Set(['a:child', 'task:0']) };
    assert.equal(matchAgent(legacy, filters), true);
    assert.equal(matchEvent(event, 0, 'root', new Map([['child', legacy]]), filters), true);
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


test('empty Span type selection preserves the initial render budget', () => {
    const indexes = Array.from({ length: 500 }, (_, index) => index);
    const count = (treeKindFilter: string[]) => resolveEventRenderCount(indexes, TRACE_EVENT_RENDER_BATCH, {
        revealAll: variable<boolean>('filtersActive', {
            treeKindFilter, minDurationMs: 0, minTokenK: 0, ctxSlowOnly: false, searchQuery: '',
        }),
    });
    assert.equal(count([]), TRACE_EVENT_RENDER_BATCH);
    assert.equal(count(['llm']), 500);
    assert.equal(count(['user', 'llm']), 500);
});


test('following latest reveals budgeted Span rows and keeps them after pausing', () => {
    let spanTailTrace: string | null = null;
    const spanTraceKey = 'trace-one';
    const revealSpanRows = variable<() => void>('revealSpanRows', {
        useCallback: (callback: unknown) => callback,
        spanTraceKey, setSpanTailTrace: (key: string) => { spanTailTrace = key; },
    });
    const count = (key: string, total: number) => variable<number>('renderedEventCount', {
        resolveEventRenderCount, eventRootIndexes: Array.from({ length: total }, (_, index) => index),
        eventRenderLimit: TRACE_EVENT_RENDER_BATCH, filtersActive: false, selectedEventIndex: null,
        ctx: { revealAllSpans: variable<boolean>('revealAllSpans', { spanTraceKey: key, spanTailTrace }) },
    });
    const viewport = { scrollTop: 0, scrollHeight: count(spanTraceKey, 500) * 34, clientHeight: 400 };
    const scroll = createSpanScrollController(() => viewport);
    const viewportSource = fs.readFileSync(new URL('../src/components/observe/TraceSpanViewport.tsx', import.meta.url), 'utf8');
    const viewportAst = ts.createSourceFile('TraceSpanViewport.tsx', viewportSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let followingEffect: ts.ArrowFunction | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.expression.getText(viewportAst) === 'useLayoutEffect'
            && node.arguments[0]?.getText(viewportAst).includes('onFollowingLatest')) {
            followingEffect = node.arguments[0] as ts.ArrowFunction;
        }
        ts.forEachChild(node, visit);
    };
    visit(viewportAst);
    assert.ok(followingEffect, 'following state must notify the parent render budget');
    const notify = () => evaluate<() => void>(followingEffect!.getText(viewportAst), {
        following: scroll.getSnapshot().following, onFollowingLatest: revealSpanRows,
    })();
    scroll.subscribe(notify);
    const keys = (total: number) => Array.from({ length: total }, (_, index) => `span-${index}`);
    scroll.resetView(keys(500));
    assert.equal(count(spanTraceKey, 500), TRACE_EVENT_RENDER_BATCH);
    scroll.jumpToBottom();
    assert.equal(count(spanTraceKey, 500), 500);
    viewport.scrollHeight = count(spanTraceKey, 500) * 34;
    scroll.refresh(keys(500));
    assert.equal(viewport.scrollTop, viewport.scrollHeight - viewport.clientHeight);
    scroll.pauseFollowing();
    assert.equal(count(spanTraceKey, 500), 500);
    scroll.refresh(keys(501));
    assert.equal(scroll.getSnapshot().hasNewContent, true);
    scroll.jumpToBottom();
    viewport.scrollHeight = count(spanTraceKey, 501) * 34;
    scroll.refresh(keys(501));
    assert.equal(viewport.scrollTop, viewport.scrollHeight - viewport.clientHeight);
    assert.equal(count('trace-two', 501), TRACE_EVENT_RENDER_BATCH);
});

test('clearing a deep search keeps its reading anchor beyond the initial batch', () => {
    let spanTailTrace: string | null = null;
    const spanTraceKey = 'deep-search';
    const revealSpanRows = variable<() => void>('revealSpanRows', {
        useCallback: (callback: unknown) => callback, spanTraceKey,
        setSpanTailTrace: (key: string) => { spanTailTrace = key; },
    });
    let captured: string | null = null;
    const capture = variable<() => void>('captureSpanContext', {
        useCallback: (callback: unknown) => callback, cancelPendingSpanJump: () => {}, revealSpanRows,
        spanFocusKeyRef: { current: 'e:root:150' },
        spanViewportRef: { current: { captureAnchor: (key: string) => { captured = key; } } },
    });
    capture();
    const count = variable<number>('renderedEventCount', {
        resolveEventRenderCount, eventRootIndexes: Array.from({ length: 300 }, (_, index) => index),
        eventRenderLimit: TRACE_EVENT_RENDER_BATCH, filtersActive: false, selectedEventIndex: null,
        ctx: { revealAllSpans: variable<boolean>('revealAllSpans', { spanTraceKey, spanTailTrace }) },
    });
    assert.equal(captured, 'e:root:150');
    assert.equal(count, 300);
});

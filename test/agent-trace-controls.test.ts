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
import { buildAgentCallTree } from '@/lib/engine/observability/agent-trace';

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
        treeKindFilter: 'all', minDurationMs, minTokenK: 0, ctxSlowOnly: slowOnly, searchQuery: '', matchedKeys: new Set(),
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
        rootSessionId: 'parent-task', tree: { id: 'virtual' }, nodeMap: new Map([['root', { id: 'root', sessionId: 'parent-task' }]]), defaultExpandedKeys: defaults,
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

test('nested Workflow containers survive Tool filtering when their linked Agent contains a matching tool', () => {
    const matches = functionValue<(event: any, index: number, owner: string, nodes: Map<string, any>, filters: any) => boolean>('traceEventMatchesFilters', { eventKey: (owner: string, index: number) => `${owner}:${index}`, SLOW_MS: 60_000 });
    const build = functionValue<any>('buildAgentEventTree', {});
    const contains = functionValue<any>('agentEventTreeMatches', { buildAgentEventTree: build });
    const child = { id: 'child', events: [{ kind: 'tool', name: 'lookup', startedAt: 1, completedAt: 2 }], children: [] };
    const nodes = new Map([['child', child]]);
    const entry = { event: { kind: 'chain' }, eventIndex: 0, children: [{ event: { kind: 'task', treeHidden: true, spawnedChildId: 'child' }, eventIndex: 1, children: [] }] };
    const predicate = (event: any, index: number, owner: string) => matches(event, index, owner, nodes, { treeKindFilter: 'tool', minDurationMs: 0, minTokenK: 0, ctxSlowOnly: false, searchQuery: '', matchedKeys: new Set() });
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
    const filters = { treeKindFilter: 'all', minDurationMs: 0, minTokenK: 0, ctxSlowOnly: false, searchQuery: 'child name', matchedKeys: new Set(['a:child']) };
    assert.equal(contains(entry, 'root', nodes, () => false, (node: any) => matchAgent(node, filters)), true);
    assert.equal(contains(entry, 'root', nodes, () => false, (node: any) => matchAgent(node, { ...filters, treeKindFilter: 'tool' })), false);
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
    const filters = { treeKindFilter: 'tool', minDurationMs: 0, minTokenK: 0, ctxSlowOnly: false, searchQuery: 'read', matchedKeys: new Set(['root:1']) };
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
        buildAgentEventTree: functionValue<any>('buildAgentEventTree', {}),
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

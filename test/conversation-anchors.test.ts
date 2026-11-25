/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgentCallTree } from '@/lib/engine/observability/agent-trace';
import { buildFaultPathSteps } from '@/lib/engine/observability/fault-path';
import { buildCollaborationTraceTree } from '@/lib/collaboration/display-tree';
import { attachConversationAnchors, conversationTraceHref, resolveTraceStepSelection } from '@/lib/engine/experiment/conversation-anchors';

const messages = [
  { role: 'user', content: 'question' },
  { role: 'assistant', content: 'checking', tool_calls: [{ id: 'lookup-one', function: { name: 'lookup', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'lookup-one', content: 'lookup-result' },
  { role: 'assistant', content: 'final answer' },
];
test('逐轮锚点来自真实Trace步骤，工具调用前后消息序号不冒充step编号', () => {
  const evidence = [{ input: 'question', output: 'final answer', messageIndex: 0, assistantMessageIndex: 3 }];
  const result = attachConversationAnchors(messages, evidence);
  const actual = buildFaultPathSteps(messages).find(step => step.kind === 'llm' && step.interactionIndex === 3)!;
  assert.deepEqual(result[0].traceAnchors, [`step-${actual.stepIndex}`]);
  assert.notEqual(result[0].traceAnchors[0], 'step-4');
  assert.equal(Object.hasOwn(evidence[0], 'traceAnchors'), false);
});
test('不完整轮次回退用户输入步骤，未找到真实消息时不编造锚点', () => {
  const rows = attachConversationAnchors(messages, [{ messageIndex: 0 }, { messageIndex: 99 }]);
  const user = buildFaultPathSteps(messages).find(step => step.kind === 'user' && step.id.startsWith('event:'))!;
  assert.deepEqual(rows[0].traceAnchors, [`step-${user.stepIndex}`]);assert.deepEqual(rows[1].traceAnchors, []);
});
test('step深链接映射到原Trace显示树事件并展开父Agent，兼容带冒号的节点ID', () => {
  const tree = buildAgentCallTree(messages)!;
  tree.id = 'trace:root:n0';
  const step = buildFaultPathSteps(messages).find(item => item.kind === 'llm' && item.interactionIndex === 3)!;
  const selection = resolveTraceStepSelection(messages, `step-${step.stepIndex}`, tree)!;
  const eventIndex = tree.events.findIndex(event => event.kind === 'llm' && event.interactionIndex === 3);
  assert.equal(selection.selectedKey, `e:${tree.id}:${eventIndex}`);
  assert.ok(selection.expandedKeys.includes(`a:${tree.id}`));
  assert.equal(selection.interactionIndex, 3);
  assert.equal(resolveTraceStepSelection(messages, 'step-999', tree), null);
  assert.equal(resolveTraceStepSelection(messages, 'step--1', tree), null);
});
test('用户输入根步骤同样定位原树已有用户事件，链接编码taskId及部署前缀', () => {
  const tree = buildAgentCallTree(messages)!;
  const selection = resolveTraceStepSelection(messages, 'step-1', tree)!;
  const index = tree.events.findIndex(event => event.kind === 'user' && event.interactionIndex === 0);
  assert.equal(selection.selectedKey, `e:${tree.id}:${index}`);
  assert.equal(conversationTraceHref('task/one & two', 'step-6', '/insight'), '/insight/trace?taskId=task%2Fone+%26+two&step=step-6');
  assert.equal(conversationTraceHref(null, 'step-6'), undefined);
});
test('合并Trace按当前task原始编号定位，子会话插入不会改变锚点含义', () => {
  const root = messages.map((message, index) => ({ ...message, _collaboration: { taskId: 'root-task', index, version: 'fixture' } }));
  const child = [
    { role: 'user', content: 'child question' }, { role: 'assistant', content: 'child answer' },
  ].map((message, index) => ({ ...message, _collaboration: { taskId: 'child-task', index, parent: 'root-task', sequential: true, version: 'fixture' } }));
  const merged = [root[0], root[1], ...child, root[2], root[3]];
  const tree = buildCollaborationTraceTree(merged)!;
  const step = buildFaultPathSteps(messages).find(item => item.kind === 'llm' && item.interactionIndex === 3)!;
  const selection = resolveTraceStepSelection(merged, `step-${step.stepIndex}`, tree, 'root-task')!;
  assert.equal(selection.interactionIndex, 5);
  assert.ok(selection.selectedKey.includes('root-task:'));
  assert.ok(selection.expandedKeys.includes(`a:${tree.id}`));
});

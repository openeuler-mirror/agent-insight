/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { AgentNode } from '@/lib/engine/observability/agent-trace';
import { collaborationSource } from '@/lib/collaboration/display-tree';
import { buildFaultPathSteps } from '@/lib/engine/observability/fault-path';

export function attachConversationAnchors<T extends { messageIndex: number; assistantMessageIndex?: number }>(
  messages: unknown[], evidence: T[],
): Array<T & { traceAnchors: string[] }> {
  const steps = buildFaultPathSteps(messages);
  return evidence.map(turn => {
    const replies = typeof turn.assistantMessageIndex === 'number'
      ? steps.filter(step => step.kind === 'llm' && step.interactionIndex === turn.assistantMessageIndex) : [];
    const inputs = steps.filter(step => step.kind === 'user' && step.interactionIndex === turn.messageIndex);
    const input = inputs.find(step => step.id.startsWith('event:')) || inputs[0];
    return { ...turn, traceAnchors: (replies.length ? replies : input ? [input] : []).map(step => `step-${step.stepIndex}`) };
  });
}

export function conversationTraceHref(taskId: string | null, anchor: string, prefix = ''): string | undefined {
  if (!taskId) return undefined;
  const query = new URLSearchParams({ taskId });
  if (/^step-[1-9]\d*$/.test(anchor)) query.set('step', anchor);
  return `${prefix}/trace?${query}`;
}

export interface TraceStepSelection {
  selectedKey: string;
  expandedKeys: string[];
  interactionIndex: number | null;
}

export function resolveTraceStepSelection(messages: unknown[], anchor: string, tree: AgentNode, sourceTaskId?: string): TraceStepSelection | null {
  if (!/^step-[1-9]\d*$/.test(anchor)) return null;
  let entries = messages.map((message, index) => ({ message, index }));
  if (sourceTaskId && messages.some(collaborationSource)) {
    entries = entries.filter(entry => collaborationSource(entry.message)?.taskId === sourceTaskId)
      .sort((a, b) => collaborationSource(a.message)!.index - collaborationSource(b.message)!.index);
    if (!entries.length || entries.some((entry, index) => collaborationSource(entry.message)!.index !== index)) return null;
  }
  const step = buildFaultPathSteps(entries.map(entry => entry.message)).find(item => `step-${item.stepIndex}` === anchor);
  if (!step) return null;
  const targetIndex = step.interactionIndex == null ? null : entries[step.interactionIndex]?.index;
  const candidates: TraceStepSelection[] = [];
  const visit = (node: AgentNode, parentKeys: string[]) => {
    const ancestors = [...parentKeys, `a:${node.id}`];
    if (step.kind === 'agent' && step.id === `agent:${node.id}`) {
      candidates.push({ selectedKey: `a:${node.id}`, expandedKeys: ancestors, interactionIndex: null });
    }
    node.events.forEach((event, eventIndex) => {
      if (targetIndex == null || event.interactionIndex !== targetIndex || event.kind !== step.kind || event.treeHidden) return;
      if (step.toolCallId && (event as typeof event & { _toolCallId?: string })._toolCallId !== step.toolCallId) return;
      const parents: string[] = [];
      let span = event.parentSourceSpanId;
      const seen = new Set<string>();
      while (span && !seen.has(span)) {
        seen.add(span);
        const parentIndex = node.events.findIndex(candidate => candidate.sourceSpanId === span);
        if (parentIndex < 0) break;
        parents.push(`e:${node.id}:${parentIndex}`);
        span = node.events[parentIndex].parentSourceSpanId;
      }
      candidates.push({ selectedKey: `e:${node.id}:${eventIndex}`, expandedKeys: [...ancestors, ...parents], interactionIndex: event.interactionIndex });
    });
    for (const child of node.children) {
      const parentEvent = node.events.findIndex(event => event.spawnedChildId === child.id);
      visit(child, parentEvent < 0 ? ancestors : [...ancestors, `e:${node.id}:${parentEvent}`]);
    }
  };
  visit(tree, []);
  return candidates.length === 1 ? candidates[0] : null;
}

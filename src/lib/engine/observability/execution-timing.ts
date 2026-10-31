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

import type { RawInteraction } from './agent-trace';
type Interaction = {
    role?: string;
    trace_kind?: string;
    subagent_session_id?: string;
    trace_synthetic?: unknown;
    error?: unknown;
    content?: unknown;
    timestamp?: unknown;
    timeInfo?: { created?: unknown; completed?: unknown };
    parts?: unknown;
    tool_calls?: unknown;
};
type Interval = { start: number; end: number };

function timestamp(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const parsed = /^\d+$/.test(value.trim()) ? Number(value) : Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function userInput(item: Interaction): boolean {
    return item.role === 'user' || item.trace_kind === 'user' ||
        (item.role === 'opencode' && !!item.subagent_session_id && item.trace_kind !== 'llm');
}

export function deriveExecutionTiming(interactions: readonly Interaction[], sessionId?: string): {
    activeDurationMs?: number;
    elapsedDurationMs?: number;
    startedAt?: number;
    endedAt?: number;
} {
    const prompts: number[] = [];
    const work: Interval[] = [];
    const bounds: number[] = [];
    const addWork = (start: number | undefined, end: number | undefined) => {
        if (start === undefined || (end !== undefined && end < start)) return;
        work.push({ start, end: end ?? start });
        bounds.push(start, end ?? start);
    };
    for (const item of interactions) {
        if (!item || item.role === 'hook_context' || item.trace_synthetic) continue;
        const parts = Array.isArray(item.parts) ? item.parts as NonNullable<RawInteraction['parts']> : [];
        if (parts.some(part => part?.type === 'compaction') && !item.content) continue;
        const start = timestamp(item.timeInfo?.created) ?? timestamp(item.timestamp);
        const end = timestamp(item.timeInfo?.completed);
        if (item.role === 'system') {
            if (item.error && end !== undefined) addWork(start, end);
            continue;
        }
        if (userInput(item)) {
            if (start !== undefined) {
                bounds.push(start);
                if (!item.subagent_session_id || item.subagent_session_id === sessionId) prompts.push(start);
            }
            continue;
        }
        addWork(start, end);
        for (const call of Array.isArray(item.tool_calls) ? item.tool_calls as NonNullable<RawInteraction['tool_calls']> : []) {
            const toolStart = timestamp(call?.timing?.started_at) ?? start;
            addWork(toolStart, timestamp(call?.timing?.completed_at));
        }
        for (const part of parts) {
            if (part?.type !== 'tool') continue;
            const time = part.state?.time as { start?: unknown; end?: unknown } | undefined;
            addWork(timestamp(time?.start) ?? start, timestamp(time?.end));
        }
    }
    if (!bounds.length) return {};
    const orderedPrompts = [...new Set(prompts)].sort((a, b) => a - b);
    const rounds = new Map<number, Interval>();
    for (const interval of work) {
        let lo = 0, hi = orderedPrompts.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (orderedPrompts[mid] <= interval.start) lo = mid + 1;
            else hi = mid;
        }
        const round = lo - 1;
        const current = rounds.get(round);
        if (current) {
            current.start = Math.min(current.start, interval.start);
            current.end = Math.max(current.end, interval.end);
        } else {
            rounds.set(round, { start: round >= 0 ? orderedPrompts[round] : interval.start, end: interval.end });
        }
    }
    let activeDurationMs = 0;
    let merged: Interval | undefined;
    for (const interval of [...rounds.values()].sort((a, b) => a.start - b.start)) {
        if (!merged) merged = { ...interval };
        else if (interval.start <= merged.end) merged.end = Math.max(merged.end, interval.end);
        else { activeDurationMs += merged.end - merged.start; merged = { ...interval }; }
    }
    if (merged) activeDurationMs += merged.end - merged.start;
    const startedAt = bounds.reduce((min, value) => Math.min(min, value), Infinity);
    const endedAt = bounds.reduce((max, value) => Math.max(max, value), -Infinity);
    return { activeDurationMs, elapsedDurationMs: endedAt - startedAt, startedAt, endedAt };
}

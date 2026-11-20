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

// Core 分析快照的纯投影；不访问事务库或触发评测。

import type { FailureItem, SkillImprovementItem } from '@/lib/engine/evaluation/judge';
import type { TraceLite, TrajectoryLite } from './types';

export interface CollectResult {
    traces: TraceLite[];
    truncated: boolean;
}

export interface SelectedExecRow {
    id: string;
    taskId: string | null; query: string | null; timestamp: Date;
    agentName: string | null; framework: string | null; model: string | null;
    toolCallErrorCount: number | null; failures: string | null;
    toolCallCount: number | null; llmCallCount: number | null; skillTriggerRate: number | null; invokedSkills: string | null;
    tokens: number | null; cost: number | null; latency: number | null; skillIssues: string | null;
}

function safeParseArray<T>(json: string | null | undefined): T[] {
    if (!json) return [];
    try {
        const v = JSON.parse(json);
        return Array.isArray(v) ? (v as T[]) : [];
    } catch {
        return [];
    }
}

function parseInvokedSkills(json: string | null | undefined): { name: string; version: number | null }[] {
    const arr = safeParseArray<unknown>(json);
    return arr
        .map((s) => {
            if (typeof s === 'string') return { name: s, version: null };
            const o = (s ?? {}) as { name?: unknown; version?: unknown };
            return { name: String(o.name ?? ''), version: typeof o.version === 'number' ? o.version : null };
        })
        .filter((s) => s.name);
}

/** 解析 TrajectoryEvalResult.dimensionScoresJson → TrajectoryLite。 */
export function toTrajectoryLite(row: { trajectoryScore: number | null; dimensionScoresJson: string | null }): TrajectoryLite | null {
    if (row.trajectoryScore == null && !row.dimensionScoresJson) return null;
    let dims: TrajectoryLite['dims'] = { toolChoice: 0, redundancy: 0 };
    try {
        const d = row.dimensionScoresJson ? JSON.parse(row.dimensionScoresJson) : {};
        dims = {
            completeness: typeof d.completeness === 'number' ? d.completeness : null,
            toolChoice: typeof d.toolChoice === 'number' ? d.toolChoice : 0,
            redundancy: typeof d.redundancy === 'number' ? d.redundancy : 0,
            attribution: typeof d.attribution === 'number' ? d.attribution : null,
        };
    } catch { /* ignore，保留默认 */ }
    return { score: row.trajectoryScore ?? 0, dims };
}

export function projectQualityRows(sliced: SelectedExecRow[], trajByExec: Map<string, TrajectoryLite> = new Map()): TraceLite[] {
    return sliced.map((r) => {
        const toolCallCount = r.toolCallCount ?? undefined;
        const llmCallCount = r.llmCallCount ?? undefined;
        return {
            executionId: r.id,
            taskId: r.taskId ?? undefined,
            ts: r.timestamp,
            agentName: r.agentName ?? undefined,
            framework: r.framework ?? undefined,
            model: r.model ?? undefined,
            query: r.query ?? undefined,
            toolCallErrorCount: r.toolCallErrorCount ?? undefined,
            failures: safeParseArray<FailureItem>(r.failures),
            toolCallCount,
            llmCallCount,
            stepCount: (toolCallCount != null || llmCallCount != null)
                ? (toolCallCount ?? 0) + (llmCallCount ?? 0)
                : undefined,
            trajectory: trajByExec.get(r.id) ?? null,
            skillTriggerRate: r.skillTriggerRate,
            invokedSkills: parseInvokedSkills(r.invokedSkills),
            tokens: r.tokens ?? undefined,
            cost: r.cost ?? undefined,
            latency: r.latency ?? undefined,
            skillIssues: safeParseArray<SkillImprovementItem>(r.skillIssues),
        };
    });

}

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

export type TimestampCarrier = {
    role?: unknown;
    content?: unknown;
    timestamp?: unknown;
    createdAt?: unknown;
    completedAt?: unknown;
    completed_at?: unknown;
    timeInfo?: { created?: unknown; completed?: unknown };
    timing?: { started_at?: unknown; completed_at?: unknown };
};

export const QUIET_WINDOW_INFERRED_FRAMEWORKS = new Set([
    'claudecode', 'jiuwenswarm', 'opencode', 'hermes', 'openclaw', 'qwenpaw',
]);

export function hasAssistantOutput(interactions: TimestampCarrier[]): boolean {
    return interactions.some((interaction) => {
        const role = String(interaction?.role || '').toLowerCase();
        if (role !== 'assistant' && role !== 'subagent') return false;
        return Boolean(String(interaction?.content || '').trim());
    });
}

export function inferQuietWindowTraceCompletedAt(args: {
    framework?: unknown;
    explicitCompleted?: boolean;
    latestActivityMs?: number;
    quietLongEnough?: boolean;
}): string | null {
    const framework = String(args.framework ?? '').toLowerCase();
    if (!QUIET_WINDOW_INFERRED_FRAMEWORKS.has(framework)) return null;
    if (args.explicitCompleted) return null;
    const latestActivityMs = args.latestActivityMs || 0;
    if (!args.quietLongEnough || latestActivityMs <= 0) return null;
    return new Date(latestActivityMs).toISOString();
}

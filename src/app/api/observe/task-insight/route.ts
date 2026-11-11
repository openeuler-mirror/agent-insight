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

// Token 与任务分析：从 root trace 聚合 token/成本，按任务类型和长短时分类，并给出可延后长任务建议。
// 只统计 root trace（isSubagent=false），避免子 agent 行重复计数；分类与判定口径见
// src/lib/task-insight/ 与 design/observability/token-task-insight/。

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';
import { buildTaskInsight } from '@/lib/task-insight/aggregate';
import {
    DEFAULT_THRESHOLDS,
    type TaskInsightRange,
    type TaskInsightSourceRow,
    type TaskInsightThresholds,
} from '@/lib/task-insight/types';

export const dynamic = 'force-dynamic';

/** 单次分析上限：超出时只取最近 N 条 root trace，避免全历史大表把请求拖垮。 */
const MAX_ANALYZED_TRACES = 10_000;

const RANGES: TaskInsightRange[] = ['7', '30', '90', 'all'];

function normalizeRange(raw: string | null): TaskInsightRange {
    return RANGES.includes(raw as TaskInsightRange) ? raw as TaskInsightRange : '7';
}

function rangeStart(range: TaskInsightRange, now: Date): Date | null {
    if (range === 'all') return null;
    return new Date(now.getTime() - Number(range) * 24 * 60 * 60 * 1000);
}

function parseThreshold(raw: string | null, fallback: number, min: number, max: number): number {
    if (raw == null || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
}

function parseThresholds(url: URL): TaskInsightThresholds {
    return {
        longLatencyMs: parseThreshold(
            url.searchParams.get('longLatencyMs'),
            DEFAULT_THRESHOLDS.longLatencyMs,
            1_000,
            24 * 60 * 60 * 1000,
        ),
        longTokens: parseThreshold(
            url.searchParams.get('longTokens'),
            DEFAULT_THRESHOLDS.longTokens,
            1_000,
            100_000_000,
        ),
        longToolCalls: parseThreshold(
            url.searchParams.get('longToolCalls'),
            DEFAULT_THRESHOLDS.longToolCalls,
            1,
            100_000,
        ),
        longLlmCalls: parseThreshold(
            url.searchParams.get('longLlmCalls'),
            DEFAULT_THRESHOLDS.longLlmCalls,
            1,
            100_000,
        ),
    };
}

export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        // 作用域与大盘一致：按当前用户过滤（客户端可传 ?user=）；解析不出用户则回退全量。
        const { username } = await resolveUser(req, url.searchParams.get('user'));
        const userFilter = username ? { user: username } : {};

        const now = new Date();
        const range = normalizeRange(url.searchParams.get('range'));
        const from = rangeStart(range, now);

        const rows = await prisma.execution.findMany({
            where: {
                ...userFilter,
                isSubagent: false,
                ...(from ? { timestamp: { gte: from } } : {}),
            },
            orderBy: { timestamp: 'desc' },
            take: MAX_ANALYZED_TRACES + 1,
            select: {
                id: true,
                taskId: true,
                query: true,
                user: true,
                agentName: true,
                framework: true,
                model: true,
                timestamp: true,
                latency: true,
                tokens: true,
                inputTokens: true,
                outputTokens: true,
                cost: true,
                toolCallCount: true,
                llmCallCount: true,
                toolCallErrorCount: true,
            },
        }) as TaskInsightSourceRow[];

        const truncated = rows.length > MAX_ANALYZED_TRACES;
        const analyzed = truncated ? rows.slice(0, MAX_ANALYZED_TRACES) : rows;

        const summary = buildTaskInsight(analyzed, {
            range,
            from: from ? from.toISOString() : null,
            to: now.toISOString(),
            truncated,
            maxTraces: MAX_ANALYZED_TRACES,
            thresholds: parseThresholds(url),
        });

        return NextResponse.json(summary);
    } catch (error) {
        console.error('[Task Insight] Failed to aggregate task insight:', error);
        return NextResponse.json({ error: 'Failed to aggregate task insight' }, { status: 500 });
    }
}

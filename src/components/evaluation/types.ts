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

/**
 * 评估详情共享类型。来源于 GET /api/evaluation/[id]。
 * 同时被 /evaluation/[id] 详情页 与 /skill-eval?view=static 复用。
 */

export type Severity = 'high' | 'medium' | 'low';

export interface IssueRow {
    id: string;
    evaluationId?: string;
    source?: string;
    skillId?: string;
    version?: number;
    user?: string | null;
    dedupKey?: string;
    severity: Severity;
    summary: string;
    evidence?: string | null;
    reasoning?: string | null;
    suggestedFix?: string | null;
    ruleId?: string | null;
    dimension?: string | null;
    category?: string | null;
    createdAt?: string;
}

export interface EvaluationDetail {
    evaluation: {
        id: string;
        type: 'static' | 'dynamic' | string;
        skillId?: string;
        skillName?: string | null;
        version: number;
        user?: string | null;
        executionId?: string | null;
        contentHash?: string | null;
        ranAt: string;
        status: string;
        errorMessage?: string | null;
        durationMs?: number | null;
        generator?: string | null;
        l2Scores?: {
            scores?: Record<string, number>;
            // generator @0.2: { meta, robustness, security }
            // generator @0.1 旧数据: { meta, code }（仅向后兼容读取，不再产出）
            comments?: { meta?: string; robustness?: string; security?: string; code?: string };
        } | null;
    };
    execution?: {
        id: string;
        taskId: string | null;
        query: string | null;
        model: string | null;
        framework: string | null;
        timestamp: string;
    } | null;
    issues: IssueRow[];
    histogram: Record<Severity, number>;
}

export interface StaticStandard {
    key: string;
    title: string;
    desc: string;
    /** 兼容 L2 中文维度名、L1 英文枚举、历史遗留名 */
    dimensionAliases: string[];
}

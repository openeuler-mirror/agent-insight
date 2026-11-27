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

import {
    isAgentRuntimeId,
    type AgentRuntimeDescriptor,
    type AgentRuntimeDiagnostic,
    type AgentRuntimeId,
    type AgentRuntimePreference,
} from './types';

export interface AgentRuntimeSelectionValidation {
    ok: boolean;
    runtime: AgentRuntimeDescriptor | null;
    diagnostic: AgentRuntimeDiagnostic | null;
}

function unavailable(id: AgentRuntimeId, runtime: AgentRuntimeDescriptor | null): AgentRuntimeDiagnostic {
    return {
        code: 'RUNTIME_SELECTION_UNAVAILABLE',
        message: runtime
            ? (runtime.diagnostics[0]?.message
                ?? `${runtime.label} 当前不可用于平台任务。`)
            : `运行时 ${id} 不在当前部署环境的检测结果中。`,
    };
}

/** 校验用户是否可以把该运行时保存为个人默认值。 */
export function validateAgentRuntimeSelection(
    runtimeId: string,
    runtimes: AgentRuntimeDescriptor[],
): AgentRuntimeSelectionValidation {
    if (!isAgentRuntimeId(runtimeId)) {
        return {
            ok: false,
            runtime: null,
            diagnostic: { code: 'RUNTIME_SELECTION_INVALID', message: `未知的 Agent 运行时: ${runtimeId}` },
        };
    }
    const runtime = runtimes.find(item => item.id === runtimeId) ?? null;
    if (!runtime) {
        return { ok: false, runtime: null, diagnostic: unavailable(runtimeId, null) };
    }
    if (!runtime.selectable) {
        return { ok: false, runtime, diagnostic: unavailable(runtimeId, runtime) };
    }
    return { ok: true, runtime, diagnostic: null };
}

/**
 * 解析新任务使用的运行时。
 *
 * - 用户显式保存的运行时不可用时返回 `unavailable`，**不回退**到其他引擎；
 * - 未保存时按运行时目录顺序选择第一个可选（selectable）项（Pi 优先，其次 OpenCode）；
 * - 完全无可用运行时返回 `none`，由调用方给出明确诊断。
 */
export function resolveAgentRuntimePreference(
    selectedId: string | null | undefined,
    runtimes: AgentRuntimeDescriptor[],
): AgentRuntimePreference {
    const savedId = isAgentRuntimeId(selectedId) ? selectedId : null;

    if (selectedId && !savedId) {
        return {
            selectedId: null,
            effectiveId: null,
            source: 'user',
            status: 'unavailable',
            runtime: null,
            diagnostic: {
                code: 'RUNTIME_SELECTION_INVALID',
                message: `已保存的 Agent 运行时 ${String(selectedId)} 不再受支持，请重新选择。`,
            },
        };
    }

    if (savedId) {
        const runtime = runtimes.find(item => item.id === savedId) ?? null;
        if (runtime?.selectable) {
            return {
                selectedId: savedId,
                effectiveId: savedId,
                source: 'user',
                status: 'ready',
                runtime,
                diagnostic: null,
            };
        }
        return {
            selectedId: savedId,
            effectiveId: null,
            source: 'user',
            status: 'unavailable',
            runtime,
            diagnostic: unavailable(savedId, runtime),
        };
    }

    const fallback = runtimes.find(item => item.selectable) ?? null;
    if (!fallback) {
        return {
            selectedId: null,
            effectiveId: null,
            source: 'none',
            status: 'none',
            runtime: null,
            diagnostic: {
                code: 'RUNTIME_SELECTION_UNAVAILABLE',
                message: '当前部署环境中没有可用于平台任务的 Agent 运行时。',
            },
        };
    }

    return {
        selectedId: null,
        effectiveId: fallback.id,
        source: 'platform-default',
        status: 'ready',
        runtime: fallback,
        diagnostic: null,
    };
}

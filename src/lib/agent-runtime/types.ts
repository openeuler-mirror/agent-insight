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
 * 平台内置功能可选择的 Agent 运行时。
 *
 * 这里描述的是「平台服务自己发起执行时用哪个 Agent」——外部客户端上的被测
 * Agent、Benchmark 执行端另有自己的选择机制，不经过本模块。
 */

export type AgentRuntimeId = 'pi' | 'opencode';

export const AGENT_RUNTIME_CAPABILITIES = [
    /** 可下发工具禁用、只读、白名单等工具策略。 */
    'tool-policy',
    /** 可跨轮次续接原生会话。 */
    'session-resume',
    /** 支持服务端确认式取消。 */
    'cancel',
    /** 支持任务级超时与异常退出回收。 */
    'timeout',
    /** 可加载平台部署到工作目录的 Skill。 */
    'skill-loading',
    /** 可把执行事实（会话/事件/耗时）归入平台 Trace。 */
    'trace-attribution',
] as const;

export type AgentRuntimeCapability = (typeof AGENT_RUNTIME_CAPABILITIES)[number];

export type AgentRuntimeCapabilityMap = Record<AgentRuntimeCapability, boolean>;

export type AgentRuntimeStatus =
    /** 已适配、已安装且版本兼容，可被选择。 */
    | 'available'
    /** 部署环境中找不到可执行文件。 */
    | 'not-installed'
    /** 找到可执行文件，但平台还没有对应的执行适配器。 */
    | 'adapter-missing'
    /** 可执行文件存在，但版本探测失败或输出不可解析。 */
    | 'probe-failed'
    /** 版本低于平台适配要求。 */
    | 'incompatible-version';

export type AgentRuntimeExecutableSource = 'environment' | 'bundled' | 'path';

export type AgentRuntimeDiagnosticCode =
    | 'RUNTIME_READY'
    | 'RUNTIME_NOT_INSTALLED'
    | 'RUNTIME_ADAPTER_MISSING'
    | 'RUNTIME_PROBE_FAILED'
    | 'RUNTIME_VERSION_INCOMPATIBLE'
    | 'RUNTIME_SELECTION_INVALID'
    | 'RUNTIME_SELECTION_UNAVAILABLE';

export interface AgentRuntimeDiagnostic {
    code: AgentRuntimeDiagnosticCode;
    message: string;
}

export interface AgentRuntimeExecutable {
    path: string;
    source: AgentRuntimeExecutableSource;
}

export interface AgentRuntimeAdapter {
    id: string;
    label: string;
    capabilities: AgentRuntimeCapabilityMap;
}

export interface AgentRuntimeDescriptor {
    id: AgentRuntimeId;
    label: string;
    /** 平台执行适配器；为 null 表示只检测到安装，尚不能用于平台任务。 */
    adapter: AgentRuntimeAdapter | null;
    executable: AgentRuntimeExecutable | null;
    version: string | null;
    minimumVersion: string;
    status: AgentRuntimeStatus;
    selectable: boolean;
    capabilities: AgentRuntimeCapabilityMap;
    diagnostics: AgentRuntimeDiagnostic[];
    checkedAt: string;
}

export interface AgentRuntimeDetection {
    runtimes: AgentRuntimeDescriptor[];
    checkedAt: string;
}

export type AgentRuntimePreferenceSource = 'user' | 'platform-default' | 'none';

export interface AgentRuntimePreference {
    /** 用户显式保存的运行时；null 表示未保存。 */
    selectedId: AgentRuntimeId | null;
    /** 新任务实际使用的运行时；无可用运行时为 null。 */
    effectiveId: AgentRuntimeId | null;
    source: AgentRuntimePreferenceSource;
    status: 'ready' | 'unavailable' | 'none';
    runtime: AgentRuntimeDescriptor | null;
    diagnostic: AgentRuntimeDiagnostic | null;
}

export function emptyCapabilities(): AgentRuntimeCapabilityMap {
    return Object.fromEntries(AGENT_RUNTIME_CAPABILITIES.map(key => [key, false])) as AgentRuntimeCapabilityMap;
}

export function isAgentRuntimeId(value: unknown): value is AgentRuntimeId {
    return value === 'pi' || value === 'opencode';
}

/** 把 `v1.2.3` / `1.2.3-beta.1` 之类的输出解析为数字三元组；解析失败返回 null。 */
export function parseRuntimeVersion(output: string | null | undefined): string | null {
    const match = /\bv?(\d+)\.(\d+)\.(\d+)(?!\d)/.exec(String(output || ''));
    return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** 语义版本比较，忽略预发布标记。 */
export function compareRuntimeVersions(left: string, right: string): number {
    const parse = (value: string) => value.split('.').map(part => Number.parseInt(part, 10) || 0);
    const a = parse(left);
    const b = parse(right);
    for (let index = 0; index < 3; index += 1) {
        const diff = (a[index] ?? 0) - (b[index] ?? 0);
        if (diff !== 0) return diff > 0 ? 1 : -1;
    }
    return 0;
}

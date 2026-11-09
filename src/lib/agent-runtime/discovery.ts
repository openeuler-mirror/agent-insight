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

import { spawn } from 'child_process';

import {
    AGENT_RUNTIME_DEFINITIONS,
    detectRuntimeExecutable,
    type AgentRuntimeDefinition,
} from './catalog';
import {
    compareRuntimeVersions,
    emptyCapabilities,
    parseRuntimeVersion,
    type AgentRuntimeDescriptor,
    type AgentRuntimeDetection,
    type AgentRuntimeDiagnostic,
    type AgentRuntimeExecutable,
    type AgentRuntimeId,
} from './types';

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const DETECTION_TTL_MS = 30_000;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;

export type RuntimeVersionProbe = (executable: AgentRuntimeExecutable, timeoutMs: number) => Promise<string | null>;

export interface DetectAgentRuntimesOptions {
    env?: NodeJS.ProcessEnv;
    forceRefresh?: boolean;
    probeTimeoutMs?: number;
    resolveExecutable?: (id: AgentRuntimeId, env: NodeJS.ProcessEnv) => AgentRuntimeExecutable | null;
    probeVersion?: RuntimeVersionProbe;
    now?: () => number;
}

interface DetectionCacheEntry {
    at: number;
    detection: AgentRuntimeDetection;
}

let cache: DetectionCacheEntry | null = null;
let inFlight: Promise<AgentRuntimeDetection> | null = null;

/**
 * 运行 `--version` 探测版本。只用确定参数、不经过 shell、不触发模型调用；
 * 超时或进程异常都归为探测失败（返回 null），由调用方给出明确诊断。
 */
function probeVersionWithProcess(executable: AgentRuntimeExecutable, timeoutMs: number): Promise<string | null> {
    return new Promise(resolve => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        let child: ReturnType<typeof spawn> | null = null;

        const finish = (value: string | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };

        const timer = setTimeout(() => {
            try {
                child?.kill('SIGKILL');
            } catch {
                /* 进程可能已退出 */
            }
            finish(null);
        }, timeoutMs);

        try {
            child = spawn(executable.path, ['--version'], {
                shell: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch {
            finish(null);
            return;
        }

        child.stdout?.on('data', chunk => {
            if (stdout.length < MAX_PROBE_OUTPUT_BYTES) stdout += String(chunk);
        });
        child.stderr?.on('data', chunk => {
            if (stderr.length < MAX_PROBE_OUTPUT_BYTES) stderr += String(chunk);
        });
        child.once('error', () => finish(null));
        child.once('close', code => finish(code === 0 ? `${stdout}\n${stderr}` : null));
    });
}

function diagnostic(code: AgentRuntimeDiagnostic['code'], message: string): AgentRuntimeDiagnostic {
    return { code, message };
}

function describeRuntime(
    definition: AgentRuntimeDefinition,
    executable: AgentRuntimeExecutable | null,
    probedOutput: string | null,
    probeAttempted: boolean,
    checkedAt: string,
): AgentRuntimeDescriptor {
    const base = {
        id: definition.id,
        label: definition.label,
        adapter: definition.adapter,
        executable,
        minimumVersion: definition.minimumVersion,
        capabilities: definition.adapter?.capabilities ?? emptyCapabilities(),
        checkedAt,
    };

    if (!executable) {
        return {
            ...base,
            version: null,
            status: 'not-installed',
            selectable: false,
            diagnostics: [diagnostic(
                'RUNTIME_NOT_INSTALLED',
                `部署环境中未找到 ${definition.label} 可执行文件（查找 PATH 与已配置的环境变量）。`,
            )],
        };
    }

    if (probeAttempted && probedOutput === null) {
        return {
            ...base,
            version: null,
            status: 'probe-failed',
            selectable: false,
            diagnostics: [diagnostic(
                'RUNTIME_PROBE_FAILED',
                `已找到 ${definition.label}，但执行 --version 失败或超时，无法确认版本与可用性。`,
            )],
        };
    }

    const version = parseRuntimeVersion(probedOutput);
    if (!version) {
        return {
            ...base,
            version: null,
            status: 'probe-failed',
            selectable: false,
            diagnostics: [diagnostic(
                'RUNTIME_PROBE_FAILED',
                `已找到 ${definition.label}，但无法解析其版本输出，无法确认兼容性。`,
            )],
        };
    }

    if (compareRuntimeVersions(version, definition.minimumVersion) < 0) {
        return {
            ...base,
            version,
            status: 'incompatible-version',
            selectable: false,
            diagnostics: [diagnostic(
                'RUNTIME_VERSION_INCOMPATIBLE',
                `${definition.label} ${version} 低于平台适配的最低版本 ${definition.minimumVersion}。`,
            )],
        };
    }

    if (!definition.adapter) {
        return {
            ...base,
            version,
            status: 'adapter-missing',
            selectable: false,
            diagnostics: [diagnostic(
                'RUNTIME_ADAPTER_MISSING',
                `已检测到 ${definition.label} ${version}，但平台尚未交付该运行时的执行适配器，暂不能用于平台任务。`,
            )],
        };
    }

    return {
        ...base,
        version,
        status: 'available',
        selectable: true,
        diagnostics: [diagnostic('RUNTIME_READY', `${definition.label} ${version} 可用于平台任务。`)],
    };
}

async function detectRuntime(
    definition: AgentRuntimeDefinition,
    options: Required<Pick<DetectAgentRuntimesOptions, 'env' | 'probeTimeoutMs' | 'resolveExecutable' | 'probeVersion' | 'now'>>,
): Promise<AgentRuntimeDescriptor> {
    const checkedAt = new Date(options.now()).toISOString();
    let executable: AgentRuntimeExecutable | null = null;
    try {
        executable = options.resolveExecutable(definition.id, options.env);
    } catch {
        executable = null;
    }
    if (!executable) return describeRuntime(definition, null, null, false, checkedAt);

    let output: string | null = null;
    try {
        output = await options.probeVersion(executable, options.probeTimeoutMs);
    } catch {
        output = null;
    }
    return describeRuntime(definition, executable, output, true, checkedAt);
}

/**
 * 检测平台服务实际可访问的 Agent 运行时。
 *
 * 范围限定在「服务进程所在部署环境」：容器内结果不代表宿主机或用户浏览器电脑。
 * 检测只读探测可执行文件与版本，不安装、不升级、不调用真实模型。
 */
export async function detectAgentRuntimes(options: DetectAgentRuntimesOptions = {}): Promise<AgentRuntimeDetection> {
    const now = options.now ?? Date.now;
    if (!options.forceRefresh && cache && now() - cache.at < DETECTION_TTL_MS) {
        return cache.detection;
    }
    if (!options.forceRefresh && inFlight) return inFlight;

    const resolved = {
        env: options.env ?? process.env,
        probeTimeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
        resolveExecutable: options.resolveExecutable ?? detectRuntimeExecutable,
        probeVersion: options.probeVersion ?? probeVersionWithProcess,
        now,
    };

    const run = (async () => {
        const runtimes = await Promise.all(
            AGENT_RUNTIME_DEFINITIONS.map(definition => detectRuntime(definition, resolved)),
        );
        const detection: AgentRuntimeDetection = { runtimes, checkedAt: new Date(now()).toISOString() };
        cache = { at: now(), detection };
        return detection;
    })();

    inFlight = run;
    try {
        return await run;
    } finally {
        if (inFlight === run) inFlight = null;
    }
}

/** 测试与显式刷新使用；下一次检测会重新读取部署环境。 */
export function invalidateAgentRuntimeDetection(): void {
    cache = null;
    inFlight = null;
}

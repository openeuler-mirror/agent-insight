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

import fs from 'node:fs';
import path from 'node:path';

import { runtimePackageRoot } from '@/lib/runtime/package-root';
import {
    emptyCapabilities,
    type AgentRuntimeAdapter,
    type AgentRuntimeCapability,
    type AgentRuntimeCapabilityMap,
    type AgentRuntimeExecutable,
    type AgentRuntimeExecutableSource,
    type AgentRuntimeId,
} from './types';

export interface AgentRuntimeDefinition {
    id: AgentRuntimeId;
    label: string;
    minimumVersion: string;
    /** 平台执行适配器；null 表示该运行时只有检测能力。 */
    adapter: AgentRuntimeAdapter | null;
    /** 环境变量覆盖，按优先级排列。 */
    executableEnvironmentKeys: string[];
    /** PATH 中查找的可执行文件名。 */
    binaryNames: string[];
    /** 额外候选（例如平台打包在 node_modules/.bin 下的二进制）。 */
    extraCandidates: Array<{ path: string; source: AgentRuntimeExecutableSource }>;
}

function isExecutableFile(candidate: string): boolean {
    try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile() && !stat.isSymbolicLink()) return false;
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function findOnPath(names: string[], env: NodeJS.ProcessEnv): AgentRuntimeExecutable | null {
    const pathValue = env.PATH || env.Path || '';
    if (!pathValue) return null;
    const extensions = process.platform === 'win32'
        ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
        : [''];
    for (const directory of pathValue.split(path.delimiter)) {
        if (!directory) continue;
        for (const name of names) {
            for (const extension of extensions) {
                const candidate = path.join(directory, `${name}${extension}`);
                if (isExecutableFile(candidate)) return { path: candidate, source: 'path' };
            }
        }
    }
    return null;
}

function resolveExecutable(definition: AgentRuntimeDefinition, env: NodeJS.ProcessEnv): AgentRuntimeExecutable | null {
    for (const key of definition.executableEnvironmentKeys) {
        const configured = String(env[key] || '').trim();
        if (configured && isExecutableFile(configured)) return { path: configured, source: 'environment' };
    }
    for (const candidate of definition.extraCandidates) {
        if (isExecutableFile(candidate.path)) return { path: candidate.path, source: candidate.source };
    }
    return findOnPath(definition.binaryNames, env);
}

function capabilitiesOf(...enabled: AgentRuntimeCapability[]): AgentRuntimeCapabilityMap {
    const capabilities = emptyCapabilities();
    for (const key of enabled) capabilities[key] = true;
    return capabilities;
}

/**
 * OpenCode 是现有平台内置执行引擎；适配器即 `general-agent` 的 OpenCode 路径。
 * 能力声明与 `runGeneralAgent` 的既有约束保持一致。
 */
export const OPENCODE_RUNTIME: AgentRuntimeDefinition = {
    id: 'opencode',
    label: 'OpenCode',
    // 平台同时支持 OpenCode 1.x 与 2.x；1.0.0 以下未验证。
    minimumVersion: '1.0.0',
    adapter: {
        id: 'opencode-general-agent',
        label: 'OpenCode 通用 Agent',
        capabilities: capabilitiesOf(
            'tool-policy',
            'session-resume',
            'cancel',
            'timeout',
            'skill-loading',
            'trace-attribution',
        ),
    },
    executableEnvironmentKeys: ['OPENCODE_BIN'],
    binaryNames: ['opencode'],
    extraCandidates: [
        { path: path.join(runtimePackageRoot(), 'node_modules', '.bin', 'opencode'), source: 'bundled' },
    ],
};

/**
 * Pi 的判定阈与常驻客户端一致（>= 0.82.1 起提供 `--mode json` 等非交互参数）。
 * 当前只完成检测与信息展示，执行适配器尚未交付，因此 `adapter` 为 null。
 */
export const PI_RUNTIME: AgentRuntimeDefinition = {
    id: 'pi',
    label: 'Pi',
    minimumVersion: '0.82.1',
    adapter: null,
    executableEnvironmentKeys: ['AGENT_INSIGHT_PI_EXECUTABLE', 'PI_EXECUTABLE'],
    binaryNames: ['pi'],
    extraCandidates: [],
};

/** 顺序即平台默认偏好的顺序：优先 Pi，其次 OpenCode。 */
export const AGENT_RUNTIME_DEFINITIONS: AgentRuntimeDefinition[] = [PI_RUNTIME, OPENCODE_RUNTIME];

export function getAgentRuntimeDefinition(id: AgentRuntimeId): AgentRuntimeDefinition {
    const definition = AGENT_RUNTIME_DEFINITIONS.find(item => item.id === id);
    if (!definition) throw new Error(`未知 Agent 运行时: ${id}`);
    return definition;
}

export function detectRuntimeExecutable(
    id: AgentRuntimeId,
    env: NodeJS.ProcessEnv = process.env,
): AgentRuntimeExecutable | null {
    return resolveExecutable(getAgentRuntimeDefinition(id), env);
}

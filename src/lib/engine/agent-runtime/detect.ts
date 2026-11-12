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
import fs from 'node:fs';
import path from 'node:path';

import { runtimePackageRoot } from '@/lib/runtime/package-root';
import { satisfiesMinimum, parseVersion } from './version';
import type {
  AgentRuntimeDefinition,
  AgentRuntimeDescriptor,
  AgentRuntimeDetection,
  AgentRuntimeSource,
  AgentRuntimeUnavailableReason,
} from './types';

export const AGENT_RUNTIME_DEFINITIONS: readonly AgentRuntimeDefinition[] = [
  {
    id: 'opencode',
    displayName: 'OpenCode',
    envVar: 'OPENCODE_BIN',
    bundledRelativePath: path.join('node_modules', '.bin', 'opencode'),
    command: 'opencode',
    versionArgs: ['--version'],
    // @opencode-ai/sdk 的最低版本要求；更高版本按语义版本放行。
    minimumVersion: '1.14.30',
    capabilities: ['session', 'tools', 'skills', 'permissions', 'cancel', 'timeout', 'trace'],
    adapterAvailable: true,
  },
  {
    id: 'pi',
    displayName: 'Pi',
    envVar: 'AGENT_RUNTIME_PI_BIN',
    bundledRelativePath: path.join('node_modules', '.bin', 'pi'),
    command: 'pi',
    versionArgs: ['--version'],
    // 与 Pi Trace 采集器一致的实现基线。
    minimumVersion: '0.82.1',
    capabilities: [],
    adapterAvailable: false,
  },
];

export type ExecutableResolution =
  | { kind: 'found'; path: string; source: Exclude<AgentRuntimeSource, 'unknown'> }
  | { kind: 'configured-missing'; path: string }
  | { kind: 'not-found'; searched: string[] };

export interface AgentRuntimeProbe {
  resolve(def: AgentRuntimeDefinition): Promise<ExecutableResolution>;
  readVersion(def: AgentRuntimeDefinition, executable: string): Promise<string | null>;
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathCandidates(command: string): string[] {
  if (process.platform !== 'win32') return [command];
  const extensions = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

function findOnPath(command: string): string | null {
  const pathValue = process.env.PATH || '';
  if (!pathValue) return null;
  const directories = pathValue.split(path.delimiter).filter(Boolean);
  const candidates = pathCandidates(command);
  for (const directory of directories) {
    for (const candidate of candidates) {
      const fullPath = path.join(directory, candidate);
      if (isExecutableFile(fullPath)) return fullPath;
    }
  }
  return null;
}

/**
 * 只探测当前服务进程可访问的文件系统与 PATH，不推断宿主机或用户浏览器环境。
 * 显式配置的路径不存在时直接报错，不回落到其他来源，避免部署方以为配置已生效。
 */
const filesystemProbe: AgentRuntimeProbe = {
  async resolve(def) {
    const configured = process.env[def.envVar]?.trim();
    if (configured) {
      if (isExecutableFile(configured)) return { kind: 'found', path: configured, source: 'env' };
      return { kind: 'configured-missing', path: configured };
    }

    const bundled = path.join(runtimePackageRoot(), def.bundledRelativePath);
    if (isExecutableFile(bundled)) return { kind: 'found', path: bundled, source: 'bundled' };

    const onPath = findOnPath(def.command);
    if (onPath) return { kind: 'found', path: onPath, source: 'path' };

    return {
      kind: 'not-found',
      searched: [def.envVar, path.relative(runtimePackageRoot(), bundled) || bundled, `PATH:${def.command}`],
    };
  },

  readVersion(def, executable) {
    return runVersionCommand(executable, def.versionArgs);
  },
};

function runVersionCommand(executable: string, args: string[], timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn(executable, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: true,
      });
    } catch {
      finish(null);
      return;
    }

    let output = '';
    const append = (chunk: Buffer) => {
      if (output.length < 64 * 1024) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const trimmed = output.trim();
      finish(code === 0 && trimmed ? trimmed : null);
    });
  });
}

export interface DetectAgentRuntimesOptions {
  /** 跳过缓存，用于「重新检测」。 */
  force?: boolean;
  now?: () => Date;
  probe?: AgentRuntimeProbe;
  definitions?: readonly AgentRuntimeDefinition[];
}

const CACHE_TTL_MS = 30_000;
let cached: { checkedAt: number; detection: AgentRuntimeDetection } | null = null;
let inFlight: Promise<AgentRuntimeDetection> | null = null;

function unavailableReason(
  installed: boolean,
  resolution: ExecutableResolution,
  compatible: boolean,
  version: string | null,
  def: AgentRuntimeDefinition,
): AgentRuntimeUnavailableReason | null {
  if (!installed) {
    if (resolution.kind === 'configured-missing') {
      return { code: 'CONFIGURED_PATH_MISSING', detail: resolution.path };
    }
    return { code: 'NOT_INSTALLED', detail: def.envVar };
  }
  if (version == null) return { code: 'VERSION_UNREADABLE', detail: def.versionArgs.join(' ') };
  if (!compatible) return { code: 'INCOMPATIBLE', detail: `${version} < ${def.minimumVersion}` };
  if (!def.adapterAvailable) return { code: 'NO_ADAPTER' };
  return null;
}

export async function detectRuntimesWithProbe(
  definitions: readonly AgentRuntimeDefinition[],
  probe: AgentRuntimeProbe,
  now: () => Date = () => new Date(),
): Promise<AgentRuntimeDetection> {
  const runtimes: AgentRuntimeDescriptor[] = [];

  for (const def of definitions) {
    const resolution = await probe.resolve(def);
    const installed = resolution.kind === 'found';
    const executable = resolution.kind === 'found' ? resolution.path : null;
    const version = installed ? await probe.readVersion(def, resolution.path) : null;
    const compatible = installed
      ? def.minimumVersion == null
        ? parseVersion(version) !== null
        : satisfiesMinimum(version, def.minimumVersion)
      : false;
    const reason = unavailableReason(installed, resolution, compatible, version, def);

    runtimes.push({
      id: def.id,
      displayName: def.displayName,
      installed,
      version,
      executable,
      source: resolution.kind === 'found' ? resolution.source : 'unknown',
      minimumVersion: def.minimumVersion,
      compatible,
      adapterAvailable: def.adapterAvailable,
      usable: reason == null,
      capabilities: def.adapterAvailable ? [...def.capabilities] : [],
      unavailableReason: reason,
    });
  }

  return { runtimes, checkedAt: now().toISOString() };
}

export async function detectAgentRuntimes(options: DetectAgentRuntimesOptions = {}): Promise<AgentRuntimeDetection> {
  const { force = false, now = () => new Date(), probe = filesystemProbe, definitions = AGENT_RUNTIME_DEFINITIONS } = options;

  if (!force && cached && now().getTime() - cached.checkedAt < CACHE_TTL_MS) {
    return cached.detection;
  }
  if (!force && inFlight) return inFlight;

  const task = detectRuntimesWithProbe(definitions, probe, now)
    .then((detection) => {
      cached = { checkedAt: now().getTime(), detection };
      return detection;
    })
    .finally(() => {
      if (inFlight === task) inFlight = null;
    });

  inFlight = task;
  return task;
}

/** 仅测试使用：清空模块级缓存。 */
export function resetAgentRuntimeDetectionCache(): void {
  cached = null;
  inFlight = null;
}

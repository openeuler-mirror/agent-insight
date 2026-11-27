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

/** 平台内置功能可选的 Agent 运行时。新增运行时需同时提供执行适配器。 */
export type AgentRuntimeId = 'opencode' | 'pi';

/** 可执行文件来源；`env` 指部署侧显式配置的路径。 */
export type AgentRuntimeSource = 'env' | 'bundled' | 'path' | 'unknown';

export type AgentRuntimeCapability =
  | 'session'
  | 'tools'
  | 'skills'
  | 'permissions'
  | 'cancel'
  | 'timeout'
  | 'trace';

export type AgentRuntimeUnavailableCode =
  | 'NOT_INSTALLED'
  | 'CONFIGURED_PATH_MISSING'
  | 'VERSION_UNREADABLE'
  | 'INCOMPATIBLE'
  | 'NO_ADAPTER'
  | 'UNKNOWN_RUNTIME';

export interface AgentRuntimeUnavailableReason {
  code: AgentRuntimeUnavailableCode;
  /** 补充事实（路径、实际/最低版本），由客户端拼接进本地化文案。 */
  detail?: string;
}

export interface AgentRuntimeDescriptor {
  id: AgentRuntimeId;
  displayName: string;
  installed: boolean;
  version: string | null;
  executable: string | null;
  source: AgentRuntimeSource;
  minimumVersion: string | null;
  compatible: boolean;
  adapterAvailable: boolean;
  /** installed && compatible && adapterAvailable；只有为 true 才能被选为默认值。 */
  usable: boolean;
  capabilities: AgentRuntimeCapability[];
  unavailableReason: AgentRuntimeUnavailableReason | null;
}

export interface AgentRuntimeDetection {
  runtimes: AgentRuntimeDescriptor[];
  checkedAt: string;
}

export interface AgentRuntimeSelection {
  runtimeId: AgentRuntimeId | null;
  /** 用户保存时该运行时可用；若环境后来变化，这里会变成 false。 */
  usable: boolean;
  reason: AgentRuntimeUnavailableReason | null;
}

export interface AgentRuntimeOverview extends AgentRuntimeDetection {
  selection: AgentRuntimeSelection;
  /** 用户未保存偏好时平台实际使用的运行时；没有可用运行时为 null。 */
  defaultRuntimeId: AgentRuntimeId | null;
}

export interface AgentRuntimeDefinition {
  id: AgentRuntimeId;
  displayName: string;
  /** 部署侧覆盖可执行文件路径的环境变量。 */
  envVar: string;
  /** 相对安装根目录的 bundled 可执行文件路径。 */
  bundledRelativePath: string;
  /** PATH 上的命令名。 */
  command: string;
  versionArgs: string[];
  minimumVersion: string | null;
  capabilities: AgentRuntimeCapability[];
  /** 平台是否已提供该运行时的执行适配器。 */
  adapterAvailable: boolean;
}

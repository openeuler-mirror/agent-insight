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

import type { AgentOptions, RuntimeDefinition } from './index.cjs'
type Settings = { root?: string; configDir?: string; env?: Readonly<Record<string, string | undefined>> }
type Mapping = { path: string; flag: string; falseFlag?: string; encoding?: 'json' | 'repeat' | 'join'; booleanStyle?: 'value' | 'switch'; separator?: string }
export type RuntimeInvocationPlan = { agentOptions?: AgentOptions; definition?: RuntimeDefinition; args: string[]; env: Record<string, string>; parameterFile?: { contents: string; flag?: string; env: string } }
export function loadRuntimeDefinitions(settings?: Settings): Array<{ descriptor: RuntimeDefinition; bindings: Map<string, { kind: 'argv'; flag: string; falseFlag?: string }>; deliveryBinding?: { mode?: 'passthrough'; flag?: string; env?: string; mappings?: Mapping[] } }>
export function runtimeInvocationOptions(platform: string, agent: string, options?: unknown, settings?: Settings): RuntimeInvocationPlan
export function prepareRuntimeInvocation(plan: RuntimeInvocationPlan, baseDir: string): { args: string[]; env: Record<string, string>; cleanup(): void }

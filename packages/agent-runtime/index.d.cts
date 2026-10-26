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

export type ParameterValue = string | number | boolean
export type AgentOptions = { runtimeKey: string; definitionDigest: string; values: Record<string, ParameterValue> }
export type ParameterField = { key: string; group: string; label: string; description?: string; type: 'integer' | 'number' | 'string' | 'boolean' | 'enum'; required?: boolean; default?: ParameterValue; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; choices?: ParameterValue[] }
export type RuntimeDefinition = { runtimeKey: string; displayName: string; definitionDigest: string; targets: Array<{ platform: string; agent: string }>; parameterGroups: Array<{ key: string; label: string; description?: string }>; parameters: ParameterField[]; presets: Array<{ key: string; label: string; values: Record<string, ParameterValue> }> }
export function validateDefinition(value: unknown): RuntimeDefinition
export function validateValues(definition: RuntimeDefinition, values: unknown, fillDefaults?: boolean): Record<string, ParameterValue>
export function definitionsForTarget(definitions: RuntimeDefinition[], platform: string, agent: string): RuntimeDefinition[]
export function normalizeAgentOptions(value: unknown, definition?: RuntimeDefinition): AgentOptions | undefined
export function resolveAgentOptions(definitions: RuntimeDefinition[], platform: string, agent: string, value?: unknown): { agentOptions?: AgentOptions; definition?: RuntimeDefinition }
export function optionsToInputs(definition: RuntimeDefinition, options?: unknown): Record<string, string>
export function parseOptionInputs(definition: RuntimeDefinition, inputs: Record<string, string>): AgentOptions
export function summarizeOptions(definition?: RuntimeDefinition | null, options?: AgentOptions | null): string

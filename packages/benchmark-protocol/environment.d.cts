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

export const PROTOCOL: 'execution-environment/v1'
export const ACTION: 'PREPARE_EXECUTION_ENVIRONMENT'
export const TIMEOUT_MS: number
export type EnvironmentContext = {
  protocol: typeof PROTOCOL
  clientId: string
  dataset: { id: string; adapterKey: string; revision: string; caseIds: string[]; faultTypes: string[] }
  platform: string
  agent: string
  model: string
  agentOptions?: Record<string, unknown>
  experiment: { mode: 'generate' | 'skill-ab' | 'trigger'; timeoutSeconds: number; concurrency: number }
}
export type EnvironmentState = 'checking' | 'preparing' | 'needs_action' | 'ready' | 'failed'
export type EnvironmentTask = {
  taskId: string
  contextDigest: string
  state: EnvironmentState
  message: string
  issues: Array<{ code: string; message: string }>
  durationHint?: 'first_install_minutes' | 'minutes'
}
export function validateContext(value: unknown): EnvironmentContext
export function contextDigest(value: EnvironmentContext): string
export function preparationMessage(state: string, durationHint?: string): string

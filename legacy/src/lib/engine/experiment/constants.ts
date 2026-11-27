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

export const DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS = 600;
export const TRIGGER_STARTUP_TIMEOUT_SECONDS = 120;
export const MIN_EXPERIMENT_AGENT_TIMEOUT_SECONDS = 30;
export const MAX_EXPERIMENT_AGENT_TIMEOUT_SECONDS = 3_600;

export function isValidExperimentAgentTimeoutSeconds(value: number): boolean {
  return Number.isInteger(value)
    && value >= MIN_EXPERIMENT_AGENT_TIMEOUT_SECONDS
    && value <= MAX_EXPERIMENT_AGENT_TIMEOUT_SECONDS;
}

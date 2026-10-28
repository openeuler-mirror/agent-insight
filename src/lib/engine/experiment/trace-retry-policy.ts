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

const NON_RETRYABLE_FAILURE_CODES = new Set([
  'ACTION_NOT_ALLOWED', 'AGENT_EXIT_NONZERO', 'AGENT_NO_OUTPUT', 'AGENT_TIMEOUT',
  'MODEL_ERROR', 'MODEL_NO_RESPONSE', 'MODEL_START_TIMEOUT', 'MODEL_UNAVAILABLE',
  'MODEL_MISMATCH', 'MODEL_UNCONFIRMED', 'CLIENT_MISMATCH', 'EXPERIMENT_CANCELLED', 'EXECUTION_CANCELLED',
  'CANCELLATION_UNCONFIRMED', 'EVENT_MONITOR_UNAVAILABLE', 'SKILL_EXECUTION_UNSUPPORTED', 'PAYLOAD_FORBIDDEN',
  'PLATFORM_NOT_AVAILABLE', 'TRACE_ID_MISSING', 'TRACE_ID_UNSUPPORTED', 'TRACE_ID_REUSED', 'TRACE_ID_CONFLICT', 'TRACE_ID_INVALID', 'EXECUTION_SUPERSEDED',
  'TRIGGER_EVIDENCE_MISSING', 'SKILL_ISOLATION_UNAVAILABLE', 'MODEL_CONFIGURATION_UNREADABLE', 'MODEL_CONFIGURATION_MISSING',
  'AGENT_STARTUP_TIMEOUT', 'TRIGGER_ROUTING_TIMEOUT', 'TRACE_INGEST_TIMEOUT',
  'AGENT_OPTIONS_INVALID', 'AGENT_DEFINITION_CHANGED', 'CLIENT_UPGRADE_REQUIRED',
]);

export function isTraceGenerationFailureRetryable(code: string): boolean {
  return !NON_RETRYABLE_FAILURE_CODES.has(code);
}

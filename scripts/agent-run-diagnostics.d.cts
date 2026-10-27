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

export interface AgentRunFacts {
  traceId?: string;
  startedAt?: string;
  finishedAt?: string;
  [key: string]: unknown;
}

export type AgentRunError = Error & { code: string; runFacts?: AgentRunFacts };
export function extractStructuredAgentError(value: unknown): string | null;
export function sanitizeAgentDiagnostic(value: unknown, maxLength?: number): string;
export function classifyAgentExitFailure(input: {
  platform: string;
  exitCode?: number | null;
  signal?: string | null;
  diagnostic?: unknown;
  structured?: boolean;
}): { code: string; message: string };
export function createAgentRunError(code: string, message: string, runFacts?: AgentRunFacts): AgentRunError;
export interface OpencodeFailureEvent {
  type?: string;
  error?: string | null;
  modelResponse?: boolean;
  retry?: { message?: string; attempt?: number | string };
}
export function createOpencodeFailureMonitor(options: {
  inspectEvent: (line: string) => OpencodeFailureEvent | null;
  onFailure: (code: string, message: string) => void;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}): {
  onEvent(event: OpencodeFailureEvent | null): void;
  onStderr(chunk: string): void;
  finish(): { code: string; message: string; detectedAt: string } | null;
  dispose(): void;
};

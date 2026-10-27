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

import type { DiagnosisProgressWriter } from './progress-types';

export type AgentDebugBackgroundJobKind = 'agent-debug' | 'skills-analysis';

export interface ActiveAgentDebugBackgroundJob {
  kind: AgentDebugBackgroundJobKind;
  executionId: string;
  interactionsHash: string;
  startedAt: number;
  progress?: DiagnosisProgressWriter;
}

declare global {
  // eslint-disable-next-line no-var
  var __agentDebugBackgroundJobs: Map<string, ActiveAgentDebugBackgroundJob> | undefined;
}

function jobKey(kind: AgentDebugBackgroundJobKind, executionId: string) {
  return `${kind}:${executionId}`;
}

function activeJobs() {
  if (!globalThis.__agentDebugBackgroundJobs) {
    globalThis.__agentDebugBackgroundJobs = new Map();
  }
  return globalThis.__agentDebugBackgroundJobs;
}

export function getActiveAgentDebugBackgroundJob(kind: AgentDebugBackgroundJobKind, executionId: string) {
  return activeJobs().get(jobKey(kind, executionId)) || null;
}

export function hasActiveAgentDebugBackgroundJob(
  kind: AgentDebugBackgroundJobKind,
  executionId: string,
  interactionsHash?: string,
) {
  const job = getActiveAgentDebugBackgroundJob(kind, executionId);
  if (!job) return false;
  return interactionsHash ? job.interactionsHash === interactionsHash : true;
}

export function setActiveAgentDebugBackgroundJob(job: ActiveAgentDebugBackgroundJob) {
  activeJobs().set(jobKey(job.kind, job.executionId), job);
}

export function clearActiveAgentDebugBackgroundJob(
  kind: AgentDebugBackgroundJobKind,
  executionId: string,
  interactionsHash?: string,
) {
  const key = jobKey(kind, executionId);
  const job = activeJobs().get(key);
  if (!job) return;
  if (interactionsHash && job.interactionsHash !== interactionsHash) return;
  activeJobs().delete(key);
}

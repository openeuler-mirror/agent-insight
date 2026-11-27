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

import type { AgentDebugModule } from './types';

export type DiagnosisProgressModule = Exclude<AgentDebugModule, 'others' | 'unknown'> | 'skills';
export interface DiagnosisProgressInput {
  key: string;
  kind: 'task' | 'tool' | 'evidence' | 'analysis' | 'stage';
  module?: DiagnosisProgressModule;
  state: 'started' | 'update' | 'completed' | 'failed' | 'skipped';
  title: string;
  summary: string;
  refs?: Array<{ traceStepIndex: number; anchorId?: string }>;
}

export interface DiagnosisProgressEvent extends DiagnosisProgressInput {
  seq: number;
  at: string;
}

export interface DiagnosisProgressSnapshot {
  runId: string;
  events: DiagnosisProgressEvent[];
  lastProgressAt: string | null;
  unavailable: boolean;
  truncated: boolean;
}

export interface DiagnosisProgressWriter {
  runId: string;
  emit: (event: DiagnosisProgressInput) => void;
  snapshot: () => DiagnosisProgressSnapshot;
  unavailable: () => void;
}

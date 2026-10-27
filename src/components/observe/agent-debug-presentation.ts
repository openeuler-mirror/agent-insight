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

import type { AgentDebugModule, AgentDebugReportPayload } from '@/lib/engine/agent-debug/types';
import type { DiagnosisProgressEvent, DiagnosisProgressSnapshot } from '@/lib/engine/agent-debug/progress-types';

export function getModulePresentation(report: AgentDebugReportPayload | null, module: AgentDebugModule) {
  const cells = (report?.phase1Grid || []).filter(cell => cell.module === module);
  const issues = (report?.issues || []).filter(issue => issue.module === module);
  const records = (report?.stepRecords || []).flatMap(record => {
    const output = record.modules?.[module as keyof typeof record.modules];
    return output?.content?.trim() ? [{ ...record, content: output.content }] : [];
  }).sort((a, b) => (a.traceStepIndex ?? a.step) - (b.traceStepIndex ?? b.step));
  const hasResult = cells.some(cell => cell.errorDetected || cell.errorType === 'no_error' || cell.reasoning?.trim()) || issues.length > 0;
  const hasError = issues.length > 0 || cells.some(cell => cell.errorDetected);
  const explicitlyClear = cells.some(cell => !cell.errorDetected && cell.errorType === 'no_error');
  const status = report?.skippedReason ? 'skipped' : hasResult ? 'result' : report?.triage?.shortCircuited ? 'early_end' : 'missing';
  return { cells, issues, records, status, hasError, explicitlyClear };
}
export type ModuleActivity = 'checking' | 'waiting' | 'awaiting_analysis' | 'evidence' | 'updates' | 'stage_done' | 'skipped' | 'failed' | 'interrupted' | 'unknown' | 'result' | 'missing';

export function getModuleActivity({ events, loading, failed, unavailable, reportStatus, now }: {
  events: DiagnosisProgressEvent[];
  loading: boolean;
  failed: boolean;
  unavailable: boolean;
  reportStatus?: ReturnType<typeof getModulePresentation>['status'];
  now: number;
}): ModuleActivity {
  if (reportStatus) return reportStatus === 'result' ? 'result' : reportStatus === 'skipped' ? 'skipped' : 'missing';
  if (failed) return 'interrupted';
  if (unavailable) return 'unknown';
  const phase = events.findLast(event => (event.kind === 'analysis' || event.kind === 'stage') && event.state !== 'update');
  if (phase?.state === 'failed') return 'failed';
  if (phase?.state === 'skipped') return 'skipped';
  if (phase?.state === 'completed') return 'stage_done';
  const lastAt = Date.parse(events.at(-1)?.at || '');
  const recent = Number.isFinite(lastAt) && now - lastAt < 60_000;
  if (loading && phase?.state === 'started') return recent ? 'checking' : 'waiting';
  if (loading && events.length && !recent) return 'awaiting_analysis';
  if (events.some(event => event.kind === 'analysis' || event.kind === 'stage')) return 'updates';
  return events.length ? 'evidence' : 'missing';
}

export function getNewModuleSequences(previous: DiagnosisProgressSnapshot | null, incoming: DiagnosisProgressSnapshot | null) {
  const sequences: Partial<Record<AgentDebugModule, number>> = {};
  if (!previous || !incoming || previous.runId !== incoming.runId || incoming.unavailable) return sequences;
  const lastSeq = previous.events.at(-1)?.seq ?? 0;
  for (const event of incoming.events) {
    if (event.seq > lastSeq && event.module && event.module !== 'skills' && (event.state === 'update' || event.state === 'completed')) {
      sequences[event.module] = event.seq;
    }
  }
  return sequences;
}

export function preserveDiagnosisProgress(previous: DiagnosisProgressSnapshot | null, incoming: DiagnosisProgressSnapshot | null, runId?: string): DiagnosisProgressSnapshot | null {
  if (incoming && incoming.runId !== runId) return null;
  if (!previous || previous.runId !== runId) return incoming;
  if (!incoming) return { ...previous, unavailable: true };
  if ((incoming.events.at(-1)?.seq ?? 0) < (previous.events.at(-1)?.seq ?? 0)) {
    return { ...previous, unavailable: incoming.unavailable || previous.unavailable };
  }
  return incoming;
}

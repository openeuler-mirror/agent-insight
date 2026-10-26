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

export const TRACE_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
export type TraceLifecycleStatus = 'running' | 'success' | 'failed' | 'timed_out';

function timestampMs(value: unknown): number | null {
  const ms = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export function getTraceLifecycle(completedAt: unknown, record: Record<string, unknown> = {}, now = Date.now()) {
  const completedMs = timestampMs(completedAt);
  const lastReceivedMs = timestampMs(record.lastIngestedAt) ?? timestampMs(record.timestamp);
  const traceLastReceivedAt = lastReceivedMs === null ? null : new Date(lastReceivedMs).toISOString();
  if (completedMs !== null) {
    let failures = record.failures;
    if (typeof failures === 'string') {
      try { failures = JSON.parse(failures); } catch { failures = []; }
    }
    const opencodeFailed = record.framework === 'opencode' && Array.isArray(failures)
      && failures.some(failure => failure?.failure_type === 'opencode-session-error');
    const goalPlusFailed = Array.isArray(failures)
      && failures.some(failure => failure?.failure_type === 'goal_plus_pi_session_failed');
    const processFailed = ['actrail', 'mcts-xgovernor'].includes(String(record.framework)) && Array.isArray(failures)
      && failures.some(failure => failure?.failure_type === 'agent-process-exit');
    return {
      traceStatus: (opencodeFailed || goalPlusFailed || processFailed ? 'failed' : 'success') as TraceLifecycleStatus,
      traceCompletedAt: new Date(completedMs).toISOString(),
      traceStatusReason: opencodeFailed ? 'opencode-session-error' : goalPlusFailed ? 'goal-plus-session-failed' : processFailed ? 'agent-process-exit' : 'session-ended',
      traceLastReceivedAt,
    };
  }
  const timedOut = lastReceivedMs !== null && now - lastReceivedMs >= TRACE_INACTIVITY_TIMEOUT_MS;
  return {
    traceStatus: (timedOut ? 'timed_out' : 'running') as TraceLifecycleStatus,
    traceCompletedAt: null,
    traceStatusReason: timedOut ? 'inactivity-timeout' : 'missing-completion-signal',
    traceLastReceivedAt,
  };
}

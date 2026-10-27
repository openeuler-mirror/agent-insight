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

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isLogEnabled } from './server';

type Context = { runId: string; parentRunId?: string; fields: Record<string, unknown> };
const context = new AsyncLocalStorage<Context>();

export function diagnosticTimestamp(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function diagnosticErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z_0-9]{1,40}$/.test(code) ? code : 'UNCLASSIFIED';
}

export function traceTimingEvent(event: string, fields: Record<string, unknown> = {}): void {
  const current = context.getStore();
  if (!current) return;
  try {
    console.debug(`[TraceTiming] ${JSON.stringify({
      ts: new Date().toISOString(), pid: process.pid, ...current.fields,
      runId: current.runId, parentRunId: current.parentRunId, event, ...fields,
    })}`);
  } catch {}
}

export function beginTraceStage(stage: string): () => void {
  if (!context.getStore()) return () => {};
  const started = performance.now();
  traceTimingEvent('stage-start', { stage });
  return () => traceTimingEvent('stage-end', { stage, outcome: 'completed', durationMs: performance.now() - started });
}

export async function withTraceTiming<T>(fields: Record<string, unknown>, operation: () => Promise<T>): Promise<T> {
  if (!isLogEnabled('debug')) return operation();
  return context.run({ runId: randomUUID(), parentRunId: context.getStore()?.runId, fields }, async () => {
    const started = performance.now();
    traceTimingEvent('start');
    try {
      const value = await operation();
      traceTimingEvent('end', { outcome: 'completed', durationMs: performance.now() - started });
      return value;
    } catch (error) {
      traceTimingEvent('end', { outcome: 'failed', errorCode: diagnosticErrorCode(error), durationMs: performance.now() - started });
      throw error;
    }
  });
}

export async function timeTraceStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  if (!context.getStore()) return operation();
  const started = performance.now();
  traceTimingEvent('stage-start', { stage });
  try {
    const result = await operation();
    traceTimingEvent('stage-end', { stage, outcome: 'completed', durationMs: performance.now() - started });
    return result;
  } catch (error) {
    traceTimingEvent('stage-end', { stage, outcome: 'failed', errorCode: diagnosticErrorCode(error), durationMs: performance.now() - started });
    throw error;
  }
}

export function timeTraceStageSync<T>(stage: string, operation: () => T): T {
  if (!context.getStore()) return operation();
  const started = performance.now();
  traceTimingEvent('stage-start', { stage });
  try {
    const result = operation();
    traceTimingEvent('stage-end', { stage, outcome: 'completed', durationMs: performance.now() - started });
    return result;
  } catch (error) {
    traceTimingEvent('stage-end', { stage, outcome: 'failed', errorCode: diagnosticErrorCode(error), durationMs: performance.now() - started });
    throw error;
  }
}

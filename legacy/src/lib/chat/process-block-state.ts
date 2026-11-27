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

export type ProcessOutcome = 'complete' | 'error';
export type ProcessState = 'running' | 'complete' | 'error';

interface ProcessBlockLike {
  kind?: string;
  status?: string;
  done?: boolean;
}

export function resolveProcessState(status: string | undefined, parentStatus?: string): ProcessState {
  const value = status || '';
  if (/(error|failed|cancel|incomplete|timeout)/i.test(value)) return 'error';
  if (!/(running|pending|started)/i.test(value)) return 'complete';
  if (/(failed|cancelled)/i.test(parentStatus || '')) return 'error';
  if (/(done|complete|completed|success|passed)/i.test(parentStatus || '')) return 'complete';
  return 'running';
}

export function settleProcessBlocks<T extends ProcessBlockLike>(
  blocks: readonly T[],
  outcome: ProcessOutcome,
): T[] {
  return blocks.map((block) => {
    if (block.kind === 'thinking') {
      const state = resolveProcessState(block.status);
      const unfinished = state === 'running' || (!block.status && block.done !== true);
      if (!unfinished) return block;
      return {
        ...block,
        done: true,
        status: outcome === 'complete' ? 'done' : 'error',
      } as T;
    }
    if (block.kind === 'tool' && resolveProcessState(block.status) === 'running') {
      return {
        ...block,
        status: outcome === 'complete' ? 'complete' : 'error',
      } as T;
    }
    return block;
  });
}

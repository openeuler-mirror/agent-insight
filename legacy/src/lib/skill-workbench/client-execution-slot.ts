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

const queuesKey = Symbol.for('agent-insight.skill-client-execution-queues');
const state = globalThis as unknown as { [queuesKey]: Map<string, Promise<void>> | undefined };
const queues = state[queuesKey] ??= new Map<string, Promise<void>>();

export async function withSkillClientSlot<T>(workerId: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(workerId) || Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => next);
  queues.set(workerId, queued);
  try {
    await previous;
    signal.throwIfAborted();
    return await run();
  } finally {
    release();
    if (queues.get(workerId) === queued) queues.delete(workerId);
  }
}

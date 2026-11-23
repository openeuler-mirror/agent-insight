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

export interface StreamCheckpointWriter {
  schedule: () => void;
  flush: () => Promise<void>;
  cancel: () => void;
}

export function createStreamCheckpointWriter<T>({
  capture,
  persist,
  intervalMs = 1_000,
  onError,
}: {
  capture: () => T;
  persist: (snapshot: T) => Promise<void>;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): StreamCheckpointWriter {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain = Promise.resolve();
  let lastError: unknown = null;
  let cancelled = false;

  const enqueue = () => {
    if (cancelled) return;
    const snapshot = capture();
    chain = chain
      .catch(() => undefined)
      .then(async () => {
        try {
          await persist(snapshot);
          lastError = null;
        } catch (error) {
          lastError = error;
          onError?.(error);
        }
      });
  };

  return {
    schedule() {
      if (cancelled || timer) return;
      timer = setTimeout(() => {
        timer = null;
        enqueue();
      }, intervalMs);
    },
    async flush() {
      if (cancelled) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      enqueue();
      await chain;
      if (lastError) throw lastError;
    },
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

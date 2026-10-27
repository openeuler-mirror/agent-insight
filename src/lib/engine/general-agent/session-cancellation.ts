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

export async function withSessionCancellation<T>(
  signal: AbortSignal | undefined,
  abortSession: () => Promise<boolean>,
  work: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  let stopping: Promise<Error | null> | undefined;
  const stop = () => {
    stopping ||= abortSession().then(
      (confirmed) => confirmed ? null : new Error('停止 OpenCode 执行未确认，请检查运行服务'),
      () => new Error('停止 OpenCode 执行未确认，请检查运行服务'),
    );
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const result = await work();
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener('abort', stop);
    if (stopping) {
      const error = await stopping;
      if (error) throw error;
    }
  }
}

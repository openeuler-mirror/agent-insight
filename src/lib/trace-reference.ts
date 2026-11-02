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

export function traceIdFromFacts(facts: Record<string, unknown>): string | null {
  return typeof facts.traceId === 'string' && facts.traceId.trim() ? facts.traceId.trim() : null
}

export function mergeTraceFacts(
  previous: Record<string, unknown>, incoming: Record<string, unknown>,
  fail: (code: string, message: string) => Error,
): Record<string, unknown> {
  const current = traceIdFromFacts(previous)
  const next = traceIdFromFacts(incoming)
  if (incoming.traceId != null && (!next || next.length > 1024 || /[\u0000-\u001f\u007f]/.test(next))) {
    throw fail('TRACE_ID_INVALID', '主链路 ID 不合法')
  }
  if (current && next && current !== next) throw fail('TRACE_ID_CONFLICT', '本次执行已绑定其他主链路，拒绝覆盖')
  return { ...previous, ...incoming, ...((current || next) ? { traceId: current || next } : {}) }
}

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

import { apiFetch } from './api';

/**
 * 下钻某 trace 的评测详情 URL：评测走实验后跳实验的 Trace 评测详情
 * (/experiments/<experimentId>/cases/<caseId>)；按 taskId 反查最近一次实验 case，
 * 取不到(该 trace 尚未经实验评测)则回退到该 trace 的链路详情页。
 */
export async function drillTraceEvalUrl(user: string, taskId: string): Promise<string> {
  const fallback = `/trace?taskId=${encodeURIComponent(taskId)}`;
  if (!user || !taskId) return fallback;
  try {
    const res = await apiFetch(`/api/experiments/eval-results?user=${encodeURIComponent(user)}&taskId=${encodeURIComponent(taskId)}&limit=1`);
    if (!res.ok) return fallback;
    const data = await res.json();
    const r = Array.isArray(data?.results) ? data.results[0] : null;
    if (r?.evaluatorRunId && r?.caseId) {
      return `/experiments/${encodeURIComponent(String(r.evaluatorRunId))}/cases/${encodeURIComponent(String(r.caseId))}`;
    }
  } catch { /* 回退旧页 */ }
  return fallback;
}

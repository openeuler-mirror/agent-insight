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

// Infra↔Session 反向关联：给定一个推理源 endpoint 和时间窗，列出该窗口内命中它的 execution（会话）。
// 与 correlate.ts（单条 execution → infra）方向相反：这里是「某段时间这个源上有哪些 session 在干活」。

import { prismaRaw } from '@/lib/storage/prisma';
import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {readCoreInfraExecutions,getCoreInfraLinks,setCoreInfraLinks} from '@/lib/storage-core/infra';

export interface SessionForEndpoint {
  id: string;
  taskId: string | null;
  tsMs: number;
  latencyMs: number | null;
  model: string | null;
  outputTokens: number | null;
  agentName: string | null;
}

/** 该 endpoint 在 [fromMs, toMs] 内命中的 execution 总数（分页用）。 */
export async function countSessionsForEndpoint(endpoint: string, fromMs: number, toMs: number): Promise<number> {
  if (!endpoint) return 0;
  return (await readCoreInfraExecutions()).filter(row=>row.endpoint===endpoint&&row.timestamp.getTime()>=fromMs&&row.timestamp.getTime()<=toMs).length;
}

/** 列出 [fromMs, toMs] 内、endpoint 命中该源的 execution（按时间降序=最近优先，支持 offset/limit 分页）。 */
export async function listSessionsForEndpoint(endpoint: string, fromMs: number, toMs: number, opts: { limit?: number; offset?: number } = {}): Promise<SessionForEndpoint[]> {
  if (!endpoint) return [];
  {const rows=(await readCoreInfraExecutions()).filter(row=>row.endpoint===endpoint&&row.timestamp.getTime()>=fromMs&&row.timestamp.getTime()<=toMs).sort((a,b)=>b.timestamp.getTime()-a.timestamp.getTime()),offset=Math.max(0,opts.offset??0);return rows.slice(offset,offset+Math.min(200,Math.max(1,opts.limit??20))).map(row=>({id:row.id,taskId:row.taskId,tsMs:row.timestamp.getTime(),latencyMs:row.latency,model:row.model,outputTokens:row.outputTokens,agentName:row.agentName}));}
}

// ---- 会话级（整棵 trace 树）→ 多个 (endpoint, 模型) 关联目标 ----

export interface ExecRef { endpoint: string | null; model: string | null; startMs: number; endMs: number }
export interface InfraTarget { endpoint: string; model: string | null; startMs: number; endMs: number }

/**
 * 把整棵 trace 树的 execution 按 (endpoint, model) 归并成关联目标：
 * 同 (endpoint, model) 合并成一组，窗口取组内 [min start, max end]；无 endpoint 的丢弃。
 * 一个 session 用了多个模型 → 返回多个目标（每个一张关联卡）。
 */
export function groupSessionInfraTargets(execs: ExecRef[]): InfraTarget[] {
  const byKey = new Map<string, InfraTarget>();
  for (const e of execs) {
    if (!e.endpoint) continue;
    const key = `${e.endpoint}\u0000${e.model ?? ''}`;
    const cur = byKey.get(key);
    if (cur) {
      cur.startMs = Math.min(cur.startMs, e.startMs);
      cur.endMs = Math.max(cur.endMs, e.endMs);
    } else {
      byKey.set(key, { endpoint: e.endpoint, model: e.model ?? null, startMs: e.startMs, endMs: e.endMs });
    }
  }
  // 确定性排序：endpoint 优先，再 model
  return [...byKey.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint) || String(a.model).localeCompare(String(b.model)));
}

export interface SessionLink { sourceId: string; model: string | null }

/** 读某棵树的人工覆盖关联集合（无 = 空数组 = 走自动推断）。 */
export async function getSessionLinks(rootExecutionId: string): Promise<SessionLink[]> {
  return getCoreInfraLinks(rootExecutionId);
}

/** 覆盖式保存某棵树的人工关联集合（整体替换；空数组 = 清空，回落到自动推断）。 */
export async function setSessionLinks(rootExecutionId: string, links: SessionLink[]): Promise<void> {
  {await setCoreInfraLinks(rootExecutionId,links);return;}
}

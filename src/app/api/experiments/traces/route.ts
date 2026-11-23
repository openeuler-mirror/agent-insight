import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {withCoreExperiments,requireCoreExperimentContext,coreExperimentFailure} from '@/lib/storage-core/experiments';
import {readCoreExperimentTraces} from '@/lib/storage-core/experiment-traces';
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

// 实验向导 ② 步：按 Agent 分页列 root trace，供圈选 case。
// ok = 简单判定（toolCallErrorCount===0 且 failures 为空/null），仅作列表状态展示。
// 对比向导：加 model 过滤参数；返回 model/skillName/skillVersion 供矩阵分组用。
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';
import { ensureTraceTagTables } from '@/lib/trace-tags';
import { buildExecutionOwnershipWhere } from '@/lib/agent-ownership';
import {
  buildExperimentTraceWhere,
  parseExperimentTraceFilters,
} from '@/lib/engine/experiment/trace-filters';

export const dynamic = 'force-dynamic';

interface ExperimentTraceRow {
  id: string;
  taskId: string | null;
  query: string | null;
  finalResult: string | null;
  latency: number | null;
  tokens: number | null;
  timestamp: Date;
  toolCallErrorCount: number | null;
  failures: string | null;
  model: string | null;
  skill: string | null;
  skillVersion: number | null;
}

function isOk(row: { toolCallErrorCount: number | null; failures: string | null }): boolean {
  if ((row.toolCallErrorCount ?? 0) > 0) return false;
  const f = (row.failures || '').trim();
  if (!f || f === 'null' || f === '[]') return true;
  try {
    const parsed = JSON.parse(f);
    return Array.isArray(parsed) ? parsed.length === 0 : !parsed;
  } catch {
    return false;
  }
}

export async function GET(req: Request):Promise<Response> {
  {
    try{return await withCoreExperiments(req,async()=>{
      const url=new URL(req.url);const filters=parseExperimentTraceFilters(url.searchParams);const query=new URLSearchParams({ownership:'user'});
      const agent=url.searchParams.get('agent');if(agent)query.set('agentName',agent);
      if(filters.search)query.set('query',filters.search);if(filters.from)query.set('timeFrom',filters.from.toISOString());if(filters.to)query.set('timeTo',filters.to.toISOString());if(filters.tagIds.length)query.set('tagIds',filters.tagIds.join(','));
      const model=url.searchParams.get('model');if(model)query.set('filters',JSON.stringify([{column:'model',operator:'=',value:model}]));
      const rows=await readCoreExperimentTraces(requireCoreExperimentContext(),query);const page=Math.max(1,parseInt(url.searchParams.get('page')||'1',10)||1);const pageSize=Math.min(100,Math.max(1,parseInt(url.searchParams.get('pageSize')||'20',10)||20));
      return NextResponse.json({total:rows.length,page,pageSize,items:rows.slice((page-1)*pageSize,page*pageSize).map(row=>({id:row.upload_id,taskId:row.task_id,query:row.query??null,finalResult:row.final_result??null,latency:row.latency??null,tokens:row.tokens??null,timestamp:row.timestamp,ok:Number(row.tool_call_error_count||0)===0&&row.has_failures!==true&&row.trace_status!=='failed',model:row.model??null,skillName:Array.isArray(row.skills)?row.skills[0]??null:null,skillVersion:Array.isArray(row.invoked_skills)?row.invoked_skills[0]?.version??null:null}))});
    });}catch(error){return coreExperimentFailure(error);}
  }
}

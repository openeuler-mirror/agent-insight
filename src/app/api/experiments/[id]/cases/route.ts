import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {coreExperimentWriteRoute,appendCoreExperimentCasesRoute} from '@/lib/storage-core/experiment-routes';
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

// 往已建实验追加 case（建实验向导之外的第二个入口）。
//
// 复用监听模式同一套积木：addEvalExperimentCase（按 taskId 幂等，重复圈选同一条 trace
// 只会复用已有 case 并回填参考答案）+ evaluateEvalExperimentCase（按实验既定的
// evaluatorIds 评这一条）。评测在后台 fire-and-forget 跑，接口只回"收了几条"。
//
// 注意：新 case 走的是**实验创建时定下的评估器**，不重新做 ④ 步门控。若实验里含依赖
// 参考数据的评估器而新 case 没标注参考答案，那一行会落到评估器自己的"未标注→不记分"
// 兜底（见 result-preset-evaluators）。入口 UI 负责把这个提示前置给用户。
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { addEvalExperimentCase, evaluateEvalExperimentCase } from '@/lib/engine/experiment/run-experiment';

export const dynamic = 'force-dynamic';

/** 单次追加上限：与向导跨页全选的 SELECT_ALL_CAP 同量级，避免一次灌爆评测队列。 */
const MAX_CASES_PER_CALL = 200;

interface CaseInput {
  executionId?: string;
  taskId?: string;
  input?: string;
  datasetInput?: string | null;
  actualOutput?: string;
  referenceOutput?: string | null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
):Promise<Response> {
  {const {id}=await params;return coreExperimentWriteRoute(req,()=>appendCoreExperimentCasesRoute(id));}
}

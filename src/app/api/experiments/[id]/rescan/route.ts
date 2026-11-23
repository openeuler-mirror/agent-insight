import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {coreExperimentWriteRoute} from '@/lib/storage-core/experiment-routes';
import {requireCoreExperimentContext} from '@/lib/storage-core/experiments';
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

// 增量重扫：重算配对 → 找新可比配对 → 创建 case + pending 行 + 增量评测。
// 运行中返回 409 互斥；无新配对返回 newPairsCount=0。
import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { rescanComparison } from '@/lib/engine/experiment/comparison-runner';

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
):Promise<Response> {
  {const {id}=await params;return coreExperimentWriteRoute(req,async()=>Response.json(await rescanComparison(id,requireCoreExperimentContext().actor.username)));}
}

import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {experimentReadSource,withCoreExperiments,requireCoreExperimentContext,coreExperimentFailure} from '@/lib/storage-core/experiments';
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

import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { prisma } from '@/lib/storage/prisma';

export async function GET(req: Request):Promise<Response> {
  if(isStorageCoreEnabled()){try{return await withCoreExperiments(req,async()=>{const rows=await requireCoreExperimentContext().rpc('cancellations',{limit:100}) as Array<Record<string,unknown>>;return NextResponse.json({cancellations:rows.map(row=>Object.fromEntries(['id','experimentId','caseKey','status','error','updatedAt'].map(key=>[key,row[key]??null])))});});}catch(error){return coreExperimentFailure(error);}}
  const experimentReads=experimentReadSource(prisma);
  const { username } = await resolveUser(req, new URL(req.url).searchParams.get('user'));
  if (!username) return NextResponse.json({ error: 'user is required' }, { status: 400 });
  const cancellations = await experimentReads.experimentCancellation.findMany({
    where: { user: username, status: 'pending' }, orderBy: { updatedAt: 'desc' }, take: 100,
    select: { id: true, experimentId: true, caseKey: true, status: true, error: true, updatedAt: true },
  });
  return NextResponse.json({ cancellations });
}

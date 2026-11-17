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

// auto-derive：从 Execution.endpoint 聚合候选源 → 探测 /metrics → 标记可观测 / 已注册。

import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {hasCoreInfraContext,withCoreInfraRequest} from '@/lib/storage-core/infra';
import { NextResponse } from 'next/server';

import { deriveCandidates, probeEndpoint } from '@/lib/infra/registry';
import {listInfraSources} from '@/lib/infra/store';
import {prismaRaw} from '@/lib/storage/prisma';
import {readCoreInfraExecutions} from '@/lib/storage-core/infra';

export const dynamic = 'force-dynamic';

export async function GET(req?:Request):Promise<Response> {
  if(isStorageCoreEnabled()&&!hasCoreInfraContext())return withCoreInfraRequest(req||new Request('http://localhost/api/observe/infra'),()=>GET(req));
  const rows = isStorageCoreEnabled()?(await readCoreInfraExecutions()).filter(row=>row.endpoint!==null).slice(0,5000):await prismaRaw.execution.findMany({
    where: { endpoint: { not: null } },
    select: { endpoint: true, model: true },
    take: 5000,
  });
  const candidates = deriveCandidates(rows);

  const registered = new Set(
    (await listInfraSources()).map((s) => s.endpoint),
  );

  const probed = await Promise.all(
    candidates.map(async (c) => ({
      ...c,
      registered: registered.has(c.endpoint),
      probe: await probeEndpoint(c.endpoint, { timeoutMs: 5000 }),
    })),
  );

  return NextResponse.json({ candidates: probed });
}

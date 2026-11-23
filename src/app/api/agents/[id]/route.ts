import {deleteCoreControlAgent} from '@/lib/storage-core/control-agent';
import {withCoreControlRoute} from '@/lib/storage-core/control-route';
import {requireCoreControlContext} from '@/lib/storage-core/control-context';
import {compatibilityFailure} from '@/lib/storage-core/compat';
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
import { addDeletedOpencodeSessionIds } from '@/lib/ingest/opencode-deleted-sessions';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { isUsageEnabled } from '@/lib/usage-analytics/config';

export const dynamic = 'force-dynamic';

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withCoreControlRoute(request,async()=>{
  let agentIdForLog = 'unknown';
  try {
    const { id } = await params;
    agentIdForLog = id;
    if (!id) {
      return NextResponse.json({ error: 'Missing agent ID' }, { status: 400 });
    }

    {
      const deleted=await deleteCoreControlAgent(request,id);
      if(!deleted)return NextResponse.json({error:'Agent not found'},{status:404});
      const tombstoned=addDeletedOpencodeSessionIds(deleted.opencodeSessions);
      if(isUsageEnabled())recordUsageEvent({user:requireCoreControlContext().actor.username,featureKey:'agents',eventKey:'agent.delete'});
      return NextResponse.json({success:true,deletedTraces:deleted.deletedTraces,tombstonedSessions:tombstoned});
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[agents][DELETE] error for id ${agentIdForLog}:`, msg);
    return compatibilityFailure(error);
  }

  },["write","delete"]);
}

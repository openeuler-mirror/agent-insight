import {getCoreControlContext,withCoreControlRequest} from '@/lib/storage-core/control-context';
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
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { extractTaskArtifacts } from '@/lib/engine/evaluation/task-artifacts';
import { inferSubagentNamesFromInteractions } from '@/lib/engine/observability/subagent-inference';
import { normalizeClaudeCodeInteractionsForStorage } from '@/lib/shared/interaction-content';
import { readTraceEvidence, TRACE_EVIDENCE_BYTES } from '@/lib/storage-core/evidence';
import { compatibilityFailure } from '@/lib/storage-core/compat';
import { readCoreBytes } from '@/lib/storage-core/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    return await (getCoreControlContext()
      ? coreDraft(request)
      : withCoreControlRequest(request, () => coreDraft(request)));
  } catch (error) {
    return compatibilityFailure(error);
  }
}

async function coreDraft(request: Request) {
  try {
    const raw=await readCoreBytes(request.body,64*1024);
    let body: Record<string,unknown>;
    try {
      const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
      if(!value || typeof value!=='object' || Array.isArray(value))throw new Error();
      body=value;
    } catch {return NextResponse.json({error:'invalid JSON object'},{status:400});}
    const taskId=typeof body.taskId==='string'?body.taskId.trim():undefined;
    const executionId=typeof body.executionId==='string'?body.executionId.trim():undefined;
    const {evidence,username}=await readTraceEvidence(request,{taskId:taskId||undefined,executionId:executionId||undefined});
    let interactions=evidence.session.interactions;
    if(evidence.execution.framework==='claudecode')interactions=normalizeClaudeCodeInteractionsForStorage(interactions);
    interactions=inferSubagentNamesFromInteractions(interactions as Record<string,unknown>[]);
    const input=Object.prototype.hasOwnProperty.call(evidence.execution,'query')?evidence.execution.query:evidence.session.query;
    const artifacts=await extractTaskArtifacts({rawInput:input??'',fallbackOutput:evidence.execution.finalResult??'',interactions});
    const result={draft:{values:{input:artifacts.input,output:artifacts.output,trace:artifacts.trace},traceSource:{taskId:evidence.session.taskId,executionId:evidence.execution.id,capturedAt:evidence.captured_at}},warnings:artifacts.warnings};
    if(Buffer.byteLength(JSON.stringify(result),'utf8')>TRACE_EVIDENCE_BYTES)return NextResponse.json({error:'Trace draft exceeds byte budget'},{status:413});
    recordUsageEvent({user:username,featureKey:'trace',eventKey:'trace.draft.save'});
    return NextResponse.json(result);
  } catch(error) {return compatibilityFailure(error);}
}

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


import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {resolveCollectorRequest,collectorFailure} from '@/lib/storage-core/collector-entry';
import {withCoreCollectorIdentity} from '@/lib/storage-core/collector-identity';
import { db } from '@/lib/storage/prisma';
import { startSession } from '@/lib/ingest/proxy-store';
import { NextResponse } from 'next/server';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const taskId = (await params).taskId;
  let body: any = {};
  try {
      body = await request.json();
  } catch {
  }
  if (!body || typeof body !== 'object') body = {};
  
  const { searchParams } = new URL(request.url);
  let user = body.user || searchParams.get('user');

  const apiKey = request.headers.get('x-api-key') || body.apiKey;
  const model: string | undefined = body.model || searchParams.get('model') || undefined;
  {try{const headers=new Headers(request.headers);if(apiKey)headers.set('x-witty-api-key',apiKey);const identity=await resolveCollectorRequest(new Request(request.url,{headers}),'snapshot',body);let query=body.query||searchParams.get('query');if(typeof query==='string')query=query.trim().replace(/^['"]+|['"]+$/g,'').trim();await withCoreCollectorIdentity(identity,()=>startSession(taskId,body.label,query,identity.username,model));return NextResponse.json({status:'ok',task_id:taskId,label:body.label,query,user:identity.username,message:'Session started'});}catch(error){return collectorFailure(error);}}
}

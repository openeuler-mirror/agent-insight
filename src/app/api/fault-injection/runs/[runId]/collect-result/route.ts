import {findCoreFiRun,coreFiRpc} from '@/lib/storage-core/fault-injection'
import {withCoreFiRequest} from '@/lib/storage-core/fault-injection'
import {isStorageCoreEnabled} from '@/lib/storage-core/mode'
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

import { NextResponse } from 'next/server'
import { resolveWorkerCaller } from '@/lib/reliability/worker-dual-auth'
import { prisma } from '@/lib/storage/prisma'
import type { CollectPayload } from '@/lib/fault-injection/engine'
import { persistFiCollectIngress, refreshTaskProgress } from '@/lib/fault-injection/store'

export const dynamic = 'force-dynamic'

/** True when body carries FI collect signal (markers / activation / Trace ID). */
function hasFiCollectSignal(body: Record<string, unknown>): boolean {
  if (body.faultActivated === true) return true
  if (Array.isArray(body.markers) && body.markers.length > 0) return true
  if (typeof body.taskId === 'string' && body.taskId.trim()) return true
  if (typeof body.sessionTaskId === 'string' && body.sessionTaskId.trim()) return true
  return false
}

async function handlePOST(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  try {
    // 常驻客户端用设备凭证上传结果；存量 FI Worker 仍走 API Key。
    const caller = await resolveWorkerCaller(req)
    if (!caller) {
      return NextResponse.json(
        { error: 'API key or device credential required' },
        { status: 401 },
      )
    }
    const username = caller.username
    const { runId } = await ctx.params
    const run = (await findCoreFiRun(runId))
    if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 })

    const body = await req.json()
    {
      const stopped=body.stopped===true||run.stopRequested||String(body.error||'').includes('stopped')
      const lease={runId,workerId:caller.clientId||body.workerId,claimToken:body.claimToken}
      if (stopped && (body.skipIngest || !hasFiCollectSignal(body))) {
        const {run:updated}=await coreFiRpc<{run:{status:string}}>('collect',{...lease,data:{status:'stopped',error:body.error||'stopped by user',stopRequested:true}})
        return NextResponse.json({ok:true,status:updated.status})
      }
      if (body.error && !hasFiCollectSignal(body)) {
        const {run:updated}=await coreFiRpc<{run:{status:string}}>('collect',{...lease,data:{status:stopped?'stopped':'failed',error:String(body.error)}})
        return NextResponse.json({ok:true,status:updated.status})
      }
      const rawTaskId=(typeof body.taskId==='string'&&body.taskId.trim())||(typeof body.sessionTaskId==='string'&&body.sessionTaskId.trim())||null
      const payload={runId,taskId:rawTaskId,sessionAligned:body.sessionAligned!==false,framework:body.framework||run.platform,fault:body.fault||run.fault,injectionMethod:body.injectionMethod,faultActivated:body.faultActivated,faultActivatedAt:body.faultActivatedAt,interactions:Array.isArray(body.interactions)?body.interactions:[],markers:Array.isArray(body.markers)?body.markers:[]} as CollectPayload
      const updated=await persistFiCollectIngress({...lease,user:username,payload,stopped})
      return NextResponse.json({ok:true,status:updated.status,runId:updated.runId})
    }
  } catch (err: unknown) {
    throw err
  }
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },) {
  return withCoreFiRequest(req,()=>handlePOST(req,ctx))
}

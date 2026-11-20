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

import { createHash, randomBytes } from 'crypto'
import { composeFaultPrompt, findSubmode } from '@/lib/fault-injection/compose-prompt'
import { listFaultsViaPython, type CollectPayload } from '@/lib/fault-injection/engine'

import {coreFiRpc,coreFiOwner,newCoreFiId,refreshCoreFiProgress} from '@/lib/storage-core/fault-injection'
import type {FaultInjectionTask,FaultInjectionRun} from '@prisma/client'

export function newTaskKey(): string {
  return `task-${randomBytes(4).toString('hex')}`
}

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').slice(0, 15)
  return `ras-${stamp}-${randomBytes(4).toString('hex')}`
}

export async function createTaskWithRuns(input: {
  user: string | null
  name?: string
  platform: string
  agent: string
  prompt: string
  workspace: string
  model?: string | null
  items: Array<{ fault: string; submode?: string | null }>
  timeoutSeconds?: number | null
  targetWorkerId?: string | null
  initialStatus?: 'queued' | 'running'
}, stable?: {taskKey: string; runIds: string[]}) {
  if (stable && (!/^task-[a-f0-9]{8,64}$/.test(stable.taskKey) || stable.runIds.length !== input.items.length || new Set(stable.runIds).size !== stable.runIds.length || stable.runIds.some(value => !/^ras-\d{8}T[0-9A-Za-z_-]+$/.test(value)))) throw new Error('FI stable identity is invalid')
  const stableCatalog = stable ? await listFaultsViaPython(input.platform) : undefined
  const stableHash = stable ? createHash('sha256').update(JSON.stringify({user: input.user, name: input.name || '', platform: input.platform, agent: input.agent, prompt: input.prompt, workspace: input.workspace, model: input.model || null, timeoutSeconds: input.timeoutSeconds ?? null, targetWorkerId: input.targetWorkerId || null, items: input.items, runIds: stable.runIds})).digest('hex') : undefined
  {
    const user = coreFiOwner(input.user), taskKey = stable?.taskKey || newTaskKey(), id = newCoreFiId()
    const items = input.items.map((item,index) => ({item_id:`item-${index+1}`,fault:item.fault,submode:item.submode||null,run_id:stable?.runIds[index]||newRunId(),status:'queued',phase:'queued',error:null as string|null,result:null as Record<string,unknown>|null}))
    const catalog = (stableCatalog || await listFaultsViaPython(input.platform)) as Array<{id?:string;name?:string;skillName?:string;skill_name?:string;submodes?:Array<{id:string;name:string}>}>
    const byFault = new Map(catalog.map(row => [String(row.id||row.name||''),row]))
    const task = {id,taskKey,name:input.name||`注入任务 ${taskKey}`,status:input.initialStatus||'queued',platform:input.platform,agent:input.agent,prompt:input.prompt,workspace:input.workspace,model:input.model||null,requestJson:JSON.stringify({timeoutSeconds:input.timeoutSeconds??null,...(stableHash?{coreRequestHash:stableHash}:{})}),itemsJson:JSON.stringify(items),progressJson:JSON.stringify({total:items.length,queued:items.length,running:0,completed:0,failed:0,judge_skipped:0,stopped:0}),user,startedAt:input.initialStatus==='running'?new Date():null}
    const runs = items.map(item => {
      const meta=byFault.get(item.fault),prompt=composeFaultPrompt({skillName:meta?.skillName||meta?.skill_name||item.fault,basePrompt:input.prompt,submode:findSubmode(meta?.submodes||[],item.submode)})
      return {id:newCoreFiId(),runId:item.run_id,fiTaskId:id,itemId:item.item_id,user,platform:input.platform,agent:input.agent,fault:item.fault,submode:item.submode,status:'queued',queuedAt:new Date(),requestJson:JSON.stringify({prompt,workspace:input.workspace,model:input.model||null,timeoutSeconds:input.timeoutSeconds??null,targetWorkerId:input.targetWorkerId||null})}
    })
    return coreFiRpc<{task:FaultInjectionTask;runs:FaultInjectionRun[];items:typeof items}>('create',{task,runs})
  }
}

function looksLikeFiRunId(value: string): boolean {
  return /^ras-\d{8}T[0-9a-zA-Z_-]+$/.test(value.trim())
}

function looksLikeMessageOrPartId(value: string): boolean {
  return /^(msg_|prt_)[0-9a-zA-Z_-]+$/.test(value.trim())
}

/** True when value is a bare platform session usable as FI↔RAS join key. */
export function isPlatformSessionId(value: string | null | undefined): boolean {
  if (!value || !value.trim()) return false
  const s = value.trim()
  if (looksLikeFiRunId(s) || looksLikeMessageOrPartId(s)) return false
  return true
}

/**
 * Persist FI collection facts and finish collection without invoking a Judge.
 * Business traces belong to the independent collector; experiment orchestration
 * waits for late Session/Execution uploads before starting selected evaluators.
 */
export async function persistFiCollectIngress(input: {
  runId: string
  user: string | null
  payload: CollectPayload
  stopped?: boolean
  workerId?: string
  claimToken?: string
}) {
  const rawTaskId =
    typeof input.payload.taskId === 'string' ? input.payload.taskId.trim() : ''
  const sessionAligned =
    input.payload.sessionAligned !== false && isPlatformSessionId(rawTaskId)
  const sessionTaskId = sessionAligned ? rawTaskId : null

  {
    coreFiOwner(input.user)
    const {run}=await coreFiRpc<{run:FaultInjectionRun}>('collect',{runId:input.runId,workerId:input.workerId,claimToken:input.claimToken,data:{status:input.stopped?'stopped':sessionAligned?'completed':'failed',error:input.stopped?'stopped by user':sessionAligned?null:'session_unaligned: missing platform session id (FI runId is not a RAS join key)',sessionTaskId,faultActivated:Boolean(input.payload.faultActivated),faultActivatedAt:input.payload.faultActivatedAt!=null?new Date(input.payload.faultActivatedAt):null,injectionMethod:input.payload.injectionMethod||null,markersJson:JSON.stringify((input.payload.markers||[]).filter(marker=>!marker||typeof marker!=='object'||(marker as {kind?:unknown}).kind!=='evaluation'))}})
    return run
  }
}

export async function refreshTaskProgress(taskId: string) {
  return refreshCoreFiProgress(taskId)
}

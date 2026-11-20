import {isStorageCoreEnabled} from '@/lib/storage-core/mode'
import {requireCoreExperimentContext} from '@/lib/storage-core/experiments'
import {randomUUID} from 'node:crypto'
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

import { readSavedOptions } from './runtime-options'
import { customEvaluatorsForReuse } from '@/lib/evaluators/evaluator-skill-service'
import { prisma } from '@/lib/storage/prisma'
import { createBenchmarkExperiment } from '@/lib/benchmark/experiment-service'
import { assertTraceGenerationTarget, loadTraceGenerationRetryRequest } from '@/lib/engine/experiment/trace-generation'
import { defaultExperimentName, defaultSkillExperimentName } from '@/lib/engine/experiment/experiment-name'
import { cloneWorkbenchExperimentFromFrozenConfig } from '@/lib/skill-workbench/experiment-service'

import { autoPairGroups, createComparisonExperiment } from './comparison-runner'

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

function parseObject(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export async function cloneExperimentFromFrozenConfig(input: {
  sourceExperimentId: string
  user: string
}): Promise<{ id: string; scope: string; grayscaleTaskId?: string; caseIds?: string[]; evaluatorIds?: string[] }> {
  return cloneCoreExperimentFromFrozenConfig(input)
}


async function cloneCoreExperimentFromFrozenConfig(input:{sourceExperimentId:string;user:string}):Promise<{id:string;scope:string}>{
  const context=requireCoreExperimentContext()
  if(context.actor.username!==input.user)throw Object.assign(new Error('Frozen-config clone actor differs'),{status:403})
  const row=await context.rpc('read',{experiment_id:input.sourceExperimentId}) as {experiment:Record<string,unknown>;gold_redacted?:boolean}
  if(row.gold_redacted)throw Object.assign(new Error('Frozen-config clone requires private source ownership'),{status:403})
  const source=row.experiment
  if(!source)throw Object.assign(new Error('source experiment not found'),{status:404})
  const snapshot=parseObject(typeof source.configSnapshotJson==='string'?source.configSnapshotJson:null)
  const assets=snapshot.coreAssets as {schemaVersion?:unknown;evaluators?:unknown;releases?:unknown}|undefined
  if(!assets||assets.schemaVersion!==1||!assets.evaluators||!assets.releases)throw Object.assign(new Error('Frozen core Experiment assets unavailable'),{status:409})
  if(source.scope==='skill-workbench'&&snapshot.grayscaleTaskId)return cloneWorkbenchExperimentFromFrozenConfig(input.user,String(source.id))
  if(source.scope==='benchmark')throw Object.assign(new Error('Frozen-config clone requires the matching Benchmark domain'),{status:503})
  if(source.scope==='skill-workbench'&&(snapshot.traceSource==='generate'||source.preset!=='use-case'))throw Object.assign(new Error('原 Skill 实验缺少冻结的任务配置，请通过复用同配置重新确认'),{status:409})
  const rawCases=Array.isArray(source.cases)?source.cases as Array<Record<string,unknown>>:[]
  const cases=rawCases.filter(item=>!item.deletedAt)
  const generated=snapshot.traceSource==='generate'||cases.some(item=>Boolean(item.traceGenerationCommandId))
  if(generated&&(!snapshot.executionTarget||typeof snapshot.executionTarget!=='object'))throw Object.assign(new Error('原实验缺少可复用的 Trace 生成配置'),{status:409})
  if(generated&&!snapshot.fiOrchestrate){
    const target=snapshot.executionTarget as Record<string,unknown>
    if(readSavedOptions(target.agentOptions)){
      const resolved=await assertTraceGenerationTarget({user:input.user,workerId:String(target.workerId||''),platform:String(target.platform||''),agent:String(target.agent||source.agentName||''),agentOptions:readSavedOptions(target.agentOptions)})
      snapshot.executionTarget={...target,agentOptions:resolved.agentOptions,agentParameterDefinition:resolved.definition}
    }
  }
  const groups=Array.isArray(source.groups)?source.groups as Array<Record<string,unknown>>:[]
  const groupIds=new Map(groups.map(group=>[String(group.id),randomUUID()]))
  const skillName=typeof source.skillName==='string'?source.skillName:''
  const skillVersion=typeof source.skillVersion==='number'?source.skillVersion:null
  const name=source.scope==='skill-workbench'&&skillName&&skillVersion!==null?defaultSkillExperimentName(skillName,'use-case',skillVersion):defaultExperimentName()
  if(source.scope==='skill-workbench'){
    if(!cases.length)throw Object.assign(new Error('原 Skill 实验没有可复用的 Case'),{status:409})
    snapshot.caseIds=cases.map(item=>item.executionId).filter(Boolean)
  }
  const data:Record<string,unknown>={name,type:source.type,agentName:source.agentName,evaluatorIdsJson:source.evaluatorIdsJson,evaluatorConfigsJson:source.evaluatorConfigsJson,status:'draft',scope:source.scope,skillName:source.skillName,skillVersion:source.skillVersion,preset:source.preset,skillContextJson:source.skillContextJson,configSnapshotJson:JSON.stringify(snapshot),sourceExperimentId:source.id,watchMode:source.watchMode,groups:groups.map(group=>({id:groupIds.get(String(group.id)),key:group.key,variableValue:group.variableValue})),cases:source.type==='llm'?[]:cases.map(item=>{
    const value:Record<string,unknown>={id:randomUUID(),datasetInput:null,referenceOutput:null,evaluatorContextJson:null,faultInjectionType:null,caseValuesJson:null,fiTaskId:null,fiRunId:null,traceGenerationCommandId:null,traceGenerationError:null}
    for(const key of ['input','datasetInput','referenceOutput','evaluatorContextJson','faultInjectionType','caseValuesJson','datasetBinding','rootCauses','meta'])if(Object.hasOwn(item,key))value[key]=item[key]
    value.executionId=generated?null:item.executionId??null;value.taskId=generated?null:item.taskId??null;value.actualOutput=generated?'':item.actualOutput??'';value.groupId=item.groupId?groupIds.get(String(item.groupId))||null:null
    return value
  })}
  const created=await context.rpc('create',{experiment:data}) as {experiment:{id:string}}
  if(typeof created?.experiment?.id!=='string')throw Object.assign(new Error('Frozen-config clone receipt unavailable'),{status:503})
  if(source.type==='llm')await autoPairGroups(created.experiment.id)
  return {id:created.experiment.id,scope:typeof source.scope==='string'?source.scope:''}
}

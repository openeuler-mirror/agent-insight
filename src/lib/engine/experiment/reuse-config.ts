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
  if(isStorageCoreEnabled())return cloneCoreExperimentFromFrozenConfig(input)
  const source = await prisma.experiment.findFirst({
    where: { id: input.sourceExperimentId, user: input.user },
    include: {
      cases: { orderBy: { createdAt: 'asc' } },
      groups: { orderBy: { createdAt: 'asc' } },
      benchmarkBinding: true,
    },
  })
  if (!source) throw new Error('source experiment not found')
  const evaluatorIds = parseStringArray(source.evaluatorIdsJson)
  const snapshot = parseObject(source.configSnapshotJson)
  snapshot.customEvaluatorSnapshots = await customEvaluatorsForReuse(input.user, evaluatorIds, snapshot)
  const name = source.scope === 'skill-workbench' && source.skillName && source.skillVersion != null
    ? defaultSkillExperimentName(source.skillName, 'use-case', source.skillVersion)
    : defaultExperimentName()

  if (source.scope === 'skill-workbench' && snapshot.grayscaleTaskId) {
    return cloneWorkbenchExperimentFromFrozenConfig(input.user, source.id)
  }
  if (source.scope === 'skill-workbench' && (snapshot.traceSource === 'generate' || source.preset !== 'use-case')) {
    throw new Error('原 Skill 实验缺少冻结的任务配置，请通过复用同配置重新确认')
  }

  if (source.scope === 'benchmark') {
    const binding = source.benchmarkBinding
    if (!binding) throw new Error('Benchmark 实验缺少冻结配置')
    const runConfig = parseObject(binding.runConfigJson)
    if (runConfig.submissionSource === 'imported') throw new Error('历史导入提交实验不支持复用配置')
    const selection = parseObject(binding.selectionJson)
    const result = await createBenchmarkExperiment({
      frozenCustomEvaluators: await customEvaluatorsForReuse(input.user, evaluatorIds, snapshot),
      user: input.user,
      name,
      agentName: source.agentName,
      datasetId: binding.datasetId,
      agentEvalDatasetId: typeof snapshot.agentEvalDatasetId === 'string'
        ? snapshot.agentEvalDatasetId
        : undefined,
      caseSelection: selection.mode === 'explicit' && Array.isArray(selection.caseIds)
        ? { mode: 'explicit', caseIds: selection.caseIds.map(String) }
        : { mode: 'all' },
      clientId: String(snapshot.clientId || ''),
      evaluatorIds,
      runConfig: {
        platform: String(runConfig.platform || ''),
        agent: String(runConfig.agent || source.agentName),
        agentOptions: readSavedOptions(runConfig.agentOptions),
        model: typeof runConfig.model === 'string' ? runConfig.model : undefined,
        agentTimeoutSeconds: Number(runConfig.timeoutSeconds) || undefined,
        executionConcurrency: Number(runConfig.executionConcurrency) || 1,
        maxParallelAgentCases: 1,
      },
    })
    await prisma.experiment.update({
      where: { id: result.id },
      data: { sourceExperimentId: source.id, evaluatorConfigsJson: source.evaluatorConfigsJson },
    })
    return { id: result.id, scope: 'benchmark' }
  }

  if (source.type === 'llm') {
    const created = await createComparisonExperiment({
      frozenCustomEvaluators: await customEvaluatorsForReuse(input.user, evaluatorIds, snapshot),
      user: input.user,
      name,
      agentName: source.agentName,
      variableDimension: 'llm',
      groups: source.groups.map((group: { key: string; variableValue: string }) => ({ key: group.key, value: group.variableValue })),
      evaluatorIds,
    })
    await prisma.experiment.update({
      where: { id: created.id },
      data: {
        sourceExperimentId: source.id,
        configSnapshotJson: JSON.stringify(snapshot),
        evaluatorConfigsJson: source.evaluatorConfigsJson,
      },
    })
    await autoPairGroups(created.id)
    return { id: created.id, scope: source.scope }
  }

  const traceSource = snapshot.traceSource === 'generate'
    || source.cases.some((item: { traceGenerationCommandId: string | null }) => Boolean(item.traceGenerationCommandId))
    ? 'generate'
    : 'existing'
  if (traceSource === 'generate' && (!snapshot.executionTarget || typeof snapshot.executionTarget !== 'object')) {
    const generatedCase = source.cases.find((item: { id: string; traceGenerationCommandId: string | null }) => Boolean(item.traceGenerationCommandId))
    if (!generatedCase) throw new Error('原实验缺少可复用的 Trace 生成配置')
    const request = await loadTraceGenerationRetryRequest({
      user: input.user,
      experimentId: source.id,
      caseId: generatedCase.id,
    })
    if (!request) throw new Error('原实验缺少可复用的 Trace 生成配置')
    snapshot.traceSource = 'generate'
    snapshot.agentName = source.agentName
    snapshot.executionTarget = {
      workerId: request.workerId,
      platform: request.platform,
      model: request.model,
      timeoutSeconds: request.timeoutSeconds,
    }
  }
  if (traceSource === 'generate' && !snapshot.fiOrchestrate) {
    const target = snapshot.executionTarget as Record<string, unknown> | undefined
    if (target && readSavedOptions(target.agentOptions)) {
      const resolved = await assertTraceGenerationTarget({ user: input.user, workerId: String(target.workerId || ''),
        platform: String(target.platform || ''), agent: String(target.agent || source.agentName),
        agentOptions: readSavedOptions(target.agentOptions) })
      snapshot.executionTarget = { ...target, agentOptions: resolved.agentOptions, agentParameterDefinition: resolved.definition }
    }
  }
  const activeCases = source.cases.filter((item: { deletedAt: Date | null }) => !item.deletedAt)
  if (source.scope === 'skill-workbench') {
    if (!activeCases.length) throw new Error('原 Skill 实验没有可复用的 Case')
    snapshot.caseIds = activeCases.map((item: { executionId: string | null }) => item.executionId).filter(Boolean)
  }
  const created = await prisma.experiment.create({
    data: {
      user: input.user,
      name,
      type: source.type,
      agentName: source.agentName,
      evaluatorIdsJson: source.evaluatorIdsJson,
      evaluatorConfigsJson: source.evaluatorConfigsJson,
      status: 'draft',
      scope: source.scope,
      skillName: source.skillName,
      skillVersion: source.skillVersion,
      preset: source.preset,
      skillContextJson: source.skillContextJson,
      configSnapshotJson: JSON.stringify(snapshot),
      sourceExperimentId: source.id,
      watchMode: source.watchMode,
      watchEnabledAt: source.watchMode ? new Date() : null,
      cases: {
        create: activeCases.map((item: {
          executionId: string | null
          taskId: string | null
          input: string
          datasetInput: string | null
          actualOutput: string
          referenceOutput: string | null
          evaluatorContextJson: string | null
          faultInjectionType: string | null
          caseValuesJson: string | null
        }) => ({
          executionId: traceSource === 'existing' ? item.executionId : null,
          taskId: traceSource === 'existing' ? item.taskId : null,
          input: item.input,
          datasetInput: item.datasetInput,
          actualOutput: traceSource === 'existing' ? item.actualOutput : '',
          referenceOutput: item.referenceOutput,
          evaluatorContextJson: item.evaluatorContextJson,
          faultInjectionType: item.faultInjectionType,
          caseValuesJson: item.caseValuesJson,
        })),
      },
    },
    select: { id: true },
  })
  return { id: created.id, scope: source.scope }
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

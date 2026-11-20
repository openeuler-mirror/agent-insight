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

import type { DatasetCase } from '@/server/agent_datasets_storage';
import { readExperimentDatasetCaseBinding, withExperimentDatasetCaseBinding } from '@/lib/engine/experiment/dataset-case-binding';
import { prismaRaw } from '@/lib/storage/prisma';
import {createHash} from 'node:crypto';
import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {requireWorkbenchActor} from '@/lib/storage-core/workbench';
import {activeCoreWorkbenchCancellations} from '@/lib/storage-core/workbench-results';

export function triggerExperimentCaseData(experimentId: string, datasetId: string, cases: Pick<DatasetCase, 'id' | 'input' | 'values'>[]) {
  return cases.map((item) => ({
    experimentId,
    input: item.input,
    datasetInput: item.input || null,
    actualOutput: '',
    referenceOutput: item.values?.should_trigger === true ? 'Skill 应触发' : 'Skill 不应触发',
    caseValuesJson: JSON.stringify(withExperimentDatasetCaseBinding({
      ...(item.values || {}), should_trigger: item.values?.should_trigger === true,
    }, { datasetId, caseId: item.id })),
  }));
}

export function shouldStopTriggerBatch(failureCode: string | null | undefined): boolean {
  return ['MODEL_UNAVAILABLE', 'MODEL_MISMATCH', 'CLIENT_MISMATCH', 'SKILL_ISOLATION_UNAVAILABLE', 'MODEL_CONFIGURATION_UNREADABLE', 'MODEL_CONFIGURATION_MISSING'].includes(failureCode || '');
}

export async function ensureTriggerExperimentCases(user: string, experimentId: string, datasetId: string, cases: Pick<DatasetCase, 'id' | 'input' | 'values'>[]) {
  {
    const context=requireWorkbenchActor(user);
    const snapshot=await context.rpc('read',{experiment_id:experimentId}) as {gold_redacted?:boolean;experiment:{status:string;deletedAt?:string;coreActiveCancellationIds?:string[];cases:Array<{id:string;caseValuesJson:string;deletedAt?:string}>;cancellations:Array<{id?:string;caseKey:string}>}};
    if(snapshot.gold_redacted)throw Object.assign(new Error('Task-linked Experiment belongs to another actor'),{status:403});
    const experiment=snapshot.experiment;const excluded=new Set(activeCoreWorkbenchCancellations(experiment).map(row=>row.caseKey));
    if(experiment.deletedAt||experiment.status==='cancelled'||excluded.has(''))throw Object.assign(new Error('实验已取消'),{code:'EXPERIMENT_CANCELLED',status:409});
    const bindings=new Map<string,string>();
    for(const row of experiment.cases){const binding=readExperimentDatasetCaseBinding(JSON.parse(row.caseValuesJson||'{}'));if(binding?.datasetId!==datasetId)continue;if(row.deletedAt||excluded.has(row.id))excluded.add('dataset:'+binding.caseId);else bindings.set(binding.caseId,row.id);}
    const active=cases.filter(row=>!excluded.has('dataset:'+row.id));const missing=active.filter(row=>!bindings.has(row.id));
    if(missing.length){
      const records=triggerExperimentCaseData(experimentId,datasetId,missing).map((data,index)=>({...data,id:'trigger-case-'+createHash('sha256').update(JSON.stringify([context.actor.workspace,context.actor.principal,experimentId,datasetId,missing[index].id])).digest('hex').slice(0,40)}));
      const payload={experiment_id:experimentId,cases:records,skip_deleted:true};const receipt=await context.rpc('case_upsert_many',{...payload,operation_key:context.operationKey+':trigger-cases',operation_request:payload}) as {case_ids:string[]};
      const accepted=new Set(receipt.case_ids);records.forEach((row,index)=>{if(accepted.has(row.id))bindings.set(missing[index].id,row.id);});
    }
    return new Map(active.filter(row=>bindings.has(row.id)).map(row=>[row.id,bindings.get(row.id)!]));
  }
}

export interface TriggerExecutionObservation {
  invokedSkills?: string | null;
  skills?: string | null;
}

function namesFromJson(value: string | null | undefined): string[] | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((item) => {
      const name = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as { name?: unknown }).name : null;
      return typeof name === 'string' && name.trim() ? [name.trim()] : [];
    });
  } catch { return null; }
}

export function classifyTriggerExecution(execution: TriggerExecutionObservation, targetSkillName: string) {
  const invoked = namesFromJson(execution.invokedSkills) ?? namesFromJson(execution.skills);
  if (!invoked) throw new Error('Trace 未记录 Skill 调用信息，无法判断是否触发');
  return {
    triggered: invoked.includes(targetSkillName),
    competingSkill: invoked.find((name) => name !== targetSkillName) || null,
  };
}

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

import { prisma } from '@/lib/storage/prisma';
import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {requireCoreExperimentContext} from '@/lib/storage-core/experiments';
import {projectCoreWorkbenchTaskStates,type WorkbenchCoreSnapshot,type WorkbenchProjectedStates} from '@/lib/storage-core/workbench-results';

export async function visibleExperimentTask<T extends {user?:string; configJson?: object; caseStatesJson?: object }>(task: T): Promise<T | null> {
  const experimentId = (task.configJson as { evalExperimentId?: unknown } | undefined)?.evalExperimentId;
  if (typeof experimentId !== 'string' || !experimentId) return task;
  {
    const context=requireCoreExperimentContext();if(task.user!==context.actor.username)throw Object.assign(new Error('Task actor differs'),{status:403});
    const snapshot=await context.rpc('read',{experiment_id:experimentId}) as {gold_redacted?:boolean;experiment:WorkbenchCoreSnapshot&{deletedAt?:string}};
    if(snapshot.gold_redacted)throw Object.assign(new Error('Task-linked Experiment belongs to another actor'),{status:403});
    if(snapshot.experiment.deletedAt)return null;
    return {...task,caseStatesJson:projectCoreWorkbenchTaskStates(snapshot.experiment,(task.caseStatesJson||{}) as WorkbenchProjectedStates)};
  }
}

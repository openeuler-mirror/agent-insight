import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {requireCoreExperimentContext} from '@/lib/storage-core/experiments';
import {cancelCoreExperimentExecution,reconcileCoreCancellation} from '@/lib/storage-core/experiment-cancellation';
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

import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/storage/prisma';
import { createCommand, markSent } from '@/lib/reliability/command-bus';
import { dispatchCommand } from '@/lib/reliability/control-dispatch';

type Target = {
  kind: 'ordinary' | 'benchmark' | 'evaluation' | 'local';
  runId: string; clientId?: string; baseUrl?: string; requestDigest?: string;
  commandId?: string; confirmed?: boolean; error?: string;
};
const terminalRun = ['completed', 'evaluated', 'blocked', 'execution_failed', 'evaluation_failed', 'dispatch_failed', 'submission_invalid', 'cancelled'];
const terminalEvaluation = ['completed', 'failed', 'normalization_failed', 'submission_invalid', 'cancelled'];

export async function deleteExperimentExecution(user: string, experimentId: string, caseId?: string) {
  {
    const context=requireCoreExperimentContext();if(user!==context.actor.username)throw Object.assign(new Error('Cancellation actor differs'),{status:403});
    return cancelCoreExperimentExecution(context,experimentId,{...(caseId?{caseId}:{deleteExperiment:true})});
  }
}

const reconciling = new Map<string, Promise<unknown>>();
export async function reconcileCancellation(id: string): Promise<any> {
  return reconcileCoreCancellation(requireCoreExperimentContext(),id);
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startExperimentCancellationWatchdog() {
  {void import('@/lib/storage-core/experiment-background').then(({startCoreExperimentBackground})=>startCoreExperimentBackground()).catch(()=>console.warn('[storage-core-background] cancellation startup unavailable'));return;}
}

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
import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {getCoreExperimentContext,requireCoreExperimentContext,withCoreExperimentMutationRoute} from '@/lib/storage-core/experiments';
import { markUserTerminated } from '@/server/user_termination_registry';
import { abortTrajectoryEvalRunsForUser } from '@/server/trajectory_eval_run_registry';
import { killOpencodeForUser } from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager';
import { abortBatchRunsForUser } from '@/server/batch_eval_run_registry';
import { prismaRaw } from '@/lib/storage/prisma';

/**
 * POST /api/eval/terminate-all  body: { user }
 *
 * 「终止全部」——把**该 user 自己**当前在跑的执行 + 评测全部停下(严格按 user 隔离,不碰别人/别的平台任务)。
 * 组合拳:
 *   1) markUserTerminated:choke-point 标记。后台 opencode 统一入口(withBackgroundOpencodeSlot)拿到 slot 后,
 *      凡在此刻之前入队、属于该 user 的任务一律中止 —— 挡住"排队中/即将起"的执行 case 与评测裁判。
 *   2) killOpencodeForUser:SIGKILL 该 user 在跑的后台 opencode 进程组(执行 agent + 评测裁判都是 opencode),
 *      硬停"已经在飞"的。
 *   3) abortTrajectoryEvalRunsForUser:abort 评测 run 的派发/重试循环(防止杀掉后又重试重启)。
 *   4) abortBatchRunsForUser:abort 执行批次循环 + 重置其残留 case。
 *   5) DB 兜底:把该 user 仍 running/pending 的评测行(含进程重启后无 controller 的僵尸)置失败「已终止」。
 */
export async function POST(request: Request) {
    if(isStorageCoreEnabled()&&!getCoreExperimentContext()?.compatibilityRoute)return withCoreExperimentMutationRoute(request,POST);
    try {
        const body = await request.json().catch(() => ({}));
        const user = (requireCoreExperimentContext().actor.username);
        if (!user) return NextResponse.json({ error: 'user is required' }, { status: 400 });

        let cancelledEvalRows = 0;
        {
            const context=requireCoreExperimentContext();
            const value=await context.rpc('read_view',{scope:'trajectory-direct'}) as {coverage:string;snapshots:Array<{experiment:{id:string;user:string;cases:Array<{directTrajectory?:{status:string};results:Array<{status:string}>}>}}>};
            if(value?.coverage!=='complete'||!Array.isArray(value.snapshots))throw Object.assign(new Error('Complete direct evaluation snapshot required'),{status:503});
            for(const snapshot of value.snapshots){
                if(snapshot.experiment.user!==context.actor.username)continue;
                const active=snapshot.experiment.cases.filter(item=>{const status=item.results.some(row=>row.status==='pending'||row.status==='running')?'running':item.results[0]?.status||item.directTrajectory?.status;return status==='pending'||status==='running';});
                if(!active.length)continue;
                const payload={experiment_id:snapshot.experiment.id};await context.rpc('cancel',{...payload,operation_key:context.operationKey+':direct-cancel:'+snapshot.experiment.id,operation_request:payload});cancelledEvalRows+=active.length;
            }
        }
        markUserTerminated(user);
        const killedOpencode = killOpencodeForUser(user);
        const abortedEvalRuns = abortTrajectoryEvalRunsForUser(user);
        const batch = await abortBatchRunsForUser(user);



        console.warn(
            `[terminate-all] user=${user} killedOpencode=${killedOpencode} evalRuns=${abortedEvalRuns} ` +
            `batchRuns=${batch.abortedRuns} resetCases=${batch.resetCases} cancelledEvalRows=${cancelledEvalRows}`,
        );
        return NextResponse.json({
            ok: true,
            killedOpencode,
            abortedEvalRuns,
            abortedBatchRuns: batch.abortedRuns,
            resetCases: batch.resetCases,
            cancelledEvalRows,
        });
    } catch (e) {
        const message = e instanceof Error ? e.message : 'terminate-all failed';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

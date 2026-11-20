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
import {getActiveCoreCollectorIdentity} from '@/lib/storage-core/collector-identity';
import {getCollectorEffect} from '@/lib/storage-core/collector-effect';
import {collectorPrivate,mutateCoreCollectorSession} from '@/lib/storage-core/collector-entry';
import { db } from '@/lib/storage/prisma';

export interface SessionData {
    taskId: string;
    label?: string;
    query?: string;
    startTime: number;
    interactions: {
        requestMessages: any[];
        responseMessage: any;
        usage: {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
        };
        latency: number;
        timestamp: number;
        toolCalls: any[];
    }[];
    user?: string;
    model?: string;
}

export async function startSession(taskId: string, label?: string, query?: string, user?: string, model?: string) {
    {const identity=requireIdentity();return sessionData(await mutateCoreCollectorSession(identity,taskId,{label:label??null,query:query??null,model:model??null,startTime:'server',interactions:[]},'create','proxy-start:'+taskId));}
}

export async function addToSession(taskId: string, interaction: SessionData['interactions'][0]) {
    {const identity=requireIdentity();return sessionData(await mutateCoreCollectorSession(identity,taskId,{interaction},'append'));}
}

export async function endSession(taskId: string): Promise<SessionData | null> {
    {const effect=getCollectorEffect();if(effect?.session){await effect.check();return sessionData(effect.session);}
        const identity=requireIdentity();const row=await collectorPrivate(identity,'owned_session',{task_id:taskId});if(!row)return null;return sessionData(await mutateCoreCollectorSession(identity,taskId,{endTime:'server'},'patch','proxy-end:'+taskId));}
}

export async function getSession(taskId: string): Promise<SessionData | null> {
    {const identity=requireIdentity();const row=await collectorPrivate(identity,'owned_session',{task_id:taskId});return row?.session_json?sessionData(JSON.parse(row.session_json)):null;}
}

function requireIdentity(){const identity=getActiveCoreCollectorIdentity();if(!identity)throw Object.assign(new Error('Verified proxy collector required'),{status:403});return identity;}
function sessionData(row:Record<string,any>):SessionData{return {...row,startTime:new Date(row.startTime).getTime(),interactions:Array.isArray(row.interactions)?row.interactions:JSON.parse(row.interactions||'[]') } as SessionData;}
export async function patchProxySession(taskId:string,changes:Record<string,any>){return mutateCoreCollectorSession(requireIdentity(),taskId,changes);}

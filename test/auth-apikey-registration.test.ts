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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {startIsolatedControlCore} from './helpers/isolated-control-core';
import {withCoreControlRequest} from '@/lib/storage-core/control-context';
import {bootstrapCoreControlUser} from '@/lib/storage-core/control-auth';

let core: Awaited<ReturnType<typeof startIsolatedControlCore>>;
let POST: (request:Request)=>Promise<Response>;
let prisma: typeof import('@/lib/storage/prisma').prisma;
const usernames={seed:'registration-seed',casing:'registration-case',race:'registration-race@example.com'};
const idaasUsername='Employee-UUID-ABCDEF';
const request=(token:string)=>new Request('http://localhost/internal/registration',{headers:{authorization:'Bearer '+token}});
const register=(username:string)=>POST(new Request('http://localhost/api/auth/apikey',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username})}));

test.before(async()=>{
 core=await startIsolatedControlCore(['fixture-owner'],{worker:true});
 process.env.LOGIN_MODE='standalone';delete process.env.ORGANIZATION_MODE;
 ({POST}=await import('@/app/api/auth/apikey/route'));
 ({prisma}=await import('@/lib/storage/prisma'));
});
test.after(async()=>{
 assert.equal(fs.existsSync(path.join(core.root,'witty_insight.db')),false);
 await core.dispose();
});

test('首次注册通过 Core 创建账号，不注入内置示例数据',async()=>{
 const response=await register(usernames.seed);assert.equal(response.status,200);
 const {apiKey}=await response.json();
 const counts=await withCoreControlRequest(request(apiKey),async()=>Promise.all([
  prisma.registeredAgent.count({where:{user:usernames.seed}}),
  prisma.skill.count({where:{user:usernames.seed}}),
  prisma.skillVersion.count({where:{Skill:{user:usernames.seed}}}),
 ]));
 assert.deepEqual(counts,[0,0,0]);
 const {GET:datasets}=await import('@/app/api/agent-datasets/route');
 const data=await datasets(new Request('http://localhost/api/agent-datasets',{headers:{authorization:'Bearer '+apiKey}}));
 assert.equal(data.status,200);const datasetBody=await data.json();assert.equal(datasetBody.length,1);assert.ok(datasetBody.every((row: {name:string})=>row.name!=='messages 日志分析（内置示例）'));
 const {GET:traces}=await import('@/app/api/observe/data/route');
 const traceResponse=await traces(new Request('http://localhost/api/observe/data?paginated=1&page=1&pageSize=20&listPart=records',{headers:{authorization:'Bearer '+apiKey}}));
 assert.equal(traceResponse.status,200,await traceResponse.clone().text());
 const page=await traceResponse.json();assert.equal(page.records.length,0);assert.equal(page.hasMore,false);
});

test('用户名大小写归一到同一用户和同一 API key',async()=>{
 const first=await register(usernames.casing.toUpperCase()),second=await register(usernames.casing);
 assert.equal(first.status,200);assert.equal(second.status,200);
 const a=await first.json(),b=await second.json();assert.equal(a.username,usernames.casing);assert.equal(b.username,usernames.casing);assert.equal(a.apiKey,b.apiKey);
 assert.equal(await withCoreControlRequest(request(a.apiKey),()=>prisma.user.count({where:{username:usernames.casing}})),1);
});

test('10 路并发首次注册全部成功并返回同一 API key',async()=>{
 const responses=await Promise.all(Array.from({length:10},()=>register(usernames.race)));
 assert.deepEqual(responses.map(row=>row.status),Array(10).fill(200));
 const bodies=await Promise.all(responses.map(row=>row.json()));assert.equal(new Set(bodies.map(row=>row.apiKey)).size,1);
 assert.equal(await withCoreControlRequest(request(bodies[0].apiKey),()=>prisma.user.count({where:{username:usernames.race}})),1);
});

test('看起来像邮箱但格式非法的用户名返回 400',async()=>{
 const response=await register('invalid@domain');assert.equal(response.status,400);
 assert.deepEqual(await response.json(),{error:'Username must be a valid email address'});
});

test('IDaaS 恢复登录保持 UUID 大小写并拒绝其他用户的凭据',async()=>{
 const user=await bootstrapCoreControlUser(idaasUsername);
 process.env.LOGIN_MODE='idaas_oauth';process.env.IDAAS_REGION_ACCESS_ENABLED='false';
 try {
  const restore=(token:string)=>POST(new Request('http://localhost/api/auth/apikey',{method:'POST',headers:{'content-type':'application/json','x-witty-api-key':token},body:JSON.stringify({username:'  '+idaasUsername+'  '})}));
  const response=await restore(user.apiKey);assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{username:idaasUsername,apiKey:user.apiKey,displayName:idaasUsername});
  assert.equal((await restore(core.tokens['fixture-owner'])).status,401);
 } finally {process.env.LOGIN_MODE='standalone';delete process.env.IDAAS_REGION_ACCESS_ENABLED;}
});

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

// 接入源注册表 CRUD。endpoint 由 normalizeEndpoint 归一作主键（裸机源=scheme://host:port，
// 网关托管源保留实例路径）。authHeaders 含明文凭证 → GET 一律脱敏后返回。

import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {hasCoreInfraContext,withCoreInfraRequest} from '@/lib/storage-core/infra';
import { NextResponse } from 'next/server';

import { redactSource, toAuthHeadersJson } from '@/lib/infra/auth-headers';
import { ensureSource,listInfraSources,updateInfraSource,deleteInfraSource } from '@/lib/infra/store';
import { metricsUrl, normalizeEndpoint } from '@/lib/ingest/vllm/scrape';

export const dynamic = 'force-dynamic';

export async function GET(req?:Request):Promise<Response> {
  if(isStorageCoreEnabled()&&!hasCoreInfraContext())return withCoreInfraRequest(req||new Request('http://localhost/api/observe/infra'),()=>GET(req));
  const sources = await listInfraSources();
  // legacy 路由无鉴权，两个模式都只返回凭证摘要。
  return NextResponse.json({ sources: sources.map(redactSource) });
}

export async function POST(req: Request):Promise<Response> {
  if(isStorageCoreEnabled()&&!hasCoreInfraContext())return withCoreInfraRequest(req,()=>POST(req));
  try {
    const body = await req.json();
    if (!body?.endpoint) {
      return NextResponse.json({ error: 'Missing endpoint' }, { status: 400 });
    }
    const endpoint = normalizeEndpoint(body.endpoint);
    const src = await ensureSource({
      endpoint,
      // 兜底必须从用户填的原始 URL 推，不能用归一后的 endpoint —— 后者已经把实例路径剥掉了，
      // 拼出来的 `${endpoint}/metrics` 对网关托管的源是个不存在的地址。
      scrapeUrl: body.scrapeUrl || metricsUrl(body.endpoint),
      kind: body.kind === 'push' ? 'push' : 'pull',
      model: body.model ?? null,
      hardwareName: body.hardwareName ?? null,
      memBandwidthGBs: body.memBandwidthGBs != null ? Number(body.memBandwidthGBs) : null,
      scrapeIntervalMs: body.scrapeIntervalMs != null ? Number(body.scrapeIntervalMs) : undefined,
      authHeaders: toAuthHeadersJson(body.authHeaders),
    });
    return NextResponse.json({ source: redactSource(src) });
  } catch (err) {
    if(isStorageCoreEnabled()&&err&&typeof err==='object'&&'status' in err&&[401,403,409,503].includes(Number(err.status)))throw err;
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ status: 'error', message }, { status: 400 });
  }
}

export async function PATCH(req: Request):Promise<Response> {
  if(isStorageCoreEnabled()&&!hasCoreInfraContext())return withCoreInfraRequest(req,()=>PATCH(req));
  try {
    const body = await req.json();
    if (!body?.id) {
      return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    }
    const data: Record<string, unknown> = {};
    if (body.kind === 'pull' || body.kind === 'push') data.kind = body.kind;
    if (body.scrapeIntervalMs != null) {
      const ms = Number(body.scrapeIntervalMs);
      if (!Number.isFinite(ms) || ms < 1000) {
        return NextResponse.json({ error: 'scrapeIntervalMs 需 >= 1000' }, { status: 400 });
      }
      data.scrapeIntervalMs = ms;
    }
    if (typeof body.enabled === 'boolean') data.enabled = body.enabled;
    if (body.scrapeUrl != null) data.scrapeUrl = String(body.scrapeUrl);
    if (body.hardwareName !== undefined) data.hardwareName = body.hardwareName || null;
    if (body.memBandwidthGBs !== undefined) {
      data.memBandwidthGBs = body.memBandwidthGBs != null ? Number(body.memBandwidthGBs) : null;
    }
    if (body.model !== undefined) data.model = body.model || null;
    // undefined = 不改（前端不回填真值，所以「没动那个框」不能把已存的凭证抹掉）；
    // '' / null = 显式清除。
    const nextAuth = toAuthHeadersJson(body.authHeaders);
    if (nextAuth !== undefined) data.authHeaders = nextAuth;

    const source = await updateInfraSource(body.id,data);
    return NextResponse.json({ source: redactSource(source) });
  } catch (err) {
    if(isStorageCoreEnabled()&&err&&typeof err==='object'&&'status' in err&&[401,403,409,503].includes(Number(err.status)))throw err;
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ status: 'error', message }, { status: 400 });
  }
}

export async function DELETE(req: Request):Promise<Response> {
  if(isStorageCoreEnabled()&&!hasCoreInfraContext())return withCoreInfraRequest(req,()=>DELETE(req));
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  const endpoint = searchParams.get('endpoint');
  if (!id && !endpoint) {
    return NextResponse.json({ error: 'Provide id or endpoint' }, { status: 400 });
  }
  const count=await deleteInfraSource(id?{id}:{endpoint:endpoint as string});
  return NextResponse.json({ deleted: count });
}

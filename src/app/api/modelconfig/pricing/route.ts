import {getCoreControlContext,withCoreControlRequest} from '@/lib/storage-core/control-context';
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

// 模型单价配置端点。
// GET：返回内置价(只读兜底) + 自定义价 + 链路里出现过的模型(有价/缺价) + 当前用户是否管理员。
// PUT：仅管理员可写(env AGENT_INSIGHT_ADMIN_USERS 白名单),覆写 custom-models.json。
import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { isAdminUser } from '@/lib/auth/admin';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { isStorageCoreEnabled } from '@/lib/storage-core/mode';
import { readCoreObservedModels } from '@/lib/storage-core/observed-models';
import { compatibilityFailure } from '@/lib/storage-core/compat';
import {
    BUILTIN_MODEL_PRICING, BUILTIN_CONTEXT_WINDOWS,
    getCustomModels, writeCustomModels, getModelPricing,
    type CustomModelEntry,
} from '@/lib/shared/model-config';

export const dynamic = 'force-dynamic';

function toRow(key: string, p: { inputTokenPrice: number; outputTokenPrice: number; cacheReadInputTokenPrice?: number; cacheCreationInputTokenPrice?: number }, cw?: number) {
    return {
        key,
        inputTokenPrice: p.inputTokenPrice,
        outputTokenPrice: p.outputTokenPrice,
        cacheReadInputTokenPrice: p.cacheReadInputTokenPrice ?? null,
        cacheCreationInputTokenPrice: p.cacheCreationInputTokenPrice ?? null,
        contextWindow: cw ?? null,
    };
}

export async function GET(req: Request) {
    try {
        const identity = await readCoreObservedModels(req);
        const { username } = identity;
        const isAdmin = isAdminUser(username);

        const { pricing: custom, contextWindows: customCw } = getCustomModels();

        // 过滤占位模型名（trace 没带真实模型名时被记成 unknown 等），这些无法/无需配价。
        const IGNORED_MODELS = new Set(['unknown', 'null', 'undefined', 'none', 'n/a']);
        const names = identity.models;
        const trimmed = names.map((model) => model.trim());
        const observed = (([...new Set(trimmed)]))
            .filter((m) => m && !IGNORED_MODELS.has(m.toLowerCase()))
            .sort()
            .map((model) => {
                const pr = getModelPricing(model);
                return { model, hasPricing: pr != null, source: pr?.source ?? null };
            });

        return NextResponse.json({
            isAdmin,
            currency: 'USD',
            builtin: Object.entries(BUILTIN_MODEL_PRICING).map(([k, p]) => toRow(k, p, BUILTIN_CONTEXT_WINDOWS[k])),
            custom: Object.entries(custom).map(([k, p]) => toRow(k, p, customCw[k])),
            observed,
        });
    } catch (error) {
        return compatibilityFailure(error);
    }
}

export async function PUT(req: Request):Promise<Response> {
    if(isStorageCoreEnabled()&&!getCoreControlContext())return withCoreControlRequest(req,()=>PUT(req));
    try {
        const url = new URL(req.url);
        const { username } = await resolveUser(req, url.searchParams.get('user'));
        if (!isAdminUser(username)) {
            return NextResponse.json({ error: '无权限：模型单价仅管理员可修改（部署时配置 AGENT_INSIGHT_ADMIN_USERS）' }, { status: 403 });
        }

        const body = (await req.json()) as { custom?: Record<string, unknown> };
        const input = body?.custom;
        if (!input || typeof input !== 'object') {
            return NextResponse.json({ error: '请求体缺少 custom 对象' }, { status: 400 });
        }

        const clean: Record<string, CustomModelEntry> = {};
        for (const [key, raw] of Object.entries(input)) {
            const k = key.trim();
            if (!k || k.startsWith('_')) continue;
            const v = (raw ?? {}) as Record<string, unknown>;
            const inp = Number(v.inputTokenPrice);
            const out = Number(v.outputTokenPrice);
            if (!Number.isFinite(inp) || inp < 0 || !Number.isFinite(out) || out < 0) {
                return NextResponse.json({ error: `模型「${k}」的 input/output 单价必须为 ≥0 的数字` }, { status: 400 });
            }
            const entry: CustomModelEntry = { inputTokenPrice: inp, outputTokenPrice: out };
            const cr = v.cacheReadInputTokenPrice;
            const cc = v.cacheCreationInputTokenPrice;
            const cw = v.contextWindow;
            if (cr !== undefined && cr !== null && cr !== '') { const n = Number(cr); if (Number.isFinite(n) && n >= 0) entry.cacheReadInputTokenPrice = n; }
            if (cc !== undefined && cc !== null && cc !== '') { const n = Number(cc); if (Number.isFinite(n) && n >= 0) entry.cacheCreationInputTokenPrice = n; }
            if (cw !== undefined && cw !== null && cw !== '') { const n = Number(cw); if (Number.isFinite(n) && n > 0) entry.contextWindow = Math.round(n); }
            clean[k] = entry;
        }

        writeCustomModels(clean);
        recordUsageEvent({ user: username, featureKey: 'model-registry', eventKey: 'model.pricing.save' });

        return NextResponse.json({ ok: true, count: Object.keys(clean).length });
    } catch (error) {
        console.error('[ModelPricing PUT]', error);
        return NextResponse.json({ error: 'Failed to save model pricing' }, { status: 500 });
    }
}

import { NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import { isClientSubmittable } from '@/lib/usage-analytics/catalog';
import { MAX_CLIENT_BATCH, MAX_EVENT_ID_LENGTH, MAX_KEY_LENGTH, isUsageEnabled } from '@/lib/usage-analytics/config';
import { normalizeRoute } from '@/lib/usage-analytics/collector';
import { toDateKey } from '@/lib/usage-analytics/date';
import { getUsageQueue } from '@/lib/usage-analytics/queue';
import type { UsageEvent, UsageEventInput } from '@/lib/usage-analytics/types';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    if (!isUsageEnabled()) {
        return NextResponse.json({ accepted: 0, dropped: 0 }, { status: 202 });
    }

    // 身份只从 API Key 解析；body 里的任何 user 字段一律忽略。
    const { username } = await resolveUser(request);
    if (!username) {
        return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }

    const rawEvents = (body as { events?: unknown })?.events;
    if (!Array.isArray(rawEvents)) {
        return NextResponse.json({ error: 'events must be an array' }, { status: 400 });
    }
    if (rawEvents.length > MAX_CLIENT_BATCH) {
        return NextResponse.json({ error: `batch exceeds ${MAX_CLIENT_BATCH}` }, { status: 400 });
    }

    const queue = getUsageQueue();
    let accepted = 0;
    let dropped = 0;

    for (const raw of rawEvents as UsageEventInput[]) {
        const parsed = parseClientEvent(raw, username);
        if (!parsed) {
            dropped++;
            continue;
        }
        if (queue?.enqueue(parsed)) accepted++;
        else dropped++;
    }

    // 达到上限时返回 202 + dropped，而不是 429 —— 避免客户端重试风暴，也绝不影响业务页面。
    return NextResponse.json({ accepted, dropped }, { status: 202 });
}

function parseClientEvent(raw: UsageEventInput, user: string): UsageEvent | null {
    if (!raw || typeof raw !== 'object') return null;

    const { eventId, occurredAt, featureKey, eventKey, route } = raw;
    if (typeof eventId !== 'string' || !eventId || eventId.length > MAX_EVENT_ID_LENGTH) return null;
    if (typeof featureKey !== 'string' || featureKey.length > MAX_KEY_LENGTH) return null;
    if (typeof eventKey !== 'string' || eventKey.length > MAX_KEY_LENGTH) return null;

    // 客户端只能提交注册表中 source='client' 的事件；服务端事件不可由浏览器伪造。
    if (!isClientSubmittable(featureKey, eventKey)) return null;

    const at = occurredAt ? new Date(occurredAt) : new Date();
    if (Number.isNaN(at.getTime())) return null;

    return {
        eventId,
        occurredAt: at,
        dateKey: toDateKey(at),
        user,
        featureKey,
        eventKey,
        source: 'client',
        route: normalizeRoute(route),
    };
}

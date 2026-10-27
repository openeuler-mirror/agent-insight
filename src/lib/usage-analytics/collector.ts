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

import { randomUUID } from 'crypto';

import { isValidEvent } from './catalog';
import { MAX_KEY_LENGTH, MAX_ROUTE_LENGTH, MAX_USER_LENGTH, isUsageEnabled } from './config';
import { toDateKey } from './date';
import { getUsageQueue } from './queue';
import type { UsageEvent, UsageEventSource } from './types';

export interface RecordUsageInput {
    user: string | null | undefined;
    featureKey: string;
    eventKey: string;
    source?: UsageEventSource;
    route?: string | null;
    occurredAt?: Date;
    eventId?: string;
}

/**
 * 业务成功分支调用的埋点入口。
 *
 * 契约（Phase2 §15 开发红线）：同步返回、绝不抛错、绝不等待数据库。
 * 调用点必须在业务结果已确定之后，且不得 await 本函数。
 */
export function recordUsageEvent(input: RecordUsageInput): void {
    try {
        if (!isUsageEnabled()) return;

        const user = input.user;
        if (!user || typeof user !== 'string' || user.length > MAX_USER_LENGTH) return;

        const { featureKey, eventKey } = input;
        if (featureKey.length > MAX_KEY_LENGTH || eventKey.length > MAX_KEY_LENGTH) return;
        if (!isValidEvent(featureKey, eventKey)) return;

        const queue = getUsageQueue();
        if (!queue) return;

        const occurredAt = input.occurredAt ?? new Date();
        const event: UsageEvent = {
            eventId: input.eventId ?? randomUUID(),
            occurredAt,
            dateKey: toDateKey(occurredAt),
            user,
            featureKey,
            eventKey,
            source: input.source ?? 'server',
            // 只保存规范化 pathname，绝不保存可能含敏感信息的 query string。
            route: normalizeRoute(input.route),
        };

        queue.enqueue(event);
    } catch {
        // 统计异常在此吞掉：绝不改变业务状态码、响应体或成功结果。
    }
}

export function normalizeRoute(route: string | null | undefined): string | null {
    if (!route || typeof route !== 'string') return null;
    const path = route.split('?')[0].split('#')[0];
    return path.slice(0, MAX_ROUTE_LENGTH) || null;
}

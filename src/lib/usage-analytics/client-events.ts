'use client';

import { safeUUID } from '@/lib/safe-uuid';

const basePath = process.env.NEXT_PUBLIC_URL_PREFIX || '';

/**
 * 客户端语义行为上报。
 *
 * 只在本地动作真正成功后调用（Promise resolve / 详情首次加载成功）。
 * 失败静默丢弃 —— 统计绝不影响页面功能。
 */
export function reportClientUsage(featureKey: string, eventKey: string): void {
    try {
        if (typeof window === 'undefined') return;

        const apiKey = localStorage.getItem('api_key') || '';
        if (!apiKey) return;

        const payload = JSON.stringify({
            events: [
                {
                    eventId: safeUUID(),
                    occurredAt: new Date().toISOString(),
                    featureKey,
                    eventKey,
                    route: window.location.pathname,
                },
            ],
        });

        void fetch(`${basePath}/api/usage/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-witty-api-key': apiKey },
            body: payload,
            keepalive: true,
        }).catch(() => {});
    } catch {
        // 统计上报失败绝不冒泡到业务逻辑。
    }
}

/**
 * 同一次用户"打开"动作只记一次的去重包装。
 * 用于 trace.detail.view / fault.history.view 这类"一次点击 → 内部多次请求"的场景。
 */
export function createOnceReporter(featureKey: string, eventKey: string) {
    let lastToken: string | null = null;
    return (token: string) => {
        if (!token || token === lastToken) return;
        lastToken = token;
        reportClientUsage(featureKey, eventKey);
    };
}

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

const WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 5;
const PRUNE_THRESHOLD = 1000;

interface FailureEntry {
    count: number;
    resetAt: number;
}

const failures = new Map<string, FailureEntry>();

function pruneExpired(now: number) {
    if (failures.size < PRUNE_THRESHOLD) return;
    for (const [key, entry] of failures) {
        if (entry.resetAt <= now) failures.delete(key);
    }
}

export function resolveClientIp(request: Request): string {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
        const first = forwarded.split(',')[0]?.trim();
        if (first) return first;
    }
    return request.headers.get('x-real-ip') || 'unknown';
}

export function loginRateLimitKey(request: Request, username: string): string {
    return `${resolveClientIp(request)}|${username.toLowerCase()}`;
}

export function checkLoginRateLimit(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    pruneExpired(now);
    const entry = failures.get(key);
    if (!entry || entry.resetAt <= now) {
        return { allowed: true, retryAfterSeconds: 0 };
    }
    if (entry.count < MAX_FAILURES) {
        return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
}

export function recordLoginFailure(key: string): void {
    const now = Date.now();
    const entry = failures.get(key);
    if (!entry || entry.resetAt <= now) {
        failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
        return;
    }
    entry.count += 1;
}

export function clearLoginFailures(key: string): void {
    failures.delete(key);
}

export function resetLoginRateLimits(): void {
    failures.clear();
}

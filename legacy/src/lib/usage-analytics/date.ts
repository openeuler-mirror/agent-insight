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

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 事件时间以 UTC 保存，日期键按 Asia/Shanghai 自然日生成（Phase1 §3）。 */
export function toDateKey(d: Date): string {
    return new Date(d.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** range=7 表示含今天在内的 7 个自然日，因此回退 days-1 天。 */
export function dateKeyDaysAgo(days: number, now: Date = new Date()): string {
    const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS - (days - 1) * 24 * 60 * 60 * 1000);
    return shifted.toISOString().slice(0, 10);
}

export function todayDateKey(now: Date = new Date()): string {
    return toDateKey(now);
}

export function enumerateDateKeys(from: string, to: string): string[] {
    const out: string[] = [];
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return out;
    for (let t = start; t <= end; t += 24 * 60 * 60 * 1000) {
        out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
}

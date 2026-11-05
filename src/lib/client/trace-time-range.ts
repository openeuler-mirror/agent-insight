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

import type { FilterClause } from '@/lib/filters/types';

export type TraceTimeRangeError = 'empty' | 'invalid' | 'order';

function parseTime(value: string): Date | null {
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z)?$/.exec(value);
    if (!parts) return null;
    const date = new Date(value);
    const actual = parts[7]
        ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
        : [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
    return actual.every((part, i) => part === Number(parts[i + 1] ?? 0)) ? date : null;
}

export function toLocalTraceTime(value: string): string {
    const date = parseTime(value);
    if (!date) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function resolveTraceTimeRange(from: string, to: string): {
    error: TraceTimeRangeError | null;
    from: string;
    to: string;
    clauses: FilterClause[];
} {
    const start = from ? parseTime(from) : null;
    const end = to ? parseTime(to) : null;
    const error = !from && !to ? 'empty'
        : (from && !start) || (to && !end) ? 'invalid'
        : start && end && start > end ? 'order' : null;
    if (error) return { error, from: '', to: '', clauses: [] };
    const normalizedFrom = start?.toISOString() ?? '';
    const normalizedTo = end?.toISOString() ?? '';
    const clauses: FilterClause[] = [];
    if (start) clauses.push({ column: 'timestamp', operator: '>=', value: normalizedFrom });
    if (end) clauses.push({ column: 'timestamp', operator: '<=', value: normalizedTo });
    return { error: null, from: normalizedFrom, to: normalizedTo, clauses };
}

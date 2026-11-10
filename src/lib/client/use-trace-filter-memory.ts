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

'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { parseAsString, useQueryStates, type inferParserType } from 'nuqs';

export const traceFilterParsers = {
    time: parseAsString.withDefault('all'),
    timeFrom: parseAsString.withDefault(''),
    timeTo: parseAsString.withDefault(''),
    status: parseAsString.withDefault('all'),
    anomaly: parseAsString.withDefault('all'),
    framework: parseAsString.withDefault('all'),
    // sourceKind 筛选（cli/ide/desktop/app_server，Codex Desktop PR #446）——加入共享
    // parsers 使其与其他筛选一样参与筛选记忆的恢复与重置。
    source: parseAsString.withDefault('all'),
    traceUser: parseAsString.withDefault(''),
    agent: parseAsString.withDefault('all'),
    skill: parseAsString.withDefault('all'),
    tagIds: parseAsString.withDefault(''),
    bizTag: parseAsString,
    ownership: parseAsString.withDefault('user'),
    scope: parseAsString.withDefault('root'),
    q: parseAsString.withDefault(''),
    f: parseAsString.withDefault(''),
};

type FilterSnapshot = inferParserType<typeof traceFilterParsers>;
const defaults = Object.fromEntries(Object.entries(traceFilterParsers)
    .map(([key, parser]) => [key, 'defaultValue' in parser ? parser.defaultValue : null])) as FilterSnapshot;
const resetSnapshot: FilterSnapshot = { ...defaults, ownership: 'all' };

function storageKey(user: string) {
    return `trace.filters.v1:${process.env.NEXT_PUBLIC_URL_PREFIX || ''}:${encodeURIComponent(user)}`;
}

function readSnapshot(user: string): FilterSnapshot | null {
    try {
        const raw: unknown = JSON.parse(window.sessionStorage.getItem(storageKey(user)) || 'null');
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const snapshot = { ...defaults };
        for (const key of Object.keys(traceFilterParsers) as (keyof FilterSnapshot)[]) {
            const value = (raw as Record<string, unknown>)[key];
            if (value !== undefined) {
                if (key === 'bizTag' && value === null) snapshot.bizTag = null;
                else if (typeof value === 'string') snapshot[key] = value;
                else return null;
            }
        }
        return snapshot;
    } catch {
        return null;
    }
}

export function useTraceFilterMemory(user: string | null) {
    const pathname = usePathname();
    const query = useSearchParams().toString();
    const [filters, setFilters] = useQueryStates(traceFilterParsers);
    const snapshot = JSON.stringify(filters);
    const visit = useRef<{ user: string; restoring: string | null; cleared: string | null } | null>(null);
    const [readyUser, setReadyUser] = useState<string | null>(null);

    useEffect(() => {
        if (pathname !== '/trace') return;
        if (!user) {
            visit.current = null;
            // eslint-disable-next-line react-hooks/set-state-in-effect -- Login changes must invalidate the storage hydration gate.
            setReadyUser(null);
            return;
        }
        if (visit.current?.user !== user) {
            // Deep links define their own context; only a bare /trace restores the last visit.
            const saved = query ? null : readSnapshot(user);
            visit.current = { user, restoring: saved ? JSON.stringify(saved) : null, cleared: null };
        }
        if (visit.current.restoring) {
            const params = new URLSearchParams(query);
            const committed = { ...defaults };
            for (const key of Object.keys(traceFilterParsers) as (keyof FilterSnapshot)[]) {
                const value = params.get(key);
                if (value !== null) committed[key] = value;
            }
            if (snapshot !== visit.current.restoring || JSON.stringify(committed) !== visit.current.restoring) {
                const saved = JSON.parse(visit.current.restoring) as FilterSnapshot;
                // Route entry resets nuqs's URL queue; defer restoration and wait for its committed URL.
                const timer = window.setTimeout(() => { void setFilters(saved, { history: 'replace' }); }, 0);
                return () => window.clearTimeout(timer);
            }
        }
        visit.current.restoring = null;
        setReadyUser(user);
        if (visit.current.cleared === snapshot) return;
        visit.current.cleared = null;
        try {
            window.sessionStorage.setItem(storageKey(user), snapshot);
        } catch {
            // Disabled or full browser storage must not prevent Trace browsing.
        }
    }, [pathname, query, setFilters, snapshot, user]);

    const clearFilterMemory = () => {
        if (user) {
            visit.current = { user, restoring: null, cleared: JSON.stringify(resetSnapshot) };
            try {
                window.sessionStorage.removeItem(storageKey(user));
            } catch {
                // Reset still applies when browser storage is unavailable.
            }
        }
        void setFilters(resetSnapshot, { history: 'replace' });
    };

    return { filtersReady: readyUser === user && user !== null, clearFilterMemory };
}

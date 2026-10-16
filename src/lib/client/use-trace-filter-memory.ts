'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { parseAsString, useQueryStates, type inferParserType } from 'nuqs';

export const traceFilterParsers = {
    time: parseAsString.withDefault('all'),
    status: parseAsString.withDefault('all'),
    anomaly: parseAsString.withDefault('all'),
    framework: parseAsString.withDefault('all'),
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
    const query = useSearchParams().toString();
    const [filters, setFilters] = useQueryStates(traceFilterParsers);
    const snapshot = JSON.stringify(filters);
    const visit = useRef<{ user: string; restoring: string | null; cleared: string | null } | null>(null);
    const [readyUser, setReadyUser] = useState<string | null>(null);

    useEffect(() => {
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
            if (saved && snapshot !== visit.current.restoring) {
                void setFilters(saved, { history: 'replace' });
                return;
            }
        }
        if (visit.current.restoring && snapshot !== visit.current.restoring) return;
        visit.current.restoring = null;
        setReadyUser(user);
        if (visit.current.cleared === snapshot) return;
        visit.current.cleared = null;
        try {
            window.sessionStorage.setItem(storageKey(user), snapshot);
        } catch {
            // Disabled or full browser storage must not prevent Trace browsing.
        }
    }, [query, setFilters, snapshot, user]);

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

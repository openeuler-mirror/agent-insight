import { apiFetch } from './api';

type TraceFacetValue = { value: string; count: number };

const pendingFacets = new Map<string, Promise<TraceFacetValue[]>>();

export function loadTraceFacetValues(user: string, column: string): Promise<TraceFacetValue[]> {
    const url = `/api/observe/data?user=${encodeURIComponent(user)}&facet=values&column=${encodeURIComponent(column)}`;
    const pending = pendingFacets.get(url);
    if (pending) return pending;

    const request = apiFetch(url)
        .then(response => {
            if (!response.ok) throw new Error(`Trace facet request failed: ${response.status}`);
            return response.json();
        })
        .then(rows => Array.isArray(rows) ? rows as TraceFacetValue[] : [])
        .finally(() => pendingFacets.delete(url));
    pendingFacets.set(url, request);
    return request;
}

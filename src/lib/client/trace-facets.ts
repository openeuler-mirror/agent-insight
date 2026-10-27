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

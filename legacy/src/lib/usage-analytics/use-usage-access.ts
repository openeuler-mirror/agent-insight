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

import { useEffect, useState } from 'react';

const basePath = process.env.NEXT_PUBLIC_URL_PREFIX || '';

export interface UsageAccessState {
    loading: boolean;
    enabled: boolean;
    isAdmin: boolean;
}

/** access 请求失败一律按无权限处理 —— 入口宁可不显示，也不能误开。 */
export function useUsageAccess(): UsageAccessState {
    const [state, setState] = useState<UsageAccessState>({ loading: true, enabled: false, isAdmin: false });

    useEffect(() => {
        const ctrl = new AbortController();
        const apiKey = typeof window !== 'undefined' ? localStorage.getItem('api_key') || '' : '';
        if (!apiKey) {
            setState({ loading: false, enabled: false, isAdmin: false });
            return;
        }

        fetch(`${basePath}/api/admin/usage/access`, {
            headers: { 'x-witty-api-key': apiKey },
            signal: ctrl.signal,
        })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
            .then((d) => setState({ loading: false, enabled: !!d.enabled, isAdmin: !!d.isAdmin }))
            .catch((e) => {
                if (e.name === 'AbortError') return;
                setState({ loading: false, enabled: false, isAdmin: false });
            });

        return () => ctrl.abort();
    }, []);

    return state;
}

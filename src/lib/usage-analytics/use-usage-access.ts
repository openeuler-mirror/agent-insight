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

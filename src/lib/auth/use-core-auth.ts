'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/client/api';
import type { AuthContextType } from './auth-context';
import type { CoreProfile } from '@/lib/storage-core/types';

export function useCoreAuthHook(): AuthContextType {
  const [profile, setProfile] = useState<CoreProfile | null>(null);
  const [workspaceId, setWorkspace] = useState<string | null>(null);
  const [authReady, setReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const router = useRouter(); const pathname = usePathname(); const epoch = useRef(0);
  const apply = useCallback((next: CoreProfile) => {
    setProfile(next);
    setWorkspace(current => next.workspaces.some(w => w.workspace_id === current) ? current : next.workspace_id);
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await apiFetch('/api/storage-core/auth', { cache: 'no-store', signal });
    if (!response.ok) throw Object.assign(new Error(response.status === 401 ? '请先登录' : '无法验证存储服务登录状态'), { status: response.status });
    return await response.json() as CoreProfile;
  }, []);
  useEffect(() => {
    const controller = new AbortController(); const generation = ++epoch.current;
    void refresh(controller.signal).then(next => {
      if (epoch.current === generation) { apply(next); setAuthError(null); }
    }).catch(error => {
      if (controller.signal.aborted || epoch.current !== generation) return;
      if (error?.status === 401) { setProfile(null); setAuthError(null); }
      else setAuthError('暂时无法验证登录状态，请检查存储服务后重试');
    }).finally(() => { if (!controller.signal.aborted && epoch.current === generation) setReady(true); });
    return () => controller.abort();
  }, [apply, refresh]);
  useEffect(() => {
    if (!authReady || authError || profile || pathname === '/login') return;
    router.replace('/login?' + new URLSearchParams({ returnTo: pathname + window.location.search }));
  }, [authReady, authError, profile, pathname, router]);
  const login = useCallback(async () => {
    const generation = ++epoch.current;
    const next = await refresh(); if (epoch.current !== generation) return;
    apply(next); setAuthError(null); setReady(true);
    const target = new URLSearchParams(window.location.search).get('returnTo');
    let destination = '/trace';
    if (target?.startsWith('/') && !/[\\\u0000-\u001f\u007f]/.test(target)) {
      try {
        const url = new URL(target, window.location.origin);
        const decodedPath = decodeURIComponent(url.pathname);
        if (url.origin === window.location.origin && !/[\\\u0000-\u001f\u007f]/.test(decodedPath)
          && !decodedPath.startsWith('//') && !/^\/login(?:\/|$)/.test(decodedPath)) {
          destination = url.pathname + url.search + url.hash;
        }
      } catch { /* An invalid return path uses the default destination. */ }
    }
    router.replace(destination);
  }, [apply, refresh, router]);
  const logout = useCallback(async () => {
    const generation = ++epoch.current;
    const response = await apiFetch('/api/storage-core/auth', { method: 'DELETE' });
    if (!response.ok) throw new Error('退出登录失败，请重试');
    if (epoch.current !== generation) return;
    setProfile(null); setWorkspace(null); setReady(true); router.replace('/login');
  }, [router]);
  const retryAuth = useCallback(async () => {
    const generation = ++epoch.current; setReady(false);
    try {
      const next = await refresh();
      if (epoch.current === generation) { apply(next); setAuthError(null); }
    } catch (error) {
      if (epoch.current !== generation) return;
      if ((error as { status?: number })?.status === 401) { setProfile(null); setAuthError(null); }
      else setAuthError('暂时无法验证登录状态，请检查存储服务后重试');
    } finally { if (epoch.current === generation) setReady(true); }
  }, [apply, refresh]);
  const setWorkspaceId = useCallback((value: string) => {
    if (!profile?.workspaces.some(workspace => workspace.workspace_id === value)) throw new Error('工作区不可用');
    setWorkspace(value);
  }, [profile]);
  return { user: profile?.username || null, displayName: profile?.display_name || null, apiKey: null,
    authReady, loginMode: 'standalone', loginModeReady: true, organizationLoginRedirectUrl: '',
    login, logout, profile, workspaceId, setWorkspaceId, authError, retryAuth };
}

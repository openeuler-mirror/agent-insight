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

import { usePathname, useRouter } from 'next/navigation';
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { apiFetch, getApiUrl } from '@/lib/client/api';
import type { LoginMode } from '@/lib/auth/login-mode';

interface AuthContextType {
  user: string | null;
  displayName: string | null;
  apiKey: string | null;
  isAdmin: boolean;
  passwordChangeRequired: boolean;
  passwordInitialized: boolean;
  authReady: boolean;
  loginMode: LoginMode | 'invalid' | null;
  loginModeReady: boolean;
  organizationLoginRedirectUrl: string;
  login: (
    username: string,
    apiKey?: string,
    displayName?: string,
    session?: {
      isAdmin?: boolean;
      passwordChangeRequired?: boolean;
      passwordInitialized?: boolean;
      passwordSetupToken?: string;
    },
  ) => void;
  logout: () => void;
  clearPasswordChangeRequired: () => void;
  markPasswordInitialized: () => void;
  completePasswordChange: (apiKey?: string, isAdmin?: boolean) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const CLIENT_LOGIN_MODES = new Set<LoginMode>(['standalone', 'organization', 'idaas_oauth']);
const IDAAS_REGION_ERROR_CODES = new Set(['region_restricted', 'region_check_unavailable']);
// 页面卸载会中断进行中的请求；把这类中断当成立即失败会把用户误踢回登录页。
// 探测登录模式和恢复登录态都先短暂退避重试，只有明确的鉴权拒绝才清除本地凭据。
const LOGIN_MODE_RETRY_DELAY_MS = 400;
const LOGIN_MODE_MAX_RETRY_DELAY_MS = 3000;
const AUTH_RESTORE_MAX_ATTEMPTS = 3;
const AUTH_RESTORE_RETRY_DELAY_MS = 400;

// 登录后回跳目标：仅接受站内路径（防 open redirect），排除 /login 自身（防循环）。
// 从 window.location.search 读而不用 useSearchParams()，避免给全局 Provider 引入 Suspense 边界要求。
export function getSafeReturnTo(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('returnTo');
  if (raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/login')) return raw;
  return null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);
  const [passwordInitialized, setPasswordInitialized] = useState(true);
  const [authReady, setAuthReady] = useState(false);
  const [loginMode, setLoginMode] = useState<LoginMode | 'invalid' | null>(null);
  const [loginModeReady, setLoginModeReady] = useState(false);
  const [organizationLoginRedirectUrl, setOrganizationLoginRedirectUrl] = useState('');
  const [idaasRegionError, setIdaasRegionError] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const loadLoginMode = async () => {
      try {
        const res = await apiFetch('/api/eval/config/status?check_login=true');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || 'Failed to load login mode');
        const nextMode = data?.login_mode
          || (data?.org_mode ? 'organization' : 'standalone');
        if (cancelled) return;
        if (!CLIENT_LOGIN_MODES.has(nextMode)) {
          // 服务端明确返回了不支持的登录模式：这是配置错误，不是临时故障，重试没有意义。
          setLoginMode('invalid');
          setOrganizationLoginRedirectUrl('');
          setLoginModeReady(true);
          return;
        }
        setLoginMode(nextMode);
        setOrganizationLoginRedirectUrl(data?.org_login_redirect_url || '');
        setLoginModeReady(true);
      } catch (err) {
        if (cancelled) return;
        // 登录模式探测失败不能等同于未登录：保留本地凭据，退避后重试。
        attempt += 1;
        console.error('Failed to load login mode, retrying:', err);
        retryTimer = setTimeout(
          () => { void loadLoginMode(); },
          Math.min(LOGIN_MODE_RETRY_DELAY_MS * attempt, LOGIN_MODE_MAX_RETRY_DELAY_MS),
        );
      }
    };

    void loadLoginMode();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    if (!loginModeReady) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearStoredAuth = () => {
      localStorage.removeItem('user_id');
      localStorage.removeItem('api_key');
      localStorage.removeItem('password_setup_token');
      setUser(null);
      setDisplayName(null);
      setApiKey(null);
      setIsAdmin(false);
      setPasswordChangeRequired(false);
      setPasswordInitialized(true);
    };

    const waitBeforeRetry = (attempt: number) => new Promise<void>(resolve => {
      retryTimer = setTimeout(resolve, AUTH_RESTORE_RETRY_DELAY_MS * (attempt + 1));
    });

    const restoreAuth = async () => {
      for (let attempt = 0; attempt < AUTH_RESTORE_MAX_ATTEMPTS; attempt += 1) {
        if (cancelled) return;
        try {
          const storedUser = localStorage.getItem('user_id');
          const storedApiKey = localStorage.getItem('api_key');
          const storedSetupToken = localStorage.getItem('password_setup_token');
          let response: Response | null = null;

          if (loginMode === 'invalid' || !loginMode) {
            // 登录模式配置错误与本地身份是否有效无关，不能因此清除凭据。
            return;
          }

          if (loginMode === 'organization') {
            response = await apiFetch('/api/auth/organization');
          } else if (loginMode === 'standalone') {
            // 正式 Key 或改密凭据都可以恢复登录态；改密凭据只用于设置新密码。
            if (!storedUser || (!storedApiKey && !storedSetupToken)) {
              clearStoredAuth();
              return;
            }
            response = await apiFetch('/api/auth/session', {
              headers: {
                ...(storedApiKey ? { 'x-witty-api-key': storedApiKey } : {}),
                ...(storedSetupToken ? { 'x-witty-password-token': storedSetupToken } : {}),
              },
            });
          } else if (storedUser && storedApiKey) {
            response = await apiFetch('/api/auth/apikey', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-witty-api-key': storedApiKey,
              },
              body: JSON.stringify({ username: storedUser }),
            });
          }

          if (!response) {
            clearStoredAuth();
            return;
          }

          const data = await response.json().catch(() => ({}));
          if (cancelled) return;
          if (!response.ok) {
            const responseCode = typeof data?.code === 'string' ? data.code : '';
            const regionError = loginMode === 'idaas_oauth'
              && IDAAS_REGION_ERROR_CODES.has(responseCode);
            const exhausted = attempt + 1 >= AUTH_RESTORE_MAX_ATTEMPTS;

            if (response.status === 401 || response.status === 403) {
              if (regionError) setIdaasRegionError(responseCode);
              clearStoredAuth();
              return;
            }
            // 地区校验接口不可用属于临时故障；重试仍失败时按失败关闭处理。
            if (regionError && exhausted) {
              setIdaasRegionError(responseCode);
              clearStoredAuth();
              return;
            }
            throw new Error(data?.error || `Authentication refresh failed: ${response.status}`);
          }

          let nextUser: string | null;
          let nextDisplayName: string | null;
          let nextApiKey: string | null;
          let nextIsAdmin = false;
          let nextPasswordChangeRequired = false;
          let nextPasswordInitialized = true;

          if (loginMode === 'organization') {
            nextUser = data?.displayName || data?.username;
            nextDisplayName = data?.displayName || nextUser;
            nextApiKey = data?.apiKey;
          } else if (loginMode === 'standalone') {
            nextUser = data?.username || storedUser;
            nextDisplayName = nextUser;
            nextApiKey = storedApiKey;
            nextIsAdmin = Boolean(data?.isAdmin);
            nextPasswordChangeRequired = Boolean(data?.passwordChangeRequired);
            nextPasswordInitialized = data?.passwordInitialized !== false;
          } else {
            nextUser = data?.username || storedUser;
            nextDisplayName = data?.displayName || nextUser;
            nextApiKey = data?.apiKey;
          }
          if (!nextUser) throw new Error('Authentication refresh response is incomplete');
          if (loginMode !== 'standalone' && !nextApiKey) {
            throw new Error('Authentication refresh response is incomplete');
          }
          if (loginMode === 'standalone' && !nextApiKey && !nextPasswordChangeRequired) {
            throw new Error('Authentication refresh response is incomplete');
          }
          if (cancelled) return;

          setIdaasRegionError(null);
          localStorage.setItem('user_id', nextUser);
          if (nextApiKey) localStorage.setItem('api_key', nextApiKey);
          else localStorage.removeItem('api_key');
          setUser(nextUser);
          setDisplayName(nextDisplayName);
          setApiKey(nextApiKey);
          setIsAdmin(nextIsAdmin);
          setPasswordChangeRequired(nextPasswordChangeRequired);
          setPasswordInitialized(nextPasswordInitialized);
          return;
        } catch (err) {
          if (cancelled) return;
          if (attempt + 1 >= AUTH_RESTORE_MAX_ATTEMPTS) {
            console.error('Authentication refresh failed:', err);
            return;
          }
          await waitBeforeRetry(attempt);
        }
      }
    };

    void restoreAuth().finally(() => {
      if (!cancelled) setAuthReady(true);
    });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [loginMode, loginModeReady]);

  useEffect(() => {
    if (!authReady || user || pathname === '/login') return;

    // 记下来路（含查询串，如 /trace?taskId=xxx），登录成功后由 login() 回跳。
    // search 直接取自 window.location：useSearchParams 会要求 Suspense 边界，且 pathname 已由 usePathname 去掉 basePath。
    const returnTo = `${pathname}${window.location.search}`;
    const params = new URLSearchParams({ returnTo });
    if (idaasRegionError) params.set('idaasError', idaasRegionError);
    router.push('/login?' + params.toString());
  }, [authReady, idaasRegionError, pathname, router, user]);

  // 管理员重置密码或首次建号后，必须先把密码改掉才能进入其它页面。
  useEffect(() => {
    if (!authReady || !user || !passwordChangeRequired) return;
    if (pathname === '/config/password') return;
    router.replace('/config/password');
    // 动态路由（如 /trace）首屏水合时，router.replace 可能被随后提交的页面覆盖；
    // 兜底补一次硬跳转，确保未设置密码的账号不能停留在业务页。
    const timer = window.setTimeout(() => {
      if (!window.location.pathname.endsWith('/config/password')) {
        window.location.replace(getApiUrl('/config/password'));
      }
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [authReady, passwordChangeRequired, pathname, router, user]);

  const login = useCallback((
    username: string,
    key?: string,
    nextDisplayName?: string,
    session?: {
      isAdmin?: boolean;
      passwordChangeRequired?: boolean;
      passwordInitialized?: boolean;
      passwordSetupToken?: string;
    },
  ) => {
    setIdaasRegionError(null);
    localStorage.setItem('user_id', username);
    setUser(username);
    setDisplayName(nextDisplayName || username);
    setIsAdmin(Boolean(session?.isAdmin));
    setPasswordChangeRequired(Boolean(session?.passwordChangeRequired));
    setPasswordInitialized(session?.passwordInitialized !== false);
    if (session?.passwordSetupToken) {
      localStorage.setItem('password_setup_token', session.passwordSetupToken);
    } else {
      localStorage.removeItem('password_setup_token');
    }
    if (key) {
      localStorage.setItem('api_key', key);
      setApiKey(key);
    } else {
      localStorage.removeItem('api_key');
      setApiKey(null);
    }
    setAuthReady(true);
    // 深链进入（如客户系统跳转 /trace?taskId=xxx）被登录页拦截时，登录后回原页；直接访问登录页则维持原行为落 /trace。
    if (session?.passwordChangeRequired) {
      router.replace('/config/password');
      return;
    }
    router.replace(getSafeReturnTo() || '/trace');
  }, [router]);

  const logout = useCallback(() => {
    setIdaasRegionError(null);
    localStorage.removeItem('user_id');
    localStorage.removeItem('api_key');
    localStorage.removeItem('password_setup_token');
    setUser(null);
    setDisplayName(null);
    setApiKey(null);
    setIsAdmin(false);
    setPasswordChangeRequired(false);
    setPasswordInitialized(true);
    setAuthReady(true);
    router.push('/login');
  }, [router]);

  const clearPasswordChangeRequired = useCallback(() => {
    setPasswordChangeRequired(false);
  }, []);

  const markPasswordInitialized = useCallback(() => {
    setPasswordInitialized(true);
  }, []);

  // 改密完成后服务端才会下发正式 API Key；清掉一次性改密凭据。
  const completePasswordChange = useCallback((key?: string, nextIsAdmin?: boolean) => {
    localStorage.removeItem('password_setup_token');
    if (key) {
      localStorage.setItem('api_key', key);
      setApiKey(key);
    }
    if (nextIsAdmin !== undefined) setIsAdmin(nextIsAdmin);
    setPasswordInitialized(true);
    setPasswordChangeRequired(false);
  }, []);

  return (
    <AuthContext.Provider value={{
      user,
      displayName,
      apiKey,
      isAdmin,
      passwordChangeRequired,
      passwordInitialized,
      authReady,
      loginMode,
      loginModeReady,
      organizationLoginRedirectUrl,
      login,
      logout,
      clearPasswordChangeRequired,
      markPasswordInitialized,
      completePasswordChange,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

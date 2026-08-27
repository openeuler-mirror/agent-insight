'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/client/api';
import type { LoginMode } from '@/lib/auth/login-mode';

interface AuthContextType {
  user: string | null;
  apiKey: string | null;
  authReady: boolean;
  loginMode: LoginMode | 'invalid' | null;
  loginModeReady: boolean;
  organizationLoginRedirectUrl: string;
  login: (username: string, apiKey?: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const CLIENT_LOGIN_MODES = new Set<LoginMode>(['standalone', 'organization', 'idaas_oauth']);

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
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [loginMode, setLoginMode] = useState<LoginMode | 'invalid' | null>(null);
  const [loginModeReady, setLoginModeReady] = useState(false);
  const [organizationLoginRedirectUrl, setOrganizationLoginRedirectUrl] = useState('');
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    apiFetch('/api/eval/config/status?check_login=true')
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || 'Failed to load login mode');
        const nextMode = data?.login_mode
          || (data?.org_mode ? 'organization' : 'standalone');
        if (!CLIENT_LOGIN_MODES.has(nextMode)) throw new Error('Invalid login mode');
        setLoginMode(nextMode);
        setOrganizationLoginRedirectUrl(data?.org_login_redirect_url || '');
      })
      .catch(() => {
        setLoginMode('invalid');
        setOrganizationLoginRedirectUrl('');
      })
      .finally(() => setLoginModeReady(true));
  }, []);

  useEffect(() => {
    if (!loginModeReady) return;

    let cancelled = false;

    const clearStoredAuth = () => {
      localStorage.removeItem('user_id');
      localStorage.removeItem('api_key');
      setUser(null);
      setApiKey(null);
    };

    const restoreAuth = async () => {
      try {
        const storedUser = localStorage.getItem('user_id');
        const storedApiKey = localStorage.getItem('api_key');
        let response: Response | null = null;

        if (!loginMode || loginMode === 'invalid') {
          clearStoredAuth();
          return;
        }

        if (loginMode === 'organization') {
          response = await apiFetch('/api/auth/organization');
        } else if (storedUser && (loginMode !== 'idaas_oauth' || storedApiKey)) {
          response = await apiFetch('/api/auth/apikey', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(loginMode === 'idaas_oauth' && storedApiKey
                ? { 'x-witty-api-key': storedApiKey }
                : {}),
            },
            body: JSON.stringify({ username: storedUser }),
          });
        }

        if (!response) {
          clearStoredAuth();
          return;
        }

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data?.error || `Authentication refresh failed: ${response.status}`);
        }

        const nextUser = loginMode === 'organization'
          ? data?.displayName || data?.username
          : data?.username || storedUser;
        const nextApiKey = data?.apiKey;
        if (!nextUser || !nextApiKey) throw new Error('Authentication refresh response is incomplete');
        if (cancelled) return;

        localStorage.setItem('user_id', nextUser);
        localStorage.setItem('api_key', nextApiKey);
        setUser(nextUser);
        setApiKey(nextApiKey);
      } catch (err) {
        if (cancelled) return;
        clearStoredAuth();
        console.error('Authentication refresh failed:', err);
      } finally {
        if (!cancelled) setAuthReady(true);
      }
    };

    void restoreAuth();
    return () => {
      cancelled = true;
    };
  }, [loginMode, loginModeReady]);

  useEffect(() => {
    if (!authReady || user || pathname === '/login') return;

    // 记下来路（含查询串，如 /trace?taskId=xxx），登录成功后由 login() 回跳。
    // search 直接取自 window.location：useSearchParams 会要求 Suspense 边界，且 pathname 已由 usePathname 去掉 basePath。
    const returnTo = `${pathname}${window.location.search}`;
    router.push(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [authReady, pathname, router, user]);

  const login = useCallback((username: string, key?: string) => {
    localStorage.setItem('user_id', username);
    setUser(username);
    if (key) {
      localStorage.setItem('api_key', key);
      setApiKey(key);
    } else {
      localStorage.removeItem('api_key');
      setApiKey(null);
    }
    setAuthReady(true);
    // 深链进入（如客户系统跳转 /trace?taskId=xxx）被登录页拦截时，登录后回原页；直接访问登录页则维持原行为落 /trace。
    router.replace(getSafeReturnTo() || '/trace');
  }, [router]);

  const logout = useCallback(() => {
    localStorage.removeItem('user_id');
    localStorage.removeItem('api_key');
    setUser(null);
    setApiKey(null);
    setAuthReady(true);
    router.push('/login');
  }, [router]);

  return (
    <AuthContext.Provider value={{
      user,
      apiKey,
      authReady,
      loginMode,
      loginModeReady,
      organizationLoginRedirectUrl,
      login,
      logout,
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

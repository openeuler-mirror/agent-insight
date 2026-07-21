'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/client/api';

interface AuthContextType {
  user: string | null;
  apiKey: string | null;
  login: (username: string, apiKey?: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

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
  const [isOrgMode, setIsOrgMode] = useState(false);
  const [isOrgLoading, setIsOrgLoading] = useState(false);
  const [orgModeChecked, setOrgModeChecked] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    apiFetch('/api/eval/config/status?check_org=true')
      .then(res => res.json())
      .then(data => setIsOrgMode(data.org_mode || false))
      .catch(() => {})
      .finally(() => setOrgModeChecked(true));
  }, []);

  useEffect(() => {
    if (!orgModeChecked) return;

    const storedUser = localStorage.getItem('user_id');
    const storedApiKey = localStorage.getItem('api_key');
    
    if (storedUser) {
      setUser(storedUser);
      if (storedApiKey) setApiKey(storedApiKey);
    } else if (isOrgMode && !isOrgLoading) {
      setIsOrgLoading(true);
      apiFetch('/api/auth/organization')
        .then(async res => {
          const json = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(json?.error || `Organization auth failed: ${res.status}`);
          return json;
        })
        .then(data => {
          const nextUser = data?.displayName || data?.username;
          const nextApiKey = data?.apiKey;
          if (!nextUser) throw new Error('Organization auth response missing username');

          localStorage.setItem('user_id', nextUser);
          if (nextApiKey) localStorage.setItem('api_key', nextApiKey);
          setUser(nextUser);
          if (nextApiKey) setApiKey(nextApiKey);
        })
        .catch(err => console.error('Organization auth failed:', err))
        .finally(() => setIsOrgLoading(false));
    } else if (pathname !== '/login') {
      // 记下来路（含查询串，如 /trace?taskId=xxx），登录成功后由 login() 回跳。
      // search 直接取自 window.location：useSearchParams 会要求 Suspense 边界，且 pathname 已由 usePathname 去掉 basePath。
      const returnTo = `${pathname}${window.location.search}`;
      router.push(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    }
  }, [pathname, router, isOrgMode, isOrgLoading, orgModeChecked]);

  const login = (username: string, key?: string) => {
    localStorage.setItem('user_id', username);
    setUser(username);
    if (key) {
        localStorage.setItem('api_key', key);
        setApiKey(key);
    }
    // 深链进入（如客户系统跳转 /trace?taskId=xxx）被登录页拦截时，登录后回原页；直接访问登录页则维持原行为落 /trace。
    router.replace(getSafeReturnTo() || '/trace');
  };

  const logout = () => {
    localStorage.removeItem('user_id');
    localStorage.removeItem('api_key');
    setUser(null);
    setApiKey(null);
    router.push('/login');
  };

  return (
    <AuthContext.Provider value={{ user, apiKey, login, logout }}>
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

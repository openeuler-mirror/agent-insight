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
      router.push('/login');
    }
  }, [pathname, router, isOrgMode, isOrgLoading, orgModeChecked]);

  const login = (username: string, key?: string) => {
    localStorage.setItem('user_id', username);
    setUser(username);
    if (key) {
        localStorage.setItem('api_key', key);
        setApiKey(key);
    }
    router.replace('/trace');
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

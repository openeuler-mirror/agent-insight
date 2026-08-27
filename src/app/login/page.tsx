'use client';

import { getSafeReturnTo, useAuth } from '@/lib/auth/auth-context';
import { useRouter } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';
import { useTheme } from '@/lib/client/theme-context';
import { useLocale } from '@/lib/client/locale-context';
import { apiFetch, getApiUrl } from '@/lib/client/api';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [isCompletingIdaas, setIsCompletingIdaas] = useState(false);
  const idaasCompletionStarted = useRef(false);
  const {
    login, loginMode, loginModeReady, organizationLoginRedirectUrl,
  } = useAuth();
  const router = useRouter();
  const { isDark } = useTheme();
  const { t } = useLocale();

  useEffect(() => {
    if (loginMode !== 'organization' || !organizationLoginRedirectUrl) return;

    let cancelled = false;

    const tryOrgLogin = async () => {
      try {
        const res = await apiFetch('/api/auth/organization', { cache: 'no-store' });

        if (!res.ok) {
          if (!cancelled && (res.status === 401 || res.status === 403)) {
            window.location.href = organizationLoginRedirectUrl;
          }
          return;
        }

        const data = await res.json();
        if (!cancelled && data?.username) {
          login(data.username, data.apiKey);
          // login() 已按 returnTo 回跳；仅在无 returnTo 时维持历史组织集成的落 / 行为。
          if (!getSafeReturnTo()) router.replace('/');
        }
      } catch (e) {
        if (!cancelled) {
          window.location.href = organizationLoginRedirectUrl;
        }
      }
    };

    tryOrgLogin();

    return () => {
      cancelled = true;
    };
  }, [loginMode, organizationLoginRedirectUrl, login, router]);

  useEffect(() => {
    if (!loginModeReady || loginMode !== 'idaas_oauth') return;

    const params = new URLSearchParams(window.location.search);
    if (params.get('idaasError')) {
      setError(t('login.identityLoginFailed'));
      return;
    }
    if (params.get('idaas') !== 'complete') return;

    if (idaasCompletionStarted.current) return;
    idaasCompletionStarted.current = true;
    setIsCompletingIdaas(true);
    apiFetch('/api/auth/idaas-oauth/complete', {
      method: 'POST',
      cache: 'no-store',
    })
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || 'IDaaS login failed');
        login(data.username, data.apiKey);
      })
      .catch(() => {
        setError(t('login.identityLoginFailed'));
      })
      .finally(() => {
        setIsCompletingIdaas(false);
      });
  }, [login, loginMode, loginModeReady, t]);

  const handleIdaasLogin = () => {
    setError('');
    const url = new URL(
      getApiUrl('/api/auth/idaas-oauth/authorize'),
      window.location.origin,
    );
    const returnTo = getSafeReturnTo();
    if (returnTo) url.searchParams.set('returnTo', returnTo);
    window.location.assign(url.toString());
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    
    if (!username.trim()) {
      setError(t('login.emailRequired'));
      return;
    }
    
    try {
        const res = await apiFetch('/api/auth/apikey', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username.trim() })
        });
        
        const data = await res.json();
        
        if (res.ok) {
            login(data.username, data.apiKey);
        } else {
            setError(data.error || t('login.loginFailed'));
        }
    } catch (err) {
        console.error(err);
        setError(t('login.networkError'));
    }
  };

  const colors = isDark ? {
    fg: '#fafafa',
    fgSecondary: '#a1a1aa',
    fgMuted: '#71717a',
    primary: '#3b82f6',
    primaryGlow: 'rgba(59, 130, 246, 0.3)',
    error: '#ef4444',
    errorSubtle: 'rgba(239, 68, 68, 0.1)',
    errorBorder: 'rgba(239, 68, 68, 0.2)',
  } : {
    fg: '#18181b',
    fgSecondary: '#52525b',
    fgMuted: '#a1a1aa',
    primary: '#2563eb',
    primaryGlow: 'rgba(29, 78, 216, 0.3)',
    error: '#dc2626',
    errorSubtle: 'rgba(185, 28, 28, 0.08)',
    errorBorder: 'rgba(185, 28, 28, 0.18)',
  };

  if (!loginModeReady || isCompletingIdaas || loginMode === 'organization') {
    return (
      <div className="login-container">
        <div className="login-box">
          <p style={{ color: colors.fgMuted, textAlign: 'center' }}>
            {loginMode === 'organization' ? t('login.redirecting') : t('login.checkingLogin')}
          </p>
        </div>
      </div>
    );
  }

  if (loginMode === 'invalid') {
    return (
      <div className="login-container">
        <div className="login-box">
          <p style={{ color: colors.error, textAlign: 'center' }}>{t('login.configurationError')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-container">
      <div className="login-box">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '1.25rem', marginBottom: '2rem' }}>
             <div style={{
                background: `linear-gradient(135deg, ${colors.primary}, #7c3aed)`,
                color: 'white',
                fontWeight: 600,
                fontSize: '1.5rem',
                padding: '0.625rem 1rem',
                borderRadius: '0.75rem',
                whiteSpace: 'nowrap',
                boxShadow: `0 8px 16px -4px ${colors.primaryGlow}`
            }}>
                Agent
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
                <h1 style={{ fontSize: '2.25rem', fontWeight: 700, color: colors.fg, margin: 0, lineHeight: 1, letterSpacing: '-0.025em' }}>Insight</h1>
                <span style={{ fontSize: '0.8125rem', color: colors.fgMuted, letterSpacing: '0.04em', textTransform: 'uppercase', marginTop: '0.25rem' }}>{t('login.subtitle')}</span>
            </div>
        </div>

        {loginMode === 'idaas_oauth' ? (
          <div className="login-form">
            {error && (
              <div style={{
                color: colors.error,
                fontSize: '0.8125rem',
                marginBottom: '0.875rem',
                padding: '0.375rem 0.625rem',
                background: colors.errorSubtle,
                borderRadius: '0.375rem',
                border: `1px solid ${colors.errorBorder}`,
              }}>
                ⚠️ {error}
              </div>
            )}
            <button
              className="login-btn"
              type="button"
              onClick={handleIdaasLogin}
              disabled={isCompletingIdaas}
            >
              {t('login.identitySignIn')}
            </button>
          </div>
        ) : (
          <form className="login-form">
          <div style={{ marginBottom: '0.875rem' }}>
            <label className="login-label" htmlFor="username">
              {t('login.emailLabel')}
            </label>
            <input
              className="login-input"
              id="username"
              type="email"
              placeholder="请输入邮箱地址，例如 name@example.com"
              value={username}
              onChange={(e) => { setUsername(e.target.value); setError(''); }}
              style={error ? { borderColor: colors.error } : {}}
            />
            {error && (
              <div style={{
                color: colors.error,
                fontSize: '0.8125rem',
                marginTop: '0.375rem',
                padding: '0.375rem 0.625rem',
                background: colors.errorSubtle,
                borderRadius: '0.375rem',
                border: `1px solid ${colors.errorBorder}`
              }}>
                ⚠️ {error}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <button
              className="login-btn"
              type="button"
              onClick={handleLogin}
            >
              {t('login.signIn')}
            </button>
          </div>
          </form>
        )}
      </div>
    </div>
  );
}

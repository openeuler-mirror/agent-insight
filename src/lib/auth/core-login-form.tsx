'use client';

import { useState } from 'react';
import { useAuth } from './auth-context';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/client/api';

export function CoreLoginForm() {
  const { login } = useAuth();
  const [username, setUsername] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState(''); const [pending, setPending] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(''); setPending(true);
    try {
      const response = await apiFetch('/api/storage-core/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
      if (!response.ok) throw new Error(response.status === 401 ? '用户名或密码错误' : '暂时无法登录，请检查存储服务');
      const profile = await response.json();
      await login(profile.username, undefined, profile.display_name);
      setPassword('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '登录失败'); }
    finally { setPending(false); }
  }
  return <main className="min-h-screen flex items-center justify-center p-6 bg-[var(--background)] text-[var(--foreground)]">
    <section className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--background-secondary)] p-8">
      <h1 className="text-2xl font-semibold mb-2">Agent Insight</h1>
      <p className="text-sm text-[var(--foreground-secondary)] mb-6">登录 Trace 存储工作区</p>
      <form onSubmit={submit} className="space-y-4">
        <label className="block text-sm">用户名<Input required autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} className="mt-1 w-full" disabled={pending} /></label>
        <label className="block text-sm">密码<Input required type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className="mt-1 w-full" disabled={pending} /></label>
        {error && <p role="alert" className="text-sm text-[var(--color-error)]">{error}</p>}
        <Button type="submit" className="w-full" disabled={pending}>{pending ? '正在登录…' : '登录'}</Button>
      </form>
    </section>
  </main>;
}

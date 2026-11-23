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

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { useLocale } from '@/lib/client/locale-context';

export default function ChangePasswordPage() {
    const { t } = useLocale();
    const router = useRouter();
    const { clearPasswordChangeRequired, markPasswordInitialized, passwordInitialized } = useAuth();
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const needsSetup = !passwordInitialized;

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        setError('');
        if (newPassword !== confirmPassword) {
            setError(t('changePassword.mismatch'));
            return;
        }
        setBusy(true);
        try {
            const response = await apiFetch('/api/auth/password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword, newPassword }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                const message = String(data?.error || '');
                if (message.includes('Current password')) {
                    setError(t('changePassword.currentIncorrect'));
                } else if (message.startsWith('Password must')) {
                    setError(t('changePassword.rule'));
                } else {
                    setError(message || t('changePassword.failed'));
                }
                return;
            }
            markPasswordInitialized();
            clearPasswordChangeRequired();
            router.replace('/trace');
        } catch {
            setError(t('changePassword.failed'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <AppTopBar title={needsSetup ? t('changePassword.setupTitle') : t('changePassword.title')} />
            <PageContainer>
                <div className="mb-4 space-y-1">
                    <h1 className="text-xl font-semibold text-foreground">
                        {needsSetup ? t('changePassword.setupTitle') : t('changePassword.title')}
                    </h1>
                    <p className="text-sm text-foreground-muted">
                        {needsSetup ? t('changePassword.setupDescription') : t('changePassword.description')}
                    </p>
                </div>

                <form onSubmit={submit} className="max-w-sm space-y-3 rounded-lg border border-border bg-card p-4">
                    {!needsSetup && (
                        <div className="space-y-1">
                            <Label htmlFor="current-password">{t('changePassword.current')}</Label>
                            <Input
                                id="current-password"
                                type="password"
                                autoComplete="current-password"
                                value={currentPassword}
                                onChange={(event) => { setCurrentPassword(event.target.value); setError(''); }}
                            />
                        </div>
                    )}
                    <div className="space-y-1">
                        <Label htmlFor="new-password">{t('changePassword.newPassword')}</Label>
                        <Input
                            id="new-password"
                            type="password"
                            autoComplete="new-password"
                            value={newPassword}
                            onChange={(event) => { setNewPassword(event.target.value); setError(''); }}
                        />
                        <p className="text-xs text-foreground-muted">{t('changePassword.rule')}</p>
                    </div>
                    <div className="space-y-1">
                        <Label htmlFor="confirm-password">{t('changePassword.confirm')}</Label>
                        <Input
                            id="confirm-password"
                            type="password"
                            autoComplete="new-password"
                            value={confirmPassword}
                            onChange={(event) => { setConfirmPassword(event.target.value); setError(''); }}
                        />
                    </div>
                    {error && <p className="text-sm text-error">{error}</p>}
                    <Button type="submit" disabled={busy || !newPassword || (!needsSetup && !currentPassword)}>
                        {t('changePassword.submit')}
                    </Button>
                </form>
            </PageContainer>
        </>
    );
}

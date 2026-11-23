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

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { useLocale } from '@/lib/client/locale-context';

interface Account {
    username: string;
    externalAccount: string | null;
    isAdmin: boolean;
    hasPassword: boolean;
    createdAt: string | null;
    passwordUpdatedAt: string | null;
}

type SkipReason = 'invalid' | 'exists' | 'admin_confirmation_required';

interface ImportResult {
    created: string[];
    skipped: { username: string; reason: SkipReason }[];
}

function parseUsernames(raw: string): string[] {
    const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
    // 模版首行是表头，导入时跳过，避免把 "username" 当成账号创建。
    if (USERNAME_HEADER_ALIASES.has((lines[0] ?? '').trim().toLowerCase())) {
        lines.shift();
    }
    return lines
        .join('\n')
        .split(/[\s,;]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
}

const USERNAME_HEADER_ALIASES = new Set(['username', 'account', '账号', '账号名']);

const IMPORT_TEMPLATE_CSV = 'username\r\nalice@example.com\r\nbob@example.com\r\n';

export default function AccountsPage() {
    const { t } = useLocale();
    const { user, isAdmin, loginMode } = useAuth();
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [newUsername, setNewUsername] = useState('');
    const [busy, setBusy] = useState(false);
    const [pendingAdminCreate, setPendingAdminCreate] = useState(false);
    const [resetTarget, setResetTarget] = useState<string | null>(null);
    const [resetNewPassword, setResetNewPassword] = useState('');
    const [resetConfirmPassword, setResetConfirmPassword] = useState('');
    const [resetError, setResetError] = useState('');
    const [resetBusy, setResetBusy] = useState(false);
    const [importOpen, setImportOpen] = useState(false);
    const [importText, setImportText] = useState('');
    const [importing, setImporting] = useState(false);
    const [importError, setImportError] = useState('');
    const [importResult, setImportResult] = useState<ImportResult | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
    const [deleting, setDeleting] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const load = useCallback(async () => {
        setError('');
        try {
            const response = await apiFetch('/api/admin/accounts', { cache: 'no-store' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data?.error || t('accounts.loadFailed'));
            setAccounts(Array.isArray(data?.accounts) ? data.accounts : []);
        } catch (err) {
            setError((err as Error).message || t('accounts.loadFailed'));
        } finally {
            setLoading(false);
        }
    }, [t]);

    useEffect(() => {
        if (!isAdmin || loginMode !== 'standalone') {
            setLoading(false);
            return;
        }
        void load();
    }, [isAdmin, load, loginMode]);

    const createAccount = async (acknowledgeAdmin = false) => {
        const username = newUsername.trim();
        if (!username || busy) return;
        setBusy(true);
        setError('');
        try {
            const response = await apiFetch('/api/admin/accounts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, acknowledgeAdmin }),
            });
            const data = await response.json().catch(() => ({}));
            if (response.status === 409 && data?.code === 'admin_confirmation_required') {
                setPendingAdminCreate(true);
                return;
            }
            if (!response.ok) throw new Error(data?.error || t('accounts.createFailed'));
            setNewUsername('');
            await load();
        } catch (err) {
            setError((err as Error).message || t('accounts.createFailed'));
        } finally {
            setBusy(false);
        }
    };

    const closeReset = () => {
        setResetTarget(null);
        setResetNewPassword('');
        setResetConfirmPassword('');
        setResetError('');
    };

    const submitReset = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!resetTarget || resetBusy) return;
        setResetError('');
        if (resetNewPassword !== resetConfirmPassword) {
            setResetError(t('changePassword.mismatch'));
            return;
        }
        setResetBusy(true);
        try {
            const response = await apiFetch(
                `/api/admin/accounts/${encodeURIComponent(resetTarget)}/reset-password`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: resetNewPassword }),
                },
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                const message = String(data?.error || '');
                throw new Error(
                    message.startsWith('Password must') ? t('changePassword.rule') : (message || t('accounts.resetFailed')),
                );
            }
            closeReset();
            await load();
        } catch (err) {
            setResetError((err as Error).message || t('accounts.resetFailed'));
        } finally {
            setResetBusy(false);
        }
    };

    const submitImport = async () => {
        const usernames = parseUsernames(importText);
        if (usernames.length === 0 || importing) {
            if (usernames.length === 0) setImportError(t('accounts.batchEmpty'));
            return;
        }
        setImporting(true);
        setImportError('');
        try {
            const response = await apiFetch('/api/admin/accounts/batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ usernames }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data?.error || t('accounts.batchFailed'));
            setImportResult({
                created: Array.isArray(data?.created) ? data.created : [],
                skipped: Array.isArray(data?.skipped) ? data.skipped : [],
            });
            await load();
        } catch (err) {
            setImportError((err as Error).message || t('accounts.batchFailed'));
        } finally {
            setImporting(false);
        }
    };

    const deleteAccount = async () => {
        if (!deleteTarget || deleting) return;
        setDeleting(true);
        setError('');
        try {
            const response = await apiFetch(
                `/api/admin/accounts/${encodeURIComponent(deleteTarget)}`,
                { method: 'DELETE' },
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data?.error || t('accounts.deleteFailed'));
            await load();
        } catch (err) {
            setError((err as Error).message || t('accounts.deleteFailed'));
        } finally {
            setDeleting(false);
        }
    };

    const downloadImportTemplate = () => {
        // 带 BOM，避免 Excel 打开中文表头时乱码。
        const blob = new Blob([`\uFEFF${IMPORT_TEMPLATE_CSV}`], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'account-import-template.csv';
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    };

    const handleImportOpenChange = (open: boolean) => {
        setImportOpen(open);
        if (!open) {
            setImportText('');
            setImportResult(null);
            setImportError('');
        }
    };

    const pickImportFile = () => fileInputRef.current?.click();

    const readImportFile = async (file: File | undefined) => {
        if (!file) return;
        setImportText(await file.text());
        setImportResult(null);
        setImportError('');
    };

    const formatTime = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');

    const skipReasonLabel = (reason: SkipReason) => {
        if (reason === 'exists') return t('accounts.batchReasonExists');
        if (reason === 'admin_confirmation_required') return t('accounts.batchReasonAdmin');
        return t('accounts.batchReasonInvalid');
    };

    if (!isAdmin || loginMode !== 'standalone') {
        return (
            <>
                <AppTopBar title={t('nav.accounts')} />
                <PageContainer>
                    <p className="text-sm text-foreground-muted">{t('accounts.adminOnly')}</p>
                </PageContainer>
            </>
        );
    }

    return (
        <>
            <AppTopBar title={t('nav.accounts')} />
            <PageContainer>
                <div className="mb-4 space-y-1">
                    <h1 className="text-xl font-semibold text-foreground">{t('accounts.title')}</h1>
                    <p className="text-sm text-foreground-muted">{t('accounts.description')}</p>
                </div>

                <div className="mb-4 flex flex-wrap items-center gap-2">
                    <Input
                        value={newUsername}
                        onChange={(event) => setNewUsername(event.target.value)}
                        placeholder={t('accounts.createPlaceholder')}
                        className="max-w-xs"
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') void createAccount();
                        }}
                    />
                    <Button onClick={() => void createAccount()} disabled={busy || !newUsername.trim()}>
                        {t('accounts.create')}
                    </Button>
                    <Button variant="outline" onClick={() => setImportOpen(true)}>
                        {t('accounts.batchImport')}
                    </Button>
                </div>

                {error && (
                    <div className="mb-4 rounded-md border border-border bg-card px-3 py-2 text-sm text-error">
                        {error}
                    </div>
                )}

                <div className="overflow-x-auto rounded-lg border border-border bg-card">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-border text-left text-foreground-muted">
                                <th className="px-3 py-2 font-medium">{t('accounts.username')}</th>
                                <th className="px-3 py-2 font-medium">{t('accounts.status')}</th>
                                <th className="px-3 py-2 font-medium">{t('accounts.createdAt')}</th>
                                <th className="px-3 py-2 font-medium">{t('accounts.passwordUpdatedAt')}</th>
                                <th className="px-3 py-2 font-medium" />
                            </tr>
                        </thead>
                        <tbody>
                            {accounts.map((account) => (
                                <tr key={account.username} className="border-b border-border last:border-0">
                                    <td className="px-3 py-2 text-foreground">
                                        {account.username}
                                        {account.isAdmin && (
                                            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground-muted">
                                                {t('accounts.isAdmin')}
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-3 py-2 text-foreground-muted">
                                        {account.hasPassword ? t('accounts.initialized') : t('accounts.notInitialized')}
                                    </td>
                                    <td className="px-3 py-2 text-foreground-muted">{formatTime(account.createdAt)}</td>
                                    <td className="px-3 py-2 text-foreground-muted">{formatTime(account.passwordUpdatedAt)}</td>
                                    <td className="px-3 py-2">
                                        <div className="flex items-center justify-end gap-2">
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                disabled={busy || resetBusy}
                                                onClick={() => {
                                                    setResetNewPassword('');
                                                    setResetConfirmPassword('');
                                                    setResetError('');
                                                    setResetTarget(account.username);
                                                }}
                                            >
                                                {t('accounts.reset')}
                                            </Button>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="text-error"
                                                disabled={busy || deleting || account.username === user}
                                                title={account.username === user ? t('accounts.deleteSelf') : undefined}
                                                onClick={() => setDeleteTarget(account.username)}
                                            >
                                                {t('accounts.delete')}
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {!loading && accounts.length === 0 && (
                                <tr>
                                    <td colSpan={5} className="px-3 py-6 text-center text-foreground-muted">
                                        {t('accounts.empty')}
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </PageContainer>

            <ConfirmDialog
                open={pendingAdminCreate}
                onOpenChange={setPendingAdminCreate}
                title={t('accounts.adminConfirmTitle')}
                description={t('accounts.adminWarning')}
                confirmText={t('accounts.create')}
                cancelText={t('common.cancel')}
                onConfirm={async () => { await createAccount(true); }}
            />

            <ConfirmDialog
                open={Boolean(deleteTarget)}
                onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
                title={t('accounts.deleteConfirmTitle')}
                description={t('accounts.deleteConfirmDescription', { username: deleteTarget ?? '' })}
                confirmText={t('accounts.delete')}
                cancelText={t('common.cancel')}
                tone="danger"
                onConfirm={deleteAccount}
            />

            <Dialog
                open={Boolean(resetTarget)}
                onOpenChange={(open) => { if (!open) closeReset(); }}
            >
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t('accounts.resetConfirmTitle')}</DialogTitle>
                        <DialogDescription>{t('accounts.resetDescription')}</DialogDescription>
                    </DialogHeader>
                    <form className="space-y-3" onSubmit={submitReset}>
                        <div className="space-y-1">
                            <Label htmlFor="reset-new-password">{t('changePassword.newPassword')}</Label>
                            <Input
                                id="reset-new-password"
                                type="password"
                                autoComplete="new-password"
                                value={resetNewPassword}
                                onChange={(event) => { setResetNewPassword(event.target.value); setResetError(''); }}
                            />
                            <p className="text-xs text-foreground-muted">{t('changePassword.rule')}</p>
                        </div>
                        <div className="space-y-1">
                            <Label htmlFor="reset-confirm-password">{t('changePassword.confirm')}</Label>
                            <Input
                                id="reset-confirm-password"
                                type="password"
                                autoComplete="new-password"
                                value={resetConfirmPassword}
                                onChange={(event) => { setResetConfirmPassword(event.target.value); setResetError(''); }}
                            />
                        </div>
                        {resetError && <p className="text-sm text-error">{resetError}</p>}
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={closeReset}>
                                {t('common.cancel')}
                            </Button>
                            <Button type="submit" disabled={resetBusy || !resetNewPassword}>
                                {t('changePassword.submit')}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>

            <Dialog open={importOpen} onOpenChange={handleImportOpenChange}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>{t('accounts.batchTitle')}</DialogTitle>
                        <DialogDescription>{t('accounts.batchDescription')}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-2">
                        <Textarea
                            rows={8}
                            value={importText}
                            onChange={(event) => {
                                setImportText(event.target.value);
                                setImportResult(null);
                                setImportError('');
                            }}
                            placeholder={t('accounts.batchPlaceholder')}
                        />
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".txt,.csv,text/plain,text/csv"
                            className="hidden"
                            onChange={(event) => void readImportFile(event.target.files?.[0])}
                        />
                        <div className="flex flex-wrap items-center gap-2">
                            <Button variant="outline" size="sm" onClick={pickImportFile}>
                                {t('accounts.batchPickFile')}
                            </Button>
                            <Button variant="outline" size="sm" onClick={downloadImportTemplate}>
                                {t('accounts.batchDownloadTemplate')}
                            </Button>
                        </div>
                    </div>
                    {importError && <p className="text-sm text-error">{importError}</p>}
                    {importResult && (
                        <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
                            <p className="text-foreground">
                                {t('accounts.batchResult', {
                                    created: String(importResult.created.length),
                                    skipped: String(importResult.skipped.length),
                                })}
                            </p>
                            {importResult.skipped.length > 0 && (
                                <ul className="max-h-40 space-y-1 overflow-y-auto text-foreground-muted">
                                    {importResult.skipped.map((entry) => (
                                        <li key={entry.username}>
                                            {entry.username} · {skipReasonLabel(entry.reason)}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                    <DialogFooter>
                        <Button variant="outline" onClick={() => handleImportOpenChange(false)}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            onClick={() => void submitImport()}
                            disabled={importing || parseUsernames(importText).length === 0}
                        >
                            {t('accounts.batchSubmit')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

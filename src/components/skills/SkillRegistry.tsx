'use client';

/**
 * SkillRegistry —— 保留旧的 SkillUpload / EnterpriseSync 上传逻辑，
 * 但目录与详情已迁移到 SkillCatalogV2（对齐 v2 高保真稿）。
 * 老的 SkillVersionsModal / SkillVersionDetailModal 已下线（其中还包含
 * 缺失的 SkillCardItem 引用，导致页面渲染异常）。
 */

import { useAuth } from '@/lib/auth/auth-context';
import { useLocale } from '@/lib/client/locale-context';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/client/api';
import { SkillCatalogV2 } from './SkillCatalogV2';
import { ArrowRight, FolderUp, RefreshCw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface EnterpriseSyncResult {
    totalSkills?: number;
    successCount?: number;
    failedCount?: number;
    results?: Array<{ success?: boolean; skillName?: string; version?: number | string; error?: string }>;
}

export function EnterpriseSync({ onSuccess }: { onSuccess: () => void }) {
    const { apiKey } = useAuth();
    const { t } = useLocale();

    const [syncing, setSyncing] = useState(false);
    const [syncResult, setSyncResult] = useState<EnterpriseSyncResult | null>(null);
    const [syncProgress, setSyncProgress] = useState('');

    const handleSyncFromEnterprise = async () => {
        setSyncing(true);
        setSyncProgress(t('skill.syncingProgress'));
        setSyncResult(null);

        try {
            const res = await apiFetch('/api/skills/sync-enterprise', {
                method: 'POST',
                headers: apiKey ? { 'x-witty-api-key': apiKey } : {}
            });

            const result = await res.json();
            if (res.ok) {
                setSyncProgress(t('skill.syncComplete'));
                setSyncResult(result);
                toast.success(t('skill.syncComplete'));
                onSuccess();
            } else {
                setSyncProgress(`同步失败: ${result.error}`);
                toast.error(`同步失败: ${result.error}`);
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            setSyncProgress(`同步出错: ${message}`);
            toast.error(t('skill.syncError'));
        } finally {
            setSyncing(false);
        }
    };

    return (
        <div className="flex flex-col gap-3">
            <Button
                size="lg"
                onClick={handleSyncFromEnterprise}
                disabled={syncing}
                className="w-full"
            >
                <RefreshCw className={cn('size-4', syncing && 'animate-spin')} />
                {syncing ? t('skill.syncing') : t('skill.syncStart')}
            </Button>
            <div className="-mt-1 text-center text-[11px] text-foreground-muted">
                {t('skill.syncDescription')}
            </div>

            {syncProgress && (
                <div className="text-xs text-foreground-secondary">{syncProgress}</div>
            )}

            {syncResult && (
                <div className="flex flex-col gap-1 rounded-md border border-border bg-card p-3 text-xs text-foreground-secondary">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
                        {t('skill.syncResult')}
                    </div>
                    <div>{t('skill.totalSkillsCount')}: {syncResult.totalSkills}</div>
                    <div className="text-success">{t('skill.successCount')}: {syncResult.successCount}</div>
                    <div className="text-error">{t('skill.failedCount')}: {syncResult.failedCount}</div>
                    {(syncResult.failedCount ?? 0) > 0 && (
                        <details className="mt-1">
                            <summary className="cursor-pointer text-foreground-secondary">查看失败详情</summary>
                            <ul className="mt-1 ml-5 list-disc space-y-0.5">
                                {(syncResult.results || []).filter(r => !r.success).map((r, i) => (
                                    <li key={i} className="text-error">
                                        {r.skillName} (v{r.version}): {r.error}
                                    </li>
                                ))}
                            </ul>
                        </details>
                    )}
                </div>
            )}
        </div>
    );
}

export function SkillUpload({ onSuccess }: { onSuccess: () => void }) {
    const { t } = useLocale();
    const { user } = useAuth();
    const [uploading, setUploading] = useState(false);
    const [logs, setLogs] = useState<string[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        setUploading(true);
        setLogs([t('skill.preparingUpload')]);

        const formData = new FormData();
        if (user) formData.append('user', user);
        for (let i = 0; i < files.length; i++) {
            formData.append('files', files[i]);
            formData.append('paths', files[i].webkitRelativePath);
        }

        try {
            setLogs(prev => [...prev, `Uploading ${files.length} files...`]);
            const res = await apiFetch('/api/skills/upload', { method: 'POST', body: formData });

            const result = await res.json();
            if (res.ok) {
                setLogs(prev => [...prev, 'Upload successful!', `Skill: ${result.skill.name} (v${result.version.version})`]);
                toast.success(t('skill.uploadSuccess'));
                onSuccess();
            } else {
                setLogs(prev => [...prev, `Error: ${result.error}`]);
                toast.error(`上传失败：${result.error}`);
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            setLogs(prev => [...prev, `Network Error: ${message}`]);
            toast.error(t('skill.uploadError'));
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1 rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-xs text-foreground-secondary">
                <ul className="ml-4 list-disc space-y-0.5">
                    <li>请将整个 Skill 文件夹（含 <code className="rounded-sm bg-background-tertiary px-1 font-mono text-[11px] text-foreground">SKILL.md</code>）一起选中上传</li>
                    <li>文件夹名只允许英文字符、数字与连字符，不可包含中文</li>
                </ul>
            </div>

            <Button
                size="lg"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="w-full"
            >
                <FolderUp className="size-4" />
                {uploading ? '正在上传…' : '选择文件夹并上传'}
            </Button>
            <div className="-mt-1 text-center text-[11px] text-foreground-muted">
                选中文件夹后将立即开始上传，无需二次确认
            </div>

            <input
                ref={fileInputRef}
                type="file"
                // @ts-expect-error webkitdirectory 是非标准属性
                webkitdirectory=""
                directory=""
                multiple
                className="hidden"
                onChange={handleFolderSelect}
            />

            {logs.length > 0 && (
                <div className="flex max-h-[150px] flex-col gap-1 overflow-y-auto rounded-md border border-border bg-card p-3 font-mono text-[11px] text-foreground-secondary">
                    {logs.map((log, i) => (
                        <div key={i} className="border-b border-border pb-1 last:border-b-0 last:pb-0">{log}</div>
                    ))}
                </div>
            )}
        </div>
    );
}

export function SkillGenerate({ onNavigate }: { onNavigate?: () => void }) {
    const router = useRouter();
    const handleClick = () => {
        onNavigate?.();
        router.push('/skill-generator');
    };
    return (
        <div className="flex flex-col gap-3">
            <div className="rounded-md border border-primary-border bg-primary-subtle px-3 py-2 text-xs text-foreground-secondary">
                生成器支持通过自然语言对话定义 Skill 的能力边界与结构。生成结果会自动入库为新的 Skill。
            </div>
            <Button size="lg" onClick={handleClick} className="w-full">
                <Sparkles className="size-4" />
                打开 Skill 生成器
                <ArrowRight className="size-4" />
            </Button>
            <div className="-mt-1 text-center text-[11px] text-foreground-muted">
                将跳转到生成器页面
            </div>
        </div>
    );
}

export function SkillCatalog({ refresh, onUploadClick }: { refresh: number; onUploadClick?: () => void }) {
    return <SkillCatalogV2 refresh={refresh} onUploadClick={onUploadClick} />;
}

export default function SkillRegistry() {
    const { t } = useLocale();
    const [activeTab, setActiveTab] = useState<'catalog' | 'upload'>('catalog');
    const [refreshKey, setRefreshKey] = useState(0);
    const [isEnterpriseMode, setIsEnterpriseMode] = useState(false);

    useEffect(() => {
        apiFetch('/api/eval/config/status?check_org=true')
            .then(res => res.json())
            .then(data => setIsEnterpriseMode(data.org_mode || false))
            .catch(() => {});
    }, []);

    return (
        <div style={{ marginTop: '1rem' }}>
            <div className="nav-tabs">
                <button onClick={() => setActiveTab('catalog')} className={`nav-tab-item ${activeTab === 'catalog' ? 'active' : ''}`}>
                    {t('nav.catalog')}
                </button>
                <button onClick={() => setActiveTab('upload')} className={`nav-tab-item ${activeTab === 'upload' ? 'active' : ''}`}>
                    {t('nav.upload')}
                </button>
            </div>

            <div style={{ minHeight: '400px' }}>
                {activeTab === 'catalog' && <SkillCatalog refresh={refreshKey} onUploadClick={() => setActiveTab('upload')} />}

                {activeTab === 'upload' && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '2rem' }}>
                        <SkillUpload onSuccess={() => { setRefreshKey(k => k + 1); setActiveTab('catalog'); }} />
                        {isEnterpriseMode && <EnterpriseSync onSuccess={() => setRefreshKey(k => k + 1)} />}
                    </div>
                )}
            </div>
        </div>
    );
}

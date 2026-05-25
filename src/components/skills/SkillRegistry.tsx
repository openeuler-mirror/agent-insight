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
import { apiFetch } from '@/lib/client/api';
import { SkillCatalogV2 } from './SkillCatalogV2';
import { FolderUp, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

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
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)', overflow: 'hidden' }}>
            <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--primary-subtle)', color: 'var(--primary)' }}>
                    <RefreshCw size={16} />
                </span>
                <div>
                    <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--foreground)' }}>{t('skill.syncFromEnterprise')}</h3>
                    <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--foreground-muted)' }}>{t('skill.syncDescription')}</p>
                </div>
            </div>
            <div style={{ padding: 18 }}>
            <button
                type="button"
                onClick={handleSyncFromEnterprise}
                disabled={syncing}
                style={{
                    height: 36,
                    padding: '0 14px',
                    borderRadius: 8,
                    border: '1px solid var(--primary)',
                    background: 'var(--primary)',
                    color: '#fff',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: syncing ? 'not-allowed' : 'pointer',
                    opacity: syncing ? 0.65 : 1,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                }}
            >
                <RefreshCw size={14} />
                {syncing ? t('skill.syncing') : t('skill.syncStart')}
            </button>

            {syncProgress && (
                <div style={{ marginTop: 12, color: 'var(--foreground-secondary)', fontSize: 12 }}>
                    {syncProgress}
                </div>
            )}

            {syncResult && (
                <div style={{ marginTop: 12, padding: 12, background: 'var(--background-secondary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, color: 'var(--foreground-secondary)' }}>
                    <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>{t('skill.syncResult')}</div>
                    <div>{t('skill.totalSkillsCount')}: {syncResult.totalSkills}</div>
                    <div style={{ color: 'var(--success)' }}>{t('skill.successCount')}: {syncResult.successCount}</div>
                    <div style={{ color: 'var(--error)' }}>{t('skill.failedCount')}: {syncResult.failedCount}</div>
                    {(syncResult.failedCount ?? 0) > 0 && (
                        <details style={{ marginTop: '0.5rem' }}>
                            <summary style={{ cursor: 'pointer', color: 'var(--foreground-secondary)' }}>查看失败详情</summary>
                            <ul style={{ marginTop: '0.5rem', paddingLeft: '1.5rem' }}>
                                {(syncResult.results || []).filter(r => !r.success).map((r, i) => (
                                    <li key={i} style={{ color: 'var(--error)' }}>
                                        {r.skillName} (v{r.version}): {r.error}
                                    </li>
                                ))}
                            </ul>
                        </details>
                    )}
                </div>
            )}
            </div>
        </div>
    );
}

interface SkillForVersionUpload {
    id: string;
    name: string;
    activeVersion?: number | null;
    version?: number | null;
}

export function SkillUpload({ onSuccess }: { onSuccess: () => void }) {
    const { t } = useLocale();
    const { user } = useAuth();
    const [uploading, setUploading] = useState(false);
    const [logs, setLogs] = useState<string[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // 上传模式: 新 skill / 给某个现有 skill 加版本
    // 后端 /api/skills/upload 早就支持 targetSkillId（line 67-105）,但之前
    // 前端没暴露,导致用户只能上传新 skill,同名上传就被后端拒绝。
    const [mode, setMode] = useState<'new' | 'version'>('new');
    const [skillList, setSkillList] = useState<SkillForVersionUpload[]>([]);
    const [targetSkillId, setTargetSkillId] = useState<string>('');
    const [skillsLoading, setSkillsLoading] = useState(false);

    // 加载用户已有的 skill 列表（仅在切到 version 模式时拉）
    useEffect(() => {
        if (mode !== 'version' || !user) return;
        let aborted = false;
        setSkillsLoading(true);
        apiFetch(`/api/skills?user=${encodeURIComponent(user)}`)
            .then(r => r.ok ? r.json() : [])
            .then((data: SkillForVersionUpload[]) => {
                if (aborted) return;
                const list = Array.isArray(data) ? data : [];
                setSkillList(list);
                if (list.length > 0 && !targetSkillId) setTargetSkillId(list[0].id);
            })
            .catch(() => { if (!aborted) setSkillList([]); })
            .finally(() => { if (!aborted) setSkillsLoading(false); });
        return () => { aborted = true; };
    }, [mode, user]); // eslint-disable-line react-hooks/exhaustive-deps

    const targetSkill = skillList.find(s => s.id === targetSkillId) || null;

    const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        // version 模式校验:必须选了目标 skill,且文件夹名跟 skill name 一致
        if (mode === 'version') {
            if (!targetSkill) {
                alert('请先选择要追加版本的 Skill');
                if (fileInputRef.current) fileInputRef.current.value = '';
                return;
            }
            const firstPath = files[0]?.webkitRelativePath || '';
            const folderName = firstPath.split('/')[0];
            if (folderName && folderName !== targetSkill.name) {
                alert(`文件夹名「${folderName}」与目标 Skill「${targetSkill.name}」不一致。\n上传新版本必须使用相同的文件夹名。`);
                if (fileInputRef.current) fileInputRef.current.value = '';
                return;
            }
        }

        setUploading(true);
        setLogs([t('skill.preparingUpload')]);

        const formData = new FormData();
        if (user) formData.append('user', user);
        if (mode === 'version' && targetSkillId) {
            formData.append('targetSkillId', targetSkillId);
        }
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
                toast.success(mode === 'version'
                    ? `新版本上传成功：${result.skill.name} v${result.version.version}`
                    : t('skill.uploadSuccess'));
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
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)', overflow: 'hidden' }}>
            <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--primary-subtle)', color: 'var(--primary)' }}>
                    <FolderUp size={16} />
                </span>
                <div>
                    <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--foreground)' }}>{t('skill.uploadTitle')}</h3>
                    <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--foreground-muted)' }}>{t('skill.uploadDescription')}</p>
                </div>
            </div>
            <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12, color: 'var(--foreground-secondary)' }}>
                    <span style={{ padding: '3px 8px', borderRadius: 6, background: 'var(--warning-subtle)', color: 'var(--warning)' }}>{t('skill.uploadNote1')}</span>
                    <span style={{ padding: '3px 8px', borderRadius: 6, background: 'var(--error-subtle)', color: 'var(--error)' }}>{t('skill.uploadNote2')}</span>
                </div>

                <div style={{ display: 'inline-flex', alignSelf: 'center', gap: 4, background: 'var(--background-secondary)', padding: 4, borderRadius: 8, border: '1px solid var(--border)' }}>
                    {([
                        { id: 'new', label: '上传新 Skill' },
                        { id: 'version', label: '为现有 Skill 加版本' },
                    ] as const).map(item => (
                        <button
                            key={item.id}
                            type="button"
                            onClick={() => {
                                setMode(item.id);
                                if (item.id === 'new') setTargetSkillId('');
                            }}
                            disabled={uploading}
                            style={{
                                height: 30,
                                padding: '0 12px',
                                borderRadius: 6,
                                border: 'none',
                                background: mode === item.id ? 'var(--primary)' : 'transparent',
                                color: mode === item.id ? '#fff' : 'var(--foreground-secondary)',
                                fontSize: 12,
                                fontWeight: 600,
                                cursor: uploading ? 'not-allowed' : 'pointer',
                            }}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>

                {mode === 'version' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {skillsLoading ? (
                        <span style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>正在加载已有 Skill…</span>
                    ) : skillList.length === 0 ? (
                        <span style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>你还没有任何 Skill，先用“上传新 Skill”创建第一个</span>
                    ) : (
                        <>
                            <div style={{ fontSize: 11, color: 'var(--foreground-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}>
                                目标 Skill
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8, maxHeight: 150, overflowY: 'auto', paddingRight: 2 }}>
                                {skillList.map(s => (
                                    <button
                                        key={s.id}
                                        type="button"
                                        onClick={() => setTargetSkillId(s.id)}
                                        disabled={uploading}
                                        style={{
                                            textAlign: 'left',
                                            padding: '9px 10px',
                                            borderRadius: 8,
                                            border: `1px solid ${targetSkillId === s.id ? 'var(--primary)' : 'var(--border)'}`,
                                            background: targetSkillId === s.id ? 'var(--primary-subtle)' : 'var(--background)',
                                            color: 'var(--foreground)',
                                            cursor: uploading ? 'not-allowed' : 'pointer',
                                            minWidth: 0,
                                        }}
                                    >
                                        <div style={{ fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                                        <div style={{ marginTop: 2, fontSize: 11, color: 'var(--foreground-muted)' }}>
                                            {(s.activeVersion ?? s.version) != null ? `当前 v${s.activeVersion ?? s.version}` : '暂无版本'}
                                        </div>
                                    </button>
                                ))}
                            </div>
                            {targetSkill && (
                                <span style={{ fontSize: 12, color: 'var(--foreground-secondary)' }}>
                                    文件夹名必须为 <b style={{ color: 'var(--foreground)' }}>{targetSkill.name}</b>，新版本号自动递增
                                </span>
                            )}
                        </>
                    )}
                </div>
                )}

            <div style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
                <button
                    type="button"
                    style={{
                        height: 38,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '0 14px',
                        borderRadius: 8,
                        border: '1px solid var(--primary)',
                        background: 'var(--primary)',
                        color: '#fff',
                        fontSize: 13,
                        fontWeight: 700,
                        cursor: uploading || (mode === 'version' && !targetSkillId) ? 'not-allowed' : 'pointer',
                        opacity: uploading || (mode === 'version' && !targetSkillId) ? 0.65 : 1,
                    }}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading || (mode === 'version' && !targetSkillId)}
                >
                    <FolderUp size={15} />
                    <span>{mode === 'version' && targetSkill ? `选择文件夹（${targetSkill.name}/）` : t('skill.selectFolder')}</span>
                </button>
                <input
                    ref={fileInputRef}
                    type="file"
                    // @ts-expect-error webkitdirectory 是非标准属性
                    webkitdirectory=""
                    directory=""
                    multiple
                    style={{ display: 'none' }}
                    onChange={handleFolderSelect}
                />
            </div>

            {logs.length > 0 && (
                <div style={{ width: '100%', textAlign: 'left', background: 'var(--background-secondary)', border: '1px solid var(--border)', padding: 12, borderRadius: 8, maxHeight: 150, overflowY: 'auto' }}>
                    {logs.map((log, i) => (
                        <div key={i} style={{ color: 'var(--foreground-secondary)', fontSize: 11, fontFamily: 'JetBrains Mono, ui-monospace, monospace', marginBottom: 4, borderBottom: '1px solid var(--border)', paddingBottom: 3 }}>{log}</div>
                    ))}
                </div>
            )}
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

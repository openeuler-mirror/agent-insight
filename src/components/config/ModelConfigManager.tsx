'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
    Plus,
    Search,
    Server,
    Key,
    Eye,
    EyeOff,
    Copy,
    Pencil,
    Trash2,
    Check,
    Info,
    CircleCheck,
    BadgeCheck,
    Star,
    HeartPulse,
    BookOpen,
    ExternalLink,
    RefreshCw,
    Loader2,
    XCircle,
} from 'lucide-react';
import { apiFetch } from '@/lib/client/api';
import { useAuth } from '@/lib/auth/auth-context';
import { useLocale } from '@/lib/client/locale-context';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
    LLM_PROVIDERS,
    CATEGORY_ORDER,
    getProviderLogoUrl,
    resolveCatalogProvider,
    type LlmProvider,
    type LlmProviderCategory,
} from '@/lib/llm-providers';

export interface EvalConfigItem {
    id: string;
    name: string;
    provider: 'deepseek-official' | 'openai' | 'anthropic' | 'siliconflow' | 'custom';
    apiKey?: string;
    baseUrl?: string;
    model?: string;
}

interface ProviderPreset {
    baseUrl: string;
    model: string;
}

const PROVIDER_PRESETS: Record<EvalConfigItem['provider'], ProviderPreset> = {
    'deepseek-official': { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
    siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
    anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-20240620' },
    custom: { baseUrl: '', model: '' },
};

type ProviderCategory = 'saas' | 'cn' | 'local' | 'other';

const PROVIDER_META: Record<EvalConfigItem['provider'], {
    label: string;
    monogram: string;
    category: ProviderCategory;
}> = {
    'deepseek-official': { label: 'DeepSeek (Official)', monogram: 'DS', category: 'cn' },
    siliconflow:         { label: 'SiliconFlow',         monogram: 'SF', category: 'cn' },
    openai:              { label: 'OpenAI',              monogram: 'OA', category: 'saas' },
    anthropic:           { label: 'Anthropic',           monogram: 'AN', category: 'saas' },
    custom:              { label: 'Custom (OpenAI Compatible)', monogram: 'CX', category: 'other' },
};

const CAPACITY_LIMIT = 32;

type HealthState = 'ok' | 'checking' | 'failed' | 'unconfigured';

const isDefaultConfig = (id: string | null) => !!id && id.startsWith('default_');

const initialHealth = (c: EvalConfigItem): HealthState => (c.apiKey ? 'ok' : 'unconfigured');

function toBackendProvider(catalogId: string): EvalConfigItem['provider'] {
    if (catalogId === 'openai') return 'openai';
    if (catalogId === 'anthropic') return 'anthropic';
    if (catalogId === 'deepseek-official') return 'deepseek-official';
    if (catalogId === 'siliconflow') return 'siliconflow';
    return 'custom';
}

export interface ModelConfigManagerProps {}

export function ModelConfigManager({}: ModelConfigManagerProps = {}) {
    const { user } = useAuth();
    const { t, locale } = useLocale();

    const [allConfigs, setAllConfigs] = useState<EvalConfigItem[]>([]);
    const [activeConfigId, setActiveConfigId] = useState<string>('default');
    const [editingConfigId, setEditingConfigId] = useState<string | null>(null);
    const [tempConfig, setTempConfig] = useState<EvalConfigItem>({
        id: 'new', name: locale === 'zh' ? '新配置' : 'New Config', provider: 'deepseek-official', model: 'deepseek-chat',
    });
    const [isSaving, setIsSaving] = useState(false);
    const [status, setStatus] = useState<{ type: 'success' | 'error' | 'info', msg: string } | null>(null);
    const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
    const [loaded, setLoaded] = useState(false);
    const [query, setQuery] = useState('');
    const [categoryFilter, setCategoryFilter] = useState<'all' | ProviderCategory>('all');
    const [pendingDelete, setPendingDelete] = useState<EvalConfigItem | null>(null);
    const [healthMap, setHealthMap] = useState<Record<string, HealthState>>({});
    const [isRechecking, setIsRechecking] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [pickedProvider, setPickedProvider] = useState<LlmProvider | null>(null);

    const fetchSettings = useCallback(async () => {
        if (!user) {
            setLoaded(true);
            return;
        }
        try {
            const res = await apiFetch(`/api/eval/settings?user=${encodeURIComponent(user)}`);
            if (res.ok) {
                const data = await res.json();
                if (data.configs) {
                    setAllConfigs(data.configs);
                    setActiveConfigId(data.activeConfigId || data.configs[0]?.id || 'default');
                }
            }
        } catch (e) {
            console.error('Failed to fetch settings', e);
        } finally {
            setLoaded(true);
        }
    }, [user]);

    useEffect(() => {
        fetchSettings();
    }, [fetchSettings]);

    useEffect(() => {
        setHealthMap(prev => {
            const next: Record<string, HealthState> = { ...prev };
            for (const c of allConfigs) {
                if (!(c.id in next)) next[c.id] = initialHealth(c);
            }
            for (const k of Object.keys(next)) {
                if (!allConfigs.find(x => x.id === k)) delete next[k];
            }
            return next;
        });
    }, [allConfigs]);

    const recheckHealth = useCallback(async () => {
        if (isRechecking || allConfigs.length === 0) return;
        setIsRechecking(true);
        setHealthMap(prev => {
            const n: Record<string, HealthState> = { ...prev };
            for (const c of allConfigs) n[c.id] = c.apiKey ? 'checking' : 'unconfigured';
            return n;
        });
        const results = await Promise.all(allConfigs.map(async (c) => {
            if (!c.apiKey) return [c.id, 'unconfigured' as HealthState] as const;
            try {
                const res = await apiFetch('/api/eval/settings/test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        provider: c.provider,
                        apiKey: c.apiKey,
                        baseUrl: c.baseUrl,
                        model: c.model,
                    }),
                });
                const data = await res.json().catch(() => ({ success: false }));
                return [c.id, (data.success ? 'ok' : 'failed') as HealthState] as const;
            } catch {
                return [c.id, 'failed' as HealthState] as const;
            }
        }));
        setHealthMap(prev => {
            const n: Record<string, HealthState> = { ...prev };
            for (const [id, state] of results) n[id] = state;
            return n;
        });
        setIsRechecking(false);
    }, [allConfigs, isRechecking]);

    const persist = useCallback(async (configs: EvalConfigItem[], activeId: string) => {
        const finalPayload = { settings: { activeConfigId: activeId, configs }, user };
        return apiFetch('/api/eval/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(finalPayload),
        });
    }, [user]);

    const saveCurrentConfig = async () => {
        setIsSaving(true);
        setStatus({ type: 'info', msg: locale === 'zh' ? '正在测试连接…' : 'Testing connection…' });
        try {
            let newConfigs = [...allConfigs];
            const configToSave = { ...tempConfig };
            if (configToSave.id === 'new') {
                configToSave.id = `config_${Date.now()}`;
                newConfigs.push(configToSave);
            } else {
                newConfigs = newConfigs.map(c => (c.id === configToSave.id ? configToSave : c));
            }

            const testRes = await apiFetch('/api/eval/settings/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider: configToSave.provider,
                    apiKey: configToSave.apiKey,
                    baseUrl: configToSave.baseUrl,
                    model: configToSave.model,
                }),
            });
            const testData = await testRes.json();
            if (!testData.success) {
                setStatus({ type: 'error', msg: (locale === 'zh' ? '连接测试失败：' : 'Connection test failed: ') + testData.error });
                setIsSaving(false);
                return;
            }

            let newActiveId = activeConfigId;
            if (newConfigs.length === 1 || activeConfigId === 'default') {
                newActiveId = configToSave.id;
            }

            const res = await persist(newConfigs, newActiveId);
            if (res.ok) {
                setAllConfigs(newConfigs);
                setActiveConfigId(newActiveId);
                setEditingConfigId(null);
                setPickedProvider(null);
                setStatus({ type: 'success', msg: locale === 'zh' ? '已保存' : 'Saved' });
                setTimeout(() => setStatus(null), 1500);
            } else {
                const err = await res.json().catch(() => ({}));
                setStatus({ type: 'error', msg: (locale === 'zh' ? '保存失败：' : 'Save failed: ') + (err.error || res.statusText) });
            }
        } catch (e: any) {
            setStatus({ type: 'error', msg: `Error: ${e.message}` });
        } finally {
            setIsSaving(false);
        }
    };

    const activateConfig = async (id: string) => {
        const res = await persist(allConfigs, id);
        if (res.ok) {
            setActiveConfigId(id);
            setStatus({ type: 'success', msg: locale === 'zh' ? '默认模型已切换' : 'Active model updated' });
            setTimeout(() => setStatus(null), 1500);
        }
    };

    const deleteEvalConfig = async (id: string) => {
        const newConfigs = allConfigs.filter(c => c.id !== id);
        let newActive = activeConfigId;
        if (id === activeConfigId) newActive = newConfigs[0]?.id || 'default';
        const res = await persist(newConfigs, newActive);
        if (res.ok) {
            setAllConfigs(newConfigs);
            setActiveConfigId(newActive);
            setStatus({ type: 'success', msg: locale === 'zh' ? '已删除' : 'Deleted' });
            setTimeout(() => setStatus(null), 1500);
        }
    };

    const startNew = () => {
        setPickerOpen(true);
        setPickedProvider(null);
        setEditingConfigId(null);
        setStatus(null);
    };

    const pickProvider = (p: LlmProvider) => {
        setTempConfig({
            id: 'new',
            name: p.label,
            provider: toBackendProvider(p.id),
            baseUrl: p.baseUrl,
            model: p.defaultModel,
            apiKey: '',
        });
        setPickedProvider(p);
        setPickerOpen(false);
        setEditingConfigId('new');
        setStatus(null);
    };

    const reopenPicker = () => {
        setEditingConfigId(null);
        setPickerOpen(true);
    };

    const startEdit = (c: EvalConfigItem) => {
        setTempConfig({ ...c });
        setPickedProvider(null);
        setEditingConfigId(c.id);
        setPickerOpen(false);
        setStatus(null);
    };

    const toggleReveal = (id: string) => {
        setRevealedKeys(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const copyText = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setStatus({ type: 'success', msg: t('common.copySuccess') });
            setTimeout(() => setStatus(null), 1200);
        } catch {
            setStatus({ type: 'error', msg: t('common.copyFailed') });
        }
    };

    const filteredConfigs = useMemo(() => {
        const q = query.trim().toLowerCase();
        return allConfigs.filter(c => {
            if (categoryFilter !== 'all') {
                if (PROVIDER_META[c.provider]?.category !== categoryFilter) return false;
            }
            if (!q) return true;
            return (
                c.name.toLowerCase().includes(q) ||
                (c.model || '').toLowerCase().includes(q) ||
                (c.baseUrl || '').toLowerCase().includes(q) ||
                (PROVIDER_META[c.provider]?.label || c.provider || '').toLowerCase().includes(q)
            );
        });
    }, [allConfigs, query, categoryFilter]);

    const categoryCounts = useMemo(() => {
        const counts: Record<ProviderCategory, number> = { saas: 0, cn: 0, local: 0, other: 0 };
        for (const c of allConfigs) {
            const cat = PROVIDER_META[c.provider]?.category;
            if (cat) counts[cat] += 1;
        }
        return counts;
    }, [allConfigs]);

    const activeConfig = allConfigs.find(c => c.id === activeConfigId);
    const providerKinds = new Set(allConfigs.map(c => c.provider)).size;

    if (!loaded) {
        return <div style={{ padding: 32, color: 'var(--foreground-muted)', fontSize: 12 }}>{t('common.loading')}</div>;
    }

    return (
        <div style={pageWrap}>
          <div style={pageInner}>
            {status && <StatusBar status={status} />}

            {pickerOpen ? (
                <ProviderPicker
                    onPick={pickProvider}
                    onCancel={() => setPickerOpen(false)}
                    locale={locale}
                />
            ) : editingConfigId ? (
                <EditForm
                    config={tempConfig}
                    setConfig={setTempConfig}
                    onCancel={() => { setEditingConfigId(null); setPickedProvider(null); }}
                    onReselect={editingConfigId === 'new' ? reopenPicker : undefined}
                    onSave={saveCurrentConfig}
                    isSaving={isSaving}
                    isDefault={isDefaultConfig(editingConfigId)}
                    pickedProvider={pickedProvider}
                    locale={locale}
                />
            ) : (
                <>
                    {/* === Page intro: description + primary CTA === */}
                    <div style={introRow}>
                        <p style={descText}>
                            {locale === 'zh' ? (
                                <>注册并管理评测 / 优化使用的 <b style={descStrong}>LLM</b>，可切换默认、编辑参数、管理 API Key。兼容 <b style={descStrong}>OpenAI / Anthropic / DeepSeek</b> 等主流厂商，亦支持<b style={descStrong}>国内厂商</b>与<b style={descStrong}>本地推理</b>部署。</>
                            ) : (
                                <>Register and manage LLMs used for evaluation/optimization. Set the default, edit parameters, and manage API keys. Compatible with <b style={descStrong}>OpenAI / Anthropic / DeepSeek</b> as well as <b style={descStrong}>regional providers</b> and <b style={descStrong}>self-hosted</b> inference.</>
                            )}
                        </p>
                        <button style={primaryBtn} onClick={startNew}>
                            <Plus size={14} strokeWidth={2.4} />
                            {locale === 'zh' ? '新增模型' : 'New Model'}
                        </button>
                    </div>

                    {/* === Body: 2-column with right sidebar === */}
                    <div style={twoColGrid}>
                        {/* --- Main column --- */}
                        <div style={mainCol}>
                            {/* Toolbar */}
                            <div style={toolbar}>
                                <div style={searchWrap}>
                                    <Search size={14} strokeWidth={2} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--foreground-muted)' }} />
                                    <input
                                        type="text"
                                        placeholder={locale === 'zh' ? '搜索名称 / 模型 / Base URL' : 'Search name / model / Base URL'}
                                        value={query}
                                        onChange={e => setQuery(e.target.value)}
                                        style={searchInput}
                                    />
                                </div>

                                <div style={chipsWrap}>
                                    <FilterChip active={categoryFilter === 'all'} onClick={() => setCategoryFilter('all')} count={allConfigs.length}>
                                        {locale === 'zh' ? '全部' : 'All'}
                                    </FilterChip>
                                    <FilterChip active={categoryFilter === 'saas'} onClick={() => setCategoryFilter('saas')} count={categoryCounts.saas}>
                                        {locale === 'zh' ? '主流闭源' : 'SaaS'}
                                    </FilterChip>
                                    <FilterChip active={categoryFilter === 'cn'} onClick={() => setCategoryFilter('cn')} count={categoryCounts.cn}>
                                        {locale === 'zh' ? '国内厂商' : 'Regional'}
                                    </FilterChip>
                                    <FilterChip active={categoryFilter === 'other'} onClick={() => setCategoryFilter('other')} count={categoryCounts.other}>
                                        {locale === 'zh' ? '自定义' : 'Custom'}
                                    </FilterChip>
                                </div>
                            </div>

                            {/* Section heading */}
                            <div style={sectionHeading}>
                                <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--foreground)' }}>
                                    {locale === 'zh' ? '已注册模型' : 'Registered Models'}
                                </span>
                                <span style={countPill}>{filteredConfigs.length}</span>
                                <span style={{ flex: 1 }} />
                                <span style={{ fontSize: 11.5, color: 'var(--foreground-muted)' }}>
                                    {locale === 'zh' ? `容量 ${allConfigs.length} / ${CAPACITY_LIMIT}` : `Capacity ${allConfigs.length} / ${CAPACITY_LIMIT}`}
                                </span>
                            </div>

                            {/* List */}
                            {filteredConfigs.length === 0 ? (
                                <EmptyState locale={locale} hasConfigs={allConfigs.length > 0} onAdd={startNew} onReset={() => { setQuery(''); setCategoryFilter('all'); }} />
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                    {filteredConfigs.map(c => (
                                        <ModelCard
                                            key={c.id}
                                            config={c}
                                            isActive={c.id === activeConfigId}
                                            isDefault={isDefaultConfig(c.id)}
                                            revealed={revealedKeys.has(c.id)}
                                            health={healthMap[c.id]}
                                            onActivate={() => activateConfig(c.id)}
                                            onEdit={() => startEdit(c)}
                                            onDelete={() => setPendingDelete(c)}
                                            onToggleReveal={() => toggleReveal(c.id)}
                                            onCopy={() => c.apiKey && copyText(c.apiKey)}
                                            locale={locale}
                                        />
                                    ))}
                                </div>
                            )}

                            {/* Footer hint */}
                            <div style={hintBox}>
                                <div style={hintIcon}><Info size={16} /></div>
                                <div style={{ flex: 1, fontSize: 12.5, color: 'var(--foreground-secondary)', lineHeight: 1.6 }}>
                                    <b style={{ color: 'var(--foreground)', fontWeight: 600 }}>{locale === 'zh' ? '提示' : 'Tip'}</b> · {locale === 'zh'
                                        ? '至少保留一个默认模型，用于评测与优化任务的兜底调用。删除默认模型前，请先指定其它模型为默认。'
                                        : 'Keep at least one default model for evaluation/optimization fallback. Switch the default before deleting it.'}
                                </div>
                            </div>
                        </div>

                        {/* --- Right sidebar --- */}
                        <aside style={sideCol}>
                            <CurrentDefaultPanel
                                active={activeConfig}
                                providerKinds={providerKinds}
                                registeredCount={allConfigs.length}
                                locale={locale}
                            />
                            <HealthCheckPanel
                                configs={allConfigs}
                                healthMap={healthMap}
                                isRechecking={isRechecking}
                                onRecheck={recheckHealth}
                                locale={locale}
                            />
                            <DocsPanel locale={locale} />
                        </aside>
                    </div>
                </>
            )}

          </div>
            <ConfirmDialog
                open={!!pendingDelete}
                onOpenChange={(o) => !o && setPendingDelete(null)}
                tone="danger"
                title={locale === 'zh' ? '删除该模型？' : 'Delete this model?'}
                description={pendingDelete ? (locale === 'zh'
                    ? `将永久删除「${pendingDelete.name}」配置，无法恢复。`
                    : `"${pendingDelete.name}" will be permanently removed.`) : ''}
                confirmText={locale === 'zh' ? '删除' : 'Delete'}
                cancelText={locale === 'zh' ? '取消' : 'Cancel'}
                onConfirm={async () => {
                    if (pendingDelete) await deleteEvalConfig(pendingDelete.id);
                }}
            />
        </div>
    );
}

/* ====================== Sub-components ====================== */

function StatusBar({ status }: { status: { type: 'success' | 'error' | 'info', msg: string } }) {
    const tone = status.type === 'success'
        ? { bg: 'var(--success-subtle)', fg: 'var(--success)', border: 'var(--success-subtle-border)' }
        : status.type === 'error'
        ? { bg: 'var(--error-subtle)', fg: 'var(--error)', border: 'var(--error-subtle-border)' }
        : { bg: 'var(--primary-subtle)', fg: 'var(--primary)', border: 'var(--primary-subtle-border)' };
    return (
        <div style={{
            padding: '8px 12px',
            marginBottom: 14,
            borderRadius: 8,
            background: tone.bg,
            color: tone.fg,
            border: `1px solid ${tone.border}`,
            fontSize: 12,
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
        }}>
            {status.type === 'success' && <Check size={13} strokeWidth={2.5} />}
            {status.msg}
        </div>
    );
}

function FilterChip({
    active, onClick, count, children,
}: {
    active: boolean;
    onClick: () => void;
    count?: number;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className="ai-filter-chip"
            data-active={active ? 'true' : 'false'}
            style={chipBase}
        >
            {children}
            {typeof count === 'number' && count > 0 && (
                <span className="ai-filter-chip__count">{count}</span>
            )}
        </button>
    );
}

function ModelCard({
    config, isActive, isDefault, revealed, health, onActivate, onEdit, onDelete, onToggleReveal, onCopy, locale,
}: {
    config: EvalConfigItem;
    isActive: boolean;
    isDefault: boolean;
    revealed: boolean;
    health?: HealthState;
    onActivate: () => void;
    onEdit: () => void;
    onDelete: () => void;
    onToggleReveal: () => void;
    onCopy: () => void;
    locale: string;
}) {
    const meta = PROVIDER_META[config.provider] ?? {
        label: config.provider || 'Unknown',
        monogram: (config.provider?.slice(0, 2) || '??').toUpperCase(),
        category: 'other' as ProviderCategory,
    };
    const catalogProvider = resolveCatalogProvider(config.provider, config.baseUrl);
    const effHealth: HealthState = health ?? initialHealth(config);

    return (
        <article
            style={{
                ...modelCard,
                borderColor: isActive ? 'var(--primary-subtle-border)' : 'var(--card-border)',
                background: isActive ? 'linear-gradient(180deg, var(--primary-subtle) 0%, var(--card-bg) 56px)' : 'var(--card-bg)',
            }}
        >
            {isActive && <span style={activeStripe} />}

            <ProviderLogo
                slug={catalogProvider?.logoSlug}
                initials={meta.monogram}
                size={48}
                radius={12}
            />

            <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                    <span style={modelName}>{config.name}</span>
                    {isActive && (
                        <span style={badgeDefault}>
                            <BadgeCheck size={11} strokeWidth={2.5} />
                            {locale === 'zh' ? '当前默认' : 'Default'}
                        </span>
                    )}
                    {effHealth === 'ok' && (
                        <span style={badgeHealthy}>
                            <span style={dotPulse} />
                            {locale === 'zh' ? '正常' : 'Healthy'}
                        </span>
                    )}
                    {effHealth === 'checking' && (
                        <span style={badgeChecking}>
                            <Loader2 size={11} strokeWidth={2.4} style={{ animation: 'spin 1s linear infinite' }} />
                            {locale === 'zh' ? '连接中' : 'Checking'}
                        </span>
                    )}
                    {effHealth === 'failed' && (
                        <span style={badgeFailed}>
                            <XCircle size={11} strokeWidth={2.4} />
                            {locale === 'zh' ? 'Key 已失效' : 'Key invalid'}
                        </span>
                    )}
                    {effHealth === 'unconfigured' && (
                        <span style={badgeWarn}>{locale === 'zh' ? '未设置 Key' : 'No key'}</span>
                    )}
                    {isDefault && <span style={badgeGhost}>{locale === 'zh' ? '系统默认' : 'System'}</span>}
                </div>

                <div style={metaRow}>
                    <span style={metaItem}>
                        <span style={metaLabel}>Provider</span>
                        <span style={metaValue}>{meta.label}</span>
                    </span>
                    <span style={metaSep} />
                    <span style={metaItem}>
                        <span style={metaLabel}>Model</span>
                        <span style={{ ...metaValue, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{config.model || '—'}</span>
                    </span>
                    {config.baseUrl && (
                        <>
                            <span style={metaSep} />
                            <span style={metaItem}>
                                <span style={metaLabel}>Base URL</span>
                                <span style={{ ...metaValue, fontFamily: 'var(--font-mono)', fontSize: 12 }} title={config.baseUrl}>
                                    {config.baseUrl}
                                </span>
                            </span>
                        </>
                    )}
                </div>

                <div style={apiKeyRow}>
                    <Key size={12} strokeWidth={2.2} style={{ color: 'var(--primary)' }} />
                    {config.apiKey ? (
                        <>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                                {revealed ? config.apiKey : maskKey(config.apiKey)}
                            </span>
                            <span style={keyActions}>
                                <button title={revealed ? (locale === 'zh' ? '隐藏' : 'Hide') : (locale === 'zh' ? '显示' : 'Show')} style={keyIconBtn} onClick={onToggleReveal}>
                                    {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
                                </button>
                                <button title={locale === 'zh' ? '复制' : 'Copy'} style={keyIconBtn} onClick={onCopy}>
                                    <Copy size={13} />
                                </button>
                            </span>
                        </>
                    ) : (
                        <span style={{ color: 'var(--foreground-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                            {locale === 'zh' ? '(未设置)' : '(not set)'}
                        </span>
                    )}
                </div>
            </div>

            <div style={cardActions}>
                {isActive ? (
                    <button style={inUseBtn} disabled>
                        <CircleCheck size={13} strokeWidth={2.4} />
                        {locale === 'zh' ? '当前使用' : 'In use'}
                    </button>
                ) : (
                    <button style={ghostBtn} onClick={onActivate}>
                        <Check size={13} strokeWidth={2.2} />
                        {locale === 'zh' ? '设为默认' : 'Set default'}
                    </button>
                )}
                {!isDefault && (
                    <>
                        <button style={ghostBtn} onClick={onEdit}>
                            <Pencil size={13} strokeWidth={2.2} />
                            {locale === 'zh' ? '编辑' : 'Edit'}
                        </button>
                        <button style={dangerBtn} onClick={onDelete}>
                            <Trash2 size={13} strokeWidth={2.2} />
                            {locale === 'zh' ? '删除' : 'Delete'}
                        </button>
                    </>
                )}
            </div>
        </article>
    );
}

function CurrentDefaultPanel({
    active, providerKinds, registeredCount, locale,
}: {
    active?: EvalConfigItem;
    providerKinds: number;
    registeredCount: number;
    locale: string;
}) {
    return (
        <section style={panelCard}>
            <header style={panelHeader}>
                <Star size={13} strokeWidth={2.2} style={{ color: 'var(--primary)' }} />
                <span>{locale === 'zh' ? '当前默认' : 'Current Default'}</span>
            </header>
            {active ? (
                <ul style={panelKv}>
                    <KvRow label={locale === 'zh' ? '名称' : 'Name'} value={active.name} bold />
                    <KvRow label="Provider" value={active.provider} mono />
                    <KvRow label="Model" value={active.model || '—'} mono />
                    {active.baseUrl && (
                        <KvRow label="Base URL" value={active.baseUrl} mono ellipsis />
                    )}
                    <KvRow
                        label={locale === 'zh' ? '已注册' : 'Registered'}
                        value={`${registeredCount} / ${CAPACITY_LIMIT}`}
                    />
                    <KvRow
                        label={locale === 'zh' ? '供应商种类' : 'Providers'}
                        value={String(providerKinds)}
                    />
                </ul>
            ) : (
                <div style={{ padding: '4px 0', fontSize: 12, color: 'var(--foreground-muted)' }}>
                    {locale === 'zh' ? '尚未选定默认模型。' : 'No default selected.'}
                </div>
            )}
        </section>
    );
}

function HealthCheckPanel({
    configs, healthMap, isRechecking, onRecheck, locale,
}: {
    configs: EvalConfigItem[];
    healthMap: Record<string, HealthState>;
    isRechecking: boolean;
    onRecheck: () => void;
    locale: string;
}) {
    return (
        <section style={panelCard}>
            <header style={panelHeader}>
                <HeartPulse size={13} strokeWidth={2.2} style={{ color: 'var(--success)' }} />
                <span>{locale === 'zh' ? '健康检查' : 'Health Check'}</span>
            </header>
            {configs.length === 0 ? (
                <div style={{ padding: '4px 0', fontSize: 12, color: 'var(--foreground-muted)' }}>
                    {locale === 'zh' ? '暂无模型可检查。' : 'No models to check.'}
                </div>
            ) : (
                <>
                    <ul style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 0, margin: 0, listStyle: 'none' }}>
                        {configs.map(c => {
                            const h = healthMap[c.id] ?? initialHealth(c);
                            return (
                                <li key={c.id} style={healthRow}>
                                    <span style={{
                                        flex: 1,
                                        minWidth: 0,
                                        fontSize: 12.5,
                                        color: 'var(--foreground)',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                    }} title={c.model || c.name}>
                                        {c.model || c.name}
                                    </span>
                                    <HealthBadge state={h} locale={locale} />
                                </li>
                            );
                        })}
                    </ul>
                    <button style={recheckBtn} onClick={onRecheck} disabled={isRechecking}>
                        <RefreshCw size={12} strokeWidth={2.2} style={isRechecking ? { animation: 'spin 1s linear infinite' } : undefined} />
                        {isRechecking
                            ? (locale === 'zh' ? '检查中…' : 'Checking…')
                            : (locale === 'zh' ? '重新检查' : 'Re-check')}
                    </button>
                </>
            )}
        </section>
    );
}

function DocsPanel({ locale }: { locale: string }) {
    const links = locale === 'zh' ? [
        { label: '如何获取 API Key', href: '#' },
        { label: '密钥加密与轮转策略', href: '#' },
        { label: '模型注册最佳实践', href: '#' },
    ] : [
        { label: 'How to obtain an API Key', href: '#' },
        { label: 'Key encryption & rotation', href: '#' },
        { label: 'Model registry best practices', href: '#' },
    ];
    return (
        <section style={panelCard}>
            <header style={panelHeader}>
                <BookOpen size={13} strokeWidth={2.2} style={{ color: 'var(--foreground-secondary)' }} />
                <span>{locale === 'zh' ? '相关文档' : 'Related Docs'}</span>
            </header>
            <ul style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: 0, margin: 0, listStyle: 'none' }}>
                {links.map(l => (
                    <li key={l.label}>
                        <a href={l.href} style={docLink}>
                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.label}</span>
                            <ExternalLink size={12} strokeWidth={2} style={{ color: 'var(--foreground-muted)', flexShrink: 0 }} />
                        </a>
                    </li>
                ))}
            </ul>
        </section>
    );
}

function KvRow({
    label, value, mono, bold, ellipsis,
}: {
    label: string;
    value: string;
    mono?: boolean;
    bold?: boolean;
    ellipsis?: boolean;
}) {
    return (
        <li style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '5px 0', borderBottom: '1px dashed var(--border)', minWidth: 0 }}>
            <span style={{ fontSize: 11.5, color: 'var(--foreground-muted)', flexShrink: 0 }}>{label}</span>
            <span style={{
                flex: 1,
                minWidth: 0,
                textAlign: 'right',
                fontSize: 12,
                color: 'var(--foreground)',
                fontWeight: bold ? 600 : 500,
                fontFamily: mono ? 'var(--font-mono)' : 'inherit',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
            }} title={ellipsis ? value : undefined}>
                {value}
            </span>
        </li>
    );
}

type LogoAttempt = 'color' | 'plain' | 'failed';

function ProviderLogo({
    slug, initials, size = 36, radius = 10,
}: {
    slug?: string;
    initials: string;
    size?: number;
    radius?: number;
}) {
    const [attempt, setAttempt] = useState<LogoAttempt>('color');

    useEffect(() => {
        setAttempt('color');
    }, [slug]);

    const url = attempt === 'failed' ? undefined : getProviderLogoUrl(slug, attempt);
    const showLogo = !!url;

    return (
        <div
            style={{
                ...providerIcon,
                width: size,
                height: size,
                borderRadius: radius,
                fontSize: Math.round(size * 0.32),
                background: showLogo ? '#ffffff' : 'var(--background-secondary)',
                padding: showLogo ? Math.round(size * 0.16) : 0,
                color: 'var(--foreground)',
            }}
        >
            {showLogo ? (
                <img
                    src={url}
                    alt={initials}
                    onError={() => setAttempt(attempt === 'color' ? 'plain' : 'failed')}
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                    loading="lazy"
                />
            ) : (
                initials
            )}
        </div>
    );
}

function HealthBadge({ state, locale }: { state: HealthState, locale: string }) {
    if (state === 'ok') {
        return (
            <span style={badgeHealthy}>
                <CircleCheck size={11} strokeWidth={2.4} />
                {locale === 'zh' ? '正常' : 'OK'}
            </span>
        );
    }
    if (state === 'checking') {
        return (
            <span style={badgeChecking}>
                <Loader2 size={11} strokeWidth={2.4} style={{ animation: 'spin 1s linear infinite' }} />
                {locale === 'zh' ? '检测中' : 'Checking'}
            </span>
        );
    }
    if (state === 'failed') {
        return (
            <span style={badgeFailed}>
                <XCircle size={11} strokeWidth={2.4} />
                {locale === 'zh' ? '失效' : 'Failed'}
            </span>
        );
    }
    return (
        <span style={badgeWarn}>{locale === 'zh' ? '未配置' : 'No key'}</span>
    );
}

function EmptyState({
    locale, hasConfigs, onAdd, onReset,
}: {
    locale: string;
    hasConfigs: boolean;
    onAdd: () => void;
    onReset: () => void;
}) {
    return (
        <div style={emptyBox}>
            <div style={emptyIcon}><Server size={20} /></div>
            <div style={{ fontSize: 13.5, color: 'var(--foreground)', fontWeight: 500, marginBottom: 4 }}>
                {hasConfigs
                    ? (locale === 'zh' ? '没有匹配的模型' : 'No matching models')
                    : (locale === 'zh' ? '尚未注册任何模型' : 'No models registered yet')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--foreground-muted)', marginBottom: 14, textAlign: 'center', maxWidth: 360 }}>
                {hasConfigs
                    ? (locale === 'zh' ? '试试调整搜索关键字或筛选条件。' : 'Try a different keyword or filter.')
                    : (locale === 'zh' ? '注册首个 LLM 后即可在评测、优化、对比中使用。' : 'Register your first LLM to use it for evaluation, optimization and comparison.')}
            </div>
            {hasConfigs ? (
                <button style={ghostBtn} onClick={onReset}>{locale === 'zh' ? '清除筛选' : 'Reset filters'}</button>
            ) : (
                <button style={primaryBtn} onClick={onAdd}>
                    <Plus size={14} strokeWidth={2.4} />
                    {locale === 'zh' ? '注册首个模型' : 'Register your first model'}
                </button>
            )}
        </div>
    );
}

function ProviderPicker({
    onPick, onCancel, locale,
}: {
    onPick: (p: LlmProvider) => void;
    onCancel: () => void;
    locale: string;
}) {
    const [q, setQ] = useState('');
    const [activeCat, setActiveCat] = useState<LlmProviderCategory | 'all'>('all');

    const filtered = useMemo(() => {
        const query = q.trim().toLowerCase();
        return LLM_PROVIDERS.filter(p => {
            if (activeCat !== 'all' && p.category !== activeCat) return false;
            if (!query) return true;
            return (
                p.label.toLowerCase().includes(query) ||
                p.id.toLowerCase().includes(query) ||
                p.defaultModel.toLowerCase().includes(query) ||
                p.suggestedModels.some(m => m.toLowerCase().includes(query))
            );
        });
    }, [q, activeCat]);

    const grouped = useMemo(() => {
        const byCat: Record<string, LlmProvider[]> = {};
        for (const p of filtered) {
            if (!byCat[p.category]) byCat[p.category] = [];
            byCat[p.category].push(p);
        }
        return byCat;
    }, [filtered]);

    const catCounts = useMemo(() => {
        const c: Record<string, number> = { all: LLM_PROVIDERS.length };
        for (const p of LLM_PROVIDERS) c[p.category] = (c[p.category] || 0) + 1;
        return c;
    }, []);

    return (
        <div style={editCard}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, gap: 16 }}>
                <div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--foreground)', letterSpacing: '-0.01em' }}>
                        {locale === 'zh' ? '选择模型供应商' : 'Choose a Model Provider'}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--foreground-muted)', marginTop: 3 }}>
                        {locale === 'zh'
                            ? '挑选预置供应商即可自动填写 Base URL 与默认模型，下一步只需录入 API Key。'
                            : 'Pick a built-in provider — Base URL and default model auto-fill. You only need to paste an API key next.'}
                    </div>
                </div>
                <button style={ghostBtn} onClick={onCancel}>{locale === 'zh' ? '返回列表' : 'Back to list'}</button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
                <div style={{ ...searchWrap, width: 280 }}>
                    <Search size={14} strokeWidth={2} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--foreground-muted)' }} />
                    <input
                        type="text"
                        placeholder={locale === 'zh' ? '搜索供应商 / 模型' : 'Search provider / model'}
                        value={q}
                        onChange={e => setQ(e.target.value)}
                        style={searchInput}
                    />
                </div>
                <div style={chipsWrap}>
                    <FilterChip active={activeCat === 'all'} onClick={() => setActiveCat('all')} count={catCounts.all}>
                        {locale === 'zh' ? '全部' : 'All'}
                    </FilterChip>
                    {CATEGORY_ORDER.map(c => (
                        <FilterChip
                            key={c.id}
                            active={activeCat === c.id}
                            onClick={() => setActiveCat(c.id)}
                            count={catCounts[c.id] || 0}
                        >
                            {locale === 'zh' ? c.labelZh : c.labelEn}
                        </FilterChip>
                    ))}
                </div>
            </div>

            {filtered.length === 0 ? (
                <div style={{ padding: '40px 0', textAlign: 'center', fontSize: 13, color: 'var(--foreground-muted)' }}>
                    {locale === 'zh' ? '没有匹配的供应商。' : 'No matching provider.'}
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
                    {CATEGORY_ORDER.map(cat => {
                        const items = grouped[cat.id];
                        if (!items || items.length === 0) return null;
                        return (
                            <section key={cat.id}>
                                <div style={pickerSectionHead}>
                                    <span>{locale === 'zh' ? cat.labelZh : cat.labelEn}</span>
                                    <span style={countPill}>{items.length}</span>
                                </div>
                                <div style={pickerGrid}>
                                    {items.map(p => (
                                        <button
                                            key={p.id}
                                            type="button"
                                            onClick={() => onPick(p)}
                                            style={providerCard}
                                            className="provider-pick-card"
                                        >
                                            <ProviderLogo slug={p.logoSlug} initials={p.initials} size={36} radius={9} />
                                            <div style={{ minWidth: 0, flex: 1 }}>
                                                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {p.label}
                                                </div>
                                                <div style={{ marginTop: 3, fontSize: 11.5, color: 'var(--foreground-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.suggestedModels.join(' · ') || p.defaultModel}>
                                                    {p.suggestedModels.slice(0, 3).join(' · ') || p.defaultModel || (locale === 'zh' ? '自填模型' : 'Custom model')}
                                                </div>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </section>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function EditForm({
    config, setConfig, onCancel, onReselect, onSave, isSaving, isDefault, pickedProvider, locale,
}: {
    config: EvalConfigItem;
    setConfig: (c: EvalConfigItem) => void;
    onCancel: () => void;
    onReselect?: () => void;
    onSave: () => void;
    isSaving: boolean;
    isDefault: boolean;
    pickedProvider?: LlmProvider | null;
    locale: string;
}) {
    const onProviderChange = (p: EvalConfigItem['provider']) => {
        const preset = PROVIDER_PRESETS[p];
        setConfig({ ...config, provider: p, baseUrl: preset.baseUrl || config.baseUrl, model: preset.model || config.model });
    };

    return (
        <div style={editCard}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18, gap: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                    {pickedProvider && (
                        <ProviderLogo slug={pickedProvider.logoSlug} initials={pickedProvider.initials} size={40} radius={10} />
                    )}
                    <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--foreground)', letterSpacing: '-0.01em' }}>
                            {config.id === 'new'
                                ? (pickedProvider ? pickedProvider.label : (locale === 'zh' ? '新增模型' : 'New Model'))
                                : (locale === 'zh' ? '编辑模型' : 'Edit Model')}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--foreground-muted)', marginTop: 3 }}>
                            {pickedProvider?.note
                                ? pickedProvider.note
                                : (locale === 'zh' ? '保存前会自动测试连接，连通后才会写入。' : 'Connection is tested before saving.')}
                        </div>
                    </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    {onReselect && (
                        <button style={ghostBtn} onClick={onReselect}>
                            {locale === 'zh' ? '← 选择其它供应商' : '← Choose other provider'}
                        </button>
                    )}
                    <button style={ghostBtn} onClick={onCancel}>{locale === 'zh' ? '返回列表' : 'Back to list'}</button>
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '14px 18px' }}>
                <Field label={locale === 'zh' ? '配置名称' : 'Config Name'}>
                    <input
                        style={inputStyle}
                        placeholder={locale === 'zh' ? '例如：我的 DeepSeek' : 'e.g. My DeepSeek'}
                        value={config.name || ''}
                        disabled={isDefault}
                        onChange={e => setConfig({ ...config, name: e.target.value })}
                    />
                </Field>

                <Field label={locale === 'zh' ? '供应商' : 'Provider'}>
                    <select
                        style={inputStyle}
                        value={config.provider}
                        disabled={isDefault}
                        onChange={e => onProviderChange(e.target.value as EvalConfigItem['provider'])}
                    >
                        <option value="deepseek-official">DeepSeek (Official)</option>
                        <option value="siliconflow">SiliconFlow</option>
                        <option value="openai">OpenAI</option>
                        <option value="anthropic">Anthropic</option>
                        <option value="custom">Custom (OpenAI Compatible)</option>
                    </select>
                </Field>

                <Field label="Base URL">
                    <input
                        style={inputStyle}
                        placeholder="https://api.deepseek.com"
                        value={config.baseUrl || ''}
                        disabled={isDefault}
                        onChange={e => setConfig({ ...config, baseUrl: e.target.value.replace(/\/chat\/completions\/?$/, '') })}
                    />
                </Field>

                <Field label={locale === 'zh' ? '模型名' : 'Model Name'}>
                    <input
                        style={inputStyle}
                        placeholder="deepseek-chat / gpt-4o / ..."
                        value={config.model || ''}
                        disabled={isDefault}
                        onChange={e => setConfig({ ...config, model: e.target.value })}
                    />
                    {pickedProvider && pickedProvider.suggestedModels.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
                            {pickedProvider.suggestedModels.slice(0, 6).map(m => (
                                <button
                                    key={m}
                                    type="button"
                                    onClick={() => setConfig({ ...config, model: m })}
                                    style={{
                                        ...modelChip,
                                        background: config.model === m ? 'var(--primary-subtle)' : 'var(--background-secondary)',
                                        color: config.model === m ? 'var(--primary)' : 'var(--foreground-secondary)',
                                        borderColor: config.model === m ? 'var(--primary-subtle-border)' : 'var(--border)',
                                    }}
                                >
                                    {m}
                                </button>
                            ))}
                        </div>
                    )}
                </Field>

                <div style={{ gridColumn: '1 / -1' }}>
                    <Field label={locale === 'zh' ? 'API 密钥' : 'API Key'}>
                        <input
                            style={inputStyle}
                            type="password"
                            placeholder="sk-..."
                            value={config.apiKey || ''}
                            disabled={isDefault}
                            onChange={e => setConfig({ ...config, apiKey: e.target.value })}
                        />
                        {pickedProvider?.docsUrl && (
                            <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--foreground-muted)' }}>
                                <a href={pickedProvider.docsUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--primary)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                    {locale === 'zh' ? '如何获取 API Key' : 'How to obtain an API Key'}
                                    <ExternalLink size={11} strokeWidth={2} />
                                </a>
                            </div>
                        )}
                    </Field>
                </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
                <button style={ghostBtn} onClick={onCancel}>{locale === 'zh' ? '取消' : 'Cancel'}</button>
                {!isDefault && (
                    <button style={isSaving ? primaryBtnDisabled : primaryBtn} disabled={isSaving} onClick={onSave}>
                        {isSaving
                            ? (locale === 'zh' ? '测试并保存中…' : 'Testing & Saving…')
                            : (locale === 'zh' ? '测试连接并保存' : 'Test & Save')}
                    </button>
                )}
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string, children: React.ReactNode }) {
    return (
        <div>
            <div style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--foreground-secondary)', marginBottom: 6, letterSpacing: '0.01em' }}>{label}</div>
            {children}
        </div>
    );
}

function maskKey(k: string): string {
    if (k.length <= 8) return '••••••••';
    return `${k.slice(0, 4)}••••••••${k.slice(-4)}`;
}

/* ====================== Styles ====================== */

const pageWrap: CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '24px 28px 40px',
    width: '100%',
};

const pageInner: CSSProperties = {
    maxWidth: 1320,
    margin: '0 auto',
};

const introRow: CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 24,
    marginBottom: 22,
};

const descText: CSSProperties = {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.65,
    color: 'var(--foreground-secondary)',
    maxWidth: 720,
};

const descStrong: CSSProperties = {
    color: 'var(--foreground)',
    fontWeight: 600,
};

const twoColGrid: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 300px',
    gap: 22,
    alignItems: 'flex-start',
};

const mainCol: CSSProperties = {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
};

const sideCol: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    position: 'sticky',
    top: 0,
};

const sectionHeading: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '2px 2px 6px',
    borderBottom: '1px solid var(--border)',
};

const countPill: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '1px 8px',
    fontSize: 11,
    fontWeight: 600,
    fontFamily: 'var(--font-mono)',
    color: 'var(--foreground-secondary)',
    background: 'var(--background-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 999,
    lineHeight: 1.5,
};

const panelCard: CSSProperties = {
    background: 'var(--card-bg)',
    border: '1px solid var(--card-border)',
    borderRadius: 12,
    padding: '14px 16px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
};

const panelHeader: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--foreground)',
    letterSpacing: '-0.005em',
    paddingBottom: 8,
    borderBottom: '1px solid var(--border)',
};

const panelKv: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    padding: 0,
    margin: 0,
    listStyle: 'none',
};

const healthRow: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '5px 0',
    minWidth: 0,
};

const recheckBtn: CSSProperties = {
    width: '100%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '7px 10px',
    marginTop: 4,
    background: 'var(--card-bg)',
    color: 'var(--foreground-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 7,
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all .12s ease',
};

const docLink: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 8px',
    fontSize: 12.5,
    color: 'var(--foreground-secondary)',
    textDecoration: 'none',
    borderRadius: 6,
    transition: 'background .1s',
};

const pickerSectionHead: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--foreground-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
};

const pickerGrid: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: 10,
};

const providerCard: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '11px 12px',
    background: 'var(--card-bg)',
    border: '1px solid var(--card-border)',
    borderRadius: 10,
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
    transition: 'all .12s ease',
    minWidth: 0,
};

const modelChip: CSSProperties = {
    padding: '3px 10px',
    fontSize: 11,
    fontFamily: 'var(--font-mono)',
    border: '1px solid var(--border)',
    borderRadius: 999,
    cursor: 'pointer',
    transition: 'all .12s',
    lineHeight: 1.5,
};

const toolbar: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    marginBottom: 14,
    flexWrap: 'wrap',
};

const searchWrap: CSSProperties = {
    position: 'relative',
    width: 280,
};

const searchInput: CSSProperties = {
    width: '100%',
    height: 34,
    padding: '0 12px 0 32px',
    border: '1px solid var(--input-border)',
    borderRadius: 8,
    background: 'var(--input-bg)',
    fontSize: 12.5,
    color: 'var(--foreground)',
    outline: 'none',
};

const chipsWrap: CSSProperties = {
    display: 'inline-flex',
    flexWrap: 'wrap',
    gap: 6,
};

const chipBase: CSSProperties = {
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 500,
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: 'inherit',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    whiteSpace: 'nowrap',
    lineHeight: 1.4,
};

const modelCard: CSSProperties = {
    background: 'var(--card-bg)',
    border: '1px solid var(--card-border)',
    borderRadius: 12,
    padding: '18px 22px',
    display: 'grid',
    gridTemplateColumns: 'auto 1fr auto',
    gap: 22,
    alignItems: 'center',
    transition: 'all .15s ease',
    position: 'relative',
    overflow: 'hidden',
};

const activeStripe: CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    background: 'var(--primary)',
};

const providerIcon: CSSProperties = {
    width: 48,
    height: 48,
    borderRadius: 12,
    background: 'var(--background-secondary)',
    border: '1px solid var(--card-border)',
    display: 'grid',
    placeItems: 'center',
    fontWeight: 600,
    fontSize: 14,
    color: 'var(--foreground-secondary)',
    letterSpacing: '0.02em',
    flexShrink: 0,
};

const modelName: CSSProperties = {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--foreground)',
    letterSpacing: '-0.01em',
};

const badgeBase: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 8px',
    fontSize: 10.5,
    fontWeight: 600,
    borderRadius: 999,
    lineHeight: 1.5,
    letterSpacing: '0.01em',
};

const badgeDefault: CSSProperties = {
    ...badgeBase,
    background: 'var(--primary)',
    color: 'var(--primary-foreground)',
};

const badgeHealthy: CSSProperties = {
    ...badgeBase,
    background: 'var(--success-subtle)',
    color: 'var(--success)',
};

const badgeWarn: CSSProperties = {
    ...badgeBase,
    background: 'var(--warning-subtle)',
    color: 'var(--warning)',
};

const badgeChecking: CSSProperties = {
    ...badgeBase,
    background: 'var(--primary-subtle)',
    color: 'var(--primary)',
};

const badgeFailed: CSSProperties = {
    ...badgeBase,
    background: 'var(--error-subtle)',
    color: 'var(--error)',
};

const badgeGhost: CSSProperties = {
    ...badgeBase,
    background: 'var(--background-secondary)',
    color: 'var(--foreground-secondary)',
    border: '1px solid var(--border)',
};

const dotPulse: CSSProperties = {
    width: 5,
    height: 5,
    background: 'var(--success)',
    borderRadius: '50%',
};

const metaRow: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
    marginBottom: 10,
    fontSize: 12.5,
    color: 'var(--foreground-secondary)',
};

const metaItem: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
};

const metaLabel: CSSProperties = {
    fontSize: 10.5,
    fontWeight: 500,
    color: 'var(--foreground-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
};

const metaValue: CSSProperties = {
    color: 'var(--foreground)',
    fontWeight: 500,
    maxWidth: 280,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
};

const metaSep: CSSProperties = {
    width: 1,
    height: 11,
    background: 'var(--border)',
};

const apiKeyRow: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 10px',
    background: 'var(--background-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 7,
    color: 'var(--foreground-secondary)',
    maxWidth: 'fit-content',
};

const keyActions: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    marginLeft: 4,
    paddingLeft: 6,
    borderLeft: '1px solid var(--border)',
};

const keyIconBtn: CSSProperties = {
    width: 22,
    height: 22,
    display: 'grid',
    placeItems: 'center',
    background: 'transparent',
    border: 0,
    borderRadius: 4,
    color: 'var(--foreground-muted)',
    cursor: 'pointer',
    transition: 'all .15s',
};

const cardActions: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 16,
    borderLeft: '1px dashed var(--border)',
};

const primaryBtn: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 14px',
    background: 'var(--primary)',
    color: 'var(--primary-foreground)',
    border: 'none',
    borderRadius: 8,
    fontSize: 12.5,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'background .12s ease',
    lineHeight: 1.4,
};

const primaryBtnDisabled: CSSProperties = {
    ...primaryBtn,
    opacity: 0.6,
    cursor: 'not-allowed',
};

const ghostBtn: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '6px 12px',
    background: 'var(--card-bg)',
    color: 'var(--foreground-secondary)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    borderRadius: 7,
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all .12s ease',
    lineHeight: 1.4,
};

const inUseBtn: CSSProperties = {
    ...ghostBtn,
    background: 'var(--success-subtle)',
    color: 'var(--success)',
    borderColor: 'var(--success-subtle-border)',
    cursor: 'default',
};

const dangerBtn: CSSProperties = {
    ...ghostBtn,
    color: 'var(--foreground-secondary)',
};

const editCard: CSSProperties = {
    background: 'var(--card-bg)',
    border: '1px solid var(--card-border)',
    borderRadius: 12,
    padding: '22px 26px',
};

const inputStyle: CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    background: 'var(--input-bg)',
    border: '1px solid var(--input-border)',
    borderRadius: 7,
    color: 'var(--foreground)',
    fontSize: 12.5,
    outline: 'none',
};

const hintBox: CSSProperties = {
    marginTop: 24,
    padding: '14px 18px',
    border: '1px dashed var(--border-dark)',
    borderRadius: 10,
    background: 'var(--background-secondary)',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
};

const hintIcon: CSSProperties = {
    width: 30,
    height: 30,
    borderRadius: 8,
    background: 'var(--primary-subtle)',
    color: 'var(--primary)',
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
};

const emptyBox: CSSProperties = {
    padding: '40px 24px',
    background: 'var(--card-bg)',
    border: '1px dashed var(--border-dark)',
    borderRadius: 12,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
};

const emptyIcon: CSSProperties = {
    width: 44,
    height: 44,
    borderRadius: 10,
    background: 'var(--background-secondary)',
    color: 'var(--foreground-muted)',
    display: 'grid',
    placeItems: 'center',
    marginBottom: 12,
};

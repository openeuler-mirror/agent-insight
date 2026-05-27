'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
    Globe,
    Save,
    Eye,
    EyeOff,
    Check,
    Info,
    BookOpen,
    ExternalLink,
    Wrench,
    CircleCheck,
    Search,
} from 'lucide-react';
import { apiFetch } from '@/lib/client/api';
import { useAuth } from '@/lib/auth/auth-context';
import { useLocale } from '@/lib/client/locale-context';
import { Term } from '@/components/text/Term';

/**
 * 联网搜索配置页(独立路由:/modelconfig/web-search)。
 *
 * 视觉/交互语言对齐 ModelConfigManager(registry 页):pageWrap/pageInner 骨架、
 * introRow(描述 + 主操作)、双列网格(主区 + 300px sidebar)、panelCard、StatusBar 等。
 *
 * 数据流:GET /api/eval/settings 拿全量 settings -> 改 searchProvider/searchApiKey
 *        -> POST 整体回去(必须保留 activeConfigId/configs 等字段,否则会把模型
 *        配置一并清掉)。
 *
 * 当前供应商:MVP 只接 Tavily;预留下拉框结构让后续接入 Serper / Brave 更容易。
 */

type Provider = 'tavily' | 'none';

interface FullSettings {
    activeConfigId: string | null;
    configs: any[];
    autoEvaluationEnabled?: boolean;
    searchProvider?: Provider;
    searchApiKey?: string;
}

export function WebSearchConfig() {
    const { user } = useAuth();
    const { locale, t } = useLocale();
    const isZh = locale === 'zh';

    const [snapshot, setSnapshot] = useState<FullSettings | null>(null);
    const [provider, setProvider] = useState<Provider>('none');
    const [apiKey, setApiKey] = useState('');
    const [revealKey, setRevealKey] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [status, setStatus] = useState<{ type: 'success' | 'error' | 'info'; msg: string } | null>(null);
    const [loaded, setLoaded] = useState(false);

    const refresh = useCallback(async () => {
        if (!user) { setLoaded(true); return; }
        try {
            const res = await apiFetch(`/api/eval/settings?user=${encodeURIComponent(user)}`);
            if (!res.ok) return;
            const data = await res.json();
            setSnapshot(data);
            setProvider((data.searchProvider as Provider) || 'none');
            setApiKey(data.searchApiKey || '');
        } catch (err) {
            console.error('[WebSearchConfig] load failed', err);
        } finally {
            setLoaded(true);
        }
    }, [user]);

    useEffect(() => { refresh(); }, [refresh]);

    const onSave = async () => {
        if (!user || !snapshot) return;
        setIsSaving(true);
        setStatus({ type: 'info', msg: isZh ? '保存中…' : 'Saving…' });
        try {
            const updated: FullSettings = {
                activeConfigId: snapshot.activeConfigId,
                configs: snapshot.configs || [],
                autoEvaluationEnabled: snapshot.autoEvaluationEnabled ?? true,
                searchProvider: provider,
                searchApiKey: provider === 'tavily' ? apiKey.trim() : '',
            };
            const res = await apiFetch('/api/eval/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings: updated, user }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                setStatus({ type: 'error', msg: (isZh ? '保存失败:' : 'Save failed: ') + (err.error || res.statusText) });
                return;
            }
            setStatus({
                type: 'success',
                msg: isZh
                    ? '已保存。下一次 Skills 生成对话生效。'
                    : 'Saved. Will take effect on the next Skill Generation turn.',
            });
            setTimeout(() => setStatus(null), 3000);
            await refresh();
        } catch (err: any) {
            setStatus({ type: 'error', msg: `Error: ${err.message}` });
        } finally {
            setIsSaving(false);
        }
    };

    if (!loaded) {
        return <div style={{ padding: 32, color: 'var(--foreground-muted)', fontSize: 12 }}>{t('common.loading')}</div>;
    }

    const configured = provider === 'tavily' && apiKey.trim().length > 0;

    return (
        <div style={pageWrap}>
            <div style={pageInner}>
                {status && <StatusBar status={status} />}

                {/* === Page intro: description + primary CTA === */}
                <div style={introRow}>
                    <p style={descText}>
                        {isZh ? (
                            <>为 Skills 生成 agent 注入<b style={descStrong}>联网搜索</b>能力(<code style={inlineCode}>web_search</code> / <code style={inlineCode}>web_fetch</code>),用于查官方文档、最佳实践、库的最新 API。当前接入 <b style={descStrong}>Tavily</b>,免费档约 1000 次/月即可日常使用。</>
                        ) : (
                            <>Inject <b style={descStrong}>web search</b> capability (<code style={inlineCode}>web_search</code> / <code style={inlineCode}>web_fetch</code>) into the Skill Generation agent — useful for consulting official docs, best practices, and up-to-date library APIs. Currently powered by <b style={descStrong}>Tavily</b>; its free tier (~1000 calls/month) is enough for daily use.</>
                        )}
                    </p>
                    <button
                        onClick={onSave}
                        disabled={isSaving || !user}
                        style={isSaving || !user ? primaryBtnDisabled : primaryBtn}
                    >
                        <Save size={14} strokeWidth={2.4} />
                        {isSaving ? (isZh ? '保存中…' : 'Saving…') : (isZh ? '保存' : 'Save')}
                    </button>
                </div>

                {/* === Body: 2-column with right sidebar === */}
                <div style={twoColGrid}>
                    {/* --- Main column --- */}
                    <div style={mainCol}>
                        <div style={sectionHeading}>
                            <Globe size={14} strokeWidth={2.2} style={{ color: 'var(--primary)' }} />
                            <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--foreground)' }}>
                                <Term id="web-search" label={isZh ? '联网搜索' : 'Web Search'} />
                            </span>
                            <span style={configured ? badgeHealthy : badgeWarn}>
                                {configured ? <Check size={11} strokeWidth={2.5} /> : null}
                                {configured
                                    ? (isZh ? '已就绪' : 'Ready')
                                    : (isZh ? '未配置' : 'Not configured')}
                            </span>
                            <span style={{ flex: 1 }} />
                            <span style={{ fontSize: 11.5, color: 'var(--foreground-muted)' }}>
                                {isZh ? '保存后下一轮对话生效' : 'Effective next turn after save'}
                            </span>
                        </div>

                        <section style={editCard}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '14px 18px' }}>
                                <Field label={isZh ? '供应商' : 'Provider'}>
                                    <select
                                        value={provider}
                                        onChange={e => setProvider(e.target.value as Provider)}
                                        style={inputStyle}
                                    >
                                        <option value="none">{isZh ? '不启用' : 'Disabled'}</option>
                                        <option value="tavily">Tavily</option>
                                    </select>
                                </Field>

                                {provider === 'tavily' ? (
                                    <Field label={isZh ? 'API 密钥' : 'API Key'}>
                                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                            <input
                                                type={revealKey ? 'text' : 'password'}
                                                value={apiKey}
                                                onChange={e => setApiKey(e.target.value)}
                                                placeholder="tvly-..."
                                                style={{ ...inputStyle, fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setRevealKey(v => !v)}
                                                style={ghostBtn}
                                                title={revealKey ? (isZh ? '隐藏' : 'Hide') : (isZh ? '显示' : 'Show')}
                                            >
                                                {revealKey ? <EyeOff size={13} /> : <Eye size={13} />}
                                                {revealKey ? (isZh ? '隐藏' : 'Hide') : (isZh ? '显示' : 'Show')}
                                            </button>
                                        </div>
                                    </Field>
                                ) : (
                                    <Field label={isZh ? '状态' : 'Status'}>
                                        <div style={{ fontSize: 12.5, color: 'var(--foreground-muted)', padding: '8px 0' }}>
                                            {isZh ? '当前已禁用联网搜索。' : 'Web search is currently disabled.'}
                                        </div>
                                    </Field>
                                )}

                                {provider === 'tavily' && (
                                    <div style={{ gridColumn: '1 / -1' }}>
                                        <Field label={isZh ? '说明' : 'Notes'}>
                                            <div style={{ fontSize: 12, color: 'var(--foreground-secondary)', lineHeight: 1.7 }}>
                                                {isZh ? (
                                                    <>
                                                        前往 <a href="https://tavily.com" target="_blank" rel="noopener noreferrer" style={linkStyle}>tavily.com <ExternalLink size={11} strokeWidth={2} style={{ verticalAlign: 'text-top' }} /></a> 注册获取 API Key。
                                                        Skill 生成对话界面的「联网搜索」开关单独控制每轮是否启用。
                                                    </>
                                                ) : (
                                                    <>
                                                        Get an API key at <a href="https://tavily.com" target="_blank" rel="noopener noreferrer" style={linkStyle}>tavily.com <ExternalLink size={11} strokeWidth={2} style={{ verticalAlign: 'text-top' }} /></a>.
                                                        The &quot;Web search&quot; toggle in the Skill Generation chat panel decides whether each individual turn uses search.
                                                    </>
                                                )}
                                            </div>
                                        </Field>
                                    </div>
                                )}
                            </div>
                        </section>

                        {/* Footer hint */}
                        <div style={hintBox}>
                            <div style={hintIcon}><Info size={16} /></div>
                            <div style={{ flex: 1, fontSize: 12.5, color: 'var(--foreground-secondary)', lineHeight: 1.6 }}>
                                <b style={{ color: 'var(--foreground)', fontWeight: 600 }}>{isZh ? '提示' : 'Tip'}</b> · {isZh
                                    ? '保存后,当前用户名下的所有 Skill 生成会话都会读取最新配置;禁用后 agent 不会再发起任何外部网络请求。'
                                    : 'After saving, every Skill Generation session under your account will pick up the new setting. Disabling stops the agent from issuing any outbound web requests.'}
                            </div>
                        </div>
                    </div>

                    {/* --- Right sidebar --- */}
                    <aside style={sideCol}>
                        <CurrentStatusPanel
                            configured={configured}
                            provider={provider}
                            apiKey={apiKey}
                            locale={locale}
                        />
                        <ToolReferencePanel locale={locale} />
                        <DocsPanel locale={locale} />
                    </aside>
                </div>
            </div>
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

function CurrentStatusPanel({
    configured, provider, apiKey, locale,
}: {
    configured: boolean;
    provider: Provider;
    apiKey: string;
    locale: string;
}) {
    const isZh = locale === 'zh';
    return (
        <section style={panelCard}>
            <header style={panelHeader}>
                <CircleCheck size={13} strokeWidth={2.2} style={{ color: configured ? 'var(--success)' : 'var(--foreground-muted)' }} />
                <span>{isZh ? '当前状态' : 'Current Status'}</span>
            </header>
            <ul style={panelKv}>
                <KvRow
                    label={isZh ? '供应商' : 'Provider'}
                    value={provider === 'tavily' ? 'Tavily' : (isZh ? '未启用' : 'Disabled')}
                    bold
                />
                <KvRow
                    label={isZh ? 'API Key' : 'API Key'}
                    value={apiKey
                        ? maskKey(apiKey)
                        : (isZh ? '(未设置)' : '(not set)')}
                    mono
                />
                <KvRow
                    label={isZh ? '生效范围' : 'Scope'}
                    value={isZh ? '当前账号' : 'Current account'}
                />
                <KvRow
                    label={isZh ? '工具' : 'Tools'}
                    value="web_search · web_fetch"
                    mono
                />
            </ul>
        </section>
    );
}

function ToolReferencePanel({ locale }: { locale: string }) {
    const isZh = locale === 'zh';
    return (
        <section style={panelCard}>
            <header style={panelHeader}>
                <Wrench size={13} strokeWidth={2.2} style={{ color: 'var(--foreground-secondary)' }} />
                <span>{isZh ? '工具说明' : 'Tool Reference'}</span>
            </header>
            <ul style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 0, margin: 0, listStyle: 'none' }}>
                <li>
                    <div style={toolName}>
                        <Search size={11} strokeWidth={2.2} />
                        <code style={inlineCode}>web_search(query, max_results?)</code>
                    </div>
                    <div style={toolDesc}>
                        {isZh ? '关键词搜索,返回 title / url / snippet 列表。' : 'Keyword search returning title / url / snippet.'}
                    </div>
                </li>
                <li>
                    <div style={toolName}>
                        <Globe size={11} strokeWidth={2.2} />
                        <code style={inlineCode}>web_fetch(url)</code>
                    </div>
                    <div style={toolDesc}>
                        {isZh ? '抓取并提取页面正文(去 HTML,保留段落)。' : 'Fetch a URL and extract page text (HTML stripped, paragraphs preserved).'}
                    </div>
                </li>
            </ul>
        </section>
    );
}

function DocsPanel({ locale }: { locale: string }) {
    const isZh = locale === 'zh';
    const links = isZh ? [
        { label: 'Tavily 官网与定价', href: 'https://tavily.com' },
        { label: '如何获取 Tavily API Key', href: 'https://app.tavily.com/home' },
        { label: '联网搜索最佳实践', href: '#' },
    ] : [
        { label: 'Tavily home & pricing', href: 'https://tavily.com' },
        { label: 'How to obtain a Tavily API key', href: 'https://app.tavily.com/home' },
        { label: 'Web search best practices', href: '#' },
    ];
    return (
        <section style={panelCard}>
            <header style={panelHeader}>
                <BookOpen size={13} strokeWidth={2.2} style={{ color: 'var(--foreground-secondary)' }} />
                <span>{isZh ? '相关文档' : 'Related Docs'}</span>
            </header>
            <ul style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: 0, margin: 0, listStyle: 'none' }}>
                {links.map(l => (
                    <li key={l.label}>
                        <a href={l.href} target="_blank" rel="noopener noreferrer" style={docLink}>
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
    label, value, mono, bold,
}: {
    label: string;
    value: string;
    mono?: boolean;
    bold?: boolean;
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
            }} title={value}>
                {value}
            </span>
        </li>
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

/* ====================== Styles (aligned with ModelConfigManager) ====================== */

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
    flexShrink: 0,
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
    border: '1px solid var(--border)',
    borderRadius: 7,
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all .12s ease',
    lineHeight: 1.4,
    flexShrink: 0,
};

const hintBox: CSSProperties = {
    marginTop: 4,
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

const linkStyle: CSSProperties = {
    color: 'var(--primary)',
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
};

const inlineCode: CSSProperties = {
    background: 'var(--background-secondary)',
    padding: '1px 6px',
    borderRadius: 4,
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: 11.5,
    color: 'var(--foreground)',
    border: '1px solid var(--border)',
};

const toolName: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    color: 'var(--foreground-secondary)',
    marginBottom: 3,
};

const toolDesc: CSSProperties = {
    fontSize: 11.5,
    color: 'var(--foreground-muted)',
    lineHeight: 1.55,
    paddingLeft: 17,
};

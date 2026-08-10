'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import {
    Terminal,
    SquareTerminal,
    Key,
    Copy,
    Check,
    Info,
    BookOpen,
    ExternalLink,
    CircleCheck,
    Cloud,
    UserCircle,
    Boxes,
} from 'lucide-react';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { useAuth } from '@/lib/auth/auth-context';
import { useLocale } from '@/lib/client/locale-context';
import { apiFetch, getApiUrl } from '@/lib/client/api';
import { reportClientUsage } from '@/lib/usage-analytics/client-events';
import { Term } from '@/components/text/Term';

/**
 * 客户端安装指导页。
 *
 * 视觉/交互语言对齐 ModelConfigManager(registry 页):pageWrap/pageInner 骨架、
 * introRow(描述)、双列网格(主区 + 300px sidebar)、panelCard、lucide 图标统一。
 */

/**
 * 可勾选的采集端框架。value 必须与 /api/ingest/setup 的白名单一致——
 * 勾选结果以 ?frameworks=a,b 传给脚本，脚本据此跳过终端内的交互选择。
 */
const FRAMEWORK_OPTIONS: { value: string; label: string }[] = [
    { value: 'opencode', label: 'OpenCode' },
    { value: 'claude', label: 'Claude Code' },
    { value: 'codeagent', label: 'CodeAgent' },
    { value: 'openclaw', label: 'OpenClaw' },
    { value: 'hermes', label: 'Hermes' },
    { value: 'xiaoo', label: 'xiaoO' },
    { value: 'jiuwen', label: 'JiuwenSwarm' },
    { value: 'qoder', label: 'Qoder CN product family' },
    { value: 'trae', label: 'Trae IDE' },
];

export default function AccessInstallPage() {
    const { t, locale } = useLocale();
    const { user, apiKey: ctxApiKey } = useAuth();
    const isZh = locale === 'zh';
    const [apiKey, setApiKey] = useState<string | null>(ctxApiKey);
    const [copied, setCopied] = useState<string | null>(null);

    useEffect(() => {
        // 优先级:auth context > 后端按当前登录 user 查 > localStorage fallback
        //
        // 为啥不再优先用 localStorage:之前是 localStorage > ctxApiKey > 后端,
        // 导致切换账号后页面仍显示旧账号的 key(localStorage 不会跟着登录态变)。
        // 用户混淆"我登录的是 A 但页面显示 B 的 key",而且采集端配的也是错的 key,
        // 上报到的是 B 的 trace 名下,A 用户看不到。
        if (ctxApiKey) {
            setApiKey(ctxApiKey);
            return;
        }
        if (!user) {
            // 没登录态时只能用 localStorage 兜底(比如直接拷贝链接访问)
            const stored = typeof window !== 'undefined' ? localStorage.getItem('api_key') : null;
            if (stored) setApiKey(stored);
            return;
        }
        // 有登录 user 但 ctx 暂时没 key —— 主动按 user 拉,确保跟当前账号匹配
        apiFetch('/api/auth/apikey', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user }),
        })
            .then(r => (r.ok ? r.json() : null))
            .then(d => d?.apiKey && setApiKey(d.apiKey))
            .catch(() => {});
    }, [user, ctxApiKey]);

    // 用 useState + useEffect 而不是 useMemo + typeof window 检查:
    // useMemo 同步跑——server 端返回空、client 首次渲染返回实际命令,触发 hydration mismatch。
    // 改成 mount 后再算,server 与 client 首次都渲染空,effect 之后再填入命令。
    const [linuxCmd, setLinuxCmd] = useState('');
    const [windowsCmd, setWindowsCmd] = useState('');
    const [host, setHost] = useState('');
    // 默认勾选 OpenCode——与脚本内交互选择器的默认项保持一致。
    const [frameworks, setFrameworks] = useState<string[]>(['opencode']);
    useEffect(() => {
        const protocol = window.location.protocol;
        const h = window.location.host;
        const baseUrl = `${protocol}//${h}`;
        const setupUrl = getApiUrl('/api/ingest/setup');
        // 逗号在 query 里合法，不编码——命令行里可读性更好。
        const query = [
            apiKey ? `key=${encodeURIComponent(apiKey)}` : '',
            frameworks.length ? `yes=1` : '',
            frameworks.length ? `frameworks=${frameworks.join(',')}` : '',
        ].filter(Boolean).join('&');
        const suffix = query ? `?${query}` : '';
        setLinuxCmd(`curl -sSf "${baseUrl}${setupUrl}${suffix}" | bash`);
        setWindowsCmd(`irm "${baseUrl}${setupUrl}${suffix}" | iex`);
        setHost(baseUrl);
    }, [apiKey, frameworks]);

    const toggleFramework = (value: string) => {
        setFrameworks(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]);
        // 用户主动改接入组件 = 重新生成一份接入配置；页面进入时的首次生成（上面的 effect）不计。
        reportClientUsage('access-install', 'access.config.generate');
    };

    const handleCopy = async (text: string, key: string) => {
        // 不弹任何提示——成功就让按钮变绿,失败也静默
        // (用户反馈:不要弹窗,绿色 ✓ 按钮自己说话)
        let ok = false;
        // 优先尝试现代 Clipboard API(仅在 secure context 下可用:HTTPS / localhost)
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                ok = true;
            } catch { /* 跌落到 execCommand fallback */ }
        }
        // Fallback:HTTP 环境下 clipboard API 不可用,用临时 textarea + execCommand
        // 这是 secure-context 限制的标准绕过手段,几乎所有现代浏览器都还支持
        if (!ok && typeof document !== 'undefined') {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.top = '0';
                ta.style.left = '-9999px';
                ta.setAttribute('readonly', '');
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                ok = document.execCommand('copy');
                document.body.removeChild(ta);
            } catch { ok = false; }
        }
        if (ok) {
            setCopied(key);
            setTimeout(() => setCopied(null), 1500);
            reportClientUsage('access-install', 'access.command.copy');
        }
        // 复制失败时静默——不打扰用户;按钮没变绿,他自然会再点一下或者手动复制
    };

    const keyReady = !!apiKey;
    const langfuseUser = user || (isZh ? '<你的用户名>' : '<your-username>');
    const langfuseSecret = apiKey || (isZh ? '<你的 Agent Insight API Key>' : '<your Agent Insight API key>');
    const langfuseHost = host ? `${host}${getApiUrl('')}` : 'http://localhost:3000';
    const langfuseEnv = [
        `LANGFUSE_BASE_URL=${langfuseHost}`,
        `LANGFUSE_PUBLIC_KEY=${langfuseUser}`,
        `LANGFUSE_SECRET_KEY=${langfuseSecret}`,
    ].join('\n');

    return (
        <>
            <AppTopBar title={<Term id="install-guide" label={t('nav.accessInstall')} />} />
            <div style={pageWrap}>
                <div style={pageInner}>
                    {/* === Page intro === */}
                    <div style={introRow}>
                        <div style={descText}>
                            <p style={introLead}>
                                {isZh
                                    ? <>按<b style={descStrong}>项目类型</b>(而非操作系统)选择接入方式:</>
                                    : <>Pick your integration path by <b style={descStrong}>project type</b>, not OS:</>}
                            </p>
                            <ul style={introList}>
                                <li style={introItem}>
                                    <span style={introDot} />
                                    <span>
                                        {isZh
                                            ? <><b style={descStrong}>命令行 Agent</b>(Claude Code / OpenCode / OpenClaw 等):运行下方一键脚本,自动配置 <code style={inlineCode}>AGENT_INSIGHT_HOST</code> 与 <code style={inlineCode}>AGENT_INSIGHT_API_KEY</code>。</>
                                            : <><b style={descStrong}>Command-line agents</b> (Claude Code, OpenCode, OpenClaw, …): run the one-liner below — it auto-configures <code style={inlineCode}>AGENT_INSIGHT_HOST</code> and <code style={inlineCode}>AGENT_INSIGHT_API_KEY</code>.</>}
                                    </span>
                                </li>
                                <li style={introItem}>
                                    <span style={introDot} />
                                    <span>
                                        {isZh
                                            ? <><b style={descStrong}>LangChain / LangGraph</b> 的 Python 项目:无需安装,只改环境变量;Windows / Linux / macOS 写法相同。</>
                                            : <><b style={descStrong}>LangChain / LangGraph</b> Python projects: no install needed — just set environment variables; identical on Windows, Linux and macOS.</>}
                                    </span>
                                </li>
                            </ul>
                        </div>
                    </div>

                    {/* === Body: 2-column with right sidebar === */}
                    <div style={twoColGrid}>
                        {/* --- Main column --- */}
                        <div style={mainCol}>
                            <div style={sectionHeading}>
                                <Terminal size={14} strokeWidth={2.2} style={{ color: 'var(--primary)' }} />
                                <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--foreground)' }}>
                                    {isZh ? '命令行 Agent 安装' : 'Command-line Agents'}
                                </span>
                                <span style={countPill}>{frameworks.length}</span>
                                <span style={{ flex: 1 }} />
                                <span style={{ fontSize: 11.5, color: 'var(--foreground-muted)' }}>
                                    {isZh ? '先勾选框架,再按系统二选一' : 'Pick your frameworks, then your OS'}
                                </span>
                            </div>

                            <FrameworkPicker
                                options={FRAMEWORK_OPTIONS}
                                selected={frameworks}
                                onToggle={toggleFramework}
                                locale={locale}
                            />

                            <CommandCard
                                icon={<Terminal size={14} strokeWidth={2.2} />}
                                label="Linux / macOS"
                                hint={isZh ? '运行 bash / zsh 的终端' : 'bash / zsh shells'}
                                cmd={linuxCmd}
                                copied={copied === 'linux'}
                                onCopy={() => handleCopy(linuxCmd, 'linux')}
                                locale={locale}
                            />

                            <CommandCard
                                icon={<SquareTerminal size={14} strokeWidth={2.2} />}
                                label="Windows (PowerShell)"
                                hint={isZh ? '以管理员身份运行 PowerShell' : 'Run PowerShell as administrator'}
                                cmd={windowsCmd}
                                copied={copied === 'windows'}
                                onCopy={() => handleCopy(windowsCmd, 'windows')}
                                locale={locale}
                            />

                            <div style={{ ...sectionHeading, marginTop: 8 }}>
                                <Cloud size={14} strokeWidth={2.2} style={{ color: 'var(--primary)' }} />
                                <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--foreground)' }}>
                                    {isZh ? 'LangChain / LangGraph 接入' : 'LangChain / LangGraph'}
                                </span>
                                <span style={countPill}>env</span>
                                <span style={{ flex: 1 }} />
                                <span style={{ fontSize: 11.5, color: 'var(--foreground-muted)' }}>
                                    {isZh ? 'Python 项目,任何系统只改环境变量' : 'Python — env vars only, any OS'}
                                </span>
                            </div>

                            <LangfuseEnvCard
                                envText={langfuseEnv}
                                copied={copied === 'langfuse-env'}
                                onCopy={() => handleCopy(langfuseEnv, 'langfuse-env')}
                                locale={locale}
                            />

                            {/* Footer hint */}
                            <div style={hintBox}>
                                <div style={hintIcon}><Info size={16} /></div>
                                <div style={{ flex: 1, fontSize: 12.5, color: 'var(--foreground-secondary)', lineHeight: 1.6 }}>
                                    <b style={{ color: 'var(--foreground)', fontWeight: 600 }}>{isZh ? '提示' : 'Tip'}</b> · {isZh
                                        ? '若 API Key 切换了账号没刷新,请先退出并重新登录平台再复制 —— 客户端使用错误的 Key 上报时,trace 会落到原账号名下而非当前账号。'
                                        : 'If you switched accounts but the API key did not refresh, log out and log back in before copying — a stale key sends traces to the old account.'}
                                </div>
                            </div>
                        </div>

                        {/* --- Right sidebar --- */}
                        <aside style={sideCol}>
                            <ApiKeyPanel
                                apiKey={apiKey}
                                copied={copied === 'apikey'}
                                onCopy={() => apiKey && handleCopy(apiKey, 'apikey')}
                                locale={locale}
                            />
                            <ConnectionPanel
                                host={host}
                                user={user}
                                keyReady={keyReady}
                                locale={locale}
                            />
                            <DocsPanel locale={locale} />
                        </aside>
                    </div>
                </div>
            </div>
        </>
    );
}

/* ====================== Sub-components ====================== */

function FrameworkPicker({
    options, selected, onToggle, locale,
}: {
    options: { value: string; label: string }[];
    selected: string[];
    onToggle: (value: string) => void;
    locale: string;
}) {
    const isZh = locale === 'zh';
    return (
        <article style={commandCard}>
            <header style={commandCardHeader}>
                <span style={commandIconBox}><Boxes size={14} strokeWidth={2.2} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--foreground)', letterSpacing: '-0.01em' }}>
                        {isZh ? '选择要接入的框架' : 'Frameworks to integrate'}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--foreground-muted)', marginTop: 1 }}>
                        {isZh ? '可多选,下方命令会跟着变' : 'Multi-select — the commands below update accordingly'}
                    </div>
                </div>
            </header>
            <div style={chipRow}>
                {options.map(o => {
                    const active = selected.includes(o.value);
                    return (
                        <button
                            key={o.value}
                            type="button"
                            onClick={() => onToggle(o.value)}
                            style={active ? frameworkChipActive : frameworkChip}
                        >
                            {active && <Check size={12} strokeWidth={2.6} />}
                            {o.label}
                        </button>
                    );
                })}
            </div>
            <div style={langfuseNote}>
                {selected.length === 0
                    ? (isZh
                        ? '未勾选任何框架 —— 命令不带 frameworks 参数,脚本会在终端里让你交互选择(该步骤需要访问 npm 源)。'
                        : 'Nothing selected — the command omits the frameworks parameter and the script prompts inside the terminal (that step needs npm registry access).')
                    : (isZh
                        ? '已勾选的框架会写进命令,脚本跳过终端内的交互选择 —— 内网/离线环境无需访问 npm 源。'
                        : 'Selected frameworks are baked into the command, so the script skips the terminal prompt — no npm registry access needed on offline or intranet machines.')}
            </div>
        </article>
    );
}

function CommandCard({
    icon, label, hint, cmd, copied, onCopy, locale,
}: {
    icon: React.ReactNode;
    label: string;
    hint: string;
    cmd: string;
    copied: boolean;
    onCopy: () => void;
    locale: string;
}) {
    const isZh = locale === 'zh';
    return (
        <article style={commandCard}>
            <header style={commandCardHeader}>
                <span style={commandIconBox}>{icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--foreground)', letterSpacing: '-0.01em' }}>
                        {label}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--foreground-muted)', marginTop: 1 }}>{hint}</div>
                </div>
                {cmd && (
                    <button
                        onClick={onCopy}
                        style={copied ? copiedBtn : ghostBtn}
                    >
                        {copied
                            ? <><Check size={13} strokeWidth={2.5} />{isZh ? '已复制' : 'Copied'}</>
                            : <><Copy size={13} strokeWidth={2.2} />{isZh ? '复制' : 'Copy'}</>}
                    </button>
                )}
            </header>
            <div style={commandBox}>
                <code style={commandCode}>
                    {cmd || (isZh ? '加载中…' : 'Loading…')}
                </code>
            </div>
        </article>
    );
}

function ApiKeyPanel({
    apiKey, copied, onCopy, locale,
}: {
    apiKey: string | null;
    copied: boolean;
    onCopy: () => void;
    locale: string;
}) {
    const isZh = locale === 'zh';
    return (
        <section style={{ ...panelCard, background: 'var(--primary-subtle)', borderColor: 'var(--primary-subtle-border)' }}>
            <header style={{ ...panelHeader, borderBottomColor: 'var(--primary-subtle-border)' }}>
                <Key size={13} strokeWidth={2.4} style={{ color: 'var(--primary)' }} />
                <span style={{ color: 'var(--primary)' }}>{isZh ? '你的 API Key' : 'Your API Key'}</span>
            </header>
            <div>
                <code style={apiKeyCode}>
                    {apiKey || (isZh ? '加载中…' : 'Loading…')}
                </code>
                {apiKey && (
                    <button
                        onClick={onCopy}
                        style={{ ...apiKeyCopyBtn, ...(copied ? copiedBtn : {}) }}
                    >
                        {copied
                            ? <><Check size={12} strokeWidth={2.5} />{isZh ? '已复制' : 'Copied'}</>
                            : <><Copy size={12} strokeWidth={2.2} />{isZh ? '复制 Key' : 'Copy key'}</>}
                    </button>
                )}
                <div style={{ fontSize: 11.5, color: 'var(--foreground-muted)', marginTop: 10, lineHeight: 1.6 }}>
                    {isZh
                        ? '脚本运行时提示输入 API Key —— 粘贴上方值即可。'
                        : 'Paste this when the script prompts for an API key.'}
                </div>
            </div>
        </section>
    );
}

function ConnectionPanel({
    host, user, keyReady, locale,
}: {
    host: string;
    user: string | null;
    keyReady: boolean;
    locale: string;
}) {
    const isZh = locale === 'zh';
    return (
        <section style={panelCard}>
            <header style={panelHeader}>
                <CircleCheck size={13} strokeWidth={2.2} style={{ color: keyReady ? 'var(--success)' : 'var(--foreground-muted)' }} />
                <span>{isZh ? '接入信息' : 'Connection Info'}</span>
            </header>
            <ul style={panelKv}>
                <KvRow
                    label={isZh ? '账号' : 'Account'}
                    value={user || (isZh ? '未登录' : 'Not signed in')}
                    icon={<UserCircle size={11} strokeWidth={2.2} />}
                />
                <KvRow
                    label={isZh ? '平台地址' : 'Host'}
                    value={host || '—'}
                    mono
                    ellipsis
                />
                <KvRow
                    label={isZh ? 'API Key' : 'API Key'}
                    value={keyReady
                        ? (isZh ? '已绑定' : 'Ready')
                        : (isZh ? '加载中' : 'Loading')}
                />
                <KvRow
                    label={isZh ? '上报路径' : 'Ingest'}
                    value="/api/ingest/v1/*"
                    mono
                />
                <KvRow
                    label={isZh ? 'OTEL 上报' : 'OTEL trace'}
                    value="/api/public/otel/v1/traces"
                    mono
                    ellipsis
                />
            </ul>
        </section>
    );
}

function LangfuseEnvCard({
    envText, copied, onCopy, locale,
}: {
    envText: string;
    copied: boolean;
    onCopy: () => void;
    locale: string;
}) {
    const isZh = locale === 'zh';
    return (
        <article style={commandCard}>
            <header style={commandCardHeader}>
                <span style={commandIconBox}><Cloud size={14} strokeWidth={2.2} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--foreground)', letterSpacing: '-0.01em' }}>
                        {isZh ? '环境变量配置' : 'Environment variables'}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--foreground-muted)', marginTop: 1 }}>
                        {isZh ? 'LangChain / LangGraph 项目通用,Windows / Linux / macOS 写法一致' : 'Same for LangChain / LangGraph on Windows, Linux or macOS'}
                    </div>
                </div>
                <button onClick={onCopy} style={copied ? copiedBtn : ghostBtn}>
                    {copied
                        ? <><Check size={13} strokeWidth={2.5} />{isZh ? '已复制' : 'Copied'}</>
                        : <><Copy size={13} strokeWidth={2.2} />{isZh ? '复制' : 'Copy'}</>}
                </button>
            </header>
            <div style={commandBox}>
                <code style={{ ...commandCode, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {envText}
                </code>
            </div>
            <div style={langfuseNote}>
                {isZh
                    ? '这些以 LANGFUSE_ 开头的变量由 LangChain / LangGraph 的追踪回调读取,填好即可、无需改代码。PUBLIC_KEY 填当前 Agent Insight 用户名,SECRET_KEY 填该用户的 Agent Insight API Key;两者不对应时平台会拒绝上报。'
                    : 'These LANGFUSE_-prefixed variables are read by the LangChain / LangGraph tracing callback — no code changes needed. Set PUBLIC_KEY to your Agent Insight username and SECRET_KEY to that user\'s Agent Insight API key. Mismatched credentials are rejected.'}
            </div>
        </article>
    );
}

function DocsPanel({ locale }: { locale: string }) {
    const isZh = locale === 'zh';
    const links = isZh ? [
        { label: '用户使用手册', href: 'https://atomgit.com/openeuler/witty-skill-insight/wiki/%E7%94%A8%E6%88%B7%E4%BD%BF%E7%94%A8%E6%89%8B%E5%86%8C' },
        { label: '客户端高级配置', href: '#' },
        { label: '常见接入问题排查', href: '#' },
    ] : [
        { label: 'User manual', href: 'https://atomgit.com/openeuler/witty-skill-insight/wiki/%E7%94%A8%E6%88%B7%E4%BD%BF%E7%94%A8%E6%89%8B%E5%86%8C' },
        { label: 'Advanced client configuration', href: '#' },
        { label: 'Troubleshooting installation', href: '#' },
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
    label, value, mono, bold, ellipsis, icon,
}: {
    label: string;
    value: string;
    mono?: boolean;
    bold?: boolean;
    ellipsis?: boolean;
    icon?: React.ReactNode;
}) {
    return (
        <li style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '5px 0', borderBottom: '1px dashed var(--border)', minWidth: 0 }}>
            <span style={{ fontSize: 11.5, color: 'var(--foreground-muted)', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {icon}
                {label}
            </span>
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

const introLead: CSSProperties = {
    margin: '0 0 8px',
};

const introList: CSSProperties = {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
};

const introItem: CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
};

const introDot: CSSProperties = {
    width: 5,
    height: 5,
    borderRadius: '50%',
    background: 'var(--primary)',
    flexShrink: 0,
    marginTop: 7,
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

const commandCard: CSSProperties = {
    background: 'var(--card-bg)',
    border: '1px solid var(--card-border)',
    borderRadius: 12,
    padding: '14px 18px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
};

const commandCardHeader: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
};

const commandIconBox: CSSProperties = {
    width: 32,
    height: 32,
    borderRadius: 9,
    background: 'var(--background-secondary)',
    border: '1px solid var(--card-border)',
    display: 'grid',
    placeItems: 'center',
    color: 'var(--foreground-secondary)',
    flexShrink: 0,
};

const chipRow: CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
};

const frameworkChip: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '6px 13px',
    background: 'var(--background-secondary)',
    color: 'var(--foreground-secondary)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    borderRadius: 999,
    fontSize: 12.5,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all .12s ease',
    lineHeight: 1.4,
};

const frameworkChipActive: CSSProperties = {
    ...frameworkChip,
    background: 'var(--primary-subtle)',
    color: 'var(--primary)',
    borderColor: 'var(--primary-subtle-border)',
    fontWeight: 600,
};

const commandBox: CSSProperties = {
    background: 'var(--background-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '10px 12px',
};

const commandCode: CSSProperties = {
    color: 'var(--foreground)',
    fontSize: 12,
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    wordBreak: 'break-all',
    display: 'block',
    lineHeight: 1.6,
};

const apiKeyCode: CSSProperties = {
    display: 'block',
    width: '100%',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: 11.5,
    padding: '8px 10px',
    background: 'var(--card-bg)',
    border: '1px solid var(--card-border)',
    borderRadius: 6,
    color: 'var(--foreground)',
    wordBreak: 'break-all',
    boxSizing: 'border-box',
};

const apiKeyCopyBtn: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    width: '100%',
    justifyContent: 'center',
    padding: '7px 10px',
    marginTop: 8,
    background: 'var(--card-bg)',
    color: 'var(--primary)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--primary-subtle-border)',
    borderRadius: 7,
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all .12s ease',
    lineHeight: 1.4,
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
    flexShrink: 0,
};

const copiedBtn: CSSProperties = {
    ...ghostBtn,
    background: 'var(--success-subtle)',
    color: 'var(--success)',
    borderColor: 'var(--success-subtle-border)',
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

const langfuseNote: CSSProperties = {
    fontSize: 12,
    lineHeight: 1.6,
    color: 'var(--foreground-secondary)',
    padding: '0 2px',
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

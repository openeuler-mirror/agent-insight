'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import {
    Terminal,
    Key,
    Copy,
    Check,
    Info,
    CircleCheck,
    UserCircle,
    Boxes,
} from 'lucide-react';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { useAuth } from '@/lib/auth/auth-context';
import { useLocale } from '@/lib/client/locale-context';
import { getApiUrl } from '@/lib/client/api';
import { getSelectedReportingChannels } from '@/lib/ingest/framework-reporting-channels';
import {
    FRAMEWORK_OPTIONS,
    resolveInstallProfile,
} from '@/lib/ingest/setup/install-profile';
import { reportClientUsage } from '@/lib/usage-analytics/client-events';
import { Term } from '@/components/text/Term';

/**
 * 客户端安装指导页。
 *
 * 视觉/交互语言对齐 ModelConfigManager(registry 页):pageWrap/pageInner 骨架、
 * introRow(描述)、双列网格(主区 + 300px sidebar)、panelCard、lucide 图标统一。
 */

const INSTALL_FRAMEWORK_OPTIONS = FRAMEWORK_OPTIONS
    .filter(option => ['opencode', 'qoder'].includes(option.value))
    .map(option => option.value === 'qoder' ? { ...option, label: 'Qoder' } : option);
const FRAMEWORK_LABELS = new Map(INSTALL_FRAMEWORK_OPTIONS.map(option => [option.value, option.label]));

export default function AccessInstallPage() {
    const { t, locale } = useLocale();
    const { user, apiKey, authReady } = useAuth();
    const isZh = locale === 'zh';
    const [copied, setCopied] = useState<string | null>(null);

    // 用 useState + useEffect 而不是 useMemo + typeof window 检查:
    // useMemo 同步跑——server 端返回空、client 首次渲染返回实际命令,触发 hydration mismatch。
    // 改成 mount 后再算,server 与 client 首次都渲染空,effect 之后再填入命令。
    const [linuxCmd, setLinuxCmd] = useState('');
    const [windowsCmd, setWindowsCmd] = useState('');
    const [host, setHost] = useState('');
    // 默认勾选 OpenCode——与脚本内交互选择器的默认项保持一致。
    const [frameworks, setFrameworks] = useState<string[]>(['opencode']);
    const installProfile = resolveInstallProfile(
        INSTALL_FRAMEWORK_OPTIONS.filter(option => frameworks.includes(option.value)),
    );
    const proxyCmd = frameworks.length ? 'sh ~/.agent-insight/model-proxy.sh ' + frameworks.join(',') : '';
    const effectiveFrameworks = installProfile.effectiveFrameworks.map(option => option.value);
    useEffect(() => {
        const timer = window.setTimeout(() => {
            const protocol = window.location.protocol;
            const h = window.location.host;
            const baseUrl = `${protocol}//${h}`;
            setHost(baseUrl);
            if (!authReady || !apiKey || !frameworks.length) {
                setLinuxCmd('');
                setWindowsCmd('');
                return;
            }
            const setupUrl = getApiUrl('/api/ingest/setup');
            // 逗号在 query 里合法，不编码——命令行里可读性更好。
            const query = [
                `key=${encodeURIComponent(apiKey)}`,
                'yes=1',
                `frameworks=${frameworks.join(',')}`,
            ].filter(Boolean).join('&');
            const suffix = query ? `?${query}` : '';
            const url = `${baseUrl}${setupUrl}${suffix}`;
            setLinuxCmd(`curl -sSf "${url}" | bash`);
            setWindowsCmd(`Invoke-Expression (Invoke-RestMethod -Uri "${baseUrl}${setupUrl}${suffix}" -Headers @{'x-platform'='windows'})`);
        }, 0);
        return () => window.clearTimeout(timer);
    }, [apiKey, authReady, frameworks]);

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

    const keyReady = authReady && !!apiKey;

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
                                    ? <>当前支持 <b style={descStrong}>OpenCode 和 Qoder</b>。选择要接入的 Agent，在 Agent 所在主机运行下方一键安装命令。</>
                                    : <>This deployment supports <b style={descStrong}>OpenCode and Qoder</b>. Select your agents and run the one-line installer on their host.</>}
                            </p>
                            <p style={{ margin: 0 }}>
                                {isZh
                                    ? <>采集安装不改写模型地址。OpenCode 和 Qoder CLI 可在安装后显式启用模型转发；Qoder GUI 尚不支持模型地址接管。</>
                                    : <>Collector installation leaves model addresses unchanged. Explicitly enable model forwarding for OpenCode or Qoder CLI after installation; Qoder GUI endpoint takeover is unavailable.</>}
                            </p>
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
                                    {isZh
                                        ? '先勾选框架,再在目标 Agent 主机执行对应系统的命令 —— 同时完成本机纳管'
                                        : 'Pick frameworks, then run the matching command on the target Agent host — also registers this host'}
                                </span>
                            </div>

                            <FrameworkPicker
                                options={INSTALL_FRAMEWORK_OPTIONS}
                                selected={frameworks}
                                onToggle={toggleFramework}
                                locale={locale}
                            />

                            <section aria-labelledby="client-backup-title" style={{ ...hintBox, alignItems: 'flex-start', border: '1px solid var(--warning-subtle-border)', background: 'var(--warning-subtle)' }}>
                                <Info size={18} style={{ color: 'var(--warning)', flexShrink: 0 }} />
                                <div style={{ ...descText, flex: 1, fontSize: 12.5 }}>
                                    <h2 id="client-backup-title" style={{ margin: '0 0 6px', fontSize: 13.5, fontWeight: 600, color: 'var(--foreground)' }}>
                                        {isZh ? '安装前请自行备份' : 'Back up your configuration before installation'}
                                    </h2>
                                    <p style={{ margin: '0 0 6px' }}>
                                        {isZh
                                            ? '采集安装会更新 Hook 和插件配置，请先自行备份这些配置；安装命令不改写模型地址。可选的模型转发命令会单独备份模型配置。不提供一键恢复或卸载。'
                                            : 'Collector installation updates hooks and plugin settings; back them up first. Installation leaves model addresses unchanged. The optional forwarding command backs up model configuration separately. One-click restore and uninstall are not provided.'}
                                    </p>
                                    <p style={{ margin: 0 }}>
                                        {isZh ? '备份范围：' : 'Back up: '}
                                        <code>~/.config/opencode/</code>{isZh ? '（或 XDG_CONFIG_HOME / 自定义配置路径，含模型、插件和 tui.json），项目内 ' : ' (or XDG_CONFIG_HOME / custom configuration paths, including model, plugin, and tui.json settings), project '}
                                        <code>opencode.json(c)</code>、<code>.opencode/</code>、<code>.qoder/</code>{isZh ? '，以及 ' : ', and '}
                                        <code>~/.qoder-cn/settings.json</code>、<code>~/.qoder/settings.json</code>、<code>~/.qoderworkcn/settings.json</code>、<code>~/.qoderwork/settings.json</code>{isZh ? ' 及实际使用的自定义目录。' : ', and any custom locations you use.'}
                                    </p>
                                    <p style={{ margin: '6px 0 0' }}>
                                        {isZh ? 'Qoder Token 采集还会修改 ' : 'Qoder Token collection also updates '}
                                        <code>~/.profile</code>、<code>~/.bashrc</code>、<code>~/.zshrc</code>{isZh ? '（Unix）或 Windows 用户环境变量。请备份这些文件，或记录原来的 QODERCN_EXPOSE_TOKEN_USAGE 值。' : ' (Unix) or Windows user environment variables. Back up these files or record the original QODERCN_EXPOSE_TOKEN_USAGE value.'}
                                    </p>
                                </div>
                            </section>

                            <CommandCard
                                icon={<Terminal size={14} strokeWidth={2.2} />}
                                label="Linux"
                                hint={isZh ? '使用 Agent 所在 Linux 环境的 bash / zsh 终端' : 'Use a bash / zsh shell on the Linux Agent host'}
                                cmd={linuxCmd}
                                unavailableMessage={!frameworks.length ? (isZh ? '请先选择 OpenCode 或 Qoder' : 'Select OpenCode or Qoder first') : undefined}
                                copied={copied === 'linux'}
                                onCopy={() => handleCopy(linuxCmd, 'linux')}
                                locale={locale}
                            />

                            <CommandCard
                                icon={<Terminal size={14} strokeWidth={2.2} />}
                                label="Windows (PowerShell)"
                                hint={isZh ? '在 Windows PowerShell 中运行' : 'Run in Windows PowerShell'}
                                cmd={windowsCmd}
                                unavailableMessage={!frameworks.length ? (isZh ? '请先选择 OpenCode 或 Qoder' : 'Select OpenCode or Qoder first') : undefined}
                                copied={copied === 'windows'}
                                onCopy={() => handleCopy(windowsCmd, 'windows')}
                                locale={locale}
                            />

                            <CommandCard
                                icon={<Terminal size={14} strokeWidth={2.2} />}
                                label={isZh ? '可选：启用 / 同步模型转发（Linux / macOS）' : 'Optional: enable / sync model forwarding (Linux / macOS)'}
                                hint={isZh ? '安装采集后，在 Agent 项目目录单独执行。将模型地址改为本机转发入口，原地址登记到本机路由。新增 Provider 或修改上游后，重新执行同一命令。' : 'Run separately from the Agent project after collector installation. Replaces model URLs with the local gateway and registers upstream routes. Repeat after adding providers or changing upstreams.'}
                                cmd={proxyCmd}
                                unavailableMessage={isZh ? '请先选择 OpenCode 或 Qoder' : 'Select OpenCode or Qoder first'}
                                copied={copied === 'proxy'}
                                onCopy={() => handleCopy(proxyCmd, 'proxy')}
                                locale={locale}
                            />
                            <div style={hintBox}>
                                <Info size={16} style={{ flexShrink: 0 }} />
                                <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                                    {isZh ? '命令执行前会自动备份并输出位置：original.jsonc 保留首次原件；latest.jsonc 同步用户后续修改和新增模型，并保留原始上游地址。备份位于 AGENT_INSIGHT_HOME/inference-proxy/backups/（默认 ~/.agent-insight/），可能包含 API Key，请妥善保管。后台不会自动接管新地址；修改后请重启 Agent 会话。脚本复用安装时的 Node.js 20+，缺失时会提示并停止。自定义安装目录请使用安装输出中的 sh 命令。' : 'The command backs up configuration before changes and prints its location: original.jsonc preserves the first copy; latest.jsonc includes later edits and models with original upstream URLs. Backups live under AGENT_INSIGHT_HOME/inference-proxy/backups/ (default ~/.agent-insight/) and may contain API keys. New endpoints are never enrolled in the background. Restart Agent sessions after changes. The script reuses Node.js 20+ from installation and stops if unavailable. For a custom installation directory, use the sh command printed by the installer.'}
                                </div>
                            </div>

                            {/* Footer hint */}
                            <div style={hintBox}>
                                <div style={hintIcon}><Info size={16} /></div>
                                <div style={{ flex: 1, fontSize: 12.5, color: 'var(--foreground-secondary)', lineHeight: 1.6 }}>
                                    <b style={{ color: 'var(--foreground)', fontWeight: 600 }}>{isZh ? '提示' : 'Tip'}</b> · {isZh
                                        ? '页面会先向服务端刷新并验证当前登录身份；验证完成前不会生成可复制的安装命令。切换平台地址或重建服务后，请重新打开本页并执行新命令。'
                                        : 'This page refreshes and verifies the current server identity before generating a copyable command. After changing hosts or rebuilding the service, reopen this page and run a fresh command.'}
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
                                frameworks={effectiveFrameworks}
                                locale={locale}
                            />
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
    options: readonly { value: string; label: string }[];
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
                            aria-pressed={active}
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
                        ? '请至少选择 OpenCode 或 Qoder，选择后生成安装命令。'
                        : 'Select OpenCode or Qoder to generate an installation command.')
                    : (isZh
                        ? '已勾选的框架会写进命令,脚本跳过终端内的交互选择 —— 内网/离线环境无需访问 npm 源。'
                        : 'Selected frameworks are baked into the command, so the script skips the terminal prompt — no npm registry access needed on offline or intranet machines.')}
            </div>
        </article>
    );
}

function CommandCard({
    icon, label, hint, cmd, copied, onCopy, locale, unavailableMessage,
}: {
    icon: React.ReactNode;
    label: string;
    hint: string;
    cmd: string;
    copied: boolean;
    onCopy: () => void;
    locale: string;
    unavailableMessage?: string;
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
                        type="button"
                        aria-label={isZh ? `复制${label}命令` : `Copy ${label} command`}
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
                    {cmd || unavailableMessage || (isZh ? '加载中…' : 'Loading…')}
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
                        ? '左侧命令已包含当前账号的 API Key，复制后即可执行。'
                        : 'The command includes your current API key and is ready to copy and run.'}
                </div>
            </div>
        </section>
    );
}

function ConnectionPanel({
    host, user, keyReady, frameworks, locale,
}: {
    host: string;
    user: string | null;
    keyReady: boolean;
    frameworks: string[];
    locale: string;
}) {
    const isZh = locale === 'zh';
    const reportingChannels = getSelectedReportingChannels(frameworks);
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
            </ul>
            <div style={channelSectionHeader}>
                <span>{isZh ? '当前上报通道' : 'Active reporting channels'}</span>
                <span style={countPill}>{reportingChannels.length}</span>
            </div>
            {reportingChannels.length === 0 ? (
                <div style={emptyChannelText}>
                    {isZh ? '请先选择 OpenCode 或 Qoder。' : 'Select OpenCode or Qoder first.'}
                </div>
            ) : (
                <div style={channelList}>
                    {reportingChannels.map(channel => (
                        <div key={channel.id} style={channelItem}>
                            <div style={channelLabel}>{isZh ? channel.labelZh : channel.labelEn}</div>
                            <code style={channelEndpoint}>{channel.endpoint}</code>
                            <div style={channelFrameworks}>
                                {channel.frameworks.map(framework => FRAMEWORK_LABELS.get(framework) || framework).join(' · ')}
                            </div>
                        </div>
                    ))}
                </div>
            )}
            {reportingChannels.length > 0 && (
                <div style={channelStatusNote}>
                    {isZh
                        ? '已受理不等于已可见，平台仍需异步聚合。'
                        : 'Accepted data still requires asynchronous aggregation before it becomes visible.'}
                </div>
            )}
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

const channelSectionHeader: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingTop: 2,
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--foreground)',
};

const channelList: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
};

const channelItem: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '9px 10px',
    background: 'var(--background-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    minWidth: 0,
};

const channelLabel: CSSProperties = {
    fontSize: 11.5,
    fontWeight: 600,
    color: 'var(--foreground-secondary)',
};

const channelEndpoint: CSSProperties = {
    fontSize: 11,
    lineHeight: 1.45,
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    color: 'var(--foreground)',
    overflowWrap: 'anywhere',
};

const channelFrameworks: CSSProperties = {
    fontSize: 10.5,
    lineHeight: 1.45,
    color: 'var(--foreground-muted)',
    overflowWrap: 'anywhere',
};

const emptyChannelText: CSSProperties = {
    padding: '10px',
    border: '1px dashed var(--border)',
    borderRadius: 8,
    background: 'var(--background-secondary)',
    fontSize: 11.5,
    lineHeight: 1.5,
    color: 'var(--foreground-muted)',
};

const channelStatusNote: CSSProperties = {
    fontSize: 10.5,
    lineHeight: 1.5,
    color: 'var(--foreground-muted)',
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
    maxHeight: 320,
    overflow: 'auto',
};

const commandCode: CSSProperties = {
    color: 'var(--foreground)',
    fontSize: 12,
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflowWrap: 'anywhere',
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

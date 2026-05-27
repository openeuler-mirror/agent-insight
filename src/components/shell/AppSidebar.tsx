'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth/auth-context';
import { useTheme } from '@/lib/client/theme-context';
import { useLocale } from '@/lib/client/locale-context';
import { useSidebar } from '@/lib/client/sidebar-context';

const basePath = process.env.NEXT_PUBLIC_URL_PREFIX || '';

type BadgeKind = 'r' | 'y' | 'g';

interface NavItem {
    key: string;
    href?: string;
    labelKey: string;
    iconPath?: React.ReactNode;
    matchPrefixes?: string[];
    badge?: { text: string; kind: BadgeKind };
    pending?: boolean;
    children?: NavItem[];
}

interface NavGroup {
    key: string;
    labelKey: string;
    iconPath: React.ReactNode;
    variant?: 'agent' | 'plain';
    href?: string;
    items?: NavItem[];
}

const ICON_AGENT = (<><circle cx="7" cy="4.5" r="2.2" /><path d="M2.5 12c0-2.49 2.02-4.5 4.5-4.5s4.5 2.01 4.5 4.5" /><circle cx="12" cy="3.5" r="1.4" /><path d="M12 6.5c1 .28 1.8 1.12 1.8 2.2" /></>);
const ICON_SKILLS = (<><rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1" /><rect x="8" y="1.5" width="4.5" height="4.5" rx="1" /><rect x="1.5" y="8" width="4.5" height="4.5" rx="1" /><rect x="8" y="8" width="4.5" height="4.5" rx="1" /></>);
const ICON_PLAYGROUND = (<><rect x="1.5" y="3" width="11" height="8" rx="1.5" /><path d="M4.5 6.5l2 2 3-3" /></>);
const ICON_DEBUG = (<><path d="M4 2h6v2l1.5 1.5v5.5H2.5V5.5L4 4V2z" /><path d="M5 10v1.5M7 10v1.5M9 10v1.5" /></>);
const ICON_RELEASE = (<><circle cx="7" cy="7" r="5.5" /><path d="M5 7l2 2 2-4" /></>);
const ICON_DASHBOARD = (<><rect x="2" y="2" width="4.5" height="4.5" rx="1" /><rect x="7.5" y="2" width="4.5" height="4.5" rx="1" /><rect x="2" y="7.5" width="4.5" height="4.5" rx="1" /><rect x="7.5" y="7.5" width="4.5" height="4.5" rx="1" /></>);
const ICON_OBSERVE = (<><circle cx="7" cy="7" r="5.5" /><path d="M4.5 7c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5" /><circle cx="7" cy="7" r="1.5" /></>);
const ICON_TRACE = <path d="M2 4h10M2 7h7M2 10h9" />;
const ICON_FAULT = (<><path d="M7 2.5v4.5M7 10v.5" /><circle cx="7" cy="7" r="5.5" /></>);
const ICON_EVAL = (<><path d="M4.5 7l2 2 3-3" /><circle cx="7" cy="7" r="5.5" /></>);
const ICON_DATASET = (<><ellipse cx="7" cy="4.5" rx="4.5" ry="2" /><path d="M2.5 4.5v3c0 1.1 2.02 2 4.5 2s4.5-.9 4.5-2v-3" /><path d="M2.5 7.5v3c0 1.1 2.02 2 4.5 2s4.5-.9 4.5-2v-3" /></>);
const ICON_METRICS = <path d="M2 12h10M3 12V8h2v4M6 12V4h2v8M9 12V6h2v6" />;
const ICON_MEMORY = (<><ellipse cx="7" cy="4.5" rx="4.5" ry="2" /><path d="M2.5 4.5v2.5c0 1.1 2.02 2 4.5 2s4.5-.9 4.5-2V4.5" /><path d="M2.5 7v2.5c0 1.1 2.02 2 4.5 2s4.5-.9 4.5-2V7" /></>);
const ICON_QUALITY = <path d="M2 9.5l2.5-2.5 2.5 2.5 5-6" />;
const ICON_SECURITY = <path d="M7 1.5L2 4v4.5c0 3 2.5 4.5 5 5 2.5-.5 5-2 5-5V4l-5-2.5z" />;
const ICON_MODEL = (<><path d="M2 4.5h10M2 9.5h10" /><circle cx="4.5" cy="4.5" r="1.5" /><circle cx="9.5" cy="9.5" r="1.5" /></>);
const ICON_ACCESS = (<><path d="M2 2.5h10M2 7h10M2 11.5h10" /><circle cx="7" cy="2.5" r="1" /><circle cx="7" cy="7" r="1" /><circle cx="7" cy="11.5" r="1" /></>);
const ICON_KEY = (<><circle cx="4" cy="9" r="2.2" /><path d="M5.5 7.5l5-5M9 4l1.5 1.5M11 6l1-1" /></>);
const ICON_DEFAULT = (<><circle cx="7" cy="7" r="5.5" /><path d="M7 4v3l2 2" /></>);
const ICON_WEBHOOK = (<><circle cx="3.5" cy="10" r="1.6" /><circle cx="10.5" cy="4" r="1.6" /><circle cx="7" cy="11" r="1.6" /><path d="M5 10l4-4M9 10.5l1-5" /></>);
const ICON_HEALTH = <path d="M2 7h2.5l1.5-3 2 6 1.5-3H12" />;
const ICON_INSTALL = (<><path d="M7 1.5v7M4 6l3 3 3-3" /><path d="M2 11h10" /></>);
const ICON_WEB = (<><circle cx="7" cy="7" r="5" /><path d="M2 7h10M7 2a8 8 0 0 1 0 10M7 2a8 8 0 0 0 0 10" /></>);

const SKILLS_TREE: NavItem = {
    key: 'skills',
    labelKey: 'nav.groupSkills',
    iconPath: ICON_SKILLS,
    children: [
        { key: 'skillsmgr', href: '/skills', labelKey: 'nav.skillsManage', iconPath: ICON_SKILLS, matchPrefixes: ['/skills', '/skill-history', '/skill-detail'] },
        { key: 'skill-generator', href: '/skill-generator', labelKey: 'nav.skillGenerator', iconPath: ICON_PLAYGROUND },
        { key: 'skill-eval', href: '/skill-eval', labelKey: 'nav.skillEval', iconPath: ICON_DEBUG },
        { key: 'skill-opt', href: '/skill-opt', labelKey: 'nav.skillOpt', iconPath: ICON_SKILLS },
    ],
};

const EVAL_TREE: NavItem = {
    key: 'eval-center',
    labelKey: 'nav.evalCenter',
    iconPath: ICON_EVAL,
    children: [
        { key: 'dataset', href: '/dataset', labelKey: 'nav.evalDataset', iconPath: ICON_DATASET },
        { key: 'metrics', href: '/metrics', labelKey: 'nav.evalMetrics', iconPath: ICON_METRICS },
        { key: 'eval', href: '/eval', labelKey: 'nav.evalExecute', iconPath: ICON_EVAL },
        // { key: 'memory', href: '/memory', labelKey: 'nav.memory', iconPath: ICON_MEMORY },
    ],
};

const OBSERVE_TREE: NavItem = {
    key: 'observe',
    labelKey: 'nav.groupObserve',
    iconPath: ICON_OBSERVE,
    children: [
        { key: 'trace', href: '/trace', labelKey: 'nav.trace', iconPath: ICON_TRACE, matchPrefixes: ['/trace', '/details'] },
        { key: 'fault', href: '/fault', labelKey: 'nav.fault', iconPath: ICON_FAULT },
        { key: 'quality', href: '/quality', labelKey: 'nav.quality', iconPath: ICON_QUALITY, pending: true },
    ],
};

const AGENT_GROUP: NavGroup = {
    key: 'agent-workspace',
    labelKey: 'nav.groupAgentWorkspace',
    variant: 'agent',
    iconPath: <path d="M1 3h8M1 5h8M1 7h8" />,
    items: [
        { key: 'dashboard', href: '/dashboard', labelKey: 'nav.dashboard', iconPath: ICON_DASHBOARD },
        { key: 'agents', href: '/agents', labelKey: 'nav.agents', iconPath: ICON_AGENT },
        OBSERVE_TREE,
        EVAL_TREE,
        SKILLS_TREE,
    ],
};

const CONFIG_GROUP: NavGroup = {
    key: 'config',
    labelKey: 'nav.configGroup', // We need to add this to locales
    iconPath: ICON_MODEL,
    items: [
        { key: 'model-registry', href: '/modelconfig/registry', labelKey: 'nav.modelRegistry', iconPath: ICON_MODEL },
        { key: 'web-search', href: '/modelconfig/web-search', labelKey: 'nav.webSearch', iconPath: ICON_WEB },
        { key: 'access-install', href: '/accessconfig/install', labelKey: 'nav.accessInstall', iconPath: ICON_INSTALL },
        // 暂时屏蔽 channels / webhooks / health —— 后端能力未稳定,先不暴露给用户。
        // 页面源码保留在 src/app/(main)/accessconfig/{channels,webhooks,health} 下,
        // 恢复时取消下面三行注释即可。
        // { key: 'access-channels', href: '/accessconfig/channels', labelKey: 'nav.accessChannels', iconPath: ICON_ACCESS },
        // { key: 'access-webhooks', href: '/accessconfig/webhooks', labelKey: 'nav.accessWebhooks', iconPath: ICON_WEBHOOK },
        // { key: 'access-health', href: '/accessconfig/health', labelKey: 'nav.accessHealth', iconPath: ICON_HEALTH },
    ],
};

const GROUPS: NavGroup[] = [AGENT_GROUP, CONFIG_GROUP];

function normalizePath(p: string): string {
    const stripped = p.startsWith(basePath) ? p.slice(basePath.length) : p;
    return stripped || '/';
}

function isItemActive(item: NavItem, pathname: string): boolean {
    if (!item.href) {
        return (item.children || []).some(c => isItemActive(c, pathname));
    }
    const current = normalizePath(pathname);
    if (current === item.href) return true;
    const prefixes = item.matchPrefixes ?? [item.href];
    return prefixes.some(p => current === p || current.startsWith(p + '/'));
}

export function AppSidebar() {
    const pathname = usePathname() || '/';
    const router = useRouter();
    const { user, logout } = useAuth();
    const { isDark, toggleTheme } = useTheme();
    const { t, locale, setLocale } = useLocale();
    const { isCollapsed } = useSidebar();
    const [showUserMenu, setShowUserMenu] = useState(false);
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
    const [expandedTrees, setExpandedTrees] = useState<Set<string>>(new Set(['skills', 'eval-center', 'observe']));

    useEffect(() => {
        setExpandedTrees(prev => {
            const next = new Set(prev);
            const visit = (item: NavItem, ancestors: string[]) => {
                if (item.children) {
                    if (item.children.some(c => isItemActive(c, pathname))) {
                        ancestors.forEach(a => next.add(a));
                        next.add(item.key);
                    }
                    item.children.forEach(c => visit(c, [...ancestors, item.key]));
                }
            };
            GROUPS.forEach(g => (g.items || []).forEach(it => visit(it, [])));
            return next.size === prev.size ? prev : next;
        });
    }, [pathname]);

    const toggleGroup = (key: string) =>
        setCollapsedGroups(s => {
            const next = new Set(s);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });

    const toggleTree = (key: string) =>
        setExpandedTrees(s => {
            const next = new Set(s);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });

    return (
        <aside
            style={{
                width: isCollapsed ? 0 : 220,
                flexShrink: 0,
                background: 'var(--sidebar-bg)',
                borderRight: isCollapsed ? 'none' : '1px solid var(--sidebar-border)',
                display: 'flex',
                flexDirection: 'column',
                fontSize: '11.5px',
                position: 'sticky',
                top: 0,
                height: '100vh',
                transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                overflow: 'hidden',
                opacity: isCollapsed ? 0 : 1,
                visibility: isCollapsed ? 'hidden' : 'visible'
            }}
        >
            <div
                style={{
                    padding: '16px 14px 14px',
                    borderBottom: '1px solid var(--sidebar-border)',
                    display: 'flex',
                    alignItems: 'center',
                    whiteSpace: 'nowrap',
                    opacity: isCollapsed ? 0 : 1,
                    transition: 'opacity 0.2s'
                }}
            >
                <Image
                    src={isDark ? '/brand/logo-horizontal-dark.svg' : '/brand/logo-horizontal-light.svg'}
                    alt="Agent Insight"
                    width={180}
                    height={45}
                    priority
                    unoptimized
                    style={{ flexShrink: 0, display: 'block' }}
                />
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '2px 0' }}>
                {GROUPS.map(group => {
                    const collapsed = collapsedGroups.has(group.key);
                    return (
                        <div
                            key={group.key}
                            style={{
                                margin: '2px 6px',
                                borderRadius: 10,
                                background: group.variant === 'agent'
                                    ? 'linear-gradient(135deg, var(--card-bg) 0%, var(--background-secondary) 100%)'
                                    : 'var(--card-bg)',
                                border: '1px solid var(--card-border)',
                                overflow: 'hidden',
                                transition: 'all 0.3s ease-out',
                                paddingBottom: collapsed || !group.items ? 0 : 6,
                            }}
                        >
                            <GroupLabel
                                group={group}
                                collapsed={collapsed}
                                onToggle={() => (group.items ? toggleGroup(group.key) : null)}
                                onClickHref={() => group.href && router.push(group.href)}
                                pathname={pathname}
                                t={t}
                            />
                            {!collapsed && group.items && (
                                <div style={{ padding: '0 4px' }}>
                                    {group.items.map(item => (
                                        <NavTree
                                            key={item.key}
                                            item={item}
                                            pathname={pathname}
                                            expanded={expandedTrees}
                                            onToggle={toggleTree}
                                            t={t}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            <div style={{ padding: '8px 12px 10px', borderTop: '1px solid var(--sidebar-border)' }}>
                <div style={{ display: 'flex', gap: 5, marginBottom: 8 }}>
                    <button
                        onClick={toggleTheme}
                        title={isDark ? t('theme.switchToLight') : t('theme.switchToDark')}
                        style={{
                            flex: 1, padding: 4,
                            background: 'var(--card-bg)',
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                            color: 'var(--foreground-secondary)',
                            cursor: 'pointer', fontSize: 12,
                        }}
                    >
                        {isDark ? '☀' : '☾'}
                    </button>
                    <button
                        onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
                        title={locale === 'zh' ? t('theme.switchToEnglish') : t('theme.switchToChinese')}
                        style={{
                            flex: 1, padding: 4,
                            background: 'var(--card-bg)',
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                            color: 'var(--foreground-secondary)',
                            cursor: 'pointer', fontSize: 10, fontWeight: 600,
                        }}
                    >
                        {locale === 'zh' ? 'EN' : '中'}
                    </button>
                </div>

                {user && (
                    <div style={{ position: 'relative' }}>
                        <button
                            onClick={() => setShowUserMenu(v => !v)}
                            style={{
                                width: '100%', padding: 0,
                                background: 'transparent', border: 'none',
                                cursor: 'pointer',
                                display: 'flex', alignItems: 'center', gap: 8,
                                textAlign: 'left',
                            }}
                        >
                            <span
                                style={{
                                    width: 28, height: 28, borderRadius: '50%',
                                    background: 'var(--background-secondary)',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    fontSize: 10.5, fontWeight: 500, color: 'var(--foreground)',
                                    flexShrink: 0,
                                    border: '1px solid var(--border)',
                                }}
                            >
                                {user.charAt(0).toUpperCase()}
                            </span>
                            <span style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                                <span style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--foreground)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {user}
                                </span>
                                <span style={{ fontSize: 10, color: 'var(--foreground-muted)' }}>Admin</span>
                            </span>
                        </button>
                        {showUserMenu && (
                            <div
                                style={{
                                    position: 'absolute',
                                    bottom: 'calc(100% + 6px)',
                                    left: 0, right: 0,
                                    background: 'var(--dropdown-bg)',
                                    border: '1px solid var(--dropdown-border)',
                                    borderRadius: 6,
                                    boxShadow: '0 8px 16px -4px var(--shadow-color-lg)',
                                    overflow: 'hidden', zIndex: 50,
                                }}
                            >
                                <button
                                    onClick={() => { setShowUserMenu(false); logout(); }}
                                    style={{
                                        width: '100%', padding: '7px 11px',
                                        background: 'transparent', border: 'none',
                                        textAlign: 'left', color: 'var(--error)',
                                        fontSize: 11, cursor: 'pointer',
                                        borderTop: '1px solid var(--border)',
                                    }}
                                >
                                    {locale === 'zh' ? '退出登录' : 'Sign out'}
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </aside>
    );
}

function GroupLabel({
    group, collapsed, onToggle, onClickHref, pathname, t,
}: {
    group: NavGroup;
    collapsed: boolean;
    onToggle: () => void;
    onClickHref: () => void;
    pathname: string;
    t: (k: string) => string;
}) {
    const isClickable = !!group.href;
    const active = group.href ? normalizePath(pathname) === group.href : false;
    const fg = active
        ? 'var(--primary)'
        : 'var(--foreground-muted)';

    return (
        <div
            onClick={() => (isClickable ? onClickHref() : onToggle())}
            style={{
                padding: '6px 10px',
                fontSize: 9.5,
                fontWeight: 600,
                color: fg,
                letterSpacing: '0.9px',
                textTransform: 'uppercase',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                cursor: 'pointer',
                userSelect: 'none',
                transition: 'background 0.2s',
                background: active ? 'var(--primary-subtle)' : 'transparent',
            }}
            onMouseEnter={e => {
                if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--background-secondary)';
            }}
            onMouseLeave={e => {
                if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent';
            }}
        >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ opacity: 0.8, flexShrink: 0 }}>
                {group.iconPath}
            </svg>
            <span style={{ flex: 1 }}>{t(group.labelKey)}</span>
            {!isClickable && (
                <svg
                    width="10" height="10" viewBox="0 0 10 10"
                    fill="none" stroke="currentColor" strokeWidth="1.5"
                    style={{
                        marginLeft: 'auto', opacity: 0.5,
                        transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s',
                    }}
                >
                    <path d="M2 3l3 3 3-3" />
                </svg>
            )}
        </div>
    );
}

function NavTree({
    item, pathname, expanded, onToggle, t,
}: {
    item: NavItem;
    pathname: string;
    expanded: Set<string>;
    onToggle: (key: string) => void;
    t: (k: string) => string;
}) {
    const hasChildren = !!(item.children && item.children.length > 0);
    const active = isItemActive(item, pathname);
    const open = expanded.has(item.key);

    if (item.href && !hasChildren) {
        return <LeafLink item={item} active={active} t={t} />;
    }

    return (
        <div>
            <button
                onClick={() => onToggle(item.key)}
                style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '4px 10px 4px 12px', margin: '1px 5px',
                    borderRadius: 7, fontSize: 11.5,
                    color: active ? 'var(--sidebar-active-fg)' : 'var(--foreground-secondary)',
                    background: active ? 'var(--sidebar-active-bg)' : 'transparent',
                    fontWeight: active ? 500 : 400,
                    border: 'none', width: 'calc(100% - 10px)',
                    textAlign: 'left', cursor: 'pointer',
                    transition: 'all 0.12s',
                }}
                onMouseEnter={e => {
                    if (!active) {
                        (e.currentTarget as HTMLElement).style.background = 'var(--sidebar-hover)';
                        (e.currentTarget as HTMLElement).style.color = 'var(--foreground)';
                    }
                }}
                onMouseLeave={e => {
                    if (!active) {
                        (e.currentTarget as HTMLElement).style.background = 'transparent';
                        (e.currentTarget as HTMLElement).style.color = 'var(--foreground-secondary)';
                    }
                }}
            >
                <span style={{ width: 14, height: 14, flexShrink: 0, display: 'inline-flex', opacity: active ? 1 : 0.75 }}>
                    {item.iconPath && (
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            {item.iconPath}
                        </svg>
                    )}
                </span>
                <span style={{ flex: 1 }}>{t(item.labelKey)}</span>
                <svg
                    width="10" height="10" viewBox="0 0 10 10"
                    fill="none" stroke="currentColor" strokeWidth="1.5"
                    style={{
                        opacity: 0.5,
                        transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
                        transition: 'transform 0.2s',
                    }}
                >
                    <path d="M2 3l3 3 3-3" />
                </svg>
            </button>
            {hasChildren && open && (
                <div
                    style={{
                        paddingLeft: 12, marginBottom: 4,
                        borderLeft: '1px solid var(--border)',
                        marginLeft: 20,
                    }}
                >
                    {item.children!.map(child => (
                        <NavTree
                            key={child.key} item={child}
                            pathname={pathname} expanded={expanded}
                            onToggle={onToggle} t={t}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function LeafLink({ item, active, t }: { item: NavItem; active: boolean; t: (k: string) => string }) {
    const pendingColor = item.pending ? 'var(--tag-amber-fg)' : null;
    const color = pendingColor || (active ? 'var(--sidebar-active-fg)' : 'var(--foreground-secondary)');

    return (
        <Link
            href={item.href!}
            prefetch={false}
            style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '4px 10px 4px 12px', margin: '1px 5px',
                borderRadius: 7, fontSize: 11.5,
                color,
                background: active ? 'var(--sidebar-active-bg)' : 'transparent',
                fontWeight: active ? 500 : 400,
                opacity: item.pending ? 0.85 : 1,
                textDecoration: 'none', transition: 'all 0.12s',
            }}
            onMouseEnter={e => {
                if (!active) {
                    e.currentTarget.style.background = 'var(--sidebar-hover)';
                    if (!pendingColor) e.currentTarget.style.color = 'var(--foreground)';
                }
            }}
            onMouseLeave={e => {
                if (!active) {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = color;
                }
            }}
        >
            <span style={{ width: 14, height: 14, flexShrink: 0, display: 'inline-flex', opacity: active ? 1 : 0.75 }}>
                {item.iconPath && (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        {item.iconPath}
                    </svg>
                )}
            </span>
            <span style={{ flex: 1 }}>{t(item.labelKey)}</span>
            {item.badge && (
                <span
                    style={{
                        fontSize: 10, padding: '1px 5px', borderRadius: 8,
                        fontWeight: 500, flexShrink: 0,
                        background: item.badge.kind === 'r' ? 'var(--tag-red-bg)' : item.badge.kind === 'y' ? 'var(--tag-amber-bg)' : 'var(--tag-green-bg)',
                        color: item.badge.kind === 'r' ? 'var(--tag-red-fg)' : item.badge.kind === 'y' ? 'var(--tag-amber-fg)' : 'var(--tag-green-fg)',
                    }}
                >
                    {item.badge.text}
                </span>
            )}
        </Link>
    );
}

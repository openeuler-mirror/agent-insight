'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth/auth-context';
import { useTheme } from '@/lib/client/theme-context';
import { useLocale } from '@/lib/client/locale-context';
import { useSidebar } from '@/lib/client/sidebar-context';
import { useUsageAccess } from '@/lib/usage-analytics/use-usage-access';
import {
    getSidebarNavigation,
    isSidebarItemActive,
    type SidebarIconKey,
    type SidebarNavItem,
} from './sidebar-navigation';

const basePath = process.env.NEXT_PUBLIC_URL_PREFIX || '';

const ICON_AGENT = (<><circle cx="7" cy="4.5" r="2.2" /><path d="M2.5 12c0-2.49 2.02-4.5 4.5-4.5s4.5 2.01 4.5 4.5" /><circle cx="12" cy="3.5" r="1.4" /><path d="M12 6.5c1 .28 1.8 1.12 1.8 2.2" /></>);
const ICON_SKILLS = (<><rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1" /><rect x="8" y="1.5" width="4.5" height="4.5" rx="1" /><rect x="1.5" y="8" width="4.5" height="4.5" rx="1" /><rect x="8" y="8" width="4.5" height="4.5" rx="1" /></>);
const ICON_DASHBOARD = (<><rect x="2" y="2" width="4.5" height="4.5" rx="1" /><rect x="7.5" y="2" width="4.5" height="4.5" rx="1" /><rect x="2" y="7.5" width="4.5" height="4.5" rx="1" /><rect x="7.5" y="7.5" width="4.5" height="4.5" rx="1" /></>);
const ICON_QUICKSTART = (<><path d="M3 11c2.8-4.9 5.3-7.3 8-8" /><path d="M7.5 3H11v3.5" /><circle cx="3" cy="11" r="1.3" /></>);
const ICON_OBSERVE = (<><circle cx="7" cy="7" r="5.5" /><path d="M4.5 7c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5" /><circle cx="7" cy="7" r="1.5" /></>);
const ICON_TRACE = <path d="M2 4h10M2 7h7M2 10h9" />;
const ICON_FAULT = (<><path d="M7 2.5v4.5M7 10v.5" /><circle cx="7" cy="7" r="5.5" /></>);
const ICON_EVAL = (<><path d="M4.5 7l2 2 3-3" /><circle cx="7" cy="7" r="5.5" /></>);
const ICON_DATASET = (<><ellipse cx="7" cy="4.5" rx="4.5" ry="2" /><path d="M2.5 4.5v3c0 1.1 2.02 2 4.5 2s4.5-.9 4.5-2v-3" /><path d="M2.5 7.5v3c0 1.1 2.02 2 4.5 2s4.5-.9 4.5-2v-3" /></>);
const ICON_METRICS = <path d="M2 12h10M3 12V8h2v4M6 12V4h2v8M9 12V6h2v6" />;
const ICON_MODEL = (<><path d="M2 4.5h10M2 9.5h10" /><circle cx="4.5" cy="4.5" r="1.5" /><circle cx="9.5" cy="9.5" r="1.5" /></>);
const ICON_INSTALL = (<><path d="M7 1.5v7M4 6l3 3 3-3" /><path d="M2 11h10" /></>);
const ICON_WEB = (<><circle cx="7" cy="7" r="5" /><path d="M2 7h10M7 2a8 8 0 0 1 0 10M7 2a8 8 0 0 0 0 10" /></>);
const ICON_EXPERIMENT = (<><path d="M5.5 1.5h3M6 1.5v3.5L2.8 10.5a1.2 1.2 0 0 0 1 1.9h6.4a1.2 1.2 0 0 0 1-1.9L8 5V1.5" /><path d="M4.2 9h5.6" /></>);
const ICON_USAGE = (<><path d="M2 12h10" /><path d="M4 12V7M7 12V3M10 12V9" /></>);

const NAV_ICONS: Record<SidebarIconKey, ReactNode> = {
    dashboard: ICON_DASHBOARD,
    quickstart: ICON_QUICKSTART,
    observe: ICON_OBSERVE,
    agent: ICON_AGENT,
    trace: ICON_TRACE,
    infra: ICON_METRICS,
    evaluation: ICON_EVAL,
    experiment: ICON_EXPERIMENT,
    dataset: ICON_DATASET,
    metrics: ICON_METRICS,
    diagnosis: ICON_FAULT,
    optimization: ICON_SKILLS,
    skill: ICON_SKILLS,
    config: ICON_MODEL,
    model: ICON_MODEL,
    web: ICON_WEB,
    install: ICON_INSTALL,
    usage: ICON_USAGE,
};

export function AppSidebar() {
    const pathname = usePathname() || '/';
    const { user, logout } = useAuth();
    const { isDark, toggleTheme } = useTheme();
    const { t, locale, setLocale } = useLocale();
    const { isCollapsed } = useSidebar();
    const [showUserMenu, setShowUserMenu] = useState(false);
    const usageAccess = useUsageAccess();
    const showUsage = usageAccess.enabled && usageAccess.isAdmin;
    const navigation = useMemo(() => getSidebarNavigation(showUsage), [showUsage]);
    const [expandedTrees, setExpandedTrees] = useState<Set<string>>(
        new Set(['observe', 'evaluation', 'continuous-optimization', 'config']),
    );

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

            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 6px' }}>
                {navigation.map(item => (
                    <NavTree
                        key={item.key}
                        item={item}
                        pathname={pathname}
                        expanded={expandedTrees}
                        onToggle={toggleTree}
                        t={t}
                        depth={0}
                    />
                ))}
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

function NavTree({
    item, pathname, expanded, onToggle, t, depth,
}: {
    item: SidebarNavItem;
    pathname: string;
    expanded: Set<string>;
    onToggle: (key: string) => void;
    t: (k: string) => string;
    depth: number;
}) {
    const hasChildren = !!(item.children && item.children.length > 0);
    const active = isSidebarItemActive(item, pathname, basePath);
    const open = expanded.has(item.key) || active;

    if (item.href && !hasChildren) {
        return <LeafLink item={item} active={active} t={t} depth={depth} />;
    }

    return (
        <div>
            <button
                onClick={() => onToggle(item.key)}
                aria-expanded={open}
                style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 10px', margin: '3px 0 1px',
                    borderRadius: 7, fontSize: 11.5,
                    color: active ? 'var(--sidebar-active-fg)' : 'var(--foreground-secondary)',
                    background: active ? 'var(--sidebar-active-bg)' : 'transparent',
                    fontWeight: active ? 600 : 500,
                    border: 'none', width: '100%',
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
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        {NAV_ICONS[item.icon]}
                    </svg>
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
                        paddingLeft: 8, marginBottom: 5,
                        borderLeft: '1px solid var(--border)',
                        marginLeft: 7,
                    }}
                >
                    {item.children!.map(child => (
                        <NavTree
                            key={child.key} item={child}
                            pathname={pathname} expanded={expanded}
                            onToggle={onToggle} t={t} depth={depth + 1}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function LeafLink({
    item, active, t, depth,
}: {
    item: SidebarNavItem;
    active: boolean;
    t: (k: string) => string;
    depth: number;
}) {
    const color = active ? 'var(--sidebar-active-fg)' : 'var(--foreground-secondary)';

    return (
        <Link
            href={item.href!}
            prefetch={false}
            aria-current={active ? 'page' : undefined}
            style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: depth === 0 ? '7px 10px' : '6px 10px',
                margin: depth === 0 ? '3px 0' : '1px 0',
                borderRadius: 7, fontSize: 11.5,
                color,
                background: active ? 'var(--sidebar-active-bg)' : 'transparent',
                fontWeight: active ? 600 : 400,
                textDecoration: 'none', transition: 'all 0.12s',
            }}
            onMouseEnter={e => {
                if (!active) {
                    e.currentTarget.style.background = 'var(--sidebar-hover)';
                    e.currentTarget.style.color = 'var(--foreground)';
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
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    {NAV_ICONS[item.icon]}
                </svg>
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

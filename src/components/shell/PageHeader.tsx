'use client';

// docs/design/patterns.md §A.5 — unified PageHeader with 4 variants.
// Slot ⓪ sidebar-toggle is auto-rendered (do not pass).
// Existing libraries only: lucide-react, @radix-ui/react-dropdown-menu, shadcn Button, date-fns.

import * as React from 'react';
import {
    PanelLeftClose,
    PanelLeftOpen,
    ChevronDown,
    MoreHorizontal,
    Pause,
    Play,
    RefreshCw,
    type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useSidebar } from '@/lib/client/sidebar-context';
import { cn } from '@/lib/utils';

/* ─────────────────────────────────────────────────────────────────────────────
 * Types
 * ────────────────────────────────────────────────────────────────────────── */

export interface BreadcrumbItem {
    label: React.ReactNode;
    href?: string;
    onClick?: () => void;
}

interface PageHeaderActionDef {
    label: string;
    icon?: LucideIcon;
    onClick: () => void;
    disabled?: boolean;
}

interface MoreMenuItem {
    label: string;
    icon?: LucideIcon;
    onClick: () => void;
    destructive?: boolean;
}

interface LiveProps {
    label?: string;
    lastUpdate: Date;
    refreshRate: '1s' | '3s' | '5s' | '15s' | '30s' | '1m';
    onRefreshRateChange?: (rate: LiveProps['refreshRate']) => void;
    paused: boolean;
    onTogglePause: () => void;
}

interface ContextObject {
    iconChar: string;
    title: string;
    sub: React.ReactNode;
    versionMenu?: {
        current: string;
        versions: Array<{ id: string; label: string; current?: boolean }>;
        onSelect: (id: string) => void;
    };
}

interface BannerProps {
    variant: 'info' | 'warning' | 'error';
    message: React.ReactNode;
    action?: { label: string; onClick: () => void };
}

type MetaStrip =
    | { kind: 'kpi'; items: KpiItem[] }
    | { kind: 'filter'; children: React.ReactNode }
    | {
          kind: 'tabs';
          items: TabItem[];
          value: string;
          onChange: (v: string) => void;
      };

interface KpiItem {
    label: string;
    value: React.ReactNode;
    sub?: string;
    tone?: 'default' | 'warning' | 'success';
}

interface TabItem {
    label: React.ReactNode;
    value: string;
}

export interface PageHeaderProps {
    /** Slot ① eyebrow — breadcrumb items (last is the current page). */
    breadcrumbs?: BreadcrumbItem[];
    /** Fallback for slot ① when breadcrumbs is empty (e.g. home page). */
    moduleLabel?: string;

    /** Slot ② title-row left — module icon (lucide). */
    icon?: LucideIcon;
    /** Slot ② title-row left — title text (ignored when `contextObject` is set). */
    title?: string;
    /** Slot ② title-row left — inline badges next to title. */
    badges?: React.ReactNode;

    /** Slot ② title-row right — picks one of 4 layouts (see §A.5.3). */
    variant: 'management' | 'detail' | 'live' | 'detail-object';

    /** management / detail / detail-object — primary action button. */
    action?: PageHeaderActionDef;
    /** management / detail-object — optional secondary button (e.g. 同步 / 导出). */
    secondaryAction?: PageHeaderActionDef;
    /** detail — overflow menu items shown behind ⋯. */
    moreMenu?: MoreMenuItem[];
    /** live — real-time cluster props. */
    live?: LiveProps;
    /** detail-object — object identity (icon + title + version menu). */
    contextObject?: ContextObject;

    /** Slot ③ description. */
    description?: string;
    /** Slot ⑤ banner. */
    banner?: BannerProps;
    /** Slot ⑥ meta-strip. */
    metaStrip?: MetaStrip;
    /** When true, the meta-strip stays visible on scroll. */
    stickyMeta?: boolean;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Subcomponents
 * ────────────────────────────────────────────────────────────────────────── */

function SidebarToggle() {
    const { isCollapsed, toggleSidebar } = useSidebar();
    const Icon = isCollapsed ? PanelLeftOpen : PanelLeftClose;
    return (
        <button
            type="button"
            onClick={toggleSidebar}
            aria-label={isCollapsed ? '展开侧栏' : '折叠侧栏'}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-secondary transition-colors hover:bg-background-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
            <Icon className="size-4" />
        </button>
    );
}

function BreadcrumbTrail({
    items,
    moduleLabel,
}: {
    items?: BreadcrumbItem[];
    moduleLabel?: string;
}) {
    const trail = items?.length ? items : moduleLabel ? [{ label: moduleLabel }] : [];
    if (!trail.length) return null;
    return (
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            {trail.map((item, idx) => {
                const isLast = idx === trail.length - 1;
                const content = isLast ? (
                    <span className="truncate font-medium text-foreground">{item.label}</span>
                ) : item.href || item.onClick ? (
                    <a
                        href={item.href}
                        onClick={item.onClick}
                        className="truncate text-foreground-secondary transition-colors hover:text-foreground"
                    >
                        {item.label}
                    </a>
                ) : (
                    <span className="truncate text-foreground-secondary">{item.label}</span>
                );
                return (
                    <React.Fragment key={idx}>
                        {content}
                        {!isLast && (
                            <span
                                aria-hidden="true"
                                className="select-none text-[var(--primary)] opacity-50"
                            >
                                {' › '}
                            </span>
                        )}
                    </React.Fragment>
                );
            })}
        </nav>
    );
}

function RightActions({
    variant,
    action,
    secondaryAction,
    moreMenu,
    live,
}: {
    variant: PageHeaderProps['variant'];
    action?: PageHeaderActionDef;
    secondaryAction?: PageHeaderActionDef;
    moreMenu?: MoreMenuItem[];
    live?: LiveProps;
}) {
    if (variant === 'live' && live) {
        return <LiveCluster live={live} />;
    }
    return (
        <div className="flex items-center gap-2">
            {secondaryAction && (
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={secondaryAction.onClick}
                    disabled={secondaryAction.disabled}
                >
                    {secondaryAction.icon && <secondaryAction.icon />}
                    {secondaryAction.label}
                </Button>
            )}
            {action && (
                <Button
                    variant="default"
                    size="sm"
                    onClick={action.onClick}
                    disabled={action.disabled}
                >
                    {action.icon && <action.icon />}
                    {action.label}
                </Button>
            )}
            {variant === 'detail' && moreMenu && moreMenu.length > 0 && (
                <OverflowMenu items={moreMenu} />
            )}
        </div>
    );
}

function OverflowMenu({ items }: { items: MoreMenuItem[] }) {
    // Lightweight uncontrolled menu using <details> as a no-dep alternative.
    // Pages that want Radix DropdownMenu can swap in directly when they migrate.
    return (
        <details className="relative">
            <summary
                aria-label="更多操作"
                className="inline-flex size-8 cursor-pointer list-none items-center justify-center rounded-md text-foreground-secondary transition-colors hover:bg-background-secondary hover:text-foreground [&::-webkit-details-marker]:hidden"
            >
                <MoreHorizontal className="size-4" />
            </summary>
            <div
                role="menu"
                className="absolute right-0 z-30 mt-1 min-w-[160px] overflow-hidden rounded-md border border-border bg-card shadow-md"
            >
                {items.map((item, idx) => (
                    <button
                        key={idx}
                        type="button"
                        role="menuitem"
                        onClick={item.onClick}
                        className={cn(
                            'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-background-secondary',
                            item.destructive
                                ? 'text-[var(--error)]'
                                : 'text-foreground',
                        )}
                    >
                        {item.icon && <item.icon className="size-4" />}
                        {item.label}
                    </button>
                ))}
            </div>
        </details>
    );
}

const RATE_OPTIONS: Array<LiveProps['refreshRate']> = ['1s', '3s', '5s', '15s', '30s', '1m'];

function LiveCluster({ live }: { live: LiveProps }) {
    const ts = formatTimestamp(live.lastUpdate);
    return (
        <div className="flex items-center gap-3">
            <span
                aria-label={live.label ?? '实时数据'}
                className="inline-flex items-center gap-1.5 rounded-sm bg-[var(--success-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--success)]"
            >
                <span className="size-1.5 animate-pulse rounded-full bg-current" />
                {live.label ?? '实时数据'}
            </span>
            <time className="font-mono tabular-nums text-xs text-foreground-muted">{ts}</time>
            {live.onRefreshRateChange ? (
                <details className="relative">
                    <summary className="inline-flex h-7 cursor-pointer list-none items-center gap-1 rounded-md border border-border bg-card px-2 text-xs text-foreground transition-colors hover:bg-background-secondary [&::-webkit-details-marker]:hidden">
                        <RefreshCw className="size-3" />
                        {live.refreshRate}
                        <ChevronDown className="size-3 opacity-60" />
                    </summary>
                    <div className="absolute right-0 z-30 mt-1 min-w-[64px] overflow-hidden rounded-md border border-border bg-card shadow-md">
                        {RATE_OPTIONS.map((rate) => (
                            <button
                                key={rate}
                                type="button"
                                onClick={() => live.onRefreshRateChange?.(rate)}
                                className={cn(
                                    'block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-background-secondary',
                                    rate === live.refreshRate
                                        ? 'font-medium text-[var(--primary)]'
                                        : 'text-foreground',
                                )}
                            >
                                {rate}
                            </button>
                        ))}
                    </div>
                </details>
            ) : (
                <span className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2 text-xs text-foreground-muted">
                    <RefreshCw className="size-3" />
                    {live.refreshRate}
                </span>
            )}
            <Button variant="secondary" size="sm" onClick={live.onTogglePause}>
                {live.paused ? <Play /> : <Pause />}
                {live.paused ? '继续' : '暂停'}
            </Button>
        </div>
    );
}

function formatTimestamp(d: Date) {
    const mo = `${d.getMonth() + 1}`;
    const da = `${d.getDate()}`;
    const hh = `${d.getHours()}`.padStart(2, '0');
    const mm = `${d.getMinutes()}`.padStart(2, '0');
    const ss = `${d.getSeconds()}`.padStart(2, '0');
    return `${mo}/${da} · ${hh}:${mm}:${ss}`;
}

function ContextObjectBlock({ obj }: { obj: ContextObject }) {
    const first = (obj.iconChar || obj.title.charAt(0) || '?').slice(0, 1).toUpperCase();
    return (
        <div className="flex items-center gap-3">
            <div className="grid size-8 shrink-0 place-items-center rounded-md bg-[var(--primary-subtle)] font-mono text-xs font-semibold text-[var(--primary)]">
                {first}
            </div>
            <div className="min-w-0 leading-tight">
                <div className="flex items-center gap-1.5 font-mono text-[15px] font-semibold tracking-[-0.01em] text-foreground">
                    <span className="truncate">{obj.title}</span>
                    {obj.versionMenu && <VersionMenu menu={obj.versionMenu} />}
                </div>
                <div className="mt-0.5 text-xs text-foreground-muted">{obj.sub}</div>
            </div>
        </div>
    );
}

function VersionMenu({ menu }: { menu: NonNullable<ContextObject['versionMenu']> }) {
    return (
        <details className="relative">
            <summary
                aria-label="切换版本"
                className="inline-flex cursor-pointer list-none items-center text-foreground-muted hover:text-foreground [&::-webkit-details-marker]:hidden"
            >
                <ChevronDown className="size-3" />
            </summary>
            <div className="absolute left-0 z-30 mt-1 min-w-[160px] overflow-hidden rounded-md border border-border bg-card shadow-md">
                {menu.versions.map((v) => (
                    <button
                        key={v.id}
                        type="button"
                        onClick={() => menu.onSelect(v.id)}
                        className={cn(
                            'flex w-full items-center justify-between px-3 py-1.5 text-left text-xs transition-colors hover:bg-background-secondary',
                            v.id === menu.current
                                ? 'font-medium text-[var(--primary)]'
                                : 'text-foreground',
                        )}
                    >
                        <span className="font-mono">{v.label}</span>
                        {v.current && (
                            <span className="text-[10px] text-foreground-muted">当前</span>
                        )}
                    </button>
                ))}
            </div>
        </details>
    );
}

function BannerRow({ banner }: { banner: BannerProps }) {
    const tone =
        banner.variant === 'info'
            ? 'bg-[var(--primary-subtle)] text-[var(--primary)] border-[var(--primary-subtle-border)]'
            : banner.variant === 'warning'
              ? 'bg-[var(--warning-subtle)] text-[var(--warning)] border-[var(--warning-subtle-border)]'
              : 'bg-[var(--error-subtle)] text-[var(--error)] border-[var(--error-subtle-border)]';
    return (
        <div
            role="status"
            className={cn(
                'flex items-center gap-3 border-b px-6 py-3 text-sm',
                tone,
            )}
        >
            <span className="flex-1">{banner.message}</span>
            {banner.action && (
                <button
                    type="button"
                    onClick={banner.action.onClick}
                    className="shrink-0 font-medium underline-offset-2 hover:underline"
                >
                    {banner.action.label} →
                </button>
            )}
        </div>
    );
}

function MetaStripRow({ meta, sticky }: { meta: MetaStrip; sticky?: boolean }) {
    return (
        <div
            className={cn(
                'border-b border-border bg-card px-6 py-3',
                sticky && 'sticky top-[56px] z-[9]',
            )}
        >
            {meta.kind === 'kpi' && <KpiStrip items={meta.items} />}
            {meta.kind === 'filter' && (
                <div className="flex flex-wrap items-center gap-3">{meta.children}</div>
            )}
            {meta.kind === 'tabs' && (
                <TabsStrip items={meta.items} value={meta.value} onChange={meta.onChange} />
            )}
        </div>
    );
}

function KpiStrip({ items }: { items: KpiItem[] }) {
    return (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {items.map((it, i) => (
                <div key={i} className="min-w-0">
                    <div className="text-xs text-foreground-muted">{it.label}</div>
                    <div
                        className={cn(
                            'mt-1 font-mono text-lg font-semibold tabular-nums',
                            it.tone === 'warning' && 'text-[var(--warning)]',
                            it.tone === 'success' && 'text-[var(--success)]',
                            !it.tone && 'text-foreground',
                        )}
                    >
                        {it.value}
                    </div>
                    {it.sub && (
                        <div className="mt-0.5 text-xs text-foreground-muted">{it.sub}</div>
                    )}
                </div>
            ))}
        </div>
    );
}

function TabsStrip({
    items,
    value,
    onChange,
}: {
    items: TabItem[];
    value: string;
    onChange: (v: string) => void;
}) {
    return (
        <div className="flex items-center gap-1 overflow-x-auto">
            {items.map((it) => {
                const active = it.value === value;
                return (
                    <button
                        key={it.value}
                        type="button"
                        onClick={() => onChange(it.value)}
                        className={cn(
                            'relative whitespace-nowrap px-3 py-2 text-sm transition-colors',
                            active
                                ? 'font-medium text-[var(--primary)]'
                                : 'text-foreground-secondary hover:text-foreground',
                        )}
                    >
                        {it.label}
                        {active && (
                            <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-[var(--primary)]" />
                        )}
                    </button>
                );
            })}
        </div>
    );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Main component
 * ────────────────────────────────────────────────────────────────────────── */

export function PageHeader(props: PageHeaderProps) {
    const {
        breadcrumbs,
        moduleLabel,
        icon: Icon,
        title,
        badges,
        variant,
        action,
        secondaryAction,
        moreMenu,
        live,
        contextObject,
        description,
        banner,
        metaStrip,
        stickyMeta,
    } = props;

    const isDoubleRow = variant === 'detail-object' && contextObject;

    return (
        <header className="sticky top-0 z-10 bg-card">
            {isDoubleRow ? (
                <>
                    {/* row-1: crumbs */}
                    <div className="flex h-9 items-center gap-3 border-b border-border bg-background-secondary px-6">
                        <SidebarToggle />
                        <BreadcrumbTrail items={breadcrumbs} moduleLabel={moduleLabel} />
                    </div>
                    {/* row-2: context object */}
                    <div className="flex h-14 items-center gap-3 border-b border-border px-6">
                        <ContextObjectBlock obj={contextObject!} />
                        <div className="flex-1" />
                        <RightActions
                            variant={variant}
                            action={action}
                            secondaryAction={secondaryAction}
                        />
                    </div>
                </>
            ) : (
                <div className="flex h-14 items-center gap-3 border-b border-border px-6">
                    <SidebarToggle />
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                        <BreadcrumbTrail items={breadcrumbs} moduleLabel={moduleLabel} />
                        {title && (
                            <div className="flex min-w-0 items-center gap-2">
                                {Icon && <Icon className="size-4 text-foreground-secondary" />}
                                <h1 className="truncate text-sm font-medium text-foreground">
                                    {title}
                                </h1>
                                {badges}
                            </div>
                        )}
                    </div>
                    <RightActions
                        variant={variant}
                        action={action}
                        secondaryAction={secondaryAction}
                        moreMenu={moreMenu}
                        live={live}
                    />
                </div>
            )}

            {description && !isDoubleRow && (
                <p className="border-b border-border bg-card px-6 py-2 text-xs text-foreground-secondary">
                    {description}
                </p>
            )}
            {banner && <BannerRow banner={banner} />}
            {metaStrip && <MetaStripRow meta={metaStrip} sticky={stickyMeta} />}
        </header>
    );
}

export default PageHeader;

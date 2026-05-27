'use client';

/**
 * AppTopBar — v2.1 兼容层（2026-05-27）
 *
 * `docs/design/patterns.md` §A.1 v2.1 起废弃独立 AppTopBar 行。本组件保留旧
 * API（title / actions / showDefaultActions）让 27 个调用点继续工作，但内部
 * 渲染已切换为新统一 header（h=56, sidebar-toggle 在左, lucide 图标, 单行
 * 容器）—— 全站视觉立刻一致。
 *
 * @deprecated 新增页面请直接 `import { PageHeader } from '@/components/shell/PageHeader'`
 *   以使用 4 种 variant（management / detail / live / detail-object）。
 */

import * as React from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

import { useSidebar } from '@/lib/client/sidebar-context';

export interface AppTopBarProps {
    /** 页面标题（字符串或 ReactNode，如 `<Term/>`） */
    title: React.ReactNode;
    /** 右侧次要操作集群（按钮、selector 等） */
    actions?: React.ReactNode;
    /**
     * 是否显示默认右侧 chips（v1 的"近 24h"）。
     * v2.1 起默认 false —— 已无默认 chip 可显示。保留参数仅为不破坏调用点 API。
     */
    showDefaultActions?: boolean;
}

export function AppTopBar({ title, actions }: AppTopBarProps) {
    const { isCollapsed, toggleSidebar } = useSidebar();
    const ToggleIcon = isCollapsed ? PanelLeftOpen : PanelLeftClose;

    return (
        <header
            className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-border bg-card px-6"
            style={{ flexShrink: 0 }}
        >
            <button
                type="button"
                onClick={toggleSidebar}
                aria-label={isCollapsed ? '展开侧栏' : '折叠侧栏'}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-secondary transition-colors hover:bg-background-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                <ToggleIcon className="size-4" />
            </button>

            <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-foreground">
                {typeof title === 'string' ? (
                    <span className="truncate">{title}</span>
                ) : (
                    title
                )}
            </div>

            {actions && (
                <div className="flex items-center gap-2">{actions}</div>
            )}
        </header>
    );
}

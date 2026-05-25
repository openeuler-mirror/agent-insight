'use client';

import { useLocale } from '@/lib/client/locale-context';
import { useSidebar } from '@/lib/client/sidebar-context';

export interface AppTopBarProps {
    /** Page title — string or arbitrary node (e.g. clickable breadcrumb) */
    title: React.ReactNode;
    /** Optional secondary actions on the right */
    actions?: React.ReactNode;
    /** When true, show the right-side default chips (version + time + export) */
    showDefaultActions?: boolean;
}

/**
 * Hifi v5-aligned page header.
 * Renders inside each (main) route page so different tabs can plug their own
 * controls into the right side without coupling to the sidebar shell.
 */
export function AppTopBar({ title, actions, showDefaultActions = true }: AppTopBarProps) {
    const { t } = useLocale();
    const { isCollapsed, toggleSidebar } = useSidebar();
    
    return (
        <div
            style={{
                height: 50,
                padding: '0 16px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexShrink: 0,
                background: 'var(--card-bg)',
                position: 'sticky',
                top: 0,
                zIndex: 10,
            }}
        >
            <button 
                onClick={toggleSidebar}
                className="sidebar-toggle-btn"
                style={{
                    width: 32,
                    height: 32,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: 'var(--background)',
                    cursor: 'pointer',
                    color: 'var(--foreground)',
                    transition: 'all 0.2s ease'
                }}
            >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {isCollapsed ? (
                        <path d="M3 3h18v18H3z M9 3v18 M12 15l3-3-3-3" />
                    ) : (
                        <path d="M3 3h18v18H3z M9 3v18 M15 9l-3 3 3 3" />
                    )}
                </svg>
            </button>
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--foreground)' }}>{title}</span>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7 }}>
                {actions}
                {showDefaultActions && <DefaultActions t={t} />}
            </div>
        </div>
    );
}

function DefaultActions({ t }: { t: (k: string) => string }) {
    return (
        <>
            <div className="ai-chip" title={t('topbar.timeRange')}>
                {t('topbar.last24h') || '近 24h'}
            </div>
        </>
    );
}

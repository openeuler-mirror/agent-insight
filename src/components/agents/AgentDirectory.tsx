'use client';

import React, { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { AppTopBar } from '@/components/shell/AppTopBar';

interface BtnProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'default' | 'outline' | 'secondary';
    size?: 'sm' | 'md';
    fullWidth?: boolean;
}

export function Btn({ variant = 'default', size = 'md', fullWidth, style, children, ...props }: BtnProps) {
    const [hover, setHover] = useState(false);

    const base: React.CSSProperties = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        borderRadius: 6,
        fontWeight: 500,
        fontFamily: 'inherit',
        cursor: 'pointer',
        transition: 'background 0.15s, border-color 0.15s, color 0.15s',
        whiteSpace: 'nowrap',
        outline: 'none',
        boxSizing: 'border-box',
        width: fullWidth ? '100%' : undefined,
        height: size === 'sm' ? 28 : 32,
        padding: size === 'sm' ? '0 8px' : '0 12px',
        fontSize: size === 'sm' ? 11 : 12,
    };

    const variants: Record<string, React.CSSProperties> = {
        default: {
            background: hover ? 'var(--primary-hover, var(--primary))' : 'var(--primary)',
            color: 'var(--primary-foreground, #fff)',
            border: '1px solid var(--primary)',
        },
        outline: {
            background: hover ? 'var(--background-secondary)' : 'transparent',
            color: 'var(--foreground)',
            border: '1px solid var(--border)',
        },
        secondary: {
            background: hover ? 'var(--secondary-hover, var(--secondary))' : 'var(--secondary)',
            color: 'var(--foreground)',
            border: '1px solid transparent',
        },
    };

    return (
        <button
            {...props}
            style={{ ...base, ...variants[variant], ...style }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
        >
            {children}
        </button>
    );
}

interface TagProps {
    variant?: 'default' | 'secondary' | 'outline';
    children: React.ReactNode;
    style?: React.CSSProperties;
}

export function Tag({ variant = 'default', children, style }: TagProps) {
    const base: React.CSSProperties = {
        display: 'inline-flex',
        alignItems: 'center',
        height: 16,
        padding: '0 6px',
        borderRadius: 4,
        fontSize: 9,
        fontWeight: 600,
        fontFamily: 'inherit',
        textTransform: 'uppercase',
        letterSpacing: '0.02em',
        flexShrink: 0,
        lineHeight: 1,
    };

    const variants: Record<string, React.CSSProperties> = {
        default: {
            background: 'var(--primary)',
            color: 'var(--primary-foreground, #fff)',
        },
        secondary: {
            background: 'var(--secondary, #f1f5f9)',
            color: 'var(--foreground)',
        },
        outline: {
            background: 'transparent',
            color: 'var(--foreground-secondary, var(--foreground))',
            border: '1px solid var(--border)',
        },
    };

    return <span style={{ ...base, ...variants[variant], ...style }}>{children}</span>;
}

interface FilterSelectProps {
    label: string;
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
    minWidth?: number;
    tooltip?: React.ReactNode;
}

export function FilterSelect({ label, value, onChange, options, minWidth = 220, tooltip }: FilterSelectProps) {
    return (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth }}>
            <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                {label}
                {tooltip && (
                    <TooltipProvider>
                        <Tooltip delayDuration={300}>
                            <TooltipTrigger asChild>
                                <HelpCircle size={12} style={{ cursor: 'help', color: 'var(--foreground-muted)' }} />
                            </TooltipTrigger>
                            <TooltipContent
                                side="bottom"
                                sideOffset={6}
                                className="bg-[var(--card-bg,#fff)] text-[var(--foreground)] border border-[var(--border)] shadow-md max-w-[280px] p-3 [&>svg]:hidden"
                            >
                                {tooltip}
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                )}
            </span>
            <select
                value={value}
                onChange={(event) => onChange(event.target.value)}
                style={{
                    width: '100%',
                    height: 36,
                    padding: '0 12px',
                    borderRadius: 10,
                    border: '1px solid var(--border)',
                    background: 'var(--background)',
                    color: 'var(--foreground)',
                    fontSize: 12,
                    fontWeight: 500,
                    outline: 'none',
                    cursor: 'pointer',
                    boxSizing: 'border-box',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
                }}
            >
                {options.map(option => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
        </label>
    );
}

export const agentDirectoryGridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: 16,
};

export function AgentDirectoryLayout({ title, children }: { title: string; children: React.ReactNode }) {
    return <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <AppTopBar title={title} showDefaultActions={false} />
        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px 28px', width: '100%', boxSizing: 'border-box' }}>{children}</div>
    </div>;
}

export function AgentDirectoryPanel({ children }: { children: React.ReactNode }) {
    return <div style={{
        background: 'linear-gradient(180deg, rgba(127,127,127,0.03), transparent 88%), var(--card-bg, var(--background))',
        border: '1px solid var(--border)',
        borderRadius: 14,
        padding: 18,
        boxShadow: '0 8px 24px rgba(0,0,0,0.03)',
    }}>{children}</div>;
}

export function AgentCardFrame({ children, onHoverChange }: { children: React.ReactNode; onHoverChange?: (hover: boolean) => void }) {
    const [hover, setHover] = useState(false);
    const cardStyle: React.CSSProperties = {
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 8,
        border: '1px solid var(--border)',
        background: 'var(--card-bg, var(--background))',
        padding: 16,
        boxShadow: hover ? '0 4px 12px rgba(0,0,0,0.06)' : 'none',
        borderColor: hover ? 'var(--primary)' : 'var(--border)',
        transition: 'box-shadow 0.2s, border-color 0.2s',
        boxSizing: 'border-box',
    };

    return <div style={cardStyle} onMouseEnter={() => { setHover(true); onHoverChange?.(true); }} onMouseLeave={() => { setHover(false); onHoverChange?.(false); }}>{children}</div>;
}

// docs/design/components.md §2 E.2 — no native <select>. This is a lightweight Select built on
// existing Radix DropdownMenu (RadioGroup pattern) so we don't add a new package.
'use client';

import * as React from 'react';
import { Check, ChevronDown } from 'lucide-react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export interface SelectOption<T extends string = string> {
    value: T;
    label: React.ReactNode;
    /** Optional dot/icon color (for status-tinted options). */
    accent?: string;
}

interface SelectProps<T extends string = string> {
    value: T;
    onChange: (v: T) => void;
    options: ReadonlyArray<SelectOption<T>>;
    /** Optional fixed label rendered before the value chip (e.g., "Status"). */
    label?: React.ReactNode;
    /** True if the selection is non-default (renders primary-tinted chip). */
    active?: boolean;
    size?: 'sm' | 'md';
    className?: string;
    'aria-label'?: string;
}

export function Select<T extends string = string>({
    value,
    onChange,
    options,
    label,
    active,
    size = 'sm',
    className,
    'aria-label': ariaLabel,
}: SelectProps<T>) {
    const current = options.find(o => o.value === value);
    const heightClass = size === 'sm' ? 'h-7 text-xs' : 'h-8 text-sm';

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                aria-label={ariaLabel || (typeof label === 'string' ? label : undefined)}
                className={cn(
                    'inline-flex items-center gap-1.5 px-2.5 rounded-md border transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    heightClass,
                    active
                        ? 'bg-primary-subtle border-primary-border text-primary'
                        : 'bg-card border-border text-foreground hover:bg-background-secondary',
                    className,
                )}
            >
                {label && (
                    <span className={cn('font-medium', active ? 'text-primary' : 'text-foreground-muted')}>
                        {label}
                    </span>
                )}
                <span className="truncate max-w-[14rem]">{current?.label ?? value}</span>
                <ChevronDown className="size-3 shrink-0 text-foreground-muted" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={4} className="min-w-[10rem]">
                <DropdownMenuRadioGroup value={value} onValueChange={v => onChange(v as T)}>
                    {options.map(opt => (
                        <DropdownMenuRadioItem
                            key={opt.value}
                            value={opt.value}
                            className="pl-8 pr-2"
                        >
                            <span className="absolute left-2 flex size-4 items-center justify-center">
                                {opt.value === value && <Check className="size-3.5" />}
                            </span>
                            {opt.accent && (
                                <span
                                    aria-hidden
                                    className="inline-block size-2 rounded-full mr-1.5 shrink-0"
                                    style={{ background: opt.accent }}
                                />
                            )}
                            <span className="truncate">{opt.label}</span>
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

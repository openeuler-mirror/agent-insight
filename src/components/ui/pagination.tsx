// docs/design/components.md §2 E.9 — pagination component used by list pages.
'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export interface PaginationProps {
    page: number;
    pageSize: number;
    total: number;
    onPageChange: (p: number) => void;
    onPageSizeChange?: (size: number) => void;
    pageSizes?: ReadonlyArray<number>;
    summary?: (start: number, end: number, total: number) => React.ReactNode;
    pageSizeLabel?: (n: number) => string;
    className?: string;
}

function getPageNumbers(current: number, total: number): (number | 'ellipsis')[] {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    if (current <= 3) return [1, 2, 3, 4, 'ellipsis', total];
    if (current >= total - 2) return [1, 'ellipsis', total - 3, total - 2, total - 1, total];
    return [1, 'ellipsis', current - 1, current, current + 1, 'ellipsis', total];
}

export function Pagination({
    page,
    pageSize,
    total,
    onPageChange,
    onPageSizeChange,
    pageSizes = [20, 50, 100],
    summary,
    pageSizeLabel = n => `${n} / page`,
    className,
}: PaginationProps) {
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    const pages = getPageNumbers(page, totalPages);

    return (
        <div className={cn('flex items-center justify-between gap-3', className)}>
            <p className="text-xs text-foreground-muted">
                {summary ? summary(start, end, total) : `${start}–${end} of ${total}`}
            </p>
            <div className="flex items-center gap-1.5">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onPageChange(page - 1)}
                    disabled={page <= 1}
                    className="size-8 p-0"
                    aria-label="Previous page"
                >
                    <ChevronLeft className="size-4" />
                </Button>
                {pages.map((p, i) =>
                    p === 'ellipsis' ? (
                        <span key={`e-${i}`} className="px-1 text-foreground-muted text-xs">…</span>
                    ) : (
                        <Button
                            key={`p-${p}`}
                            variant={p === page ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => onPageChange(p)}
                            className="size-8 p-0 text-xs tabular-nums"
                            aria-current={p === page ? 'page' : undefined}
                        >
                            {p}
                        </Button>
                    ),
                )}
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onPageChange(page + 1)}
                    disabled={page >= totalPages}
                    className="size-8 p-0"
                    aria-label="Next page"
                >
                    <ChevronRight className="size-4" />
                </Button>
                {onPageSizeChange && (
                    <Select
                        className="ml-2"
                        value={String(pageSize)}
                        onChange={v => onPageSizeChange(Number(v))}
                        options={pageSizes.map(s => ({ value: String(s), label: pageSizeLabel(s) }))}
                    />
                )}
            </div>
        </div>
    );
}

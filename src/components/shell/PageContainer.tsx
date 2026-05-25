// docs/design/patterns.md §1 — unified page shell, left-aligned, no mx-auto.
import * as React from 'react';
import { cn } from '@/lib/utils';

type Variant = 'default' | 'wide' | 'canvas';

const VARIANT_CLASSES: Record<Variant, string> = {
  // 95% of pages — left-aligned, fills available width
  default: 'w-full px-6 py-6',
  // Dashboard / multi-column
  wide:    'w-full px-8 py-6',
  // Canvas / full-bleed
  canvas:  'w-full p-0',
};

export function PageContainer({
  variant = 'default',
  className,
  children,
}: {
  variant?: Variant;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex-1 flex flex-col min-h-0 overflow-y-auto', VARIANT_CLASSES[variant], className)}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4 mb-4', className)}>
      <div className="min-w-0 space-y-1">
        <h1 className="text-xl font-semibold text-foreground truncate">{title}</h1>
        {description && <p className="text-sm text-foreground-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function PageToolbar({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2 mb-3', className)}>
      {children}
    </div>
  );
}

export function PageContent({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn('flex-1 min-h-0', className)}>{children}</div>;
}

export function PageFooter({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3 mt-4 pt-3 border-t border-border', className)}>
      {children}
    </div>
  );
}

// docs/design/components.md §2 E.8 — explicit empty state with icon + title + description + action.
import * as React from 'react';
import { Inbox, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon = Inbox, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 text-center py-12 px-6',
        'text-foreground-muted',
        className,
      )}
    >
      <div className="size-10 rounded-full bg-background-secondary text-foreground-muted flex items-center justify-center">
        <Icon className="size-5" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="text-base font-semibold text-foreground">{title}</p>
        {description && <p className="text-sm text-foreground-muted max-w-md">{description}</p>}
      </div>
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}

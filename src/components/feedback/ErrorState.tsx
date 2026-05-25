// docs/design/components.md §2 E.8 — explicit error state with title + description + retry.
import * as React from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ErrorStateProps {
  title: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

export function ErrorState({ title, description, onRetry, retryLabel = 'Retry', className }: ErrorStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 text-center py-12 px-6', className)}>
      <div className="size-10 rounded-full bg-error-subtle text-error flex items-center justify-center">
        <AlertCircle className="size-5" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="text-base font-semibold text-foreground">{title}</p>
        {description && <p className="text-sm text-foreground-muted max-w-md">{description}</p>}
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-1">
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

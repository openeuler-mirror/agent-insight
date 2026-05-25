'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ConfirmDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: React.ReactNode;
    description?: React.ReactNode;
    confirmText?: string;
    cancelText?: string;
    tone?: 'normal' | 'danger';
    /** Called when the user clicks the confirm button. Return a Promise to keep the button in "pending" state. */
    onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    confirmText = '确认',
    cancelText = '取消',
    tone = 'normal',
    onConfirm,
}: ConfirmDialogProps) {
    const [isPending, setIsPending] = React.useState(false);

    const handleConfirm = async () => {
        try {
            setIsPending(true);
            await onConfirm();
            onOpenChange(false);
        } finally {
            setIsPending(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className={cn('flex items-center gap-2', tone === 'danger' && 'text-destructive')}>
                        {tone === 'danger' && <AlertTriangle className="size-4" />}
                        {title}
                    </DialogTitle>
                    {description && <DialogDescription>{description}</DialogDescription>}
                </DialogHeader>
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={isPending}
                    >
                        {cancelText}
                    </Button>
                    <Button
                        onClick={handleConfirm}
                        disabled={isPending}
                        className={cn(
                            tone === 'danger' && 'bg-error text-error-foreground hover:bg-error/90',
                        )}
                    >
                        {isPending ? '处理中…' : confirmText}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

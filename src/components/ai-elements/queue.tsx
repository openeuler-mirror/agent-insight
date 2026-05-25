import type { HTMLAttributes, PropsWithChildren } from 'react';

type QueueItemProps = PropsWithChildren<
    HTMLAttributes<HTMLDivElement> & {
        state?: 'queued' | 'running' | 'completed' | 'failed' | string;
    }
>;

export function Queue({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
    return (
        <div className={`ae-queue ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function QueueItem({ state = 'queued', className = '', children, ...props }: QueueItemProps) {
    const normalized = state.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    return (
        <div className={`ae-queue-item ae-queue-item-${normalized} ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

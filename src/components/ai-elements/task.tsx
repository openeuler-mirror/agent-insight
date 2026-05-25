import type { HTMLAttributes, PropsWithChildren } from 'react';

type TaskState = 'running' | 'completed' | 'failed' | 'pending' | string;

type TaskProps = PropsWithChildren<
    HTMLAttributes<HTMLDivElement> & {
        state: TaskState;
    }
>;

export function Task({ state, className = '', children, ...props }: TaskProps) {
    const normalized = state.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    return (
        <div className={`ae-task ae-task-${normalized} ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function TaskLabel({ className = '', children, ...props }: HTMLAttributes<HTMLSpanElement>) {
    return (
        <span className={`ae-task-label ${className}`.trim()} {...props}>
            {children}
        </span>
    );
}

import type { HTMLAttributes, PropsWithChildren } from 'react';

export function Context({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
    return (
        <div className={`ae-context ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function ContextItem({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
    return (
        <div className={`ae-context-item ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

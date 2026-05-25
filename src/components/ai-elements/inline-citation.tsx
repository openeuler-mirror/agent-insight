import type { HTMLAttributes, PropsWithChildren } from 'react';

export function InlineCitation({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLElement>>) {
    return (
        <sup className={`ae-inline-citation ${className}`.trim()} {...props}>
            {children}
        </sup>
    );
}

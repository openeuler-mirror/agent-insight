import type { HTMLAttributes, PropsWithChildren } from 'react';

export function Checkpoint({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
    return (
        <div className={`ae-checkpoint ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

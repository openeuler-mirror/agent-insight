import type { HTMLAttributes, PropsWithChildren } from 'react';

export function ChainOfThought({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
    return (
        <div className={`ae-chain-of-thought ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

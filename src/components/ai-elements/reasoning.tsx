import type { DetailsHTMLAttributes, HTMLAttributes, PropsWithChildren } from 'react';

type ReasoningProps = PropsWithChildren<DetailsHTMLAttributes<HTMLDetailsElement>>;

export function Reasoning({ className = '', children, ...props }: ReasoningProps) {
    return (
        <details className={`ae-reasoning ${className}`.trim()} {...props}>
            {children}
        </details>
    );
}

export function ReasoningTrigger({ className = '', children, ...props }: HTMLAttributes<HTMLElement>) {
    return (
        <summary className={`ae-reasoning-trigger ${className}`.trim()} {...props}>
            {children}
        </summary>
    );
}

export function ReasoningContent({ className = '', children, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div className={`ae-reasoning-content ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

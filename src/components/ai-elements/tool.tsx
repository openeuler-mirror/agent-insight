import type { ButtonHTMLAttributes, HTMLAttributes, PropsWithChildren } from 'react';

type ToolProps = PropsWithChildren<HTMLAttributes<HTMLDivElement>>;

export function Tool({ className = '', children, ...props }: ToolProps) {
    return (
        <div className={`ae-tool ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function ToolHeader({ className = '', children, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div className={`ae-tool-header ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function ToolTitle({ className = '', children, ...props }: HTMLAttributes<HTMLSpanElement>) {
    return (
        <span className={`ae-tool-title ${className}`.trim()} {...props}>
            {children}
        </span>
    );
}

export function ToolTrigger({ className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
        <button type="button" className={`ae-tool-trigger ${className}`.trim()} {...props}>
            {children}
        </button>
    );
}

export function ToolInput({ className = '', children, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div className={`ae-tool-input ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

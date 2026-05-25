import type { ButtonHTMLAttributes, HTMLAttributes, PropsWithChildren } from 'react';

export function ModelSelector({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
    return (
        <div className={`ae-model-selector ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function ModelSelectorTrigger({ className = '', children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) {
    return (
        <button type="button" className={`ae-model-selector-trigger ${className}`.trim()} {...props}>
            {children}
        </button>
    );
}

export function ModelSelectorContent({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
    return (
        <div className={`ae-model-selector-content ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function ModelSelectorItem({ className = '', children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) {
    return (
        <button type="button" className={`ae-model-selector-item ${className}`.trim()} {...props}>
            {children}
        </button>
    );
}

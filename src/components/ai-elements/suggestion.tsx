import type { ButtonHTMLAttributes, HTMLAttributes, PropsWithChildren } from 'react';

export function Suggestion({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
    return (
        <div className={`ae-suggestion ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function SuggestionItem({ className = '', children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) {
    return (
        <button type="button" className={`ae-suggestion-item ${className}`.trim()} {...props}>
            {children}
        </button>
    );
}

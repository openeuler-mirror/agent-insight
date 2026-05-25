import type { ButtonHTMLAttributes, HTMLAttributes, PropsWithChildren, TextareaHTMLAttributes } from 'react';

export function PromptInput({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
    return (
        <div className={`ae-prompt-input ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function PromptInputTextarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
    return <textarea className={`ae-prompt-input-textarea ${className}`.trim()} {...props} />;
}

export function PromptInputActions({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
    return (
        <div className={`ae-prompt-input-actions ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function PromptInputSubmit({ className = '', children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) {
    return (
        <button type="button" className={`ae-prompt-input-submit ${className}`.trim()} {...props}>
            {children}
        </button>
    );
}

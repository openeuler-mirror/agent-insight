import type { ButtonHTMLAttributes, DialogHTMLAttributes, HTMLAttributes, PropsWithChildren } from 'react';

export function Confirmation({ className = '', children, open, ...props }: PropsWithChildren<DialogHTMLAttributes<HTMLDialogElement>>) {
    return (
        <dialog open={open} className={`ae-confirmation ${className}`.trim()} {...props}>
            {children}
        </dialog>
    );
}

export function ConfirmationBody({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
    return (
        <div className={`ae-confirmation-body ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function ConfirmationActions({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
    return (
        <div className={`ae-confirmation-actions ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function ConfirmationAction({ className = '', children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) {
    return (
        <button type="button" className={`ae-confirmation-action ${className}`.trim()} {...props}>
            {children}
        </button>
    );
}

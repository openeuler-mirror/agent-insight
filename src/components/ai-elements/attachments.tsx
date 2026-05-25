import type { ButtonHTMLAttributes, HTMLAttributes, PropsWithChildren } from 'react';

export function Attachments({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
    return (
        <div className={`ae-attachments ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function AttachmentItem({ className = '', children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) {
    return (
        <button type="button" className={`ae-attachment-item ${className}`.trim()} {...props}>
            {children}
        </button>
    );
}

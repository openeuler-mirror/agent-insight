import type { HTMLAttributes, PropsWithChildren } from 'react';

type MessageProps = PropsWithChildren<
    HTMLAttributes<HTMLDivElement> & {
        from: 'user' | 'assistant';
    }
>;

export function Message({ from, className = '', children, ...props }: MessageProps) {
    const roleClass = from === 'user' ? 'message-user' : 'message-assistant';
    return (
        <div className={`ae-message ${roleClass} ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function MessageContent({ className = '', children, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div className={`ae-message-content ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function MessageResponse({ className = '', children, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div className={`ae-message-response ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

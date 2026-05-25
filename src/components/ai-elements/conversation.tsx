import type { HTMLAttributes, PropsWithChildren } from 'react';

type ConversationProps = PropsWithChildren<HTMLAttributes<HTMLDivElement>>;

export function Conversation({ className = '', children, ...props }: ConversationProps) {
    return (
        <div className={`ae-conversation ${className}`.trim()} role="log" aria-live="polite" aria-relevant="additions text" {...props}>
            {children}
        </div>
    );
}

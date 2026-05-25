import type { AnchorHTMLAttributes, HTMLAttributes, PropsWithChildren } from 'react';

export function Sources({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
    return (
        <div className={`ae-sources ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function SourcesList({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLUListElement>>) {
    return (
        <ul className={`ae-sources-list ${className}`.trim()} {...props}>
            {children}
        </ul>
    );
}

export function SourcesItem({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLLIElement>>) {
    return (
        <li className={`ae-sources-item ${className}`.trim()} {...props}>
            {children}
        </li>
    );
}

export function SourcesLink({ className = '', children, ...props }: PropsWithChildren<AnchorHTMLAttributes<HTMLAnchorElement>>) {
    return (
        <a className={`ae-sources-link ${className}`.trim()} target="_blank" rel="noreferrer" {...props}>
            {children}
        </a>
    );
}

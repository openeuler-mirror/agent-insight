import type { HTMLAttributes } from 'react';

export function Shimmer({ className = '', ...props }: HTMLAttributes<HTMLSpanElement>) {
    return <span className={`ae-shimmer ${className}`.trim()} {...props} />;
}

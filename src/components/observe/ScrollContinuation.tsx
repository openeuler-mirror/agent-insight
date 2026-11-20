'use client';
import { useEffect, useRef } from 'react';

export function ScrollContinuation({ onMore, busy, error, count, network }: {
    onMore: () => void; busy?: boolean; error?: string; count: number; network?: boolean;
}) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const element = ref.current;
        const root = element?.closest('[role="tree"]');
        if (!element || !root || busy || error) return;
        let triggered = false;
        const check = () => {
            if (triggered || root.scrollTop <= 0 || (network && root.querySelector('[data-trace-hidden-events]'))) return;
            if (element.getBoundingClientRect().top <= root.getBoundingClientRect().bottom + 160) {
                triggered = true; onMore();
            }
        };
        root.addEventListener('scroll', check, { passive: true });
        const observer = new MutationObserver(check);
        observer.observe(root, { childList: true, subtree: true });
        check();
        return () => { root.removeEventListener('scroll', check); observer.disconnect(); };
    }, [onMore, busy, error, count, network]);
    return <div ref={ref} className="px-3 py-2 text-xs text-foreground-muted" role="status">
        {error ? <button onClick={onMore}>加载失败，点击重试</button> : busy ? '加载中…' : null}
    </div>;
}

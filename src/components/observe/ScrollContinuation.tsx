'use client';
import { useEffect, useRef, useState } from 'react';
import { useLocale } from '@/lib/client/locale-context';

export function ScrollContinuation({ onMore, busy, error, count, network }: {
    onMore: () => void; busy?: boolean; error?: string; count: number; network?: boolean;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const { locale } = useLocale();
    const [showLoadButton, setShowLoadButton] = useState(false);
    useEffect(() => {
        const element = ref.current;
        const root = element?.closest('[role="tree"]');
        if (!element || !root || busy || error) return;
        let triggered = false;
        const check = () => {
            const hasHiddenEvents = network && Boolean(root.querySelector('[data-trace-hidden-events]'));
            const needsButton = network && !hasHiddenEvents && root.scrollHeight - element.offsetHeight <= root.clientHeight;
            if (network) setShowLoadButton(Boolean(needsButton));
            if (triggered || needsButton || root.scrollTop <= 0 || hasHiddenEvents) return;
            if (element.getBoundingClientRect().top <= root.getBoundingClientRect().bottom + 160) {
                triggered = true; onMore();
            }
        };
        root.addEventListener('scroll', check, { passive: true });
        const observer = new MutationObserver(check);
        observer.observe(root, { childList: true, subtree: true });
        const resizeObserver = network ? new ResizeObserver(check) : null;
        resizeObserver?.observe(root);
        check();
        return () => { root.removeEventListener('scroll', check); observer.disconnect(); resizeObserver?.disconnect(); };
    }, [onMore, busy, error, count, network]);
    return <div ref={ref} className="px-3 py-2 text-xs text-foreground-muted" role="status">
        {error ? <button onClick={onMore}>加载失败，点击重试</button> : busy ? '加载中…' : showLoadButton ? (
            <button type="button" onClick={onMore}>{locale === 'zh' ? '继续加载更多调用' : 'Show more calls'}</button>
        ) : null}
    </div>;
}

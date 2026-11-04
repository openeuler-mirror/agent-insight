/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use client';

import React, { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/lib/client/locale-context';
import { createSpanScrollController, captureSpanScrollAnchor, spanScrollAnchorDelta, type SpanScrollAnchor } from '@/lib/client/trace-span-scroll';

export interface TraceSpanViewportHandle {
    pauseFollowing: () => void;
    captureAnchor: (preferredKey?: string | null) => void;
}

export const TraceSpanViewport = forwardRef<TraceSpanViewportHandle, {
    navigationKey: unknown;
    onUserNavigation?: () => void;
    children: React.ReactNode;
}>(function TraceSpanViewport({ navigationKey, onUserNavigation, children }, ref) {
    const { t } = useLocale();
    const viewportRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const pendingAnchorRef = useRef<SpanScrollAnchor | null>(null);
    const [scroll] = useState(() => createSpanScrollController(() => viewportRef.current));
    const { following, hasNewContent } = useSyncExternalStore(scroll.subscribe, scroll.getSnapshot, scroll.getSnapshot);
    const visibleKeys = useCallback(() => Array.from(
        contentRef.current?.querySelectorAll('[data-span-key]') ?? [],
        element => element.getAttribute('data-span-key') || '',
    ), []);
    const scrollRows = useCallback(() => Array.from(
        contentRef.current?.querySelectorAll('[data-span-key]') ?? [], element => {
            const rect = element.getBoundingClientRect();
            return { key: element.getAttribute('data-span-key') || '', top: rect.top, bottom: rect.bottom };
        },
    ), []);
    const captureAnchor = useCallback((preferredKey?: string | null) => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        onUserNavigation?.();
        scroll.pauseFollowing();
        pendingAnchorRef.current = captureSpanScrollAnchor(viewport.getBoundingClientRect(), scrollRows(), preferredKey);
    }, [onUserNavigation, scroll, scrollRows]);
    const pauseFollowing = useCallback(() => { pendingAnchorRef.current = null; scroll.pauseFollowing(); }, [scroll]);
    const userScroll = (upward = false) => {
        pendingAnchorRef.current = null;
        onUserNavigation?.();
        scroll.userScroll(upward);
    };
    useImperativeHandle(ref, () => ({ pauseFollowing, captureAnchor }), [pauseFollowing, captureAnchor]);

    useLayoutEffect(() => {
        scroll.resetView(visibleKeys());
        const anchor = pendingAnchorRef.current;
        pendingAnchorRef.current = null;
        const viewport = viewportRef.current;
        if (anchor && viewport) {
            const delta = spanScrollAnchorDelta(anchor, viewport.getBoundingClientRect().top, scrollRows());
            if (delta !== null) viewport.scrollTop += delta;
        }
    }, [navigationKey, scroll, scrollRows, visibleKeys]);

    useLayoutEffect(() => {
        const viewport = viewportRef.current;
        const content = contentRef.current;
        if (!viewport || !content) return;
        let frame: number | null = null;
        const schedule = () => {
            if (frame !== null) return;
            frame = requestAnimationFrame(() => {
                frame = null;
                scroll.refresh(visibleKeys());
            });
        };
        scroll.refresh(visibleKeys());
        viewport.addEventListener('scrollend', scroll.endUserScroll);
        const mutationObserver = new MutationObserver(schedule);
        mutationObserver.observe(content, { childList: true, subtree: true });
        const resizeObserver = new ResizeObserver(schedule);
        resizeObserver.observe(content);
        resizeObserver.observe(viewport);
        return () => {
            viewport.removeEventListener('scrollend', scroll.endUserScroll);
            mutationObserver.disconnect();
            resizeObserver.disconnect();
            if (frame !== null) cancelAnimationFrame(frame);
        };
    }, [scroll, visibleKeys]);

    return (
        <div className="relative flex-1 min-h-0">
            <div
                ref={viewportRef}
                role="tree"
                aria-label={t('traceTree.spanList')}
                tabIndex={0}
                onScroll={scroll.onScroll}
                onWheel={event => { if (event.deltaY !== 0) userScroll(event.deltaY < 0); }}
                onTouchMove={() => userScroll()}
                onPointerDown={event => { if (event.target === event.currentTarget) userScroll(); }}
                onKeyDown={event => {
                    if (event.ctrlKey || event.metaKey || event.altKey) return;
                    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
                        userScroll(['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey));
                    }
                }}
                className="h-full overflow-y-auto overflow-x-auto pt-1 pb-12 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
                <div ref={contentRef}>{children}</div>
            </div>
            <div className="absolute bottom-2 right-3 flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1 shadow-sm">
                <span role="status" aria-live="polite" className="text-xs text-foreground-muted">
                    {following ? t('traceTree.followingLatest') : hasNewContent ? t('traceTree.newContent') : ''}
                </span>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => { pendingAnchorRef.current = null; onUserNavigation?.(); scroll.refresh(visibleKeys()); scroll.jumpToBottom(); }}
                >
                    <ArrowDown className="size-3.5" aria-hidden />
                    {t('traceTree.jumpToBottom')}
                </Button>
            </div>
        </div>
    );
});

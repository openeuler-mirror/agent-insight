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

import React, { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/lib/client/locale-context';
import { createSpanScrollController, captureSpanScrollAnchor, type SpanScrollAnchor } from '@/lib/client/trace-span-scroll';
import { buildSpanLayout, createSpanWindowStore, spanAnchorOffset, spanScrollOffset, spanKeyboardIndex, spanModelAnchor, SPAN_VIRTUAL_THRESHOLD, type SpanTreeRow } from '@/lib/client/trace-span-virtualization';

export interface TraceSpanViewportHandle {
    pauseFollowing: () => void;
    captureAnchor: (preferredKey?: string | null) => void;
    scrollToKey: (key: string) => void;
}

export const TraceSpanViewport = forwardRef<TraceSpanViewportHandle, {
    navigationKey: unknown;
    rows: SpanTreeRow[];
    onUserNavigation?: () => void;
    onToggleRow?: (key: string) => void;
    children: (row: SpanTreeRow) => React.ReactNode;
}>(function TraceSpanViewport({ navigationKey, rows, onUserNavigation, onToggleRow, children }, ref) {
    const { t } = useLocale();
    const viewportRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const pendingAnchorRef = useRef<SpanScrollAnchor | null>(null);
    const pendingJumpRef = useRef<string | null>(null);
    const pendingFocusRef = useRef<string | null>(null);
    const previousNavigationRef = useRef<unknown>(undefined);
    const frameRef = useRef<number | null>(null);
    const [focusedKey, setFocusedKey] = useState<string | null>(null);
    const [scroll] = useState(() => createSpanScrollController(() => viewportRef.current));
    const [windowStore] = useState(() => createSpanWindowStore(() => viewportRef.current));
    const layout = useMemo(() => buildSpanLayout(rows), [rows]);
    const virtualWindow = useSyncExternalStore(windowStore.subscribe, windowStore.getSnapshot, windowStore.getSnapshot);
    const { following, hasNewContent } = useSyncExternalStore(scroll.subscribe, scroll.getSnapshot, scroll.getSnapshot);
    const mountedRow = useCallback((key: string) => Array.from(
        contentRef.current?.querySelectorAll<HTMLElement>('[data-span-key]') ?? [],
    ).find(element => element.getAttribute('data-span-key') === key), []);
    const visibleKeys = useCallback(() => windowStore.getLayout().rows.map(row => row.key), [windowStore]);
    const contentInset = useCallback(() => {
        const viewport = viewportRef.current, content = contentRef.current;
        return viewport && content ? content.getBoundingClientRect().top + viewport.scrollTop - viewport.getBoundingClientRect().top : 4;
    }, []);
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
        pendingJumpRef.current = null;
        pendingFocusRef.current = null;
        scroll.pauseFollowing();
        pendingAnchorRef.current = captureSpanScrollAnchor(viewport.getBoundingClientRect(), scrollRows(), preferredKey);
    }, [onUserNavigation, scroll, scrollRows]);
    const pauseFollowing = useCallback(() => {
        pendingAnchorRef.current = null; pendingJumpRef.current = null; pendingFocusRef.current = null;
        scroll.pauseFollowing();
    }, [scroll]);
    const userScroll = (upward = false) => {
        pendingAnchorRef.current = null; pendingJumpRef.current = null; pendingFocusRef.current = null;
        onUserNavigation?.(); scroll.userScroll(upward);
    };
    const focusPending = useCallback(() => {
        const key = pendingFocusRef.current;
        if (!key) return;
        const element = mountedRow(key);
        if (element) { pendingFocusRef.current = null; element.focus({ preventScroll: true }); }
    }, [mountedRow]);
    const scrollToKey = useCallback((key: string) => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        pendingJumpRef.current = key;
        const top = spanScrollOffset(windowStore.getLayout(), key, viewport.clientHeight, 'center', viewport.scrollTop, contentInset());
        if (top === null) return;
        pendingJumpRef.current = null;
        viewport.scrollTop = top;
        windowStore.update();
    }, [windowStore, contentInset]);
    useImperativeHandle(ref, () => ({ pauseFollowing, captureAnchor, scrollToKey }), [pauseFollowing, captureAnchor, scrollToKey]);

    useLayoutEffect(() => {
        const navigationChanged = previousNavigationRef.current !== navigationKey;
        const automaticAnchor = !navigationChanged && !scroll.getSnapshot().following
            ? spanModelAnchor(windowStore.getLayout(), windowStore.getScrollTop(), contentInset()) : null;
        windowStore.setLayout(layout);
        if (navigationChanged) {
            previousNavigationRef.current = navigationKey;
            scroll.resetView(visibleKeys());
        } else scroll.refresh(visibleKeys());
        const viewport = viewportRef.current;
        const anchor = pendingAnchorRef.current ?? automaticAnchor;
        pendingAnchorRef.current = null;
        if (anchor && viewport) {
            const top = spanAnchorOffset(layout, anchor, contentInset());
            if (top !== null) viewport.scrollTop = top;
        }
        if (pendingJumpRef.current) scrollToKey(pendingJumpRef.current);
        windowStore.update();
    }, [layout, navigationKey, scroll, windowStore, visibleKeys, contentInset, scrollToKey]);

    useLayoutEffect(focusPending, [virtualWindow, rows, focusPending]);
    useLayoutEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        const refresh = () => { scroll.refresh(visibleKeys()); windowStore.update(); };
        const resizeObserver = new ResizeObserver(refresh);
        resizeObserver.observe(viewport);
        viewport.addEventListener('scrollend', scroll.endUserScroll);
        return () => {
            viewport.removeEventListener('scrollend', scroll.endUserScroll);
            resizeObserver.disconnect();
            if (frameRef.current !== null) { cancelAnimationFrame(frameRef.current); frameRef.current = null; }
        };
    }, [scroll, windowStore, visibleKeys]);

    const virtualized = rows.length > SPAN_VIRTUAL_THRESHOLD;
    const start = virtualized ? Math.min(virtualWindow.start, rows.length) : 0;
    const end = virtualized ? Math.min(virtualWindow.end, rows.length) : rows.length;
    const mountedIndices = Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
    const focusedIndex = focusedKey ? layout.indexByKey.get(focusedKey) : undefined;
    if (focusedIndex !== undefined && (focusedIndex < start || focusedIndex >= end)) mountedIndices.push(focusedIndex);
    mountedIndices.sort((left, right) => left - right);

    return (
        <div className="relative flex-1 min-h-0">
            <div
                ref={viewportRef}
                role="tree"
                aria-label={t('traceTree.spanList')}
                tabIndex={0}
                onFocusCapture={event => setFocusedKey((event.target as Element).closest('[data-span-key]')?.getAttribute('data-span-key') ?? null)}
                onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedKey(null); }}
                onScroll={() => {
                    scroll.onScroll();
                    windowStore.recordPosition();
                    if (frameRef.current !== null) return;
                    frameRef.current = requestAnimationFrame(() => { frameRef.current = null; windowStore.update(); });
                }}
                onWheel={event => { if (event.deltaY !== 0) userScroll(event.deltaY < 0); }}
                onTouchMove={() => userScroll()}
                onPointerDown={event => { if (event.target === event.currentTarget) userScroll(); }}
                onKeyDown={event => {
                    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
                    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
                        userScroll(['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey));
                    }
                    const viewport = viewportRef.current;
                    if (!viewport || !rows.length) return;
                    const key = (event.target as Element).closest('[data-span-key]')?.getAttribute('data-span-key');
                    let index = spanKeyboardIndex(layout, key, viewport.scrollTop, viewport.clientHeight, event.key, contentInset());
                    if (index === null) return;
                    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                        userScroll(event.key === 'ArrowLeft');
                        const row = rows[index];
                        if (row.hasChildren && row.isExpanded === (event.key === 'ArrowLeft')) {
                            event.preventDefault(); onToggleRow?.(row.key); return;
                        }
                        const target = event.key === 'ArrowLeft' ? row.parentKey : rows[index + 1]?.parentKey === row.key ? rows[index + 1]?.key : undefined;
                        if (!target) return;
                        index = layout.indexByKey.get(target) ?? index;
                    }
                    event.preventDefault();
                    const target = rows[Math.max(0, Math.min(rows.length - 1, index))];
                    pendingFocusRef.current = target.key;
                    const top = spanScrollOffset(layout, target.key, viewport.clientHeight, 'nearest', viewport.scrollTop, contentInset());
                    if (event.key === 'Home') viewport.scrollTop = 0;
                    else if (event.key === 'End') viewport.scrollTop = viewport.scrollHeight;
                    else if (top !== null) viewport.scrollTop = top;
                    windowStore.update(); focusPending();
                }}
                className="h-full overflow-y-auto overflow-x-auto pt-1 pb-12 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
                <div ref={contentRef} className="relative" style={{ height: layout.total }} data-span-row-count={rows.length}>
                    {mountedIndices.map(index => <div key={rows[index].key} className="absolute inset-x-0" style={{ top: layout.offsets[index], height: rows[index].height }}>
                        {children(rows[index])}
                    </div>)}
                </div>
            </div>
            <div className="absolute bottom-2 right-3 flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1 shadow-sm">
                <span role="status" aria-live="polite" className="text-xs text-foreground-muted">
                    {following ? t('traceTree.followingLatest') : hasNewContent ? t('traceTree.newContent') : ''}
                </span>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => {
                    pendingAnchorRef.current = null; pendingJumpRef.current = null; pendingFocusRef.current = null;
                    onUserNavigation?.(); scroll.refresh(visibleKeys()); scroll.jumpToBottom(); windowStore.update();
                }}>
                    <ArrowDown className="size-3.5" aria-hidden />
                    {t('traceTree.jumpToBottom')}
                </Button>
            </div>
        </div>
    );
});

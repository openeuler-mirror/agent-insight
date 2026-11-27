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

type ScrollViewport = { scrollTop: number; scrollHeight: number; clientHeight: number };
type ScrollSnapshot = { following: boolean; hasNewContent: boolean };

export function createSpanScrollController(getViewport: () => ScrollViewport | null) {
    let snapshot: ScrollSnapshot = { following: false, hasNewContent: false };
    let knownKeys: Set<string> | undefined;
    let lastScrollTop = getViewport()?.scrollTop ?? 0;
    let userScrolling = false;
    let scrollingUp = false;
    const listeners = new Set<() => void>();

    const publish = (following: boolean, hasNewContent: boolean) => {
        if (snapshot.following === following && snapshot.hasNewContent === hasNewContent) return;
        snapshot = { following, hasNewContent };
        listeners.forEach(listener => listener());
    };
    const pinBottom = () => {
        const viewport = getViewport();
        if (!viewport) return;
        viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        lastScrollTop = viewport.scrollTop;
    };

    const pauseFollowing = () => {
        userScrolling = false;
        lastScrollTop = getViewport()?.scrollTop ?? 0;
        publish(false, snapshot.hasNewContent);
    };

    return {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        jumpToBottom: () => {
            userScrolling = false;
            publish(true, false);
            pinBottom();
        },
        pauseFollowing,
        resetView: (keys: Iterable<string>) => {
            knownKeys = new Set(keys);
            pauseFollowing();
            publish(false, false);
        },
        userScroll: (upward = false) => {
            userScrolling = true;
            scrollingUp = upward;
            if (upward) publish(false, snapshot.hasNewContent);
        },
        endUserScroll: () => { userScrolling = false; },
        onScroll: () => {
            const viewport = getViewport();
            if (!viewport) return;
            const atBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2;
            if (userScrolling) {
                const following = atBottom && !scrollingUp;
                publish(following, following ? false : snapshot.hasNewContent);
            } else if (snapshot.following && viewport.scrollTop < lastScrollTop - 1 && !atBottom) {
                publish(false, snapshot.hasNewContent);
            }
            lastScrollTop = viewport.scrollTop;
        },
        refresh: (keys: Iterable<string>) => {
            const next = new Set(keys);
            const previousKeys = knownKeys;
            const hasAddedRows = previousKeys !== undefined && [...next].some(key => !previousKeys.has(key));
            knownKeys = next;
            if (snapshot.following) pinBottom();
            else if (hasAddedRows) publish(false, true);
        },
    };
}


type SpanScrollRow = { key: string; top: number; bottom: number };
export type SpanScrollAnchor = { key: string; offset: number };

export function captureSpanScrollAnchor(
    viewport: { top: number; bottom: number }, rows: SpanScrollRow[], preferredKey?: string | null,
): SpanScrollAnchor | null {
    const visible = rows.filter(row => row.bottom > viewport.top && row.top < viewport.bottom);
    const row = visible.find(item => item.key === preferredKey) ?? visible[0];
    return row ? { key: row.key, offset: row.top - viewport.top } : null;
}

export function spanScrollAnchorDelta(anchor: SpanScrollAnchor, viewportTop: number, rows: SpanScrollRow[]): number | null {
    const row = rows.find(item => item.key === anchor.key);
    return row ? row.top - viewportTop - anchor.offset : null;
}

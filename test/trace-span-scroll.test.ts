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

import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpanScrollController, captureSpanScrollAnchor, spanScrollAnchorDelta } from '../src/lib/client/trace-span-scroll';

function fixture(scrollTop = 0, scrollHeight = 1000, clientHeight = 200) {
    const viewport = { scrollTop, scrollHeight, clientHeight };
    const controller = createSpanScrollController(() => viewport);
    controller.refresh(['root', 'user:0', 'llm:1']);
    return { viewport, controller };
}

test('opening a Trace keeps the initial viewport and does not start following', () => {
    const { viewport, controller } = fixture(120);
    assert.equal(viewport.scrollTop, 120);
    assert.deepEqual(controller.getSnapshot(), { following: false, hasNewContent: false });
});

test('jumping to the bottom enables following and tracks appended rows', () => {
    const { viewport, controller } = fixture();
    controller.jumpToBottom();
    assert.equal(viewport.scrollTop, 800);
    assert.equal(controller.getSnapshot().following, true);
    viewport.scrollHeight = 1400;
    controller.refresh(['root', 'user:0', 'llm:1', 'user:2', 'llm:3']);
    assert.equal(viewport.scrollTop, 1200);
    assert.deepEqual(controller.getSnapshot(), { following: true, hasNewContent: false });
});

test('scrolling upward pauses following before an arriving update and preserves history position', () => {
    const { viewport, controller } = fixture();
    controller.jumpToBottom();
    controller.userScroll(true);
    viewport.scrollHeight = 1400;
    controller.refresh(['root', 'user:0', 'llm:1', 'user:2']);
    assert.equal(viewport.scrollTop, 800);
    viewport.scrollTop = 450;
    controller.onScroll();
    controller.refresh(['root', 'user:0', 'llm:1', 'user:2', 'llm:3']);
    assert.equal(viewport.scrollTop, 450);
    assert.deepEqual(controller.getSnapshot(), { following: false, hasNewContent: true });
});

test('manual scrolling back to the bottom resumes following and clears the new-content hint', () => {
    const { viewport, controller } = fixture(100);
    controller.refresh(['root', 'user:0', 'llm:1', 'user:2']);
    controller.userScroll();
    viewport.scrollTop = 799.5;
    controller.onScroll();
    assert.deepEqual(controller.getSnapshot(), { following: true, hasNewContent: false });
    viewport.scrollHeight = 1200;
    controller.refresh(['root', 'user:0', 'llm:1', 'user:2', 'llm:3']);
    assert.equal(viewport.scrollTop, 1000);
});

test('programmatic navigation to the bottom does not accidentally resume following', () => {
    const { viewport, controller } = fixture();
    controller.jumpToBottom();
    controller.userScroll();
    controller.pauseFollowing();
    viewport.scrollTop = 800;
    controller.onScroll();
    viewport.scrollHeight = 1400;
    controller.refresh(['root', 'llm:1', 'llm:3']);
    assert.equal(viewport.scrollTop, 800);
    assert.deepEqual(controller.getSnapshot(), { following: false, hasNewContent: true });
});

test('filtering and expanding reset the visible-row baseline without reporting existing rows as new', () => {
    const { controller } = fixture();
    controller.jumpToBottom();
    controller.resetView(['root', 'user:0', 'llm:1', 'tool:1']);
    controller.refresh(['root', 'user:0', 'llm:1', 'tool:1']);
    assert.deepEqual(controller.getSnapshot(), { following: false, hasNewContent: false });
});

test('payload-only updates and row removal do not create a new-content hint', () => {
    const { controller } = fixture();
    controller.refresh(['root', 'user:0', 'llm:1']);
    controller.refresh(['root', 'llm:1']);
    assert.deepEqual(controller.getSnapshot(), { following: false, hasNewContent: false });
    controller.refresh(['root', 'llm:2']);
    assert.equal(controller.getSnapshot().hasNewContent, true);
});

test('content and viewport resizing keep the bottom pinned only while following', () => {
    const { viewport, controller } = fixture();
    controller.jumpToBottom();
    viewport.clientHeight = 100;
    controller.refresh(['root', 'user:0', 'llm:1']);
    assert.equal(viewport.scrollTop, 900);
    controller.pauseFollowing();
    viewport.scrollHeight = 2000;
    controller.refresh(['root', 'user:0', 'llm:1']);
    assert.equal(viewport.scrollTop, 900);
});

test('short and empty lists remain usable and do not auto-follow on initial render', () => {
    const { viewport, controller } = fixture(0, 80, 200);
    assert.equal(controller.getSnapshot().following, false);
    controller.jumpToBottom();
    assert.equal(viewport.scrollTop, 0);
    controller.refresh([]);
    assert.deepEqual(controller.getSnapshot(), { following: true, hasNewContent: false });
});

test('scrolling down away from the bottom does not resume following prematurely', () => {
    const { viewport, controller } = fixture(100);
    controller.userScroll();
    viewport.scrollTop = 300;
    controller.onScroll();
    assert.equal(controller.getSnapshot().following, false);
    controller.refresh(['root', 'user:0', 'llm:1', 'user:2']);
    assert.equal(viewport.scrollTop, 300);
});

test('scrolling away with a scrollbar pauses following even without a wheel event', () => {
    const { viewport, controller } = fixture();
    controller.jumpToBottom();
    viewport.scrollTop = 200;
    controller.onScroll();
    assert.equal(controller.getSnapshot().following, false);
});

test('subscribers are notified only when the follow state changes and can unsubscribe', () => {
    const { controller } = fixture();
    let notifications = 0;
    const unsubscribe = controller.subscribe(() => { notifications++; });
    const initial = controller.getSnapshot();
    controller.refresh(['root', 'user:0', 'llm:1']);
    controller.onScroll();
    assert.equal(controller.getSnapshot(), initial);
    assert.equal(notifications, 0);
    controller.jumpToBottom();
    assert.equal(notifications, 1);
    unsubscribe();
    controller.pauseFollowing();
    assert.equal(notifications, 1);
});


test('reading another historical Span preserves the unread-content hint until reaching the bottom', () => {
    const { controller } = fixture(100);
    controller.refresh(['root', 'user:0', 'llm:1', 'user:2']);
    controller.pauseFollowing();
    assert.deepEqual(controller.getSnapshot(), { following: false, hasNewContent: true });
    controller.jumpToBottom();
    assert.equal(controller.getSnapshot().hasNewContent, false);
});

test('a data refresh during one scroll gesture still allows reaching the bottom to resume following', () => {
    const { viewport, controller } = fixture(100);
    controller.userScroll();
    viewport.scrollTop = 400;
    controller.onScroll();
    viewport.scrollHeight = 1400;
    controller.refresh(['root', 'user:0', 'llm:1', 'user:2']);
    viewport.scrollTop = 1200;
    controller.onScroll();
    assert.deepEqual(controller.getSnapshot(), { following: true, hasNewContent: false });
});


test('pausing before the observer processes newly committed rows does not swallow unread content', () => {
    const { controller } = fixture();
    controller.pauseFollowing();
    controller.refresh(['root', 'user:0', 'llm:1', 'user:2']);
    assert.equal(controller.getSnapshot().hasNewContent, true);
});

test('an ended user gesture cannot make a later programmatic scroll resume following', () => {
    const { viewport, controller } = fixture(100);
    controller.userScroll();
    viewport.scrollTop = 300;
    controller.onScroll();
    controller.endUserScroll();
    viewport.scrollTop = 800;
    controller.onScroll();
    assert.equal(controller.getSnapshot().following, false);
});

test('a queued bottom-scroll event cannot undo an explicit upward-scroll intent', () => {
    const { controller } = fixture();
    controller.jumpToBottom();
    controller.userScroll(true);
    controller.onScroll();
    assert.equal(controller.getSnapshot().following, false);
});


test('clearing a filter can keep the selected Span at the same viewport offset', () => {
    const anchor = captureSpanScrollAnchor({ top: 200, bottom: 500 }, [
        { key: 'root', top: 200, bottom: 230 },
        { key: 'user:150', top: 238, bottom: 268 },
        { key: 'llm:150', top: 268, bottom: 298 },
    ], 'llm:150');
    assert.deepEqual(anchor, { key: 'llm:150', offset: 68 });
    assert.equal(spanScrollAnchorDelta(anchor!, 200, [{ key: 'llm:150', top: 9208, bottom: 9238 }]), 8940);
});

test('an offscreen remembered Span does not override the current reading position', () => {
    const anchor = captureSpanScrollAnchor({ top: 200, bottom: 500 }, [
        { key: 'old', top: 10, bottom: 40 },
        { key: 'visible', top: 190, bottom: 220 },
        { key: 'next', top: 220, bottom: 250 },
    ], 'old');
    assert.deepEqual(anchor, { key: 'visible', offset: -10 });
});

test('empty views and removed anchors do not force a new scroll position', () => {
    assert.equal(captureSpanScrollAnchor({ top: 200, bottom: 500 }, [], null), null);
    assert.equal(spanScrollAnchorDelta({ key: 'gone', offset: 50 }, 200, [{ key: 'other', top: 200, bottom: 230 }]), null);
});

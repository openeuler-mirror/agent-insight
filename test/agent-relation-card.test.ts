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
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentRelationCard } from '@/components/observe/AgentRelationCard';
import { ParentAgentCard } from '@/components/observe/ParentAgentCard';

const stats = { durationMs: 276000, totalTokens: 1255599 };
const props = { agentName: 'Pi', stats, durationBasisMs: stats.durationMs, label: '打开父 Agent 的 Trace' };

test('relation card has a single native button for both the body and Trace label', () => {
    let navigated = 0, selected = 0;
    const element = AgentRelationCard({ ...props, onNavigate: () => { navigated++; }, onSelect: () => { selected++; } }) as ReactElement<{ onClick: () => void }>;
    assert.equal(element.type, 'button');
    element.props.onClick();
    assert.equal(navigated, 1);
    assert.equal(selected, 0, 'standalone Trace navigation must take precedence over tree selection');
    const html = renderToStaticMarkup(element);
    assert.equal((html.match(/<button\b/g) || []).length, 1, 'no nested buttons with competing handlers');
    assert.match(html, /Trace/);
});
test('parent and child cards share duration, token, slow color and bar layout with no footer', () => {
    const parent = renderToStaticMarkup(createElement(ParentAgentCard, {
        parent: { state: 'resolved', taskId: 'parent', agentName: 'Pi', stats }, onNavigate: () => {}, locale: 'zh',
    }));
    for (const value of ['4m 36s', '1,255,599', 'bg-warning', 'width:100%']) assert.ok(parent.includes(value), value);
    assert.doesNotMatch(parent, /自身 Tokens|以父 Agent|为基准/);
    const child = renderToStaticMarkup(createElement(AgentRelationCard, { ...props, stats: { durationMs: 180000, totalTokens: 211227 } }));
    assert.match(child, /211,227/);
    assert.match(child, /width:65\./);
});
test('missing metrics do not become zero or a false completed bar; real zeros remain visible', () => {
    const missing = renderToStaticMarkup(createElement(AgentRelationCard, { ...props, stats: undefined }));
    assert.match(missing, /—/);
    assert.doesNotMatch(missing, /width:|bg-warning/);
    const zeros = renderToStaticMarkup(createElement(AgentRelationCard, { ...props, stats: { durationMs: 0, totalTokens: 0 } }));
    assert.match(zeros, /0ms/);
    assert.match(zeros, /width:0%/);
    const invalid = renderToStaticMarkup(createElement(AgentRelationCard, { ...props, stats: { durationMs: NaN, totalTokens: -1 } }));
    assert.doesNotMatch(invalid, /NaN|>-1<|width:/);
});
test('Agent without a standalone session keeps in-tree selection and does not advertise Trace navigation', () => {
    let selected = false;
    const element = AgentRelationCard({ ...props, onSelect: () => { selected = true; }, label: '选择 Agent' }) as ReactElement<{ onClick: () => void }>;
    element.props.onClick();
    assert.equal(selected, true);
    assert.doesNotMatch(renderToStaticMarkup(element), />Trace</);
});

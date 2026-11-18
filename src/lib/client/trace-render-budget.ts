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

/**
 * 超大型 Trace 的渲染预算。
 *
 * 五百次以上模型调用的 Trace 若一次性铺满调用树，首屏与节点切换都会被 DOM
 * 数量拖慢；大文本则主要卡在 JSON/Markdown 的解析与布局上。这里只限制
 * 「一次渲染多少」，不改变数据本身：继续加载和「查看全部」始终能回到完整原文。
 */

/** 单次渲染的顶层事件行数；继续加载时按同样步长追加。 */
export const TRACE_EVENT_RENDER_BATCH = 120;

/** 详情面板内联预览的字符上限；超过部分通过「查看全部」读取。 */
export const TRACE_INLINE_PREVIEW_CHARS = 20_000;

/** 折叠块（DisclosureBar）展开后内联渲染的字符上限。 */
export const TRACE_DISCLOSURE_PREVIEW_CHARS = 8_000;

export interface TextPreview {
    text: string;
    truncated: boolean;
    totalChars: number;
}

export function truncateForPreview(text: string, maxChars: number): TextPreview {
    const totalChars = text.length;
    if (maxChars <= 0 || totalChars <= maxChars) {
        return { text, truncated: false, totalChars };
    }
    // 不要从代理对中间切开，否则预览尾部会出现半个字符。
    let end = maxChars;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    return { text: text.slice(0, end), truncated: true, totalChars };
}

/**
 * 当前应渲染的顶层事件行数。
 *
 * @param rootEventIndexes 顶层事件行在所属 agent `events` 中的下标，按渲染顺序排列。
 * @param requested 用户已请求的批次上限。
 * @param options.revealAll 搜索时需要匹配全部行，跳过批次限制。
 * @param options.revealThrough 选中的事件下标；不在当前批次内时自动扩展到包含它的那一行。
 */
export function resolveEventRenderCount(
    rootEventIndexes: ReadonlyArray<number>,
    requested: number,
    options: { revealAll?: boolean; revealThrough?: number | null } = {},
): number {
    const total = rootEventIndexes.length;
    if (total === 0) return 0;
    if (options.revealAll) return total;

    let count = Math.min(total, Math.max(1, Math.trunc(requested) || 1));
    const through = options.revealThrough;
    if (through != null && Number.isFinite(through) && through >= 0) {
        const position = rootEventIndexes.findIndex(index => index >= through);
        const needed = position < 0 ? total : position + 1;
        if (needed > count) count = Math.min(total, needed);
    }
    return count;
}

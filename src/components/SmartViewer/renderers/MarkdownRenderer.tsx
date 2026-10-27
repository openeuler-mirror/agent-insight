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

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeRenderer } from './CodeRenderer';

interface Props {
    text: string;
    theme?: 'light' | 'dark';
}

export function MarkdownRenderer({ text, theme }: Props) {
    return (
        <div className="sv-markdown">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    code(props) {
                        const { children, className } = props;
                        const match = /language-(\w+)/.exec(className || '');
                        const codeText = String(children).replace(/\n$/, '');
                        const isBlock = codeText.includes('\n') || !!match;
                        if (!isBlock) {
                            return <code className="sv-inline-code">{children}</code>;
                        }
                        return <CodeRenderer code={codeText} lang={match?.[1] || 'bash'} theme={theme} />;
                    },
                    // Trace/agent content often contains markdown like `![](url)` where
                    // url is empty (compaction summaries, tool outputs, doc snippets).
                    // ReactMarkdown's default would emit `<img src="">`, which Next.js
                    // warns about because the empty src refetches the current page.
                    // Render a tiny placeholder for those instead of nothing, so the
                    // alt text isn't silently dropped.
                    img(props) {
                        const { src, alt } = props as { src?: string | null; alt?: string };
                        const safeSrc = typeof src === 'string' ? src.trim() : '';
                        if (!safeSrc) {
                            return alt ? <span className="sv-img-fallback">[image: {alt}]</span> : null;
                        }
                        // eslint-disable-next-line @next/next/no-img-element
                        return <img src={safeSrc} alt={alt || ''} loading="lazy" />;
                    },
                }}
            >
                {text}
            </ReactMarkdown>
        </div>
    );
}

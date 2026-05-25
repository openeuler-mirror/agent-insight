'use client';

import { useMemo, useState } from 'react';
import { detect } from './detector';
import { unescapeText } from './unescape';
import { CodeRenderer } from './renderers/CodeRenderer';
import { JsonRenderer } from './renderers/JsonRenderer';
import { MarkdownRenderer } from './renderers/MarkdownRenderer';
import { PlainRenderer } from './renderers/PlainRenderer';
import './styles.css';

export interface SmartViewerProps {
    text: string;
    type?: 'json' | 'markdown' | 'code' | 'plain';
    lang?: string;
    unescape?: boolean;
    theme?: 'light' | 'dark';
    toolbar?: boolean;
    maxHeight?: number | string;
    className?: string;
}

export function SmartViewer({
    text,
    type,
    lang,
    unescape = true,
    theme = 'light',
    toolbar = true,
    maxHeight = 500,
    className,
}: SmartViewerProps) {
    const [copied, setCopied] = useState(false);

    const processed = useMemo(
        () => (unescape ? unescapeText(text) : text),
        [text, unescape],
    );

    const detected = useMemo(() => {
        if (type === 'code' && lang) return { kind: 'code' as const, lang };
        if (type === 'plain') return { kind: 'plain' as const };
        return detect(processed, type);
    }, [processed, type, lang]);

    const onCopy = async () => {
        try {
            await navigator.clipboard.writeText(processed);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch { }
    };

    const kindLabel = detected.kind === 'code' ? (detected as any).lang : detected.kind;

    return (
        <div
            className={`sv-root sv-theme-${theme}${className ? ' ' + className : ''}`}
            style={{ maxHeight }}
        >
            {toolbar && (
                <div className="sv-toolbar">
                    <span className="sv-badge">{kindLabel}</span>
                    <button className="sv-copy" onClick={onCopy}>
                        {copied ? '✓ Copied' : 'Copy'}
                    </button>
                </div>
            )}
            <div className="sv-body">
                {detected.kind === 'json' && (
                    <JsonRenderer data={detected.data} theme={theme} />
                )}
                {detected.kind === 'markdown' && (
                    <MarkdownRenderer text={processed} theme={theme} />
                )}
                {detected.kind === 'code' && (
                    <CodeRenderer code={processed} lang={detected.lang} theme={theme} />
                )}
                {detected.kind === 'plain' && <PlainRenderer text={processed} />}
            </div>
        </div>
    );
}

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
                }}
            >
                {text}
            </ReactMarkdown>
        </div>
    );
}

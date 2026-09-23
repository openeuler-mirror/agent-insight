'use client';

import JsonView from 'react18-json-view';
import 'react18-json-view/src/style.css';

interface Props {
    data: unknown;
    theme?: 'light' | 'dark';
    collapsed?: boolean | number;
    fullContent?: boolean;
}

export function JsonRenderer({ data, theme = 'light', collapsed = 2, fullContent = false }: Props) {
    const isDark = theme === 'dark';
    return (
        <div className="sv-json">
            <JsonView
                src={data as object}
                collapsed={fullContent ? false : collapsed}
                collapseStringsAfterLength={fullContent ? Infinity : undefined}
                ignoreLargeArray={fullContent}
                theme={isDark ? 'vscode' : 'default'}
                dark={isDark}
            />
        </div>
    );
}

'use client';

import JsonView from 'react18-json-view';
import 'react18-json-view/src/style.css';

interface Props {
    data: unknown;
    theme?: 'light' | 'dark';
}

export function JsonRenderer({ data, theme = 'light' }: Props) {
    const isDark = theme === 'dark';
    return (
        <div className="sv-json">
            <JsonView
                src={data as object}
                collapsed={2}
                theme={isDark ? 'vscode' : 'default'}
                dark={isDark}
            />
        </div>
    );
}

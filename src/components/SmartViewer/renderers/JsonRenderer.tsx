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

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

import type { AnchorHTMLAttributes, HTMLAttributes, PropsWithChildren } from 'react';

export function Sources({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
    return (
        <div className={`ae-sources ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function SourcesList({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLUListElement>>) {
    return (
        <ul className={`ae-sources-list ${className}`.trim()} {...props}>
            {children}
        </ul>
    );
}

export function SourcesItem({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLLIElement>>) {
    return (
        <li className={`ae-sources-item ${className}`.trim()} {...props}>
            {children}
        </li>
    );
}

export function SourcesLink({ className = '', children, ...props }: PropsWithChildren<AnchorHTMLAttributes<HTMLAnchorElement>>) {
    return (
        <a className={`ae-sources-link ${className}`.trim()} target="_blank" rel="noreferrer" {...props}>
            {children}
        </a>
    );
}

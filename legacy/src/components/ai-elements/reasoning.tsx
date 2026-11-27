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

import type { DetailsHTMLAttributes, HTMLAttributes, PropsWithChildren } from 'react';

type ReasoningProps = PropsWithChildren<DetailsHTMLAttributes<HTMLDetailsElement>>;

export function Reasoning({ className = '', children, ...props }: ReasoningProps) {
    return (
        <details className={`ae-reasoning ${className}`.trim()} {...props}>
            {children}
        </details>
    );
}

export function ReasoningTrigger({ className = '', children, ...props }: HTMLAttributes<HTMLElement>) {
    return (
        <summary className={`ae-reasoning-trigger ${className}`.trim()} {...props}>
            {children}
        </summary>
    );
}

export function ReasoningContent({ className = '', children, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div className={`ae-reasoning-content ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

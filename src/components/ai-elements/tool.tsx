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

import type { ButtonHTMLAttributes, HTMLAttributes, PropsWithChildren } from 'react';

type ToolProps = PropsWithChildren<HTMLAttributes<HTMLDivElement>>;

export function Tool({ className = '', children, ...props }: ToolProps) {
    return (
        <div className={`ae-tool ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function ToolHeader({ className = '', children, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div className={`ae-tool-header ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function ToolTitle({ className = '', children, ...props }: HTMLAttributes<HTMLSpanElement>) {
    return (
        <span className={`ae-tool-title ${className}`.trim()} {...props}>
            {children}
        </span>
    );
}

export function ToolTrigger({ className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
        <button type="button" className={`ae-tool-trigger ${className}`.trim()} {...props}>
            {children}
        </button>
    );
}

export function ToolInput({ className = '', children, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div className={`ae-tool-input ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

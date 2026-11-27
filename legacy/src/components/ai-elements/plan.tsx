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

import type { HTMLAttributes, PropsWithChildren } from 'react';

type PlanProps = PropsWithChildren<HTMLAttributes<HTMLDivElement>>;

type PlanItemProps = PropsWithChildren<
    HTMLAttributes<HTMLLIElement> & {
        status?: 'completed' | 'active' | 'pending' | string;
    }
>;

export function Plan({ className = '', children, ...props }: PlanProps) {
    return (
        <div className={`ae-plan ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function PlanHeader({ className = '', children, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div className={`ae-plan-header ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function PlanTitle({ className = '', children, ...props }: HTMLAttributes<HTMLSpanElement>) {
    return (
        <span className={`ae-plan-title ${className}`.trim()} {...props}>
            {children}
        </span>
    );
}

export function PlanList({ className = '', children, ...props }: HTMLAttributes<HTMLOListElement>) {
    return (
        <ol className={`ae-plan-list ${className}`.trim()} {...props}>
            {children}
        </ol>
    );
}

export function PlanItem({ status = 'pending', className = '', children, ...props }: PlanItemProps) {
    const normalized = status.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    return (
        <li className={`ae-plan-item ae-plan-item-${normalized} ${className}`.trim()} {...props}>
            {children}
        </li>
    );
}

export function PlanItemText({ className = '', children, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div className={`ae-plan-item-text ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

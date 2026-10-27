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

type QueueItemProps = PropsWithChildren<
    HTMLAttributes<HTMLDivElement> & {
        state?: 'queued' | 'running' | 'completed' | 'failed' | string;
    }
>;

export function Queue({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
    return (
        <div className={`ae-queue ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function QueueItem({ state = 'queued', className = '', children, ...props }: QueueItemProps) {
    const normalized = state.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    return (
        <div className={`ae-queue-item ae-queue-item-${normalized} ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

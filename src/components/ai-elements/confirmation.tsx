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

import type { ButtonHTMLAttributes, DialogHTMLAttributes, HTMLAttributes, PropsWithChildren } from 'react';

export function Confirmation({ className = '', children, open, ...props }: PropsWithChildren<DialogHTMLAttributes<HTMLDialogElement>>) {
    return (
        <dialog open={open} className={`ae-confirmation ${className}`.trim()} {...props}>
            {children}
        </dialog>
    );
}

export function ConfirmationBody({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
    return (
        <div className={`ae-confirmation-body ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function ConfirmationActions({ className = '', children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
    return (
        <div className={`ae-confirmation-actions ${className}`.trim()} {...props}>
            {children}
        </div>
    );
}

export function ConfirmationAction({ className = '', children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) {
    return (
        <button type="button" className={`ae-confirmation-action ${className}`.trim()} {...props}>
            {children}
        </button>
    );
}

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

export type VersionWorkspaceTabKey = 'analysis' | 'management';

export interface VersionWorkspaceTab {
    key: VersionWorkspaceTabKey;
    href: string;
    labelKey: string;
    matchPrefixes: string[];
}

export const VERSION_WORKSPACE_TABS: VersionWorkspaceTab[] = [
    {
        key: 'analysis',
        href: '/version-analysis',
        labelKey: 'nav.versionAnalysis',
        matchPrefixes: ['/version-analysis'],
    },
    {
        key: 'management',
        href: '/version-management',
        labelKey: 'nav.versionManagement',
        matchPrefixes: ['/version-management'],
    },
];

export function getActiveVersionWorkspaceTab(
    pathname: string,
    basePath = '',
): VersionWorkspaceTabKey | null {
    const current = basePath && pathname.startsWith(basePath)
        ? pathname.slice(basePath.length) || '/'
        : pathname;
    const active = VERSION_WORKSPACE_TABS.find(tab =>
        tab.matchPrefixes.some(prefix => current === prefix || current.startsWith(`${prefix}/`)),
    );
    return active?.key ?? null;
}

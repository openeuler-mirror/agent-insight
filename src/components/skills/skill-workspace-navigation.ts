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

export type SkillWorkspaceTabKey = 'hub' | 'generate' | 'evaluate' | 'optimize';

export interface SkillWorkspaceTab {
    key: SkillWorkspaceTabKey;
    href: string;
    labelKey: string;
    matchPrefixes: string[];
}

export const SKILL_WORKSPACE_TABS: SkillWorkspaceTab[] = [
    {
        key: 'hub',
        href: '/skills',
        labelKey: 'nav.skillWorkspaceHub',
        matchPrefixes: ['/skills', '/skill-history', '/skill-detail'],
    },
    {
        key: 'generate',
        href: '/skill-generator',
        labelKey: 'nav.skillWorkspaceGenerate',
        matchPrefixes: ['/skill-generator'],
    },
    {
        key: 'evaluate',
        href: '/skill-eval',
        labelKey: 'nav.skillWorkspaceEvaluate',
        matchPrefixes: ['/skill-eval'],
    },
    {
        key: 'optimize',
        href: '/skill-opt',
        labelKey: 'nav.skillWorkspaceOptimize',
        matchPrefixes: ['/skill-opt'],
    },
];

export function getActiveSkillWorkspaceTab(
    pathname: string,
    basePath = '',
): SkillWorkspaceTabKey | null {
    const current = basePath && pathname.startsWith(basePath)
        ? pathname.slice(basePath.length) || '/'
        : pathname;
    const active = SKILL_WORKSPACE_TABS.find(tab =>
        tab.matchPrefixes.some(prefix => current === prefix || current.startsWith(`${prefix}/`)),
    );
    return active?.key ?? null;
}

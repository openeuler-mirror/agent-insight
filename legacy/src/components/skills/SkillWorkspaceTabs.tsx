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

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale } from '@/lib/client/locale-context';
import {
    getActiveSkillWorkspaceTab,
    SKILL_WORKSPACE_TABS,
} from './skill-workspace-navigation';

const basePath = process.env.NEXT_PUBLIC_URL_PREFIX || '';

export function SkillWorkspaceTabs() {
    const pathname = usePathname() || '/';
    const { t } = useLocale();
    const activeTab = getActiveSkillWorkspaceTab(pathname, basePath);

    return (
        <nav
            aria-label={t('nav.skillWorkspace')}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                minHeight: 42,
                padding: '0 20px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--card-bg)',
                flexShrink: 0,
                overflowX: 'auto',
                whiteSpace: 'nowrap',
            }}
        >
            {SKILL_WORKSPACE_TABS.map(tab => {
                const active = activeTab === tab.key;
                return (
                    <Link
                        key={tab.key}
                        href={tab.href}
                        prefetch={false}
                        aria-current={active ? 'page' : undefined}
                        style={{
                            position: 'relative',
                            display: 'inline-flex',
                            alignItems: 'center',
                            height: 42,
                            padding: '0 14px',
                            color: active ? 'var(--primary)' : 'var(--foreground-secondary)',
                            fontSize: 12,
                            fontWeight: active ? 600 : 500,
                            textDecoration: 'none',
                            transition: 'color 120ms ease',
                        }}
                    >
                        {t(tab.labelKey)}
                        {active && (
                            <span
                                aria-hidden="true"
                                style={{
                                    position: 'absolute',
                                    right: 10,
                                    bottom: -1,
                                    left: 10,
                                    height: 2,
                                    borderRadius: '2px 2px 0 0',
                                    background: 'var(--primary)',
                                }}
                            />
                        )}
                    </Link>
                );
            })}
        </nav>
    );
}

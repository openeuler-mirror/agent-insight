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

import { ComingSoon } from '@/components/primitives/ComingSoon';
import { useLocale } from '@/lib/client/locale-context';

export default function SecurityPage() {
    const { t, locale } = useLocale();
    return (
        <ComingSoon
            title={t('nav.security')}
            tagline={
                locale === 'zh'
                    ? '安全设计：Agent 输入输出风险评估、敏感信息泄漏检测、Prompt 注入防护与策略管理。'
                    : 'Security: Agent I/O risk assessment, PII detection, prompt-injection defense, policy management.'
            }
            capabilities={[
                { label: locale === 'zh' ? '风险评估' : 'Risk assessment', desc: locale === 'zh' ? '自动扫描 Agent 输出敏感内容' : 'Auto-scan agent output for sensitive content' },
                { label: locale === 'zh' ? '注入防护' : 'Injection defense', desc: locale === 'zh' ? 'Prompt 注入检测与拦截' : 'Detect and block prompt injection' },
                { label: locale === 'zh' ? '策略管理' : 'Policy management', desc: locale === 'zh' ? '统一安全合规策略下发' : 'Centralized compliance policy push' },
            ]}
        />
    );
}

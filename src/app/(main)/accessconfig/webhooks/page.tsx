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

export default function AccessWebhooksPage() {
    const { t, locale } = useLocale();
    return (
        <ComingSoon
            title={t('nav.accessWebhooks')}
            tagline={
                locale === 'zh'
                    ? '配置 Webhook 入口与回调路由：签名校验、路由规则、重试与限流策略。'
                    : 'Configure webhook ingress and callback routing: signature verification, routing rules, retry & rate-limit policy.'
            }
            capabilities={[
                { label: locale === 'zh' ? '签名校验' : 'Signature verification' },
                { label: locale === 'zh' ? '路由规则' : 'Routing rules' },
                { label: locale === 'zh' ? '重试与限流' : 'Retry & rate-limit' },
            ]}
        />
    );
}

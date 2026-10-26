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

export default function AccessChannelsPage() {
    const { t, locale } = useLocale();
    return (
        <ComingSoon
            title={t('nav.accessChannels')}
            tagline={
                locale === 'zh'
                    ? '注册并管理 Agent 接入渠道：钉钉、企业微信、Slack、自定义 IM/API。'
                    : 'Register and manage agent ingress channels: DingTalk, WeCom, Slack, custom IM/API.'
            }
            capabilities={[
                { label: locale === 'zh' ? '钉钉 / 企业微信' : 'DingTalk / WeCom' },
                { label: locale === 'zh' ? 'Slack / 自定义 IM' : 'Slack / Custom IM' },
                { label: locale === 'zh' ? '通用 API 接入' : 'Generic API ingress' },
            ]}
        />
    );
}

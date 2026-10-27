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

export default function AccessHealthPage() {
    const { t, locale } = useLocale();
    return (
        <ComingSoon
            title={t('nav.accessHealth')}
            tagline={
                locale === 'zh'
                    ? '渠道健康检查：连通性探测、延迟监控、失败告警与历史可用性。'
                    : 'Channel health checks: connectivity probes, latency monitoring, failure alerts and uptime history.'
            }
            capabilities={[
                { label: locale === 'zh' ? '连通性探测' : 'Connectivity probes' },
                { label: locale === 'zh' ? '延迟与失败率' : 'Latency & failure rate' },
                { label: locale === 'zh' ? '可用性历史' : 'Uptime history' },
            ]}
        />
    );
}

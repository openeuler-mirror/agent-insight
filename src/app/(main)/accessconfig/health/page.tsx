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

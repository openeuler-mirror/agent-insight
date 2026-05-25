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

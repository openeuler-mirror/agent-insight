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

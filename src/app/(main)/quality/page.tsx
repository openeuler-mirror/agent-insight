'use client';

import { ComingSoon } from '@/components/primitives/ComingSoon';
import { useLocale } from '@/lib/client/locale-context';

export default function QualityPage() {
    const { t, locale } = useLocale();
    return (
        <ComingSoon
            title={t('nav.quality')}
            tagline={
                locale === 'zh'
                    ? 'Agent 版本质量门禁：跨版本对比、回归基线检测、CI/CD 拦截。依赖 Agent 版本管理（Agent 管理）模块就绪。'
                    : 'Agent version quality gate: cross-version comparison, regression baseline, CI/CD blocking. Depends on the Agents module.'
            }
            capabilities={[
                { label: locale === 'zh' ? '版本对比' : 'Version compare', desc: locale === 'zh' ? 'v2.1 vs v2.0 等' : 'e.g. v2.1 vs v2.0' },
                { label: locale === 'zh' ? '劣化 case 列表' : 'Regressed cases', desc: locale === 'zh' ? '版本切换后下降的样例' : 'Cases that regressed after rollout' },
                { label: locale === 'zh' ? 'Quality Gate' : 'Quality Gate', desc: locale === 'zh' ? 'CI 中阻塞低质量版本' : 'Block low-quality builds in CI' },
            ]}
        />
    );
}

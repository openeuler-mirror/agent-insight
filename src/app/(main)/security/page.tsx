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

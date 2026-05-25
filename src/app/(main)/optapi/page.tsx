'use client';

import { ComingSoon } from '@/components/primitives/ComingSoon';
import { useLocale } from '@/lib/client/locale-context';

export default function OptApiPage() {
    const { t, locale } = useLocale();
    return (
        <ComingSoon
            title={t('nav.optapi')}
            tagline={
                locale === 'zh'
                    ? '运行时为 Agent 推荐最优执行路径的 API：基于历史 Trace 沉淀路径库，按 task_type + context 返回参考路径。属于产品远期能力。'
                    : 'Runtime API recommending optimal execution paths to Agents based on historical trace patterns. A roadmap capability.'
            }
            capabilities={[
                { label: 'GET /api/v1/optimal-paths', desc: locale === 'zh' ? '按 task_type + context 推荐执行路径' : 'Recommend paths by task_type + context' },
                { label: locale === 'zh' ? '路径库沉淀' : 'Path library', desc: locale === 'zh' ? '从成功 Trace 中抽取最优路径' : 'Extract optimal paths from successful traces' },
                { label: locale === 'zh' ? '效率提升度量' : 'Efficiency lift', desc: locale === 'zh' ? 'Agent 接入前后对比' : 'Pre/post-integration comparison' },
            ]}
        />
    );
}

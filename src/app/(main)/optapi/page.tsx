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

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

export default function SkillReleasePage() {
    const { t, locale } = useLocale();
    return (
        <ComingSoon
            title={t('nav.skillRelease')}
            tagline={
                locale === 'zh'
                    ? '完整 Skill 发布流水线：审批、灰度、回滚、版本 diff。当前已具备 skill-sync 同步链路，但审批与回滚状态机尚未就绪。'
                    : 'Skill release pipeline: approval, canary, rollback, version diff. The skill-sync sync link exists, but the approval/rollback state machine is not yet ready.'
            }
            capabilities={[
                { label: locale === 'zh' ? '审批流' : 'Approval flow' },
                { label: locale === 'zh' ? '版本 diff 查看' : 'Version diff' },
                { label: locale === 'zh' ? '回滚记录' : 'Rollback history' },
            ]}
        />
    );
}

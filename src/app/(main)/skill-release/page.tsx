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

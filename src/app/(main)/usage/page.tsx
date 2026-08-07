'use client';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { UsageOverview } from '@/components/usage/UsageOverview';
import { useUsageAccess } from '@/lib/usage-analytics/use-usage-access';

export default function UsagePage() {
    const access = useUsageAccess();

    if (access.loading) return null;

    // 页面自身也做闸 —— 隐藏菜单不等于挡住直接输地址栏。
    if (!access.enabled || !access.isAdmin) {
        return (
            <>
                <AppTopBar title="用量统计" />
                <div style={{ padding: 32, color: 'var(--foreground-muted)', fontSize: 'var(--text-sm)' }}>
                    没有访问权限。平台用量统计仅对部署环境变量 <code>AGENT_INSIGHT_ADMIN_USERS</code> 中显式配置的平台管理员开放。
                </div>
            </>
        );
    }

    return (
        <>
            <AppTopBar title="用量统计" />
            <div style={{ flex: 1, overflowY: 'auto' }}>
                <UsageOverview />
            </div>
        </>
    );
}

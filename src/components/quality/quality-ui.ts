// 质量监控前端共享：状态 → 颜色/徽章 映射（纯函数，无 hook）。
import type { StatusKind } from '@/components/feedback/StatusBadge';
import type { QualityStatus, Severity, Attribution } from '@/lib/engine/quality-monitoring/types';

export function statusToKind(status: QualityStatus): StatusKind {
    return status === '达标' ? 'success' : status === '关注' ? 'warning' : 'error';
}

/** 分数 → 语义色（与状态阈值一致：≥85 绿 / ≥70 黄 / <70 红）。 */
export function scoreColor(score: number): string {
    if (score >= 85) return 'var(--success)';
    if (score >= 70) return 'var(--warning)';
    return 'var(--error)';
}

export function statusColor(status: QualityStatus): string {
    return status === '达标' ? 'var(--success)' : status === '关注' ? 'var(--warning)' : 'var(--error)';
}

export function severityColor(sev: Severity): string {
    return sev === 'high' ? 'var(--error)' : sev === 'medium' ? 'var(--warning)' : 'var(--foreground-muted)';
}

export const ATTR_COLOR: Record<Attribution, { bg: string; fg: string }> = {
    'agent逻辑': { bg: 'var(--primary-subtle)', fg: 'var(--primary)' },
    '模型能力': { bg: 'color-mix(in srgb, var(--primary) 10%, transparent)', fg: 'var(--primary)' },
    '工具&infra': { bg: 'var(--warning-subtle)', fg: 'var(--warning)' },
    '外部输入': { bg: 'var(--success-subtle)', fg: 'var(--success)' },
};

export function fmtNum(n: number | null | undefined, digits = 1): string {
    if (n == null || !Number.isFinite(n)) return '—';
    return (Math.round(n * 10 ** digits) / 10 ** digits).toString();
}

/** agent-debug 认知模块 → 展示标签与配色（与智能诊断模块口径一致）。 */
export const MODULE_LABEL: Record<string, string> = {
    planning: 'Planning·规划',
    action: 'Action·执行',
    memory: 'Memory·记忆',
    reflection: 'Reflection·反思',
    system: 'System·环境',
    others: '其他',
};
export const MODULE_COLORS = ['var(--primary)', 'var(--warning)', '#2c6bd1', 'var(--success)', 'var(--foreground-muted)', 'var(--error)'];

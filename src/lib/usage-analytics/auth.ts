import { resolveUser } from '@/lib/auth/auth';
import { isUsageEnabled } from './config';

/**
 * 用量统计专用的 fail-closed 管理员判定。
 *
 * 与 `isAdminUser()` 的区别：那个在 AGENT_INSIGHT_ADMIN_USERS 未配置时回退 ['admin']，
 * 本函数要求显式非空配置，未配置则任何人都不是管理员（SR-002 / AC-002）。
 * 不改动 isAdminUser 以免影响模型单价等既有功能。
 */
export function getUsageAdminUsers(): string[] {
    const raw = process.env.AGENT_INSIGHT_ADMIN_USERS || '';
    return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
}

export function isUsageAdmin(username: string | null | undefined): boolean {
    if (!username) return false;
    const admins = getUsageAdminUsers();
    if (!admins.length) return false;
    return admins.includes(username);
}

export interface UsageAdminGate {
    ok: boolean;
    username: string | null;
    reason?: 'disabled' | 'unauthenticated' | 'forbidden';
}

/**
 * 管理 API 权限闸。身份只从 API Key 解析 —— 绝不传 explicitUser，
 * 否则 `?user=admin` 就能伪造管理员（NFR-006 / AC-001）。
 */
export async function gateUsageAdmin(request: Request): Promise<UsageAdminGate> {
    if (!isUsageEnabled()) return { ok: false, username: null, reason: 'disabled' };

    const { username } = await resolveUser(request);
    if (!username) return { ok: false, username: null, reason: 'unauthenticated' };
    if (!isUsageAdmin(username)) return { ok: false, username, reason: 'forbidden' };
    return { ok: true, username };
}

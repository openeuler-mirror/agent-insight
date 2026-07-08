// 平台管理员判定（当前平台无角色体系，用部署级 env 白名单充当权限闸）。
// AGENT_INSIGHT_ADMIN_USERS="admin,alice@x.com" —— 逗号分隔的用户名白名单。
// 未配置时默认仅平台默认账号 `admin` 为管理员（沿用"只有能碰服务端的人可改全局配置"的治理模型）。
export function getAdminUsers(): string[] {
    const raw = process.env.AGENT_INSIGHT_ADMIN_USERS || '';
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return list.length ? list : ['admin'];
}

export function isAdminUser(username: string | null | undefined): boolean {
    if (!username) return false;
    return getAdminUsers().includes(username);
}

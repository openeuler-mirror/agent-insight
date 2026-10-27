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

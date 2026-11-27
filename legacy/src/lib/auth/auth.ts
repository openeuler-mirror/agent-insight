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


import { db } from '@/lib/storage/prisma';
import { NextRequest } from 'next/server';

export interface AuthResult {
    username: string | null;
    apiKey: string | null;
}

export async function resolveUser(
    request: NextRequest | Request,
    explicitUser?: string | null
): Promise<AuthResult> {
    const requestedUser = explicitUser?.trim() || null;
    const headerApiKey = request.headers.get('x-witty-api-key')?.trim();
    if (headerApiKey) {
        const user = await lookupUserByApiKey(headerApiKey);
        return user && (!requestedUser || user === requestedUser)
            ? { username: user, apiKey: headerApiKey }
            : { username: null, apiKey: null };
    }

    const url = new URL(request.url);
    const queryApiKey = url.searchParams.get('apiKey')?.trim();
    if (queryApiKey) {
        const user = await lookupUserByApiKey(queryApiKey);
        return user && (!requestedUser || user === requestedUser)
            ? { username: user, apiKey: queryApiKey }
            : { username: null, apiKey: null };
    }

    return { username: null, apiKey: null };
}

async function lookupUserByApiKey(apiKey: string): Promise<string | null> {
    try {
        const user = await db.findUserByApiKey(apiKey);
        return user?.username || null;
    } catch (e) {
        console.error('[Auth] Failed to lookup user by API Key:', e);
        return null;
    }
}

export async function canAccessSkill(
    skillId: string,
    username: string | null
): Promise<{ allowed: boolean; skill: any }> {
    const skill: any = await db.findSkillById(skillId);
    
    if (!skill) {
        return { allowed: false, skill: null };
    }

    if (skill.visibility === 'public') {
        return { allowed: true, skill };
    }

    if (username && skill.user === username) {
        return { allowed: true, skill };
    }

    if (!skill.user) {
        return { allowed: true, skill };
    }

    return { allowed: false, skill };
}

export async function canManageSkill(
    skillId: string,
    username: string | null
): Promise<{ allowed: boolean; skill: any }> {
    const skill: any = await db.findSkillById(skillId);
    const canManageSystemSkill = Boolean(
        username
        && !skill?.user
        && isPlatformAdmin(username)
    );
    return {
        allowed: Boolean(username && (skill?.user === username || canManageSystemSkill)),
        skill,
    };
}

export function isPlatformAdmin(username: string | null | undefined): boolean {
    if (!username) return false;
    const admins = (process.env.AGENT_INSIGHT_ADMIN_USERS || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    return (admins.length ? admins : ['admin']).includes(username);
}

export function skillVisibilityWhere(username: string | null) {
    return {
        OR: [
            ...(username ? [{ user: username }] : []),
            { user: null },
            { visibility: 'public' },
        ],
    };
}

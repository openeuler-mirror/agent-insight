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

import { NextResponse } from 'next/server';
import { db } from '@/lib/storage/prisma';
import { resolveLoginMode } from '@/lib/auth/login-mode';
import { resolveAdminUser } from '@/lib/auth/admin';
import { normalizeAccountUsername } from '@/lib/auth/local-user';
import { hashPassword, validatePasswordPolicy } from '@/lib/auth/password';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(
    request: Request,
    { params }: { params: Promise<{ username: string }> },
) {
    if (resolveLoginMode() !== 'standalone') {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const { username: adminUsername, isAdmin } = await resolveAdminUser(request);
    if (!adminUsername) {
        return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    if (!isAdmin) {
        return NextResponse.json({ error: 'Admin permission required' }, { status: 403 });
    }

    const { username: rawUsername } = await params;
    const username = normalizeAccountUsername(rawUsername);
    const user = username ? await db.findUserByUsername(username) : null;
    if (!user) {
        return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // 重置即由管理员直接设置新密码：旧密码立即失效，不用等对方下次登录。
    const body: any = await request.json().catch(() => ({}));
    const password = typeof body?.password === 'string' ? body.password : '';
    const policyError = validatePasswordPolicy(password, username);
    if (policyError) {
        return NextResponse.json({ error: policyError }, { status: 400, headers: NO_STORE });
    }

    await db.updateUserPassword(username, {
        passwordHash: await hashPassword(password),
        passwordUpdatedAt: new Date(),
        // 管理员知道新密码，用户下次登录后仍需自行修改。
        mustChangePassword: true,
    });

    return NextResponse.json({ username }, { headers: NO_STORE });
}

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
import { resolveUser } from '@/lib/auth/auth';
import { isAdminUser } from '@/lib/auth/admin';
import { resolveLoginMode } from '@/lib/auth/login-mode';
import { hashPassword, validatePasswordPolicy, verifyPassword } from '@/lib/auth/password';
import { verifyPasswordSetupToken } from '@/lib/auth/password-setup-token';

export async function POST(request: Request) {
    if (resolveLoginMode() !== 'standalone') {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const body: any = await request.json().catch(() => ({}));
    const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';

    if (!newPassword) {
        return NextResponse.json({ error: 'New password is required' }, { status: 400 });
    }

    // 登录返回的改密凭据只允许调用本接口；它不能拿去访问业务或管理接口。
    const setupToken = request.headers.get('x-witty-password-token')?.trim() || '';
    const setupUsername = setupToken ? verifyPasswordSetupToken(setupToken) : null;
    const { username } = setupUsername
        ? { username: setupUsername }
        : await resolveUser(request);

    if (!username) {
        return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const user = await db.findUserByUsername(username);
    if (!user || user.disabledAt) {
        return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    if (user.passwordHash) {
        if (setupUsername) {
            // 改密 token 来自刚完成的密码登录，不再要求重复输入临时密码。
            if (!user.mustChangePassword) {
                return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
            }
        } else {
            if (!currentPassword) {
                return NextResponse.json({ error: 'Current password is required' }, { status: 400 });
            }
            if (!await verifyPassword(currentPassword, user.passwordHash)) {
                return NextResponse.json({ error: 'Current password is incorrect' }, { status: 400 });
            }
        }
    }

    const policyError = validatePasswordPolicy(newPassword, username);
    if (policyError) {
        return NextResponse.json({ error: policyError }, { status: 400 });
    }

    await db.updateUserPassword(username, {
        passwordHash: await hashPassword(newPassword),
        passwordUpdatedAt: new Date(),
        mustChangePassword: false,
    });

    // 只有改密凭据路径需要把正式 API Key 交给浏览器；既有 Key 路径本来就有 Key。
    return NextResponse.json(
        setupUsername
            ? { ok: true, apiKey: user.apiKey, isAdmin: isAdminUser(user.username) }
            : { ok: true },
        { headers: { 'Cache-Control': 'no-store' } },
    );
}

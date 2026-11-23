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
import { resolveLoginMode } from '@/lib/auth/login-mode';
import { hashPassword, validatePasswordPolicy, verifyPassword } from '@/lib/auth/password';

export async function POST(request: Request) {
    if (resolveLoginMode() !== 'standalone') {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const { username } = await resolveUser(request);
    if (!username) {
        return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const body: any = await request.json().catch(() => ({}));
    const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';

    if (!newPassword) {
        return NextResponse.json({ error: 'New password is required' }, { status: 400 });
    }

    const user = await db.findUserByUsername(username);
    if (!user) {
        return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    // 首次登录设置密码：账号尚无密码时不需要校验原密码，其余情况必须校验。
    if (user.passwordHash) {
        if (!currentPassword) {
            return NextResponse.json({ error: 'Current password is required' }, { status: 400 });
        }
        if (!await verifyPassword(currentPassword, user.passwordHash)) {
            return NextResponse.json({ error: 'Current password is incorrect' }, { status: 400 });
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

    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}

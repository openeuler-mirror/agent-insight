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

import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { db } from '@/lib/storage/prisma';
import { resolveLoginMode } from '@/lib/auth/login-mode';
import { isAdminUser, resolveAdminUser } from '@/lib/auth/admin';
import { hashPassword } from '@/lib/auth/password';
import {
    isDuplicateUsernameError,
    normalizeAccountUsername,
    validateAccountUsername,
} from '@/lib/auth/local-user';

const NO_STORE = { 'Cache-Control': 'no-store' };

function toAccount(user: any) {
    return {
        username: user.username,
        externalAccount: user.externalAccount || null,
        isAdmin: isAdminUser(user.username),
        hasPassword: Boolean(user.passwordHash),
        createdAt: user.createdAt || null,
        passwordUpdatedAt: user.passwordUpdatedAt || null,
    };
}

async function guard(
    request: Request,
): Promise<{ error: NextResponse } | { username: string; isAdmin: boolean }> {
    if (resolveLoginMode() !== 'standalone') {
        return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
    }
    const { username, isAdmin } = await resolveAdminUser(request);
    if (!username) {
        return { error: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
    }
    if (!isAdmin) {
        return { error: NextResponse.json({ error: 'Admin permission required' }, { status: 403 }) };
    }
    return { username, isAdmin };
}

export async function GET(request: Request) {
    const access = await guard(request);
    if ('error' in access) return access.error;

    const users = await db.findUsers();
    return NextResponse.json(
        { accounts: users.map(toAccount) },
        { headers: NO_STORE },
    );
}

export async function POST(request: Request) {
    const access = await guard(request);
    if ('error' in access) return access.error;

    const body: any = await request.json().catch(() => ({}));
    const username = normalizeAccountUsername(body?.username);
    const validationError = validateAccountUsername(username);
    if (validationError) {
        return NextResponse.json({ error: validationError }, { status: 400 });
    }
    if (isAdminUser(username) && body?.acknowledgeAdmin !== true) {
        return NextResponse.json(
            { error: 'Admin account requires confirmation', code: 'admin_confirmation_required' },
            { status: 409 },
        );
    }

    try {
        await db.createUser({
            username,
            apiKey: 'wi_' + crypto.randomBytes(24).toString('hex'),
            // 初始密码与账号名相同，首次登录后强制修改。
            passwordHash: await hashPassword(username),
            passwordUpdatedAt: new Date(),
            mustChangePassword: true,
        });
    } catch (error: any) {
        if (isDuplicateUsernameError(error)) {
            return NextResponse.json({ error: 'Username already exists' }, { status: 409 });
        }
        throw error;
    }

    return NextResponse.json(
        {
            username,
            adminGranted: isAdminUser(username),
        },
        { status: 201, headers: NO_STORE },
    );
}

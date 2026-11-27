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
import { resolveAdminUser } from '@/lib/auth/admin';
import { normalizeAccountUsername } from '@/lib/auth/local-user';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function DELETE(
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
    if (!username) {
        return NextResponse.json({ error: 'Username is required' }, { status: 400 });
    }
    if (username === adminUsername) {
        return NextResponse.json(
            { error: 'Cannot disable the account you are signed in with' },
            { status: 400, headers: NO_STORE },
        );
    }

    const existing = await db.findUserByUsername(username);
    if (!existing) {
        return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }
    if (existing.disabledAt) {
        return NextResponse.json(
            { error: 'Account is already disabled', code: 'account_disabled' },
            { status: 409, headers: NO_STORE },
        );
    }

    // 停用而不是删除：保留用户名与历史业务归属，同时轮换 Key 让旧凭据立即失效。
    // 这样同名新账号不会继承前一个账号的 Trace。
    const disabled = await db.disableUser(username, {
        apiKey: 'wi_revoked_' + crypto.randomBytes(24).toString('hex'),
        disabledAt: new Date(),
    });
    if (!disabled) {
        return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    return NextResponse.json(
        { username, disabled: true, disabledAt: disabled.disabledAt },
        { headers: NO_STORE },
    );
}

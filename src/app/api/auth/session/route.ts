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

// standalone 刷新页面时的登录态恢复：只回显身份和改密要求，不下发 API Key。
export async function GET(request: Request) {
    if (resolveLoginMode() !== 'standalone') {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const { username } = await resolveUser(request);
    if (!username) {
        return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const user = await db.findUserByUsername(username);
    if (!user) {
        return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    return NextResponse.json(
        {
            username: user.username,
            isAdmin: isAdminUser(user.username),
            passwordChangeRequired: Boolean(user.mustChangePassword) || !user.passwordHash,
            passwordInitialized: Boolean(user.passwordHash),
        },
        { headers: { 'Cache-Control': 'no-store' } },
    );
}

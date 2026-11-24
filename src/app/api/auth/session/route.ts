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
import { isAdminUser } from '@/lib/auth/admin';
import { resolveLoginMode } from '@/lib/auth/login-mode';
import { verifyPasswordSetupToken } from '@/lib/auth/password-setup-token';

// standalone 刷新页面时的登录态恢复：只回显身份和改密要求，不下发 API Key。
export async function GET(request: Request) {
    if (resolveLoginMode() !== 'standalone') {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const apiKey = request.headers.get('x-witty-api-key')?.trim() || '';
    const setupToken = request.headers.get('x-witty-password-token')?.trim() || '';

    // 改密凭据优先于浏览器里可能残留的旧 API Key，避免旧会话覆盖当前强制改密身份。
    let user = null;
    if (setupToken) {
        const tokenUser = verifyPasswordSetupToken(setupToken);
        if (tokenUser) {
            const tokenAccount = await db.findUserByUsername(tokenUser);
            // 改密凭据只在仍待改密时有效，改密完成后不能继续当会话凭据使用。
            if (tokenAccount
                && (tokenAccount.mustChangePassword || !tokenAccount.passwordHash)
                && !tokenAccount.disabledAt) {
                user = tokenAccount;
            }
        }
    }
    if (!user && apiKey) {
        user = await db.findUserByApiKey(apiKey);
    }

    if (!user || user.disabledAt) {
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

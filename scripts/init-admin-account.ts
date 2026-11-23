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

/**
 * 确保本地账号存在。
 *
 * 用法：node --import tsx scripts/init-admin-account.ts [username]
 * 默认目标账号为 admin。账号首次网页登录免密，登录后必须设置密码。
 */

import crypto from 'node:crypto';
import { db } from '@/lib/storage/prisma';
import { resolveLoginMode } from '@/lib/auth/login-mode';

async function closeClient() {
    const client: any = db.getClient();
    if (typeof client?.$disconnect === 'function') await client.$disconnect();
    else if (typeof client?.end === 'function') await client.end();
}

async function main() {
    if (resolveLoginMode() !== 'standalone') {
        throw new Error('Password login is only available when LOGIN_MODE=standalone');
    }

    const username = String(process.argv[2] || 'admin').trim().toLowerCase();
    if (!username) throw new Error('Username is required');

    const existing = await db.findUserByUsername(username);
    if (!existing) {
        await db.createUser({
            username,
            apiKey: 'wi_' + crypto.randomBytes(24).toString('hex'),
            mustChangePassword: true,
        });
    }

    console.log(`✓ Account ready: ${username}`);
    if (existing) {
        console.log('  Account already exists; its password state is unchanged.');
    } else {
        console.log('  First web sign-in needs only this username, then set a password.');
    }
}

main()
    .catch((error) => {
        console.error(`✗ Failed to initialize account: ${error.message}`);
        process.exitCode = 1;
    })
    .finally(() => {
        void closeClient();
    });

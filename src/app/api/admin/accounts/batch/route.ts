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
import { generateActivationPassword, hashPassword } from '@/lib/auth/password';
import {
    isDuplicateUsernameError,
    normalizeAccountUsername,
    validateAccountUsername,
} from '@/lib/auth/local-user';

const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_BATCH_SIZE = 200;

type SkipReason = 'invalid' | 'exists' | 'admin_confirmation_required';

export async function POST(request: Request) {
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

    const body: any = await request.json().catch(() => ({}));
    if (!Array.isArray(body?.usernames)) {
        return NextResponse.json({ error: 'usernames must be an array' }, { status: 400 });
    }

    const usernames = [...new Set(
        body.usernames
            .map((entry: unknown) => normalizeAccountUsername(entry))
            .filter(Boolean),
    )] as string[];
    if (usernames.length === 0) {
        return NextResponse.json({ error: 'At least one username is required' }, { status: 400 });
    }
    if (usernames.length > MAX_BATCH_SIZE) {
        return NextResponse.json(
            { error: `At most ${MAX_BATCH_SIZE} usernames per import` },
            { status: 400 },
        );
    }

    const acknowledgeAdmin = body?.acknowledgeAdmin === true;
    const created: { username: string; initialPassword: string }[] = [];
    const skipped: { username: string; reason: SkipReason }[] = [];

    for (const username of usernames) {
        if (validateAccountUsername(username)) {
            skipped.push({ username, reason: 'invalid' });
            continue;
        }
        if (isAdminUser(username) && !acknowledgeAdmin) {
            skipped.push({ username, reason: 'admin_confirmation_required' });
            continue;
        }
        try {
            const initialPassword = generateActivationPassword();
            await db.createUser({
                username,
                apiKey: 'wi_' + crypto.randomBytes(24).toString('hex'),
                passwordHash: await hashPassword(initialPassword),
                passwordUpdatedAt: new Date(),
                mustChangePassword: true,
            });
            created.push({ username, initialPassword });
        } catch (error: any) {
            if (isDuplicateUsernameError(error)) {
                skipped.push({ username, reason: 'exists' });
                continue;
            }
            throw error;
        }
    }

    return NextResponse.json({ created, skipped }, { headers: NO_STORE });
}

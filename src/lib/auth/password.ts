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

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const HASH_PREFIX = 'scrypt';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

function deriveKey(
    password: string,
    salt: Buffer,
    keyLength: number,
    options: crypto.ScryptOptions,
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, keyLength, options, (error, derived) => {
            if (error) reject(error);
            else resolve(derived);
        });
    });
}

export async function hashPassword(plain: string): Promise<string> {
    const salt = crypto.randomBytes(SALT_BYTES);
    const derived = await deriveKey(plain, salt, KEY_LENGTH, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
    });
    return [
        HASH_PREFIX,
        SCRYPT_N,
        SCRYPT_R,
        SCRYPT_P,
        salt.toString('base64'),
        derived.toString('base64'),
    ].join('$');
}

export async function verifyPassword(plain: string, stored: string | null | undefined): Promise<boolean> {
    if (!stored) return false;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== HASH_PREFIX) return false;

    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (!salt.length || !expected.length) return false;

    try {
        const derived = await deriveKey(plain, salt, expected.length, { N, r, p });
        return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
    } catch {
        return false;
    }
}

export function validatePasswordPolicy(plain: unknown, username: string): string | null {
    if (typeof plain !== 'string' || !plain) return 'Password is required';
    if (plain.length < PASSWORD_MIN_LENGTH || plain.length > PASSWORD_MAX_LENGTH) {
        return `Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`;
    }
    if (plain.toLowerCase() === String(username || '').trim().toLowerCase()) {
        return 'Password must be different from username';
    }
    return null;
}

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
import { db } from '@/lib/storage/prisma';

export function isDuplicateUsernameError(error: any): boolean {
  return error?.code === 'P2002'
    || (error?.code === '23505'
      && (error?.constraint?.includes('User_username_key') || error?.detail?.includes('username')));
}

const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
// Unicode 字母/数字 + 少量安全符号；拒绝空白、控制字符、$、|、逗号等会破坏
// CSV、限流键或日志的字符。邮箱形态单独校验。
const PLAIN_ACCOUNT_PATTERN = /^[\p{L}\p{N}._-]+$/u;
export const ACCOUNT_USERNAME_MAX_LENGTH = 128;

export function normalizeAccountUsername(raw: unknown): string {
  return String(raw || '').trim().toLowerCase();
}

export function validateAccountUsername(username: string): string | null {
  if (!username) return 'Username is required';
  if (username.length > ACCOUNT_USERNAME_MAX_LENGTH) {
    return `Username must be at most ${ACCOUNT_USERNAME_MAX_LENGTH} characters`;
  }
  if (username.includes('@')) {
    return EMAIL_PATTERN.test(username) ? null : 'Username must be a valid email address';
  }
  return PLAIN_ACCOUNT_PATTERN.test(username)
    ? null
    : 'Username may contain only letters, numbers, dots, underscores, and hyphens';
}

interface ExternalAccountStore {
  findUserByExternalAccount(externalAccount: string): Promise<any>;
  updateUserExternalAccount(username: string, externalAccount: string): Promise<any>;
}

interface LocalUserStore extends ExternalAccountStore {
  findUserByUsername(username: string): Promise<any>;
  createUser(data: { username: string; apiKey: string; externalAccount?: string }): Promise<any>;
}

export class LocalUserAuthenticationError extends Error {
  constructor() {
    super('Existing local user requires the matching API key');
    this.name = 'LocalUserAuthenticationError';
  }
}

export async function syncLocalUserExternalAccount(
  user: any,
  rawExternalAccount?: string,
  store: ExternalAccountStore = db,
) {
  const externalAccount = String(rawExternalAccount || '').trim();
  if (!externalAccount || user.externalAccount === externalAccount) return user;

  const linkedUser = await store.findUserByExternalAccount(externalAccount);
  if (linkedUser) {
    if (linkedUser.username !== user.username) {
      throw new Error('External account is already linked to another user');
    }
    return linkedUser;
  }

  const updatedUser = await store.updateUserExternalAccount(user.username, externalAccount);
  if (!updatedUser) throw new Error('Failed to update external account');
  return updatedUser;
}

export async function findOrCreateLocalUser(username: string, rawExternalAccount?: string) {
  const externalAccount = String(rawExternalAccount || '').trim();
  let user = await db.findUserByUsername(username);

  if (!user) {
    const apiKey = 'wi_' + crypto.randomBytes(24).toString('hex');
    try {
      user = await db.createUser({
        username,
        apiKey,
        ...(externalAccount ? { externalAccount } : {}),
      });
    } catch (error: any) {
      if (!isDuplicateUsernameError(error)) throw error;
      user = await db.findUserByUsername(username);
      if (!user) throw error;
    }
  }

  if (!user) throw new Error('Failed to retrieve or create user');
  if (user.disabledAt) throw new Error('Local user is disabled');
  user = await syncLocalUserExternalAccount(user, externalAccount);

  return user;
}

export async function authenticateOrRegisterLocalUser(
  username: string,
  apiKey: string | null,
  store: LocalUserStore = db,
) {
  let user = await store.findUserByUsername(username);

  if (user) {
    if (user.disabledAt) throw new LocalUserAuthenticationError();
    if (!apiKey || user.apiKey !== apiKey) throw new LocalUserAuthenticationError();
    return user;
  }

  if (apiKey) throw new LocalUserAuthenticationError();

  const nextApiKey = 'wi_' + crypto.randomBytes(24).toString('hex');
  try {
    return await store.createUser({ username, apiKey: nextApiKey });
  } catch (error: any) {
    if (!isDuplicateUsernameError(error)) throw error;
  }

  user = await store.findUserByUsername(username);
  if (!user || !apiKey || user.apiKey !== apiKey) throw new LocalUserAuthenticationError();
  return user;
}

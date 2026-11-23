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

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const ACCOUNT_USERNAME_MAX_LENGTH = 128;

export function normalizeAccountUsername(raw: unknown): string {
  return String(raw || '').trim().toLowerCase();
}

export function validateAccountUsername(username: string): string | null {
  if (!username) return 'Username is required';
  if (username.length > ACCOUNT_USERNAME_MAX_LENGTH) {
    return `Username must be at most ${ACCOUNT_USERNAME_MAX_LENGTH} characters`;
  }
  if (username.includes('@') && !EMAIL_PATTERN.test(username)) {
    return 'Username must be a valid email address';
  }
  return null;
}

interface ExternalAccountStore {
  findUserByExternalAccount(externalAccount: string): Promise<any>;
  updateUserExternalAccount(username: string, externalAccount: string): Promise<any>;
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
  user = await syncLocalUserExternalAccount(user, externalAccount);

  return user;
}

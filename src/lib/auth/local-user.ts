import {withCoreControlRequest} from '@/lib/storage-core/control-context';
import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {bootstrapCoreControlUser} from '@/lib/storage-core/control-auth';
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
import { seedBuiltinExampleForUser } from '@/server/builtin-example/seed';

function isDuplicateUsernameError(error: any): boolean {
  return error?.code === 'P2002'
    || (error?.code === '23505'
      && (error?.constraint?.includes('User_username_key') || error?.detail?.includes('username')));
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
  {
    const user=await bootstrapCoreControlUser(username,rawExternalAccount);
    return withCoreControlRequest(new Request('http://localhost/internal/local-user',{headers:{authorization:'Bearer '+user.apiKey}}),async()=>{
      const synced=await syncLocalUserExternalAccount(user,rawExternalAccount);
      if(user._created)await seedBuiltinExampleForUser(synced.username);
      return synced;
    });
  }
}

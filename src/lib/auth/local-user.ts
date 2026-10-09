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
  const externalAccount = String(rawExternalAccount || '').trim();
  let user = await db.findUserByUsername(username);
  let isNewUser = false;

  if (!user) {
    const apiKey = 'wi_' + crypto.randomBytes(24).toString('hex');
    try {
      user = await db.createUser({
        username,
        apiKey,
        ...(externalAccount ? { externalAccount } : {}),
      });
      isNewUser = true;
    } catch (error: any) {
      if (!isDuplicateUsernameError(error)) throw error;
      user = await db.findUserByUsername(username);
      if (!user) throw error;
    }
  }

  if (!user) throw new Error('Failed to retrieve or create user');
  user = await syncLocalUserExternalAccount(user, externalAccount);
  if (isNewUser) await seedBuiltinExampleForUser(user.username);

  return user;
}

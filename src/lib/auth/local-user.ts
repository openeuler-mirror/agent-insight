import crypto from 'node:crypto';
import { db } from '@/lib/storage/prisma';
import { seedBuiltinExampleForUser } from '@/server/builtin-example/seed';

function isDuplicateUsernameError(error: any): boolean {
  return error?.code === 'P2002'
    || (error?.code === '23505'
      && (error?.constraint?.includes('User_username_key') || error?.detail?.includes('username')));
}

export async function findOrCreateLocalUser(username: string) {
  let user = await db.findUserByUsername(username);
  let isNewUser = false;

  if (!user) {
    const apiKey = 'wi_' + crypto.randomBytes(24).toString('hex');
    try {
      user = await db.createUser({ username, apiKey });
      isNewUser = true;
    } catch (error: any) {
      if (!isDuplicateUsernameError(error)) throw error;
      user = await db.findUserByUsername(username);
    }
  }

  if (!user) throw new Error('Failed to retrieve or create user');
  if (isNewUser) await seedBuiltinExampleForUser(user.username);

  return user;
}

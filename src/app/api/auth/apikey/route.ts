import { NextResponse } from 'next/server';
import { db } from '@/lib/storage/prisma';
import { seedBuiltinExampleForUser } from '@/server/builtin-example/seed';
import crypto from 'node:crypto';

export async function POST(request: Request) {
  try {
    const body: any = await request.json().catch(() => ({}));
    const username = String(body?.username || '').trim().toLowerCase();

    if (!username) {
      return NextResponse.json({ error: 'Username is required' }, { status: 400 });
    }

    if (username.includes('@') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) {
      return NextResponse.json({ error: 'Username must be a valid email address' }, { status: 400 });
    }

    let user = await db.findUserByUsername(username);
    let isNewUser = false;

    if (!user) {
      const apiKey = 'wi_' + crypto.randomBytes(24).toString('hex');
      try {
        user = await db.createUser({ username, apiKey });
        isNewUser = true;
      } catch (error: any) {
        const isDuplicate = error?.code === 'P2002'
          || (error?.code === '23505'
            && (error?.constraint?.includes('User_username_key') || error?.detail?.includes('username')));
        if (!isDuplicate) throw error;
        user = await db.findUserByUsername(username);
      }
    }

    if (!user) throw new Error('Failed to retrieve or create user');

    if (isNewUser) await seedBuiltinExampleForUser(user.username);

    return NextResponse.json({
      username: user.username,
      apiKey: user.apiKey,
    });
  } catch (err: any) {
    console.error('[Auth/Apikey] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

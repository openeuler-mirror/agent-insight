import { NextResponse } from 'next/server';
import { db } from '@/lib/storage/prisma';
import crypto from 'node:crypto';

export async function POST(request: Request) {
  try {
    const body: any = await request.json().catch(() => ({}));
    const username = String(body?.username || '').trim();

    if (!username) {
      return NextResponse.json({ error: 'Username is required' }, { status: 400 });
    }

    // Look up existing user
    let user = await db.findUserByUsername(username);

    // Create if not exists
    if (!user) {
      const apiKey = 'wi_' + crypto.randomBytes(24).toString('hex');
      user = await db.createUser({
        username,
        apiKey,
      });
    }

    return NextResponse.json({
      username: user.username,
      apiKey: user.apiKey,
    });
  } catch (err: any) {
    console.error('[Auth/Apikey] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
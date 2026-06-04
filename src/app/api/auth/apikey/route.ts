
import { db } from '@/lib/storage/prisma';
import { seedBuiltinExampleForUser } from '@/server/builtin-example/seed';
import crypto from 'crypto';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const { username } = await request.json();
    
    if (!username || typeof username !== 'string') {
      return NextResponse.json({ error: 'Username is required' }, { status: 400 });
    }

    const cleanUsername = username.trim().toLowerCase();
    
    // Validate email format only if username looks like an email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const looksLikeEmail = cleanUsername.includes('@');
    if (looksLikeEmail && !emailRegex.test(cleanUsername)) {
      return NextResponse.json({ error: 'Username must be a valid email address' }, { status: 400 });
    }
    
    // Find existing user
    let user = await db.findUserByUsername(cleanUsername);

    // If not found, create new user with API Key
    let isNewUser = false;
    if (!user) {
      const apiKey = `sk-${crypto.randomBytes(16).toString('hex')}`;
      try {
          user = await db.createUser({
              username: cleanUsername,
              apiKey
          });
          isNewUser = true; // 本请求真正创建了用户（竞态分支走 findUserByUsername，不算）
      } catch (e: any) {
          // Handle race condition where user might be created between findUnique and create
          // P2002 is Prisma unique constraint violation code
          // Postgres duplicate key error is 23505
          if (e.code === 'P2002' || (e.code === '23505' && (e.constraint?.includes('User_username_key') || e.detail?.includes('username')))) {
              user = await db.findUserByUsername(cleanUsername);
          } else {
              throw e;
          }
      }
    }

    if (!user) {
        throw new Error("Failed to retrieve or create user");
    }

    // 新用户注册：一次性注入内置示例数据（数据集 + 两条链路追踪 Trace）。
    // best-effort，内部已吞异常，绝不阻断登录/注册。
    if (isNewUser) {
      await seedBuiltinExampleForUser(user.username);
    }

    return NextResponse.json({
      apiKey: user.apiKey,
      username: user.username
    });
  } catch (error) {
    console.error('API Key generation error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

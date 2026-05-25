import { db } from '@/lib/storage/prisma';
import crypto from 'crypto';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const orgUserInfoUrl = process.env.ORG_USER_INFO_URL;
  
  if (!orgUserInfoUrl) {
    return NextResponse.json({ error: 'Organization mode not configured' }, { status: 500 });
  }
  
  try {
    // 从前端请求中读取 Cookie，用于转发给企业用户信息接口
    const incomingCookie = request.headers.get('cookie') || undefined;

    const response = await fetch(orgUserInfoUrl, {
      method: 'GET',
      headers: {
        'Accept': '*/*',
        ...(incomingCookie ? { Cookie: incomingCookie } : {})
      }
    });
    
    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to get user info from organization' }, { status: response.status });
    }
    
    const data = await response.json();
    const orgData = data?.data ?? data;
    const rawId = orgData?.id;
    const rawUserName = orgData?.userName;
    const rawUserEmail = orgData?.userEmail;
    const userId = rawId || rawUserEmail || rawUserName;
    
    if (!userId) {
      return NextResponse.json({ error: 'No user ID returned from organization' }, { status: 400 });
    }
    
    let user = await db.findUserByUsername(userId);
    if (!user) {
      const apiKey = `sk-${crypto.randomBytes(16).toString('hex')}`;
      user = await db.createUser({ username: userId, apiKey });
    }
    
    return NextResponse.json({ 
      username: user.username,
      displayName: rawUserName || rawUserEmail || user.username,
      apiKey: user.apiKey 
    });
    
  } catch (error) {
    console.error('Organization auth error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

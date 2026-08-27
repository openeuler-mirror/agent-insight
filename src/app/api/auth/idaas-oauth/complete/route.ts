import { NextRequest, NextResponse } from 'next/server';
import { resolveLoginMode } from '@/lib/auth/login-mode';
import { db } from '@/lib/storage/prisma';
import {
  describeIdaasOAuthError,
  getIdaasOAuthConfig,
  getIdaasRoutePath,
  IDAAS_LOGIN_COOKIE,
  isIdaasCookieSecure,
  verifyIdaasLoginToken,
} from '@/lib/auth/idaas-oauth';

export const dynamic = 'force-dynamic';

function clearLoginCookie(response: NextResponse, path: string, secure: boolean) {
  response.cookies.set(IDAAS_LOGIN_COOKIE, '', {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: 0,
    path,
  });
}

export async function POST(request: NextRequest) {
  try {
    if (resolveLoginMode() !== 'idaas_oauth') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
  } catch (error) {
    console.error(`[Auth/IDaaS] Complete login mode configuration failed: ${describeIdaasOAuthError(error)}`);
    return NextResponse.json({ error: 'Invalid login configuration' }, { status: 500 });
  }

  let config;
  try {
    config = getIdaasOAuthConfig();
  } catch (error) {
    console.error(`[Auth/IDaaS] Complete OAuth configuration failed: ${describeIdaasOAuthError(error)}`);
    return NextResponse.json({ error: 'IDaaS OAuth login is not configured' }, { status: 500 });
  }

  const path = getIdaasRoutePath(config, '/api/auth/idaas-oauth/complete');
  const secure = isIdaasCookieSecure(config);
  const token = request.cookies.get(IDAAS_LOGIN_COOKIE)?.value || '';
  const payload = token ? verifyIdaasLoginToken(token, config.clientSecret) : null;

  if (!payload) {
    const response = NextResponse.json({ error: 'Login session expired' }, { status: 401 });
    clearLoginCookie(response, path, secure);
    return response;
  }

  const user = await db.findUserByUsername(payload.username);
  if (!user) {
    const response = NextResponse.json({ error: 'User not found' }, { status: 401 });
    clearLoginCookie(response, path, secure);
    return response;
  }

  const response = NextResponse.json({
    username: user.username,
    apiKey: user.apiKey,
  });
  response.headers.set('Cache-Control', 'no-store');
  clearLoginCookie(response, path, secure);
  return response;
}

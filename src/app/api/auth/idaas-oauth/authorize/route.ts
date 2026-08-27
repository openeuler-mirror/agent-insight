import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { resolveLoginMode } from '@/lib/auth/login-mode';
import {
  buildIdaasAuthorizationUrl,
  createIdaasStateToken,
  describeIdaasOAuthError,
  getIdaasCallbackPath,
  getIdaasOAuthConfig,
  getSafeServerReturnTo,
  IDAAS_STATE_COOKIE,
  IDAAS_STATE_TTL_SECONDS,
  isIdaasCookieSecure,
} from '@/lib/auth/idaas-oauth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    if (resolveLoginMode() !== 'idaas_oauth') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const config = getIdaasOAuthConfig();
    const state = crypto.randomBytes(32).toString('base64url');
    const returnTo = getSafeServerReturnTo(request.nextUrl.searchParams.get('returnTo'));
    const response = NextResponse.redirect(buildIdaasAuthorizationUrl(config, state), 302);
    response.headers.set('Cache-Control', 'no-store');
    response.cookies.set(
      IDAAS_STATE_COOKIE,
      createIdaasStateToken(state, returnTo, config.clientSecret),
      {
        httpOnly: true,
        secure: isIdaasCookieSecure(config),
        sameSite: 'lax',
        maxAge: IDAAS_STATE_TTL_SECONDS,
        path: getIdaasCallbackPath(config),
      },
    );
    return response;
  } catch (error) {
    console.error(`[Auth/IDaaS] Authorization failed: ${describeIdaasOAuthError(error)}`);
    return NextResponse.json({ error: 'IDaaS OAuth login is not configured' }, { status: 500 });
  }
}

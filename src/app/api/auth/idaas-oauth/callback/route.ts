import { NextRequest, NextResponse } from 'next/server';
import { resolveLoginMode } from '@/lib/auth/login-mode';
import { findOrCreateLocalUser } from '@/lib/auth/local-user';
import {
  buildIdaasLoginRedirectUrl,
  createIdaasLoginToken,
  describeIdaasOAuthError,
  exchangeIdaasAuthorizationCode,
  fetchIdaasUserInfo,
  getIdaasCallbackPath,
  getIdaasOAuthConfig,
  getIdaasRoutePath,
  IDAAS_LOGIN_COOKIE,
  IDAAS_LOGIN_TTL_SECONDS,
  IDAAS_STATE_COOKIE,
  IdaasOAuthRequestError,
  isIdaasCookieSecure,
  isMatchingIdaasState,
  verifyIdaasStateToken,
} from '@/lib/auth/idaas-oauth';

export const dynamic = 'force-dynamic';

function clearStateCookie(response: NextResponse, path: string, secure: boolean) {
  response.cookies.set(IDAAS_STATE_COOKIE, '', {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: 0,
    path,
  });
}

export async function GET(request: NextRequest) {
  try {
    if (resolveLoginMode() !== 'idaas_oauth') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
  } catch (error) {
    console.error(`[Auth/IDaaS] Callback login mode configuration failed: ${describeIdaasOAuthError(error)}`);
    return NextResponse.json({ error: 'Invalid login configuration' }, { status: 500 });
  }

  let config;
  try {
    config = getIdaasOAuthConfig();
  } catch (error) {
    console.error(`[Auth/IDaaS] Callback OAuth configuration failed: ${describeIdaasOAuthError(error)}`);
    return NextResponse.json({ error: 'IDaaS OAuth login is not configured' }, { status: 500 });
  }

  const statePath = getIdaasCallbackPath(config);
  const secure = isIdaasCookieSecure(config);
  const fail = (code: string, returnTo: string | null = null) => {
    const response = NextResponse.redirect(
      buildIdaasLoginRedirectUrl(config, { error: code, returnTo }),
      303,
    );
    response.headers.set('Cache-Control', 'no-store');
    clearStateCookie(response, statePath, secure);
    return response;
  };

  const providerError = request.nextUrl.searchParams.get('error');
  const code = request.nextUrl.searchParams.get('code');
  const receivedState = request.nextUrl.searchParams.get('state');
  const stateCookie = request.cookies.get(IDAAS_STATE_COOKIE)?.value || '';
  const statePayload = stateCookie
    ? verifyIdaasStateToken(stateCookie, config.clientSecret)
    : null;

  if (!receivedState || !statePayload) return fail('invalid_callback');
  if (!isMatchingIdaasState(receivedState, statePayload.state)) {
    return fail('invalid_state', statePayload.returnTo);
  }
  if (providerError) return fail('authorization_denied', statePayload.returnTo);
  if (!code) return fail('invalid_callback', statePayload.returnTo);

  try {
    const accessToken = await exchangeIdaasAuthorizationCode(config, code);
    const userInfo = await fetchIdaasUserInfo(config, accessToken);
    const user = await findOrCreateLocalUser(userInfo.uuid);
    const response = NextResponse.redirect(
      buildIdaasLoginRedirectUrl(config, {
        complete: true,
        returnTo: statePayload.returnTo,
      }),
      303,
    );
    response.headers.set('Cache-Control', 'no-store');
    clearStateCookie(response, statePath, secure);
    response.cookies.set(
      IDAAS_LOGIN_COOKIE,
      createIdaasLoginToken(user.username, config.clientSecret),
      {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        maxAge: IDAAS_LOGIN_TTL_SECONDS,
        path: getIdaasRoutePath(config, '/api/auth/idaas-oauth/complete'),
      },
    );
    return response;
  } catch (error) {
    const code = error instanceof IdaasOAuthRequestError ? error.code : 'login_failed';
    console.error(`[Auth/IDaaS] Login failed: ${code}; ${describeIdaasOAuthError(error)}`);
    return fail(code, statePayload.returnTo);
  }
}

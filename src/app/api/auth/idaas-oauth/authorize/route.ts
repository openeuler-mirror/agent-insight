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

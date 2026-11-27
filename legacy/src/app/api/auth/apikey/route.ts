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

import { NextResponse } from 'next/server';
import { db } from '@/lib/storage/prisma';
import { resolveLoginMode } from '@/lib/auth/login-mode';
import {
  authenticateOrRegisterLocalUser,
  LocalUserAuthenticationError,
  syncLocalUserExternalAccount,
} from '@/lib/auth/local-user';
import { isAdminUser } from '@/lib/auth/admin';
import { verifyPassword } from '@/lib/auth/password';
import { createPasswordSetupToken, passwordVersionOf } from '@/lib/auth/password-setup-token';
import {
  checkLoginRateLimit,
  clearLoginFailures,
  loginRateLimitKey,
  recordLoginFailure,
} from '@/lib/auth/login-rate-limit';
import {
  inspectIdaasRegionAccess,
  describeIdaasRegionAccessError,
} from '@/lib/auth/idaas-region-access';

const NO_STORE = { 'Cache-Control': 'no-store' };

function invalidCredentials() {
  return NextResponse.json(
    { error: 'Invalid username or password' },
    { status: 401, headers: NO_STORE },
  );
}

// 需要先改密的账号只拿到改密用途的短时凭据，正式 API Key 等新密码落库后再发放。
function pendingPasswordResponse(user: any) {
  return NextResponse.json(
    {
      username: user.username,
      isAdmin: isAdminUser(user.username),
      passwordChangeRequired: true,
      passwordInitialized: Boolean(user.passwordHash),
      passwordSetupToken: createPasswordSetupToken(user.username, passwordVersionOf(user)),
    },
    { headers: NO_STORE },
  );
}

function authenticatedResponse(user: any) {
  return NextResponse.json(
    {
      username: user.username,
      apiKey: user.apiKey,
      isAdmin: isAdminUser(user.username),
      passwordChangeRequired: false,
      passwordInitialized: true,
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  try {
    const body: any = await request.json().catch(() => ({}));
    const submittedUsername = String(body?.username || '').trim();

    if (!submittedUsername) {
      return NextResponse.json({ error: 'Username is required' }, { status: 400 });
    }

    const loginMode = resolveLoginMode();
    const username = loginMode === 'idaas_oauth'
      ? submittedUsername
      : submittedUsername.toLowerCase();

    if (username.includes('@') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) {
      return NextResponse.json({ error: 'Username must be a valid email address' }, { status: 400 });
    }

    if (loginMode === 'idaas_oauth') {
      const apiKey = request.headers.get('x-witty-api-key') || '';
      const user = apiKey ? await db.findUserByApiKey(apiKey) : null;
      if (!user || user.username !== username) {
        return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
      }

      let externalAccount: string | null = null;
      try {
        const regionAccess = await inspectIdaasRegionAccess(user.username);
        externalAccount = regionAccess.externalAccount;
        if (regionAccess.decision === 'restricted') {
          console.warn('[Auth/IDaaS] Login restore blocked: region_restricted');
          return NextResponse.json(
            { error: 'Region restricted', code: 'region_restricted' },
            { status: 403 },
          );
        }
      } catch (error) {
        console.error(
          '[Auth/IDaaS] Region access restore failed: ' + describeIdaasRegionAccessError(error),
        );
        return NextResponse.json(
          { error: 'Region access check unavailable', code: 'region_check_unavailable' },
          { status: 503 },
        );
      }

      const refreshedUser = await syncLocalUserExternalAccount(
        user,
        externalAccount || undefined,
      );
      return NextResponse.json({
        username: refreshedUser.username,
        apiKey: refreshedUser.apiKey,
        displayName: refreshedUser.externalAccount || refreshedUser.username,
      });
    }

    if (loginMode === 'organization') {
      const apiKey = request.headers.get('x-witty-api-key')?.trim() || null;
      const user = await authenticateOrRegisterLocalUser(username, apiKey);
      return NextResponse.json({
        username: user.username,
        apiKey: user.apiKey,
      });
    }

    const rateLimitKey = loginRateLimitKey(request, username);
    const limit = checkLoginRateLimit(rateLimitKey);
    if (!limit.allowed) {
      return NextResponse.json(
        {
          error: 'Too many login attempts',
          code: 'too_many_attempts',
          retryAfterSeconds: limit.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { 'Retry-After': String(limit.retryAfterSeconds), ...NO_STORE },
        },
      );
    }

    const user = await db.findUserByUsername(username);
    if (!user || user.disabledAt) {
      recordLoginFailure(rateLimitKey);
      return invalidCredentials();
    }

    // 存量浏览器会话或 Agent 凭据可凭既有 API Key 恢复身份，但改密前仍只发改密凭据。
    const presentedApiKey = request.headers.get('x-witty-api-key')?.trim() || '';
    if (presentedApiKey) {
      if (presentedApiKey !== user.apiKey) {
        recordLoginFailure(rateLimitKey);
        return invalidCredentials();
      }
      clearLoginFailures(rateLimitKey);
      return user.mustChangePassword || !user.passwordHash
        ? pendingPasswordResponse(user)
        : authenticatedResponse(user);
    }

    // 未设置密码的存量账号不再凭用户名换取正式 API Key，必须出示既有 Key 或管理员激活凭据。
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!password || !user.passwordHash || !await verifyPassword(password, user.passwordHash)) {
      recordLoginFailure(rateLimitKey);
      return invalidCredentials();
    }

    clearLoginFailures(rateLimitKey);
    return user.mustChangePassword
      ? pendingPasswordResponse(user)
      : authenticatedResponse(user);
  } catch (err: any) {
    if (err instanceof LocalUserAuthenticationError) {
      return NextResponse.json(
        { error: 'Existing account requires its API key', code: 'credential_required' },
        { status: 401 },
      );
    }
    console.error('[Auth/Apikey] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

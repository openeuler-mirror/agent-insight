import { NextResponse } from 'next/server';
import { db } from '@/lib/storage/prisma';
import { resolveLoginMode } from '@/lib/auth/login-mode';
import { findOrCreateLocalUser, syncLocalUserExternalAccount } from '@/lib/auth/local-user';
import {
  inspectIdaasRegionAccess,
  describeIdaasRegionAccessError,
} from '@/lib/auth/idaas-region-access';

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

    const user = await findOrCreateLocalUser(username);

    return NextResponse.json({
      username: user.username,
      apiKey: user.apiKey,
    });
  } catch (err: any) {
    console.error('[Auth/Apikey] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

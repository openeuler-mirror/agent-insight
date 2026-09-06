import type { NextRequest } from 'next/server';
import { GET as handleIdaasOAuthCallback } from '@/app/api/auth/idaas-oauth/callback/route';

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleIdaasOAuthCallback(request);
}

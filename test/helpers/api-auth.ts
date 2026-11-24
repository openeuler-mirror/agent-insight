import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';

export function testApiKey(username: string): string {
  const digest = createHash('sha256').update(username).digest('hex').slice(0, 32);
  return `wi_test_${digest}`;
}

export async function ensureTestApiUsers(...usernames: string[]): Promise<void> {
  const { prisma } = await import('@/lib/storage/prisma');
  await Promise.all(usernames.filter(Boolean).map(username => prisma.user.upsert({
    where: { username },
    update: { apiKey: testApiKey(username) },
    create: { username, apiKey: testApiKey(username) },
  })));
}

export function testRequest(url: string, username: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('x-witty-api-key', testApiKey(username));
  return new Request(url, { ...init, headers });
}

export function testNextRequest(url: string, username: string, init: RequestInit = {}): NextRequest {
  const headers = new Headers(init.headers);
  headers.set('x-witty-api-key', testApiKey(username));
  return new NextRequest(
    url,
    { ...init, headers } as ConstructorParameters<typeof NextRequest>[1],
  );
}

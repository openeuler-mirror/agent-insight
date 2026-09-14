import crypto from 'node:crypto';

export const IDAAS_STATE_COOKIE = 'agent_insight_idaas_state';
export const IDAAS_LOGIN_COOKIE = 'agent_insight_idaas_login';
export const IDAAS_STATE_TTL_SECONDS = 5 * 60;
export const IDAAS_LOGIN_TTL_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 20_000;
const CALLBACK_SUFFIX = '/callback';
const LEGACY_CALLBACK_SUFFIX = '/api/auth/idaas-oauth/callback';

export interface IdaasOAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
}

export interface IdaasStatePayload {
  state: string;
  returnTo: string | null;
  exp: number;
}

export interface IdaasLoginPayload {
  username: string;
  nonce: string;
  exp: number;
}

export interface IdaasUserInfo {
  uuid: string;
}

export class IdaasOAuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdaasOAuthConfigurationError';
  }
}

export class IdaasOAuthRequestError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'IdaasOAuthRequestError';
  }
}

export function describeIdaasOAuthError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return 'Unknown non-Error exception';
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = String(env[name] || '').trim();
  if (!value) throw new IdaasOAuthConfigurationError(`Missing ${name}`);
  return value;
}

function validateHttpUrl(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new IdaasOAuthConfigurationError(`Invalid ${name}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new IdaasOAuthConfigurationError(`Invalid ${name}`);
  }
  return parsed.toString();
}

export function getIdaasOAuthConfig(env: Record<string, string | undefined> = process.env): IdaasOAuthConfig {
  const config = {
    authorizationUrl: validateHttpUrl(
      requiredEnv(env, 'IDAAS_OAUTH_AUTHORIZATION_URL'),
      'IDAAS_OAUTH_AUTHORIZATION_URL',
    ),
    tokenUrl: validateHttpUrl(
      requiredEnv(env, 'IDAAS_OAUTH_TOKEN_URL'),
      'IDAAS_OAUTH_TOKEN_URL',
    ),
    userInfoUrl: validateHttpUrl(
      requiredEnv(env, 'IDAAS_OAUTH_USERINFO_URL'),
      'IDAAS_OAUTH_USERINFO_URL',
    ),
    clientId: requiredEnv(env, 'IDAAS_OAUTH_CLIENT_ID'),
    clientSecret: requiredEnv(env, 'IDAAS_OAUTH_CLIENT_SECRET'),
    redirectUri: validateHttpUrl(
      requiredEnv(env, 'IDAAS_OAUTH_REDIRECT_URI'),
      'IDAAS_OAUTH_REDIRECT_URI',
    ),
    scope: requiredEnv(env, 'IDAAS_OAUTH_SCOPE'),
  };

  if (!new URL(config.redirectUri).pathname.endsWith(CALLBACK_SUFFIX)) {
    throw new IdaasOAuthConfigurationError(
      `IDAAS_OAUTH_REDIRECT_URI must end with ${CALLBACK_SUFFIX}`,
    );
  }

  return config;
}

function deriveSigningKey(secret: string, purpose: 'state' | 'login'): Buffer {
  return crypto
    .createHash('sha256')
    .update(`agent-insight:idaas-oauth:${purpose}\0`)
    .update(secret)
    .digest();
}

function signPayload(
  payload: Record<string, unknown>,
  secret: string,
  purpose: 'state' | 'login',
): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', deriveSigningKey(secret, purpose))
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyPayload(
  token: string,
  secret: string,
  purpose: 'state' | 'login',
  nowMs: number,
): Record<string, unknown> | null {
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) return null;

  const expected = crypto
    .createHmac('sha256', deriveSigningKey(secret, purpose))
    .update(encoded)
    .digest('base64url');
  if (!safeEqual(signature, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(nowMs / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function createIdaasStateToken(
  state: string,
  returnTo: string | null,
  secret: string,
  nowMs = Date.now(),
): string {
  return signPayload({
    state,
    returnTo,
    exp: Math.floor(nowMs / 1000) + IDAAS_STATE_TTL_SECONDS,
  }, secret, 'state');
}

export function verifyIdaasStateToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): IdaasStatePayload | null {
  const payload = verifyPayload(token, secret, 'state', nowMs);
  if (!payload || typeof payload.state !== 'string') return null;
  if (payload.returnTo !== null && typeof payload.returnTo !== 'string') return null;
  return payload as unknown as IdaasStatePayload;
}

export function createIdaasLoginToken(
  username: string,
  secret: string,
  nowMs = Date.now(),
): string {
  return signPayload({
    username,
    nonce: crypto.randomBytes(16).toString('base64url'),
    exp: Math.floor(nowMs / 1000) + IDAAS_LOGIN_TTL_SECONDS,
  }, secret, 'login');
}

export function verifyIdaasLoginToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): IdaasLoginPayload | null {
  const payload = verifyPayload(token, secret, 'login', nowMs);
  if (!payload || typeof payload.username !== 'string' || typeof payload.nonce !== 'string') {
    return null;
  }
  return payload as unknown as IdaasLoginPayload;
}

export function isMatchingIdaasState(received: string, expected: string): boolean {
  return safeEqual(received, expected);
}

export function getSafeServerReturnTo(raw: string | null): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/login')) {
    return null;
  }
  return raw;
}

function getConfiguredBasePath(config: IdaasOAuthConfig): string {
  const pathname = new URL(config.redirectUri).pathname;
  const suffix = pathname.endsWith(LEGACY_CALLBACK_SUFFIX)
    ? LEGACY_CALLBACK_SUFFIX
    : CALLBACK_SUFFIX;
  return pathname.slice(0, -suffix.length).replace(/\/$/, '');
}

export function getIdaasCallbackPath(config: IdaasOAuthConfig): string {
  return new URL(config.redirectUri).pathname;
}

export function getIdaasRoutePath(config: IdaasOAuthConfig, route: string): string {
  return `${getConfiguredBasePath(config)}${route}` || '/';
}

export function isIdaasCookieSecure(config: IdaasOAuthConfig): boolean {
  return new URL(config.redirectUri).protocol === 'https:';
}

export function buildIdaasAuthorizationUrl(config: IdaasOAuthConfig, state: string): URL {
  const url = new URL(config.authorizationUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', state);
  return url;
}

export function buildIdaasLoginRedirectUrl(
  config: IdaasOAuthConfig,
  options: { complete?: boolean; error?: string; returnTo?: string | null },
): URL {
  const url = new URL(config.redirectUri);
  url.pathname = getIdaasRoutePath(config, '/login');
  url.search = '';
  if (options.complete) url.searchParams.set('idaas', 'complete');
  if (options.error) url.searchParams.set('idaasError', options.error);
  if (options.returnTo) url.searchParams.set('returnTo', options.returnTo);
  return url;
}

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    throw new IdaasOAuthRequestError('invalid_response');
  }
}

export async function exchangeIdaasAuthorizationCode(
  config: IdaasOAuthConfig,
  code: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const url = new URL(config.tokenUrl);
  url.searchParams.set('grant_type', 'authorization_code');
  url.searchParams.set('code', code);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('client_secret', config.clientSecret);
  url.searchParams.set('redirect_uri', config.redirectUri);

  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new IdaasOAuthRequestError('token_request_failed');
  }
  if (!response.ok) throw new IdaasOAuthRequestError('token_request_failed');

  const body = await readJson(response);
  const accessToken = body?.access_token ?? body?.data?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new IdaasOAuthRequestError('token_missing');
  }
  return accessToken;
}

export async function fetchIdaasUserInfo(
  config: IdaasOAuthConfig,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<IdaasUserInfo> {
  const url = new URL(config.userInfoUrl);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('access_token', accessToken);

  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new IdaasOAuthRequestError('userinfo_request_failed');
  }
  if (!response.ok) throw new IdaasOAuthRequestError('userinfo_request_failed');

  const body = await readJson(response);
  const userInfo = body?.data ?? body;
  const uuid = String(userInfo?.uuid || '').trim();
  if (!uuid) {
    throw new IdaasOAuthRequestError('uuid_missing');
  }

  return { uuid };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildIdaasAuthorizationUrl,
  createIdaasLoginToken,
  createIdaasStateToken,
  describeIdaasOAuthError,
  exchangeIdaasAuthorizationCode,
  fetchIdaasUserInfo,
  getIdaasCallbackPath,
  getIdaasOAuthConfig,
  getIdaasRoutePath,
  getSafeServerReturnTo,
  IdaasOAuthRequestError,
  verifyIdaasLoginToken,
  verifyIdaasStateToken,
} from '@/lib/auth/idaas-oauth';
import {
  LoginModeConfigurationError,
  resolveLoginMode,
} from '@/lib/auth/login-mode';

function oauthEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    IDAAS_OAUTH_AUTHORIZATION_URL: 'https://identity.example.com/oauth/authorize',
    IDAAS_OAUTH_TOKEN_URL: 'https://identity.example.com/oauth/token',
    IDAAS_OAUTH_USERINFO_URL: 'https://identity.example.com/oauth/userinfo',
    IDAAS_OAUTH_CLIENT_ID: 'example-client',
    IDAAS_OAUTH_CLIENT_SECRET: 'example-secret',
    IDAAS_OAUTH_REDIRECT_URI: 'https://insight.example.com/callback',
    IDAAS_OAUTH_SCOPE: 'profile',
    ...overrides,
  };
}

test('登录模式明确区分本地、历史组织集成和 IDaaS OAuth', () => {
  assert.equal(resolveLoginMode({}), 'standalone');
  assert.equal(resolveLoginMode({ LOGIN_MODE: 'standalone' }), 'standalone');
  assert.equal(resolveLoginMode({ ORGANIZATION_MODE: 'true' }), 'organization');
  assert.equal(resolveLoginMode({ LOGIN_MODE: 'idaas_oauth' }), 'idaas_oauth');
});

test('IDaaS OAuth 与历史组织集成同时开启时拒绝配置', () => {
  assert.throws(
    () => resolveLoginMode({
      LOGIN_MODE: 'idaas_oauth',
      ORGANIZATION_MODE: 'true',
    }),
    LoginModeConfigurationError,
  );
  assert.throws(
    () => resolveLoginMode({ LOGIN_MODE: 'enterprise_oauth' }),
    LoginModeConfigurationError,
  );
});

test('OAuth 配置支持 /callback 并兼容原 IDaaS callback 路径', () => {
  const config = getIdaasOAuthConfig(oauthEnv());
  assert.equal(config.clientId, 'example-client');
  assert.equal(config.redirectUri, 'https://insight.example.com/callback');
  assert.equal(getIdaasCallbackPath(config), '/callback');
  assert.equal(getIdaasRoutePath(config, '/login'), '/login');

  const legacyConfig = getIdaasOAuthConfig(oauthEnv({
    IDAAS_OAUTH_REDIRECT_URI: 'https://insight.example.com/base/api/auth/idaas-oauth/callback',
  }));
  assert.equal(getIdaasCallbackPath(legacyConfig), '/base/api/auth/idaas-oauth/callback');
  assert.equal(getIdaasRoutePath(legacyConfig, '/login'), '/base/login');

  assert.throws(() => getIdaasOAuthConfig(oauthEnv({
    IDAAS_OAUTH_REDIRECT_URI: 'https://insight.example.com/base',
  })));
});

test('OAuth 配置错误日志包含具体字段但不包含字段值', () => {
  let capturedError: unknown;
  try {
    getIdaasOAuthConfig(oauthEnv({ IDAAS_OAUTH_TOKEN_URL: '/oauth/token' }));
  } catch (error) {
    capturedError = error;
  }

  const detail = describeIdaasOAuthError(capturedError);
  assert.equal(detail, 'IdaasOAuthConfigurationError: Invalid IDAAS_OAUTH_TOKEN_URL');
  assert.equal(detail.includes('/oauth/token'), false);
});

test('authorization URL 和 token 请求使用同一个 redirect URI', async () => {
  const config = getIdaasOAuthConfig(oauthEnv());
  const authorizationUrl = buildIdaasAuthorizationUrl(config, 'state-value');
  assert.equal(authorizationUrl.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(authorizationUrl.searchParams.get('state'), 'state-value');

  let capturedUrl = '';
  let capturedMethod = '';
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedMethod = String(init?.method || '');
    return Response.json({ access_token: 'provider-access-token' });
  }) as typeof fetch;

  const accessToken = await exchangeIdaasAuthorizationCode(config, 'authorization-code', fetcher);
  assert.equal(accessToken, 'provider-access-token');
  assert.equal(capturedMethod, 'POST');
  assert.equal(new URL(capturedUrl).searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(new URL(capturedUrl).searchParams.get('client_secret'), 'example-secret');
});

test('userinfo 沿用 POST query 约定并以 UUID 作为账号', async () => {
  const config = getIdaasOAuthConfig(oauthEnv());
  let capturedUrl = '';
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    assert.equal(init?.method, 'POST');
    return Response.json({ uuid: '  employee-uuid-001  ' });
  }) as typeof fetch;

  const userInfo = await fetchIdaasUserInfo(config, 'provider-access-token', fetcher);
  assert.deepEqual(userInfo, { uuid: 'employee-uuid-001' });
  assert.equal(new URL(capturedUrl).searchParams.get('access_token'), 'provider-access-token');
});

test('userinfo 兼容 data.uuid 并在缺少 UUID 时返回明确错误码', async () => {
  const config = getIdaasOAuthConfig(oauthEnv());
  const nestedFetcher = (async () => Response.json({
    data: { uuid: 'employee-uuid-002' },
  })) as typeof fetch;
  assert.deepEqual(
    await fetchIdaasUserInfo(config, 'provider-access-token', nestedFetcher),
    { uuid: 'employee-uuid-002' },
  );

  const missingFetcher = (async () => Response.json({ data: {} })) as typeof fetch;
  await assert.rejects(
    () => fetchIdaasUserInfo(config, 'provider-access-token', missingFetcher),
    (error: unknown) => error instanceof IdaasOAuthRequestError && error.code === 'uuid_missing',
  );
});

test('state 和登录结果 Cookie 可校验、可过期且篡改后失效', () => {
  const now = 1_800_000_000_000;
  const stateToken = createIdaasStateToken('state-value', '/trace?taskId=1', 'secret', now);
  assert.deepEqual(verifyIdaasStateToken(stateToken, 'secret', now), {
    state: 'state-value',
    returnTo: '/trace?taskId=1',
    exp: Math.floor(now / 1000) + 300,
  });
  assert.equal(verifyIdaasStateToken(`${stateToken}x`, 'secret', now), null);
  assert.equal(verifyIdaasStateToken(stateToken, 'secret', now + 301_000), null);

  const loginToken = createIdaasLoginToken('user@example.com', 'secret', now);
  const loginPayload = verifyIdaasLoginToken(loginToken, 'secret', now);
  assert.equal(loginPayload?.username, 'user@example.com');
  assert.ok(loginPayload?.nonce);
  assert.equal(verifyIdaasLoginToken(loginToken, 'other-secret', now), null);
  assert.equal(verifyIdaasLoginToken(loginToken, 'secret', now + 61_000), null);
});

test('returnTo 只接受站内非登录路径', () => {
  assert.equal(getSafeServerReturnTo('/trace?taskId=1'), '/trace?taskId=1');
  assert.equal(getSafeServerReturnTo('//example.com'), null);
  assert.equal(getSafeServerReturnTo('https://example.com'), null);
  assert.equal(getSafeServerReturnTo('/login?returnTo=/trace'), null);
});

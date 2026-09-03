import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  createIdaasRegionAccessChecker,
  getIdaasRegionAccessConfig,
  IdaasRegionAccessConfigurationError,
  IdaasRegionAccessRequestError,
} from '@/lib/auth/idaas-region-access';

function regionEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    IDAAS_REGION_ACCESS_ENABLED: 'true',
    IDAAS_REGION_ACCESS_IAM_URL: 'https://iam.example.com/token',
    IDAAS_REGION_ACCESS_PERSON_URL: 'https://people.example.com/query',
    IDAAS_REGION_ACCESS_IAM_PROJECT: 'example-project',
    IDAAS_REGION_ACCESS_IAM_ACCOUNT: 'example-service-account',
    IDAAS_REGION_ACCESS_IAM_SECRET: 'example-secret',
    IDAAS_REGION_ACCESS_IAM_ENTERPRISE: 'example-enterprise',
    IDAAS_REGION_ACCESS_TLS_VERIFY: 'false',
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

test('地区访问配置默认关闭，启用后读取必要参数并默认关闭 TLS 校验', () => {
  assert.equal(getIdaasRegionAccessConfig({}), null);

  const config = getIdaasRegionAccessConfig(regionEnv());
  assert.equal(config?.iamUrl, 'https://iam.example.com/token');
  assert.equal(config?.personUrl, 'https://people.example.com/query');
  assert.equal(config?.tlsVerify, false);
  assert.equal(
    getIdaasRegionAccessConfig(regionEnv({ IDAAS_REGION_ACCESS_TLS_VERIFY: 'true' }))?.tlsVerify,
    true,
  );

  assert.throws(
    () => getIdaasRegionAccessConfig(regionEnv({ IDAAS_REGION_ACCESS_TLS_VERIFY: 'invalid' })),
    IdaasRegionAccessConfigurationError,
  );
  assert.throws(
    () => getIdaasRegionAccessConfig(regionEnv({ IDAAS_REGION_ACCESS_IAM_SECRET: '' })),
    IdaasRegionAccessConfigurationError,
  );
});

test('人员查询固定发送 uuids 数组，直接常驻地命中欧盟时拒绝', async () => {
  const requests: Array<{ url: string; init: any }> = [];
  let tlsVerify: boolean | null = null;
  const checker = createIdaasRegionAccessChecker({
    env: regionEnv(),
    dispatcherFactory: (value) => {
      tlsVerify = value;
      return {} as any;
    },
    fetcher: (async (url: string | URL, init?: any) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('/token')) return response({ access_token: 'iam-token' });
      return response({
        data: {
          result: [{ baseLocationNameEn: 'France\\Paris' }],
        },
      });
    }) as any,
  });

  assert.equal(await checker.check('employee-uuid-001'), 'restricted');
  assert.equal(tlsVerify, false);
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    uuids: ['employee-uuid-001'],
  });
  assert.equal(requests[1].init.headers.Authorization, 'iam-token');
});

test('IAM token 缓存 10 小时，人员数据缓存 2 小时', async () => {
  let currentTime = 1_800_000_000_000;
  let tokenRequests = 0;
  let personRequests = 0;
  const checker = createIdaasRegionAccessChecker({
    env: regionEnv(),
    now: () => currentTime,
    dispatcherFactory: () => ({} as any),
    fetcher: (async (url: string | URL) => {
      if (String(url).includes('/token')) {
        tokenRequests += 1;
        return response({ access_token: 'iam-token' });
      }
      personRequests += 1;
      return response({
        data: {
          result: [{ baseLocationNameEn: 'Canada\\Toronto' }],
        },
      });
    }) as any,
  });

  assert.equal(await checker.check('employee-uuid-001'), 'allowed');
  assert.equal(await checker.check('employee-uuid-001'), 'allowed');
  assert.equal(tokenRequests, 1);
  assert.equal(personRequests, 1);

  currentTime += (2 * 60 * 60 * 1000) + 1;
  assert.equal(await checker.check('employee-uuid-001'), 'allowed');
  assert.equal(tokenRequests, 1);
  assert.equal(personRequests, 2);

  currentTime += (8 * 60 * 60 * 1000) + 1;
  assert.equal(await checker.check('employee-uuid-002'), 'allowed');
  assert.equal(tokenRequests, 2);
  assert.equal(personRequests, 3);
});

test('常驻地为空时依次检查组织树和主管常驻地', async () => {
  const organizationChecker = createIdaasRegionAccessChecker({
    env: regionEnv(),
    dispatcherFactory: () => ({} as any),
    fetcher: (async (url: string | URL) => {
      if (String(url).includes('/token')) return response({ access_token: 'iam-token' });
      return response({
        data: {
          result: [{ orgTreeNameEn: 'Global European Operations' }],
        },
      });
    }) as any,
  });
  assert.equal(await organizationChecker.check('employee-uuid-org'), 'restricted');

  const personBodies: unknown[] = [];
  const managerChecker = createIdaasRegionAccessChecker({
    env: regionEnv(),
    dispatcherFactory: () => ({} as any),
    fetcher: (async (url: string | URL, init?: any) => {
      if (String(url).includes('/token')) return response({ access_token: 'iam-token' });
      const body = JSON.parse(init.body);
      personBodies.push(body);
      if (body.uuids) {
        return response({
          data: {
            result: [{ orgTreeNameEn: 'Global Operations', orgManagerNumber: 'manager-001' }],
          },
        });
      }
      return response({
        data: {
          result: [{ baseLocationNameEn: 'Germany\\Berlin' }],
        },
      });
    }) as any,
  });

  assert.equal(await managerChecker.check('employee-uuid-manager'), 'restricted');
  assert.deepEqual(personBodies, [
    { uuids: ['employee-uuid-manager'] },
    { employeeNumbers: ['manager-001'] },
  ]);
});

test('IAM 或人员数据异常时 fail-closed，且异常不会进入人员缓存', async () => {
  let personRequests = 0;
  const checker = createIdaasRegionAccessChecker({
    env: regionEnv(),
    dispatcherFactory: () => ({} as any),
    fetcher: (async (url: string | URL) => {
      if (String(url).includes('/token')) return response({ access_token: 'iam-token' });
      personRequests += 1;
      return response({ data: { result: [] } });
    }) as any,
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      () => checker.check('employee-uuid-missing'),
      (error: unknown) => (
        error instanceof IdaasRegionAccessRequestError
        && error.code === 'region_data_missing'
      ),
    );
  }
  assert.equal(personRequests, 2);

  const unavailableChecker = createIdaasRegionAccessChecker({
    env: regionEnv(),
    dispatcherFactory: () => ({} as any),
    fetcher: (async () => {
      throw new Error('internal endpoint details must not escape');
    }) as any,
  });
  await assert.rejects(
    () => unavailableChecker.check('employee-uuid-failed'),
    (error: unknown) => (
      error instanceof IdaasRegionAccessRequestError
      && error.code === 'region_token_request_failed'
    ),
  );
});

test('缓存 IAM token 被人员接口拒绝时刷新一次后重试', async () => {
  let tokenRequests = 0;
  let personRequests = 0;
  const checker = createIdaasRegionAccessChecker({
    env: regionEnv(),
    dispatcherFactory: () => ({} as any),
    fetcher: (async (url: string | URL) => {
      if (String(url).includes('/token')) {
        tokenRequests += 1;
        return response({ access_token: 'iam-token-' + tokenRequests });
      }
      personRequests += 1;
      if (personRequests === 1) return response({}, 401);
      return response({
        data: {
          result: [{ baseLocationNameEn: 'Canada\\Toronto' }],
        },
      });
    }) as any,
  });

  assert.equal(await checker.check('employee-uuid-refresh'), 'allowed');
  assert.equal(tokenRequests, 2);
  assert.equal(personRequests, 2);
});

test('地区校验发生在创建用户之前，登录页区分两种地区错误', () => {
  const callback = fs.readFileSync(
    path.resolve(__dirname, '../src/app/api/auth/idaas-oauth/callback/route.ts'),
    'utf8',
  );
  assert.ok(
    callback.indexOf('checkIdaasRegionAccess(userInfo.uuid)')
      < callback.indexOf('findOrCreateLocalUser(userInfo.uuid)'),
  );
  assert.match(callback, /fail\('region_restricted'/);
  assert.match(callback, /fail\('region_check_unavailable'/);

  const loginPage = fs.readFileSync(
    path.resolve(__dirname, '../src/app/login/page.tsx'),
    'utf8',
  );
  assert.match(loginPage, /login\.identityRegionRestricted/);
  assert.match(loginPage, /login\.identityRegionCheckUnavailable/);

  const apiKeyRoute = fs.readFileSync(
    path.resolve(__dirname, '../src/app/api/auth/apikey/route.ts'),
    'utf8',
  );
  assert.ok(
    apiKeyRoute.indexOf('user.username !== username')
      < apiKeyRoute.indexOf('checkIdaasRegionAccess(user.username)'),
  );
  assert.match(apiKeyRoute, /code: 'region_restricted'/);
  assert.match(apiKeyRoute, /code: 'region_check_unavailable'/);

  const authContext = fs.readFileSync(
    path.resolve(__dirname, '../src/lib/auth/auth-context.tsx'),
    'utf8',
  );
  assert.match(authContext, /IDAAS_REGION_ERROR_CODES/);
});

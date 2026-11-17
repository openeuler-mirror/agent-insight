import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/lib/auth/auth-context.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('auth-context.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function extractEffect(marker: string): ts.Node {
  let found: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0]?.getText(ast).includes(marker)) found = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, `未找到包含 ${marker} 的 useEffect`);
  return found;
}

function compileEffect(marker: string): string {
  return ts.transpileModule(`const effect = (${extractEffect(marker).getText(ast)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const restoreEffectSource = compileEffect('const restoreAuth =');
const loginModeEffectSource = compileEffect('check_login=true');

function createTimers() {
  const pending = new Map<number, () => void>();
  let nextId = 1;
  return {
    setTimeout: (fn: () => void) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, fn);
      return id;
    },
    clearTimeout: (id: number) => { pending.delete(id); },
    async flush() {
      for (let i = 0; i < 20; i += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
        const due = [...pending.values()];
        pending.clear();
        for (const fn of due) fn();
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    },
  };
}

interface RestoreState {
  user: string | null;
  displayName: string | null;
  apiKey: string | null;
  ready: boolean;
  regionError: string | null;
}

function restoreHarness(
  request: (url: string, init?: RequestInit) => Promise<Response>,
  loginMode = 'standalone',
  sharedStorage?: Map<string, string>,
) {
  const stored = sharedStorage ?? new Map([['user_id', 'test_person@example.com'], ['api_key', 'fixture-key']]);
  const state: RestoreState = { user: null, displayName: null, apiKey: null, ready: false, regionError: null };
  const timers = createTimers();
  const scope = {
    loginModeReady: true,
    loginMode,
    IDAAS_REGION_ERROR_CODES: new Set(['region_restricted', 'region_check_unavailable']),
    AUTH_RESTORE_MAX_ATTEMPTS: 3,
    AUTH_RESTORE_RETRY_DELAY_MS: 400,
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    },
    apiFetch: request,
    setUser: (value: string | null) => { state.user = value; },
    setApiKey: (value: string | null) => { state.apiKey = value; },
    setDisplayName: (value: string | null) => { state.displayName = value; },
    setAuthReady: (value: boolean) => { state.ready = value; },
    setIdaasRegionError: (value: string | null) => { state.regionError = value; },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    console: { error: () => {} },
  };
  const effect = new Function(...Object.keys(scope), `${restoreEffectSource}\nreturn effect;`)(...Object.values(scope));
  return { stored, state, start: () => effect() as () => void, flush: () => timers.flush() };
}

interface LoginModeState {
  mode: string | null;
  redirectUrl: string;
  ready: boolean;
}

function loginModeHarness(request: (url: string) => Promise<Response>) {
  const state: LoginModeState = { mode: null, redirectUrl: '', ready: false };
  const timers = createTimers();
  const scope = {
    CLIENT_LOGIN_MODES: new Set(['standalone', 'organization', 'idaas_oauth']),
    LOGIN_MODE_RETRY_DELAY_MS: 400,
    LOGIN_MODE_MAX_RETRY_DELAY_MS: 3000,
    apiFetch: request,
    setLoginMode: (value: string) => { state.mode = value; },
    setOrganizationLoginRedirectUrl: (value: string) => { state.redirectUrl = value; },
    setLoginModeReady: (value: boolean) => { state.ready = value; },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    console: { error: () => {} },
  };
  const effect = new Function(...Object.keys(scope), `${loginModeEffectSource}\nreturn effect;`)(...Object.values(scope));
  return { state, start: () => effect() as () => void, flush: () => timers.flush() };
}

test('登录恢复网络中断保留凭据，但不把未完成的认证标为已登录', async () => {
  const h = restoreHarness(async () => { throw new TypeError('Failed to fetch'); });
  h.start();
  await h.flush();
  assert.equal(h.stored.get('user_id'), 'test_person@example.com');
  assert.equal(h.stored.get('api_key'), 'fixture-key');
  assert.equal(h.state.user, null);
  assert.equal(h.state.apiKey, null);
  assert.equal(h.state.ready, true);
});

test('登录恢复遇到瞬时中断会重试并最终恢复登录', async () => {
  let calls = 0;
  const h = restoreHarness(async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('Failed to fetch');
    return Response.json({ username: 'test_person@example.com', apiKey: 'refreshed-fixture-key' });
  });
  h.start();
  await h.flush();
  assert.equal(calls, 2);
  assert.equal(h.state.user, 'test_person@example.com');
  assert.equal(h.state.apiKey, 'refreshed-fixture-key');
  assert.equal(h.stored.get('api_key'), 'refreshed-fixture-key');
  assert.equal(h.state.ready, true);
});

test('登录恢复服务端 500 不撤销有效凭据', async () => {
  const h = restoreHarness(async () => Response.json({ error: 'Temporary server failure' }, { status: 500 }));
  h.start();
  await h.flush();
  assert.equal(h.stored.get('user_id'), 'test_person@example.com');
  assert.equal(h.stored.get('api_key'), 'fixture-key');
  assert.equal(h.state.user, null);
  assert.equal(h.state.ready, true);
});

for (const status of [401, 403]) {
  test(`登录恢复收到 ${status} 明确拒绝时清除凭据`, async () => {
    const h = restoreHarness(async () => Response.json({ error: 'Rejected' }, { status }));
    h.start();
    await h.flush();
    assert.equal(h.stored.has('user_id'), false);
    assert.equal(h.stored.has('api_key'), false);
    assert.equal(h.state.user, null);
    assert.equal(h.state.ready, true);
  });
}

test('IDaaS 地域限制继续清除凭据并保留限制原因', async () => {
  const h = restoreHarness(
    async () => Response.json({ code: 'region_restricted' }, { status: 403 }),
    'idaas_oauth',
  );
  h.start();
  await h.flush();
  assert.equal(h.state.regionError, 'region_restricted');
  assert.equal(h.stored.has('api_key'), false);
});

test('登录模式配置错误不清除本地凭据', async () => {
  const h = restoreHarness(
    async () => { throw new Error('should not request auth with invalid mode'); },
    'invalid',
  );
  h.start();
  await h.flush();
  assert.equal(h.stored.get('api_key'), 'fixture-key');
  assert.equal(h.state.user, null);
  assert.equal(h.state.ready, true);
});

test('已卸载页面的迟到拒绝不能清除后续页面使用的凭据', async () => {
  let finish!: (value: Response) => void;
  const h = restoreHarness(() => new Promise(resolve => { finish = resolve; }));
  const cleanup = h.start();
  cleanup();
  finish(Response.json({ error: 'Rejected' }, { status: 401 }));
  await h.flush();
  assert.equal(h.stored.get('api_key'), 'fixture-key');
  assert.equal(h.state.ready, false);
});

test('连续导航打断恢复请求后，新页面仍能恢复同一登录身份', async () => {
  const shared = new Map([['user_id', 'test_person@example.com'], ['api_key', 'fixture-key']]);
  let abortInFlight!: (reason: Error) => void;
  const interrupted = restoreHarness(
    () => new Promise<Response>((_resolve, reject) => { abortInFlight = reject; }),
    'standalone',
    shared,
  );
  const cleanup = interrupted.start();
  cleanup();
  abortInFlight(new TypeError('Failed to fetch'));
  await interrupted.flush();
  assert.equal(interrupted.state.ready, false);
  assert.equal(shared.get('user_id'), 'test_person@example.com');
  assert.equal(shared.get('api_key'), 'fixture-key');

  const reloaded = restoreHarness(
    async () => Response.json({ username: 'test_person@example.com', apiKey: 'fixture-key' }),
    'standalone',
    shared,
  );
  reloaded.start();
  await reloaded.flush();
  assert.equal(reloaded.state.user, 'test_person@example.com');
  assert.equal(reloaded.state.ready, true);
});

test('成功恢复仍使用服务器返回的身份和凭据', async () => {
  const h = restoreHarness(async () => Response.json({ username: 'test_person@example.com', apiKey: 'refreshed-fixture-key' }));
  h.start();
  await h.flush();
  assert.equal(h.state.user, 'test_person@example.com');
  assert.equal(h.state.apiKey, 'refreshed-fixture-key');
  assert.equal(h.stored.get('api_key'), 'refreshed-fixture-key');
  assert.equal(h.state.ready, true);
});

test('登录模式探测遇到瞬时失败会重试，不会把用户当作未登录', async () => {
  let calls = 0;
  const h = loginModeHarness(async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('Failed to fetch');
    return Response.json({ login_mode: 'standalone' });
  });
  h.start();
  await h.flush();
  assert.equal(calls, 2);
  assert.equal(h.state.mode, 'standalone');
  assert.equal(h.state.ready, true);
});

test('登录模式明确配置错误时直接提示，不重试', async () => {
  let calls = 0;
  const h = loginModeHarness(async () => {
    calls += 1;
    return Response.json({ login_mode: 'bogus' });
  });
  h.start();
  await h.flush();
  assert.equal(calls, 1);
  assert.equal(h.state.mode, 'invalid');
  assert.equal(h.state.ready, true);
});

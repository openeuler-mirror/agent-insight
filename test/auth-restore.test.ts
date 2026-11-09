import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/lib/auth/auth-context.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('auth-context.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Node | undefined;
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
    && node.arguments[0]?.getText(ast).includes('const restoreAuth =')) callback = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(callback);
const compiled = ts.transpileModule(`const effect = (${callback.getText(ast)});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function restoreHarness(request: () => Promise<Response>, loginMode = 'standalone') {
  const stored = new Map([['user_id', 'test_person@example.com'], ['api_key', 'fixture-key']]);
  const state: { user: string | null; apiKey: string | null; ready: boolean; regionError: string | null } = {
    user: null, apiKey: null, ready: false, regionError: null,
  };
  const scope = {
    loginModeReady: true, loginMode,
    IDAAS_REGION_ERROR_CODES: new Set(['region_restricted', 'region_check_unavailable']),
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    },
    apiFetch: request,
    setUser: (value: string | null) => { state.user = value; },
    setApiKey: (value: string | null) => { state.apiKey = value; },
    setDisplayName: () => {},
    setAuthReady: (value: boolean) => { state.ready = value; },
    setIdaasRegionError: (value: string | null) => { state.regionError = value; },
    console: { error: () => {} },
  };
  const effect = new Function(...Object.keys(scope), `${compiled}\nreturn effect;`)(...Object.values(scope));
  return { stored, state, start: () => effect() as () => void };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('登录恢复网络中断保留凭据，但不把未完成的认证标为已登录', async () => {
  const h = restoreHarness(async () => { throw new TypeError('Failed to fetch'); });
  h.start();await settle();
  assert.equal(h.stored.get('user_id'), 'test_person@example.com');
  assert.equal(h.stored.get('api_key'), 'fixture-key');
  assert.equal(h.state.user, null);
  assert.equal(h.state.apiKey, null);
  assert.equal(h.state.ready, true);
});

test('登录恢复服务端 500 不撤销有效凭据', async () => {
  const h = restoreHarness(async () => Response.json({ error: 'Temporary server failure' }, { status: 500 }));
  h.start();await settle();
  assert.equal(h.stored.get('user_id'), 'test_person@example.com');
  assert.equal(h.stored.get('api_key'), 'fixture-key');
  assert.equal(h.state.user, null);
});

for (const status of [401, 403]) {
  test(`登录恢复收到 ${status} 明确拒绝时清除凭据`, async () => {
    const h = restoreHarness(async () => Response.json({ error: 'Rejected' }, { status }));
    h.start();await settle();
    assert.equal(h.stored.has('user_id'), false);
    assert.equal(h.stored.has('api_key'), false);
    assert.equal(h.state.user, null);
    assert.equal(h.state.ready, true);
  });
}

test('IDaaS 地域限制继续清除凭据并保留限制原因', async () => {
  const h = restoreHarness(async () => Response.json({ code: 'region_restricted' }, { status: 403 }), 'idaas_oauth');
  h.start();await settle();
  assert.equal(h.state.regionError, 'region_restricted');
  assert.equal(h.stored.has('api_key'), false);
});

test('已卸载页面的迟到拒绝不能清除后续页面使用的凭据', async () => {
  let finish!: (value: Response) => void;
  const h = restoreHarness(() => new Promise(resolve => { finish = resolve; }));
  const cleanup = h.start();cleanup();
  finish(Response.json({ error: 'Rejected' }, { status: 401 }));await settle();
  assert.equal(h.stored.get('api_key'), 'fixture-key');
  assert.equal(h.state.ready, false);
});

test('成功恢复仍使用服务器返回的身份和凭据', async () => {
  const h = restoreHarness(async () => Response.json({ username: 'test_person@example.com', apiKey: 'refreshed-fixture-key' }));
  h.start();await settle();
  assert.equal(h.state.user, 'test_person@example.com');
  assert.equal(h.state.apiKey, 'refreshed-fixture-key');
  assert.equal(h.stored.get('api_key'), 'refreshed-fixture-key');
  assert.equal(h.state.ready, true);
});

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function fixture() {
  let authorizations = 0;
  let configReads = 0;
  const module = {exports: {} as {GET?: (request: Request) => Promise<Response>}};
  const dependencies: Record<string, unknown> = {
    '@/lib/storage-core/control-route': {withCoreControlRoute: async () => {
      authorizations++;
      return Response.json({error: 'Unauthorized'}, {status: 401});
    }},
    '@/lib/storage/prisma': {db: {findConfigById: async () => {configReads++; throw Error('unauthorized config read');}}},
    '@/lib/engine/evaluation/config-dataset': {normalizeConfigDatasetType: (value: unknown) => value},
    '@/lib/auth/login-mode': {resolveLoginMode: () => 'standalone'},
    'next/server': {NextResponse: Response},
  };
  const source = readFileSync('src/app/api/eval/config/status/route.ts', 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, {
    module, exports: module.exports, require: (name: string) => {
      assert.ok(name in dependencies, name);
      return dependencies[name];
    }, URL, Response, process: {env: {}}, console,
  });
  return {get: (query: string) => module.exports.GET!(new Request('http://localhost/api/eval/config/status?' + query)),
    counts: () => ({authorizations, configReads})};
}

test('login mode and organization probes remain available before sign-in without reading config data', async () => {
  const f = fixture();
  for (const query of ['check_login=true', 'check_org=true', 'check_login=true&id=private-config']) {
    const response = await f.get(query);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {login_mode: 'standalone', org_mode: false, org_login_redirect_url: ''});
  }
  assert.deepEqual(f.counts(), {authorizations: 0, configReads: 0});
});

test('config status data still requires the existing authenticated control scope', async () => {
  const f = fixture();
  for (const query of ['id=private-config', 'check_login=false&id=private-config', '']) {
    assert.equal((await f.get(query)).status, 401);
  }
  assert.deepEqual(f.counts(), {authorizations: 3, configReads: 0});
});

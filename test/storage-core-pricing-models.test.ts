import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const helperFile = new URL('../src/lib/storage-core/observed-models.ts', import.meta.url);
const token = 'session_' + 'A'.repeat(43);
process.env.AGENT_INSIGHT_STORAGE_CORE_URL = 'http://127.0.0.1:19000';
const request = (query = '?user=admin&traceUser=other', credential = token) => new Request('http://localhost/api/modelconfig/pricing' + query, {
  headers: credential ? {authorization: 'Bearer ' + credential} : {},
});
const profile = (username: string | null = 'alice') => ({principal_id: 'principal-a', username, workspace_id: 'private-a', workspaces: [{workspace_id: 'private-a', role: 'member'}]});

async function helper() {
  assert.ok(fs.existsSync(helperFile), 'authorized observed-model facet helper is missing');
  return import('../src/lib/storage-core/observed-models');
}

function route(options: {core?: boolean; reader?: (req: Request) => Promise<{username: string; models: string[]}>; legacyModels?: Array<{model: string | null}>} = {}) {
  let oldReads = 0; let authReads = 0; let coreReads = 0; let hint: unknown;
  const deps: Record<string, unknown> = {
    'next/server': {NextResponse: Response},
    '@/lib/storage-core/mode': {isStorageCoreEnabled: () => options.core !== false},
    '@/lib/storage-core/observed-models': {readCoreObservedModels: async (req: Request) => {
      coreReads++; return options.reader ? options.reader(req) : {username: 'alice', models: ['zeta', ' unknown ', 'alpha', 'null', ' alpha ']};
    }},
    '@/lib/storage-core/compat': {compatibilityFailure: (error: {status?: number}) => Response.json({error: 'Storage request failed'}, {status: error.status || 502})},
    '@/lib/storage/prisma': {prisma: {execution: {findMany: async (query: unknown) => {
      oldReads++;
      if (options.core !== false) throw Error('Legacy Execution storage is poisoned');
      assert.deepEqual(JSON.parse(JSON.stringify(query)), {where: {model: {not: null}}, distinct: ['model'], select: {model: true}});
      return options.legacyModels || [];
    }}}},
    '@/lib/auth/auth': {resolveUser: async (_req: Request, supplied: unknown) => {authReads++; hint = supplied; return {username: 'legacy-user'};}},
    '@/lib/auth/admin': {isAdminUser: (name: unknown) => name === 'admin'},
    '@/lib/usage-analytics/collector': {},
    '@/lib/shared/model-config': {
      BUILTIN_MODEL_PRICING: {'builtin': {inputTokenPrice: 1, outputTokenPrice: 2}},
      BUILTIN_CONTEXT_WINDOWS: {'builtin': 1000},
      getCustomModels: () => ({pricing: {'custom': {inputTokenPrice: 3, outputTokenPrice: 4}}, contextWindows: {'custom': 2000}}),
      getModelPricing: (model: string) => model === 'alpha' ? {source: 'builtin'} : null,
    },
  };
  const module = {exports: {}};
  const source = ts.transpileModule(fs.readFileSync(new URL('../src/app/api/modelconfig/pricing/route.ts', import.meta.url), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  vm.runInNewContext(source, {module, exports: module.exports, require: (name: string) => deps[name] || {}, Request, Response, URL, Set, console: {error() {}}});
  return {GET: (module.exports as {GET(req: Request): Promise<Response>}).GET, counts: () => ({oldReads, authReads, coreReads, hint})};
}

test('original pricing GET observes core models with poisoned legacy Execution and preserves price DTO', async () => {
  const api = route(); const response = await api.GET(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    isAdmin: false, currency: 'USD',
    builtin: [{key: 'builtin', inputTokenPrice: 1, outputTokenPrice: 2, cacheReadInputTokenPrice: null, cacheCreationInputTokenPrice: null, contextWindow: 1000}],
    custom: [{key: 'custom', inputTokenPrice: 3, outputTokenPrice: 4, cacheReadInputTokenPrice: null, cacheCreationInputTokenPrice: null, contextWindow: 2000}],
    observed: [{model: 'alpha', hasPricing: true, source: 'builtin'}, {model: 'zeta', hasPricing: false, source: null}],
  });
  assert.deepEqual(api.counts(), {oldReads: 0, authReads: 0, coreReads: 1, hint: undefined});
});

test('core price-admin display uses verified actor username and cannot be elevated by query user', async () => {
  for (const username of ['alice', 'admin']) {
    const api = route({reader: async () => ({username, models: []})});
    const response = await api.GET(request('?user=' + (username === 'admin' ? 'alice' : 'admin')));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).isAdmin, username === 'admin');
    assert.equal(api.counts().authReads, 0);
  }
});

test('legacy pricing GET preserves distinct Prisma query and previous auth path', async () => {
  const api = route({core: false, legacyModels: [{model: 'zeta'}, {model: ' none '}, {model: 'alpha'}, {model: null}]});
  const response = await api.GET(request('?user=legacy-hint'));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).observed, [{model: 'alpha', hasPricing: true, source: 'builtin'}, {model: 'zeta', hasPricing: false, source: null}]);
  assert.deepEqual(api.counts(), {oldReads: 1, authReads: 1, coreReads: 0, hint: 'legacy-hint'});
});

test('core helper requests only model facets with authenticated token/workspace, ignoring forged owner/admin filters', async () => {
  const {readCoreObservedModels} = await helper(); const paths: URL[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const target = new URL(String(url)); paths.push(target);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + token);
    assert.ok(init?.signal); assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store');
    if (target.pathname === '/v1/auth/me') return Response.json(profile());
    assert.equal(target.pathname, '/v1/compat/observe/data');
    assert.deepEqual([...target.searchParams.entries()], [['workspace_id', 'private-a'], ['facet', 'values'], ['column', 'model']]);
    return Response.json({value: [{value: 'owner-model', count: 2}]});
  };
  const value = await readCoreObservedModels(request('?user=admin&traceUser=other&showAllUsers=true&page=123'), {fetcher});
  assert.deepEqual(value, {username: 'alice', models: ['owner-model']});
  assert.equal(paths.length, 2);
});

test('core pricing anonymous, missing actor username and unauthorized workspace fail before model reads', async () => {
  const {readCoreObservedModels} = await helper();
  let facetReads = 0;
  const fetcher: typeof fetch = async (url) => {
    if (new URL(String(url)).pathname === '/v1/auth/me') return Response.json(profile(null));
    facetReads++; return Response.json({value: []});
  };
  await assert.rejects(readCoreObservedModels(request('?user=admin', ''), {fetcher}), error => (error as {status?: number}).status === 401);
  await assert.rejects(readCoreObservedModels(request(), {fetcher}), error => (error as {status?: number}).status === 403);
  await assert.rejects(readCoreObservedModels(request('?workspace_id=other&user=admin'), {fetcher}), error => (error as {status?: number}).status === 403);
  assert.equal(facetReads, 0);
});

test('core pricing preserves explicit backend denial/outage errors and never returns an empty successful observed list', async () => {
  const {readCoreObservedModels} = await helper();
  for (const status of [403, 503, 413]) {
    const fetcher: typeof fetch = async (url) => new URL(String(url)).pathname === '/v1/auth/me' ? Response.json(profile()) : new Response('PRIVATE-BACKEND-ERROR', {status});
    const api = route({reader: req => readCoreObservedModels(req, {fetcher})});
    const response = await api.GET(request());
    assert.equal(response.status, status);
    const body = await response.text(); assert.ok(!body.includes('observed')); assert.ok(!body.includes('PRIVATE-BACKEND-ERROR'));
    assert.equal(api.counts().oldReads, 0);
  }
});

test('strict facets reject malformed rows, duplicates, extra response fields and budget/partial results', async () => {
  const {readCoreObservedModels} = await helper();
  const malformed = [
    {}, {value: null}, {value: {storeError: 'offline'}}, {value: [] , next_cursor: 'partial'},
    {value: [{value: 'model', count: '1'}]}, {value: [{value: 'model', count: 0}]},
    {value: [{value: 'model', count: 1.5}]}, {value: [{value: null, count: 1}]},
    {value: [{value: 'model', count: 1, owner: 'private'}]},
    {value: [{value: 'model', count: 1}, {value: 'model', count: 2}]},
  ];
  for (const value of malformed) {
    const fetcher: typeof fetch = async url => new URL(String(url)).pathname === '/v1/auth/me' ? Response.json(profile()) : Response.json(value);
    await assert.rejects(readCoreObservedModels(request(), {fetcher}), error => (error as {status?: number}).status === 502);
  }
  const fetcher: typeof fetch = async url => new URL(String(url)).pathname === '/v1/auth/me' ? Response.json(profile()) : Response.json({value: Array.from({length: 10001}, (_, i) => ({value: 'model-' + i, count: 1}))});
  await assert.rejects(readCoreObservedModels(request(), {fetcher}), error => (error as {status?: number}).status === 413);
});

test('actual facet response bytes and model length are bounded and partial HTTP responses are refused', async () => {
  const {readCoreObservedModels} = await helper();
  for (const [response, status] of [
    [Response.json({value: [{value: 'x'.repeat(2 * 1024 * 1024), count: 1}]}), 502],
    [Response.json({value: [{value: 'x'.repeat(4097), count: 1}]}), 413],
    [Response.json({value: []}, {status: 206}), 502],
  ] as const) {
    const fetcher: typeof fetch = async url => new URL(String(url)).pathname === '/v1/auth/me' ? Response.json(profile()) : response;
    await assert.rejects(readCoreObservedModels(request(), {fetcher}), error => (error as {status?: number}).status === status);
  }
});

test('network and abort failures cannot become a successful empty pricing response', async () => {
  const {readCoreObservedModels} = await helper();
  for (const error of [new TypeError('PRIVATE-NETWORK'), new DOMException('PRIVATE-ABORT', 'AbortError')]) {
    const fetcher: typeof fetch = async url => {
      if (new URL(String(url)).pathname === '/v1/auth/me') return Response.json(profile());
      throw error;
    };
    const api = route({reader: req => readCoreObservedModels(req, {fetcher})});
    const response = await api.GET(request());
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes('PRIVATE-'));
    assert.equal(api.counts().oldReads, 0);
  }
});

test('distinct authenticated owners receive their own model facet and group admin adds no global bypass', async () => {
  const {readCoreObservedModels} = await helper();
  for (const [credential, username, role] of [[token, 'alice', 'member'], ['session_' + 'B'.repeat(43), 'bob', 'admin']]) {
    const fetcher: typeof fetch = async (url, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + credential);
      const target = new URL(String(url));
      if (target.pathname === '/v1/auth/me') return Response.json({...profile(username), workspaces: [{workspace_id: 'private-a', role}]});
      assert.equal(target.searchParams.has('showAllUsers'), false); assert.equal(target.searchParams.has('user'), false);
      return Response.json({value: [{value: username + '-authorized-model', count: 1}]});
    };
    assert.deepEqual((await readCoreObservedModels(request('?user=admin', credential), {fetcher})).models, [username + '-authorized-model']);
  }
});

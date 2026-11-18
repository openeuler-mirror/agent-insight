import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const pages = [
  'src/app/(main)/infra/page.tsx',
  'src/app/(main)/infra/sources/page.tsx',
  'src/app/(main)/infra/source/[id]/page.tsx',
  'src/components/observe/AgentTraceView.tsx',
];
function compile(path: string, globals: Record<string, unknown>) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, ...globals });
  return module.exports;
}

test('all original Infra UI fetch calls use the authenticated transport', () => {
  for (const file of pages) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    assert.ok(source.statements.some(statement => ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === '@/lib/client/api'
      && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
      && statement.importClause.namedBindings.elements.some(element => element.propertyName?.text === 'apiFetch' && element.name.text === 'fetch')), file);
  }
  const detail = fs.readFileSync(pages[2], 'utf8');
  assert.ok(detail.includes('await downloadApiFile(`/api/observe/infra/export?${qs}`, `infra.${format}`)'));
  assert.ok(!detail.includes('a.href = `/api/observe/infra/export?${qs}`'));
});

test('Infra requests retain URLs, methods, bodies, abort and streaming while reading current credentials', async () => {
  let key = 'first-owner';
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const api = compile('src/lib/client/api.ts', {
    Headers, Response, Date, process: { env: { NEXT_PUBLIC_URL_PREFIX: '/insight' } }, window: {},
    localStorage: { getItem: () => key },
    fetch: async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      return new Response('data: original\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
  }) as { apiFetch: (url: string, options?: RequestInit) => Promise<Response> };
  const abort = new AbortController();
  const form = new FormData(); form.set('file', new Blob(['original']), 'metrics.txt');
  for (const [url, options] of [
    ['/api/observe/infra/sources/overview', { cache: 'no-store' }],
    ['/api/observe/infra/sources', { method: 'POST', body: form, signal: abort.signal }],
    ['/api/observe/infra/sources', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":false}' }],
    ['/api/observe/infra/sources?id=a%2Fb', { method: 'DELETE' }],
    ['/api/observe/infra/poll', { method: 'POST' }],
    ['/api/observe/infra/diagnose?target=http%3A%2F%2Flocal&samples=2', { headers: { Accept: 'text/event-stream' }, signal: abort.signal }],
    ['/api/observe/executions/trace%2Fid/infra', { method: 'PUT', body: '{"links":[]}' }],
    ['/api/observe/infra/history?sourceId=a%2Fb&from=0&to=9', {}],
    ['/api/observe/infra/sources/sessions?sourceId=a%2Fb&page=2', {}],
    ['/api/observe/infra/export?sourceId=a%2Fb&format=csv', {}],
  ] as Array<[string, RequestInit]>) {
    const response = await api.apiFetch(url, options);
    const call = calls.at(-1)!;
    assert.equal(call.url, '/insight' + url);
    assert.equal(call.options.method, options.method);
    assert.equal(call.options.body, options.body);
    assert.equal(call.options.signal, options.signal);
    assert.equal(call.options.cache, options.cache);
    assert.equal(new Headers(call.options.headers).get('x-witty-api-key'), key);
    assert.equal(new Headers(call.options.headers).get('Content-Type'), new Headers(options.headers).get('Content-Type'));
    assert.equal(new Headers(call.options.headers).get('Accept'), new Headers(options.headers).get('Accept'));
    assert.equal(response.bodyUsed, false);
    assert.equal(await response.text(), 'data: original\n\n');
    key = 'next-owner';
  }
  await api.apiFetch('/api/observe/infra/sources', { headers: { authorization: 'Bearer explicit' } });
  assert.equal(new Headers(calls.at(-1)!.options.headers).get('x-witty-api-key'), null);
  await api.apiFetch('https://example.invalid/api/observe/infra/sources');
  assert.equal(new Headers(calls.at(-1)!.options.headers).get('x-witty-api-key'), null);
});

test('authenticated Infra downloads retain response filename, binary bytes and release object URLs', async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62, 0x0a]);
  const urls: string[] = []; const downloads: Array<{ href: string; download: string }> = [];
  let blob: Blob | undefined; let removed = 0; const revoked: string[] = [];
  const anchor = { href: '', download: '', click() { downloads.push({ href: this.href, download: this.download }); }, remove() { removed++; } };
  let ok = true;
  const helper = compile('src/lib/client/download.ts', {
    require: (name: string) => { assert.equal(name, './api'); return { apiFetch: async (url: string) => {
      urls.push(url); return ok ? new Response(bytes, { headers: { 'Content-Disposition': 'attachment; filename="infra-model-20261118.csv"' } })
        : new Response('{"error":"unauthorized"}', { status: 401 });
    } }; },
    document: { createElement: (name: string) => { assert.equal(name, 'a'); return anchor; }, body: { appendChild: (value: unknown) => assert.equal(value, anchor) } },
    URL: { createObjectURL: (value: Blob) => { blob = value; return 'blob:infra-export'; }, revokeObjectURL: (value: string) => revoked.push(value) },
    setTimeout: (callback: () => void) => callback(), Error,
  }) as { downloadApiFile: (url: string, fallbackFilename: string) => Promise<void> };
  const url = '/api/observe/infra/export?sourceId=a%2Fb&from=0&to=9&format=csv&metrics=gpu&sample=1000';
  await helper.downloadApiFile(url, 'infra.csv');
  assert.deepEqual(urls, [url]);
  assert.deepEqual(downloads, [{ href: 'blob:infra-export', download: 'infra-model-20261118.csv' }]);
  assert.deepEqual(new Uint8Array(await blob!.arrayBuffer()), bytes);
  assert.equal(removed, 1); assert.deepEqual(revoked, ['blob:infra-export']);
  ok = false;
  await assert.rejects(helper.downloadApiFile(url, 'infra.csv'), /401/);
  assert.equal(downloads.length, 1);
});

test('original detail export callback preserves source, time, model, metrics and sample query', async () => {
  const file = pages[2];
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'runExport') initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(initializer);
  const module = { exports: undefined as unknown };
  const calls: Array<[string, string]> = []; const hints: unknown[] = [];
  vm.runInNewContext(ts.transpileModule('module.exports = ' + initializer.getText(source), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, URLSearchParams, Error,
    useCallback: (callback: unknown) => callback,
    id: 'source/id', resolveRange: () => ({ from: 0, to: 9000 }), selectedModel: 'model/name',
    pickedGroups: ['gpu', 'tokens'], ALL_GROUPS: ['gpu', 'tokens', 'latency'], bucketMs: 1000,
    setExportHint: (hint: unknown) => hints.push(hint), reportClientUsage: () => {},
    downloadApiFile: async (url: string, fallback: string) => { calls.push([url, fallback]); },
  });
  const runExport = module.exports as (format: 'csv' | 'md') => Promise<void>;
  await runExport('csv'); await runExport('md');
  assert.deepEqual(calls, [
    ['/api/observe/infra/export?sourceId=source%2Fid&from=0&to=9000&format=csv&model=model%2Fname&metrics=gpu%2Ctokens&sample=1000', 'infra.csv'],
    ['/api/observe/infra/export?sourceId=source%2Fid&from=0&to=9000&format=md&model=model%2Fname&metrics=gpu%2Ctokens&sample=1000', 'infra.md'],
  ]);
  assert.deepEqual(hints, [null, null]);
});

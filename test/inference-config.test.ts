import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const modulePath = '../scripts/inference_config.mjs';
async function fixture(t: TestContext) {
    const api = await import(modulePath).catch(() => ({}));
    assert.equal(typeof api.syncConfigFiles, 'function', 'configuration sync must be implemented');
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inference-config-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const insightDir = path.join(dir, 'insight');
    const file = path.join(dir, 'opencode.jsonc');
    const origin = 'http://127.0.0.1:18080';
    const run = (files = [{ agent: 'opencode', file }], env: NodeJS.ProcessEnv = { NODE_ENV: 'test' }) => api.syncConfigFiles({ insightDir, origin, files, env });
    return { api, dir, insightDir, file, origin, run };
}
const openCode = (url = 'https://inference.example.test/v1') => `{
  // Keep this comment, whitespace, trailing commas and API key.
  "provider": { "custom": {
    "npm": "@ai-sdk/openai-compatible",
    "options": { "baseURL": ${JSON.stringify(url)}, "apiKey": "private-test-key", },
    "models": { "probe": {} },
  }, },
}\n`;
const readState = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'inference-proxy', 'config-state.json'), 'utf8'));

test('coverage counts current managed endpoints rather than retained routes or changed files', async t => {
    const f = await fixture(t); fs.writeFileSync(f.file, openCode());
    const first = f.run();
    assert.equal(first.managed?.length, 1);
    assert.equal(f.run().managed?.length, 1, 'an unchanged managed endpoint still counts');
    fs.writeFileSync(f.file, '{"provider":{}}');
    const removed = f.run();
    assert.equal(removed.routes.length, 1, 'historical routes remain available for in-flight requests');
    assert.deepEqual(removed.managed, [], 'historical routes must not imply current endpoint coverage');
});

test('sync changes only the exact JSONC endpoint token, creates no backups and is idempotent', async t => {
    const f = await fixture(t); const original = openCode(); fs.writeFileSync(f.file, original);
    const result = f.run(); assert.equal(result.routes.length, 1); assert.deepEqual(result.changed, [f.file]);
    const managed = f.origin + result.routes[0].basePath;
    assert.deepEqual(result.routes[0], { basePath: result.routes[0].basePath, agent: 'opencode', protocol: 'openai', upstreamBaseUrl: 'https://inference.example.test/v1' });
    assert.match(result.routes[0].basePath, /^\/managed\/opencode\/[a-f0-9]{24}$/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), original.replace(JSON.stringify('https://inference.example.test/v1'), JSON.stringify(managed)));
    assert.equal(fs.existsSync(path.join(f.insightDir, 'inference-proxy/backups')), false);
    assert.doesNotMatch(JSON.stringify(readState(f.insightDir)), /private-test-key/);
    assert.deepEqual(f.run().changed, []);
});

test('Qoder and OpenCode supported providers are rewritten while unsupported providers remain intact', async t => {
    const f = await fixture(t); const qoder = path.join(f.dir, 'settings.json');
    fs.writeFileSync(qoder, JSON.stringify({ providers: { q: { baseUrl: 'https://q.example/v1', type: 'openai-compatible', protocol: 'openai', apiKey: 'secret' } } }));
    fs.writeFileSync(f.file, JSON.stringify({ provider: { a: { npm: '@ai-sdk/anthropic', options: { baseURL: 'https://a.example/v1' } }, b: { npm: '@ai-sdk/openai', options: { baseURL: 'https://b.example/v1' } }, unsupported: { npm: '@ai-sdk/google', options: { baseURL: 'https://g.example/v1' } } } }));
    const result = f.run([{ agent: 'qoder', file: qoder }, { agent: 'opencode', file: f.file }]);
    assert.equal(result.routes.length, 3); assert.equal(result.unsupported.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).provider.unsupported.options.baseURL, 'https://g.example/v1');
    assert.equal(result.routes.find((r: { upstreamBaseUrl: string, basePath: string }) => r.upstreamBaseUrl === 'https://a.example/v1').protocol, 'anthropic');
    assert.equal(JSON.parse(fs.readFileSync(qoder, 'utf8')).providers.q.apiKey, 'secret');
});

test('sync keeps new providers and user edits, retains historical routes without reverting configuration', async t => {
    const f = await fixture(t); fs.writeFileSync(f.file, openCode());
    const first = f.run(); const managed = f.origin + first.routes[0].basePath;
    let edited = fs.readFileSync(f.file, 'utf8').replace(managed, 'https://changed.example/v1').replace('"probe": {}', '"probe": {}, "new-model": {}');
    edited = edited.replace('"provider": {', '"provider": { "new-provider": { "npm": "@ai-sdk/openai", "options": { "baseURL": "https://new.example/v1" } },');
    fs.writeFileSync(f.file, edited);
    const second = f.run(); assert.equal(second.routes.length, 3);
    assert.ok(second.routes.some((r: { upstreamBaseUrl: string, basePath: string }) => r.basePath === first.routes[0].basePath));
    assert.match(fs.readFileSync(f.file, 'utf8'), /new-model/);
    assert.ok(second.routes.some((r: { upstreamBaseUrl: string }) => r.upstreamBaseUrl === 'https://changed.example/v1'));
    assert.deepEqual(f.run().changed, []);
    assert.match(fs.readFileSync(f.file, 'utf8'), /new-provider/);
});

test('environment endpoints resolve afresh while the gateway retains the upstream expression', async t => {
    const f = await fixture(t); const original = openCode('{env:MODEL_BASE_URL}'); fs.writeFileSync(f.file, original);
    assert.equal(f.run().unsupported.length, 1); assert.equal(fs.readFileSync(f.file, 'utf8'), original);
    const first = f.run(undefined, { NODE_ENV: 'test', MODEL_BASE_URL: 'https://one.example/v1' });
    assert.equal(first.routes[0].upstreamBaseUrl, 'https://one.example/v1');
    const second = f.run(undefined, { NODE_ENV: 'test', MODEL_BASE_URL: 'https://two.example/v1' });
    assert.equal(second.routes.length, 2); assert.ok(second.routes.some((r: { upstreamBaseUrl: string, basePath: string }) => r.upstreamBaseUrl === 'https://two.example/v1'));
    assert.equal(Object.values(readState(f.insightDir).files[f.file].fields as Record<string, { original: string }>)[0].original, '{env:MODEL_BASE_URL}');
});

test('invalid syntax in another file prevents all config changes and duplicate keys are rejected', async t => {
    const f = await fixture(t); const original = openCode(); fs.writeFileSync(f.file, original);
    const bad = path.join(f.dir, 'bad.json'); fs.writeFileSync(bad, '{"providers": [');
    assert.throws(() => f.run([{ agent: 'opencode', file: f.file }, { agent: 'qoder', file: bad }]), /invalid|JSON|parse/i);
    assert.equal(fs.readFileSync(f.file, 'utf8'), original); assert.equal(fs.readFileSync(bad, 'utf8'), '{"providers": [');
    fs.writeFileSync(bad, '{"providers":{},"providers":{}}');
    assert.throws(() => f.run([{ agent: 'qoder', file: bad }]), /duplicate|JSON|invalid/i);
});

test('unknown managed URLs and non-HTTP upstreams are not rewritten or routed', async t => {
    const f = await fixture(t);
    for (const address of [f.origin + '/managed/opencode/' + 'a'.repeat(24), 'file:///private/model', 'https://user:password@inference.example/v1']) {
        const original = openCode(address); fs.writeFileSync(f.file, original);
        const result = f.run(); assert.equal(result.routes.length, 0); assert.equal(result.unsupported.length, 1); assert.equal(fs.readFileSync(f.file, 'utf8'), original);
    }
});

test('endpoint field identity distinguishes dotted provider names and unrelated URL-looking strings', async t => {
    const f = await fixture(t); const address = 'https://same.example/v1';
    fs.writeFileSync(f.file, JSON.stringify({ note: address, provider: { 'a.b': { npm: '@ai-sdk/openai', options: { baseURL: address } }, a: { npm: '@ai-sdk/openai', options: { baseURL: address } } } }, null, 2));
    const result = f.run(); assert.equal(result.routes.length, 2); assert.notEqual(result.routes[0].basePath, result.routes[1].basePath);
    assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).note, address);
});

test('sync preserves byte-order mark and unrelated escaped strings', async t => {
    const f = await fixture(t);
    const original = '\ufeff' + openCode().replace('https://inference.example.test/v1', 'https:\\/\\/inference.example.test\\/v1');
    fs.writeFileSync(f.file, original); f.run();
    assert.ok(fs.readFileSync(f.file, 'utf8').startsWith('\ufeff'));
    assert.match(fs.readFileSync(f.file, 'utf8'), /Keep this comment/);
});

test('concurrent edits abort subsequent writes without automatically reverting already-written files', async t => {
    const f = await fixture(t); const original = openCode(); fs.writeFileSync(f.file, original);
    const second = path.join(f.dir, 'second.jsonc'); fs.writeFileSync(second, original);
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
        rename(from, to);
        if (String(to) === f.file) fs.writeFileSync(second, original + '// concurrent user edit\n');
    });
    assert.throws(() => f.run([{ agent: 'opencode', file: f.file }, { agent: 'opencode', file: second }]), /concurrent/i);
    assert.match(fs.readFileSync(f.file, 'utf8'), /managed\/opencode/);
    assert.equal(fs.readFileSync(second, 'utf8'), original + '// concurrent user edit\n');
    assert.equal(readState(f.insightDir).routes.length, 2);
});

test('sync validates all files first and keeps symlink-based configurations as symlinks', async t => {
    const f = await fixture(t); const original = openCode(); fs.writeFileSync(f.file, original);
    const linked = path.join(f.dir, 'linked.jsonc'); fs.symlinkSync(f.file, linked);
    const second = path.join(f.dir, 'second.jsonc'); fs.writeFileSync(second, original);
    f.run([{ agent: 'opencode', file: linked }, { agent: 'opencode', file: second }]);
    assert.ok(fs.lstatSync(linked).isSymbolicLink());
    const managed = fs.readFileSync(f.file, 'utf8'); fs.writeFileSync(second, '{broken');
    assert.throws(() => f.run([{ agent: 'opencode', file: linked }, { agent: 'opencode', file: second }]), /JSON|invalid/i);
    assert.equal(fs.readFileSync(f.file, 'utf8'), managed);
});

test('interrupted routing-state publication does not modify Agent configuration', async t => {
    const f = await fixture(t); const original = openCode(); fs.writeFileSync(f.file, original);
    const write = fs.writeFileSync; let fail = true;
    t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
        if (fail && typeof args[0] === 'number') {
            fail = false; write(args[0], '{'); throw new Error('simulated storage write failure');
        }
        return write(...args);
    });
    assert.throws(() => f.run(), /storage write failure/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
    assert.equal(fs.existsSync(path.join(f.insightDir, 'inference-proxy/backups')), false);
    f.run();
    assert.match(fs.readFileSync(f.file, 'utf8'), /managed\/opencode/);
});

test('changing a provider protocol at the same upstream creates a new route and preserves the live historical route', async t => {
    const f = await fixture(t); const original = openCode(); fs.writeFileSync(f.file, original);
    const first = f.run();
    fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('@ai-sdk/openai-compatible', '@ai-sdk/anthropic'));
    const second = f.run();
    assert.equal(second.routes.length, 2);
    assert.deepEqual(second.routes.find((route: { protocol: string }) => route.protocol === 'openai'), first.routes[0]);
    const anthropic = second.routes.find((route: { protocol: string }) => route.protocol === 'anthropic');
    assert.notEqual(anthropic.basePath, first.routes[0].basePath);
    assert.equal(anthropic.upstreamBaseUrl, first.routes[0].upstreamBaseUrl);
    assert.ok(fs.readFileSync(f.file, 'utf8').includes(f.origin + anthropic.basePath));
    assert.deepEqual(f.run().changed, []);
    assert.match(fs.readFileSync(f.file, 'utf8'), /@ai-sdk\/anthropic/);
});

test('OpenCode V2 native and mixed V1 provider endpoints retain JSONC and later edits during repeated sync', async t => {
    const f = await fixture(t);
    const original = '{\n // V2 native configuration\n "providers": {"native":{"package":"@opencode/ai/providers/openai-compatible","settings":{"baseURL":"https://v2.example/v1","apiKey":"private"}},"claude":{"package":"@opencode/ai/providers/anthropic","settings":{"baseURL":"https://anthropic.example/v1"}}},\n "provider":{"legacy":{"npm":"@ai-sdk/openai","options":{"baseURL":"https://v1.example/v1"}}}\n}';
    fs.writeFileSync(f.file, original);
    assert.equal(f.run().routes.length, 3);
    const managed = fs.readFileSync(f.file, 'utf8');
    assert.match(managed, /\/managed\/opencode\//);
    fs.writeFileSync(f.file, managed.replace('"private"', '"user-edited"'));
    assert.deepEqual(f.run().changed, []);
    assert.equal(fs.readFileSync(f.file, 'utf8'), managed.replace('"private"', '"user-edited"'));
});


test('configuration sync no longer provides automatic backup or restore APIs', async t => {
    const f = await fixture(t);
    assert.equal(f.api.restoreConfigFiles, undefined);
    assert.equal(f.api.removeConfigPlugins, undefined);
    fs.writeFileSync(f.file, openCode());
    f.run();
    assert.equal(fs.existsSync(path.join(f.insightDir, 'inference-proxy/backups')), false);
    const state = readState(f.insightDir);
    assert.equal(state.files[f.file].backup, undefined);
    assert.equal(state.files[f.file].backupHash, undefined);
    assert.doesNotMatch(JSON.stringify(state), /private-test-key|originalToken/);
});


test('previous installations keep routing without depending on old backup files', async t => {
    const f = await fixture(t); fs.writeFileSync(f.file, openCode());
    const first = f.run();
    const state = readState(f.insightDir);
    state.files[f.file].backup = 'missing-old-backup.bak';
    state.files[f.file].backupHash = 'old-hash';
    fs.writeFileSync(path.join(f.insightDir, 'inference-proxy/config-state.json'), JSON.stringify(state));
    const next = f.run();
    assert.deepEqual(next.changed, []);
    assert.deepEqual(next.routes, first.routes);
    assert.equal(readState(f.insightDir).files[f.file].backup, undefined);
});

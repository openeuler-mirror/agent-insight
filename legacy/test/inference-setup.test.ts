/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import test, { type TestContext, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { GET as getSetup } from '@/app/api/ingest/setup/route';
import { GET as getAutoSetup } from '@/app/api/ingest/setup/auto/route';
import { temporaryDirectory, listen, closeServer, readJson as read, writeJson as write, runProcess as run } from './helpers/inference-fixtures';

describe("Configuration backups and synchronization", () => {
  const modulePath = '../scripts/inference_config.mjs';
  async function fixture(t: TestContext) {
      const api = await import(modulePath).catch(() => ({}));
      assert.equal(typeof api.syncConfigFiles, 'function', 'configuration sync must be implemented');
      const dir = temporaryDirectory('inference-config-');
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

  test('sync changes only the exact JSONC endpoint token, backs up before changes and is idempotent', async t => {
      const f = await fixture(t); const original = openCode(); fs.writeFileSync(f.file, original);
      const result = f.run(); assert.equal(result.routes.length, 1); assert.deepEqual(result.changed, [f.file]);
      const managed = f.origin + result.routes[0].basePath;
      assert.deepEqual(result.routes[0], { basePath: result.routes[0].basePath, agent: 'opencode', protocol: 'openai', upstreamBaseUrl: 'https://inference.example.test/v1' });
      assert.match(result.routes[0].basePath, /^\/managed\/opencode\/[a-f0-9]{24}$/);
      assert.equal(fs.readFileSync(f.file, 'utf8'), original.replace(JSON.stringify('https://inference.example.test/v1'), JSON.stringify(managed)));
      assert.equal(fs.existsSync(path.join(f.insightDir, 'inference-proxy/backups')), true);
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
      assert.equal(fs.existsSync(path.join(f.insightDir, 'inference-proxy/config-state.json')), false);
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


  test('explicit configuration creates backups without reintroducing automatic restore APIs', async t => {
      const f = await fixture(t);
      assert.equal(f.api.restoreConfigFiles, undefined);
      assert.equal(f.api.removeConfigPlugins, undefined);
      fs.writeFileSync(f.file, openCode());
      f.run();
      assert.equal(fs.existsSync(path.join(f.insightDir, 'inference-proxy/backups')), true);
      const state = readState(f.insightDir);
      assert.equal(state.files[f.file].backup, undefined);
      assert.equal(state.files[f.file].backupHash, undefined);
      assert.doesNotMatch(JSON.stringify(state), /private-test-key/);
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


  test('explicit configuration keeps an immutable original and synchronizes an unproxied backup with user edits', async t => {
      const f = await fixture(t); const original = openCode(); fs.writeFileSync(f.file, original);
      const first = f.run();
      assert.equal(first.backups?.length, 1);
      const backup = first.backups[0];
      assert.equal(fs.readFileSync(backup.original, 'utf8'), original);
      assert.equal(fs.readFileSync(backup.latest, 'utf8'), original);
      const managed = f.origin + first.routes[0].basePath;
      const edits = fs.readFileSync(f.file, 'utf8').replace('"probe": {}', '"probe": {}, "added-model": {}')
        .replace('private-test-key', 'changed-key').replace('"provider": {', '"provider": { "new": { "npm": "@ai-sdk/openai", "options": { "baseURL": "https://new.example/v1" } },');
      fs.writeFileSync(f.file, edits);
      const second = f.run();
      assert.equal(second.routes.length, 2);
      assert.equal(fs.readFileSync(backup.latest, 'utf8'), edits.replace(JSON.stringify(managed), JSON.stringify('https://inference.example.test/v1')));
      assert.equal(fs.readFileSync(backup.original, 'utf8'), original);
      assert.equal(fs.statSync(backup.latest).mode & 0o777, 0o600);
      assert.deepEqual(f.run().changed, []);
      assert.equal(fs.readFileSync(backup.latest, 'utf8').includes('/managed/'), false);
      assert.doesNotMatch(JSON.stringify(readState(f.insightDir)), /changed-key/);
  });

  test('backup write failure prevents configuration and routing-state changes', async t => {
      const f = await fixture(t); const original = openCode(); fs.writeFileSync(f.file, original);
      const rename = fs.renameSync;
      t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
          if (String(to).includes('/backups/')) throw new Error('backup unavailable');
          rename(from, to);
      });
      assert.throws(() => f.run(), /backup unavailable/);
      assert.equal(fs.readFileSync(f.file, 'utf8'), original);
      assert.equal(fs.existsSync(path.join(f.insightDir, 'inference-proxy/config-state.json')), false);
  });


  test('backup locations are reported before any user configuration changes', async t => {
      const f = await fixture(t); const original = openCode(); fs.writeFileSync(f.file, original);
      const announced: any[] = [];
      f.api.syncConfigFiles({ insightDir: f.insightDir, origin: f.origin, files: [{ agent: 'opencode', file: f.file }], onBackup: (backup: any) => {
          assert.equal(fs.readFileSync(f.file, 'utf8'), original);
          assert.equal(fs.readFileSync(backup.latest, 'utf8'), original);
          announced.push(backup);
      } });
      assert.equal(announced.length, 1);
  });

  test('explicit native non-HTTP transports remain unchanged instead of being rewritten to an incompatible endpoint', async t => {
      const f = await fixture(t);
      const original = JSON.stringify({ providers: { local: { package: '@opencode/ai/providers/openai', settings: { baseURL: 'https://inference.example/v1', transport: 'websocket' } } } });
      fs.writeFileSync(f.file, original);
      const result = f.run();
      assert.deepEqual(result.changed, []);
      assert.equal(fs.readFileSync(f.file, 'utf8'), original);
      assert.equal(result.routes.length, 0);
      assert.ok(result.unsupported.length);
  });
});

describe("Explicit enrollment and proxy lifecycle", () => {
  async function fixture(t: TestContext) {
      const modulePath = '../scripts/inference_proxy.mjs';
      const api = await import(modulePath).catch(() => ({}));
      assert.equal(typeof api.installProxy, 'function', 'managed proxy lifecycle must exist');
      const homeDir = temporaryDirectory('managed-proxy-');
      const insightDir = path.join(homeDir, '.agent-insight');
      const seen: { url?: string; headers: http.IncomingHttpHeaders; body: unknown }[] = [];
      const upstream = http.createServer(async (req, res) => {
          let body = ''; for await (const c of req) body += c;
          seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
          res.writeHead(seen.length === 2 ? 503 : 200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(seen.length === 2 ? { error: 'retry' } : { id: `response-${seen.length}` }));
      });
      await listen(upstream);
      const options = { homeDir, insightDir, cwd: homeDir, env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: path.join(homeDir, '.config') }, agents: ['opencode', 'qoder'], launchers: [] };
      t.after(async () => { await stopFixture(insightDir); await closeServer(upstream); fs.rmSync(homeDir, { recursive: true, force: true }); });
      return { api, options, homeDir, insightDir, seen, upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1` };
  }
  async function stopFixture(insightDir: string) {
      try {
          const runtime = read(path.join(insightDir, 'inference-proxy/runtime.json'));
          const response = await fetch(runtime.origin + '/_agent_insight/stop', { method: 'POST', headers: { 'x-agent-insight-control': runtime.token } });
          await response.text();
          for (let i = 0; i < 100; i++) {
              try { await fetch(runtime.origin + '/_agent_insight/health'); await new Promise(r => setTimeout(r, 20)); } catch { break; }
          }
      } catch {}
  }
  const oc = (url: string) => ({ provider: { local: { npm: '@ai-sdk/openai-compatible', options: { baseURL: url, apiKey: 'dummy' }, models: { one: {}, two: {} } } } });
  const qoder = (url: string) => ({ providers: { local: { type: 'openai-compatible', protocol: 'openai', baseUrl: url, apiKey: 'dummy', model: 'one', models: [{ model: 'one' }, { model: 'two' }] } } });

  test('Qoder GUI-only installation reports no model takeover and leaves product stores unchanged', async t => {
      const f = await fixture(t);
      const files = [path.join(f.homeDir, 'Library/Application Support/QoderCN/User/globalStorage/state.vscdb'), path.join(f.homeDir, 'Library/Application Support/JetBrains/IntelliJIdea2026.2/options/qodercn_setting.xml')];
      for (const file of files) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'product-owned-content'); }
      write(path.join(f.homeDir, '.qoder-cn/settings.json'), { hooks: {}, theme: 'user-value' });
      const result = await f.api.installProxy({ ...f.options, agents: ['qoder'] });
      assert.deepEqual(result.coverage, [
          { agent: 'qoder', product: 'cli', state: 'no_supported_endpoint', managedEndpoints: 0 },
          { agent: 'qoder', product: 'desktop', state: 'adapter_unavailable', managedEndpoints: 0 },
          { agent: 'qoder', product: 'jetbrains', state: 'adapter_unavailable', managedEndpoints: 0 },
      ]);
      await f.api.syncProxy(f.options);

      for (const file of files) assert.equal(fs.readFileSync(file, 'utf8'), 'product-owned-content');
      assert.equal(read(path.join(f.homeDir, '.qoder-cn/settings.json')).theme, 'user-value');
  });

  test('Qoder CLI configuration coverage never implies JetBrains or native IDE coverage', async t => {
      const f = await fixture(t); const file = path.join(f.homeDir, '.qoder-cn/settings.json'); write(file, qoder(f.upstream));
      const result = await f.api.installProxy({ ...f.options, agents: ['qoder'] });
      assert.deepEqual(result.coverage?.[0], { agent: 'qoder', product: 'cli', state: 'configured', managedEndpoints: 1 });
      assert.ok(result.coverage.slice(1).every((item: { state: string }) => item.state === 'adapter_unavailable'));
      write(file, { providers: {} });
      const after = await f.api.syncProxy(f.options);
      assert.equal(after.coverage[0].state, 'no_supported_endpoint');
      assert.equal(after.coverage[0].managedEndpoints, 0);
  });

  test('runtime hooks do not enroll inline-only providers or write snapshots', async t => {
      const f = await fixture(t); await f.api.installProxy({ ...f.options, agents: ['opencode'] });
      const cfg = oc(f.upstream); await f.api.prepareOpenCodeConfig(cfg, f.options);
      assert.equal(cfg.provider.local.options.baseURL, f.upstream);
      assert.equal(fs.existsSync(path.join(f.insightDir, 'inference-proxy/resolved')), false);
  });


  test('installation starts a healthy proxy before rewriting; model changes and retries retain uniform IDs; sync preserves user edits', async t => {
      const f = await fixture(t);
      const ocFile = path.join(f.homeDir, '.config/opencode/opencode.json');
      const qFile = path.join(f.homeDir, '.qoder-cn/settings.json');
      write(ocFile, oc(f.upstream)); write(qFile, qoder(f.upstream));
      await f.api.installProxy(f.options);
      const first = read(ocFile).provider.local.options.baseURL;
      assert.notEqual(first, f.upstream);
      await f.api.installProxy(f.options);
      assert.equal(read(ocFile).provider.local.options.baseURL, first);
      const ids: string[] = [];
      for (const [model, status] of [['one', 200], ['two', 503], ['two', 200]]) {
          const response = await fetch(read(qFile).providers.local.baseUrl + '/chat/completions', { method: 'POST', headers: { 'session-id': 'same-session' }, body: JSON.stringify({ model }) });
          assert.equal(response.status, status); ids.push(response.headers.get('x-request-id')!); await response.text();
      }
      assert.equal(new Set(ids).size, 3);
      assert.deepEqual(f.seen.map(x => x.headers['x-request-id']), ids);
      const changed = read(qFile); changed.theme = 'user-new'; changed.providers.new = qoder(f.upstream + '/second').providers.local; write(qFile, changed);
      await f.api.syncProxy(f.options);
      assert.match(read(qFile).providers.new.baseUrl, /\/managed\/qoder\//);
      assert.equal(read(qFile).theme, 'user-new');
      assert.match(read(qFile).providers.local.baseUrl, /managed/);
      assert.match(read(ocFile).provider.local.options.baseURL, /managed/);
      assert.equal(fs.existsSync(path.join(f.insightDir, 'inference-proxy/backups')), true);
  });

  test('OpenCode config hook preserves new providers and inline overrides until an explicit command', async t => {
      const f = await fixture(t); await f.api.installProxy(f.options);
      const cfg = oc(f.upstream); await f.api.prepareOpenCodeConfig(cfg, f.options);
      assert.equal(cfg.provider.local.options.baseURL, f.upstream);
      const response = await fetch(cfg.provider.local.options.baseURL + '/chat/completions', { method: 'POST', body: '{}' }); await response.text();
      assert.equal(f.seen[0].headers['x-request-id'], undefined);
  });


  test('explicit Qoder configuration leaves the executable and unselected custom settings untouched', async t => {
      const f = await fixture(t); const bin = path.join(f.homeDir, 'bin'); fs.mkdirSync(bin);
      const original = path.join(bin, 'qoder-original'); fs.writeFileSync(original, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const entry = path.join(bin, 'qoderclicn'); fs.symlinkSync(original, entry);
      const configDir = path.join(f.homeDir, 'custom-config'); const file = path.join(configDir, 'settings.json'); write(file, qoder(f.upstream));
      await f.api.installProxy({ ...f.options, launchers: [{ agent: 'qoder', path: entry }] });
      assert.equal(read(file).providers.local.baseUrl, f.upstream);
      await f.api.installProxy({ ...f.options, agents: ['qoder'], args: ['--config-dir', configDir] });
      assert.match(read(file).providers.local.baseUrl, /managed/);
      assert.equal(fs.lstatSync(entry).isSymbolicLink(), true);
      assert.equal(fs.realpathSync(entry), fs.realpathSync(original));
  });


  test('explicit Qoder configuration does not enroll inline launch arguments', async t => {
      const f = await fixture(t);
      const result = await f.api.installProxy({ ...f.options, agents: ['qoder'], args: ['--settings=' + JSON.stringify(qoder(f.upstream))] });
      assert.equal(result.managed.length, 0);
      assert.equal(fs.existsSync(path.join(f.insightDir, 'inference-proxy/inline')), false);
  });


  test('invalid explicit configuration leaves the file unchanged', async t => {
      const f = await fixture(t); const file = path.join(f.homeDir, '.qoder-cn/settings.json');
      fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, '{broken');
      await assert.rejects(f.api.installProxy(f.options), /Invalid/);
      assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  });


  test('daemon restart reuses the managed address and OpenCode resolves disk-owned URLs in merged config', async t => {
      const f = await fixture(t);
      const file = path.join(f.homeDir, '.config/opencode/opencode.json'); write(file, oc(f.upstream));
      await f.api.installProxy(f.options);
      const cfg = read(file), address = cfg.provider.local.options.baseURL;
      const runtime = read(path.join(f.insightDir, 'inference-proxy/runtime.json'));
      const stopped = await fetch(runtime.origin + '/_agent_insight/stop', { method: 'POST', headers: { 'x-agent-insight-control': runtime.token } }); await stopped.text();
      for (let i = 0; i < 50; i++) {
          try { await fetch(runtime.origin + '/_agent_insight/health'); await new Promise(r => setTimeout(r, 20)); } catch { break; }
      }
      await f.api.prepareOpenCodeConfig(cfg, f.options);
      assert.equal(new URL(cfg.provider.local.options.baseURL).origin, new URL(address).origin);
      const response = await fetch(address + '/chat/completions', { method: 'POST', body: '{}' }); await response.text();
      assert.equal(response.status, 200);
  });

  test('Qoder configuration discovery accumulates repeated setting sources as the real CLI does', async t => {
      const f = await fixture(t);
      const files = f.api.discoverConfigFiles({ ...f.options, agents: ['qoder'], env: { ...f.options.env, QODERCN_CONFIG_DIR: '/custom/qoder' }, args: ['--setting-sources=project', '--setting-sources', 'user', '--settings=override.json'] });
      assert.deepEqual(files.map((x: { file: string }) => x.file), ['/custom/qoder/settings.json', path.join(f.homeDir, '.qoder/settings.json'), path.join(f.homeDir, 'override.json')]);
      assert.deepEqual(f.api.discoverConfigFiles({ ...f.options, agents: ['qoder'], args: ['--setting-sources='] }), []);
      assert.deepEqual(f.api.discoverConfigFiles({ ...f.options, agents: ['qoder'], args: ['--setting-sources= project, local ', '--', '--config-dir=/wrong', '--setting-sources=user'] }).map((x: { file: string }) => x.file), [path.join(f.homeDir, '.qoder/settings.json'), path.join(f.homeDir, '.qoder/settings.local.json')]);
  });

  test('all repeated Qoder settings and config roots are managed without guessing native precedence', async t => {
      const f = await fixture(t);
      const files = f.api.discoverConfigFiles({ ...f.options, agents: ['qoder'], args: ['--setting-sources=user', '--config-dir=first', '--config-dir', 'second', '--settings=first.json', '--settings', 'second.json'] });
      assert.deepEqual(files.map((x: { file: string }) => x.file), ['first/settings.json', 'second/settings.json', 'first.json', 'second.json'].map(x => path.join(f.homeDir, x)));
  });

  test('explicit configuration does not rebind a vendor-upgraded Qoder executable', async t => {
      const f = await fixture(t); const bin = path.join(f.homeDir, 'bin'); fs.mkdirSync(bin);
      const entry = path.join(bin, 'qoderclicn'), original = path.join(bin, 'qoderclicn-1.1.71');
      fs.writeFileSync(original, '#!/bin/sh\necho new\n', { mode: 0o755 }); fs.symlinkSync(original, entry);
      await f.api.installProxy({ ...f.options, launchers: [{ agent: 'qoder', path: entry }] });
      await f.api.syncProxy(f.options);
      assert.equal(fs.realpathSync(entry), fs.realpathSync(original));
      assert.equal(fs.lstatSync(entry).isSymbolicLink(), true);
  });


  test('OpenCode never enrolls another host with a managed-looking suffix', async t => {
      const f = await fixture(t); const file = path.join(f.homeDir, '.config/opencode/opencode.json'); write(file, oc(f.upstream));
      await f.api.installProxy(f.options);
      const cfg = read(file); cfg.provider.local.options.baseURL = 'https://another.example' + new URL(cfg.provider.local.options.baseURL).pathname;
      await f.api.prepareOpenCodeConfig(cfg, f.options);
      assert.equal(f.api.isManagedOpenCodeEndpoint(cfg.provider.local.options.baseURL, f.options), false);
      assert.match(cfg.provider.local.options.baseURL, /^https:\/\/another\.example/);
  });


  test('reinstallation with a different collection account restarts the gateway for the new account', async t => {
      const f = await fixture(t); const file = path.join(f.homeDir, '.qoder-cn/settings.json'); write(file, qoder(f.upstream));
      await f.api.installProxy({ ...f.options, env: { ...f.options.env, AGENT_INSIGHT_API_KEY: 'account-old' } });
      const old = read(path.join(f.insightDir, 'inference-proxy/runtime.json'));
      await f.api.installProxy({ ...f.options, env: { ...f.options.env, AGENT_INSIGHT_API_KEY: 'account-new' } });
      const current = read(path.join(f.insightDir, 'inference-proxy/runtime.json'));
      assert.notEqual(current.pid, old.pid);
      const response = await fetch(read(file).providers.local.baseUrl + '/chat/completions', { method: 'POST', headers: { 'session-id': 'same' }, body: '{}' }); await response.text();
      const crypto = await import('node:crypto'); const account = crypto.createHash('sha256').update('account-new').digest('hex').slice(0, 16);
      assert.ok(fs.existsSync(path.join(f.insightDir, 'inference-gateway', account, 'qoder')));
  });

  test('daemon exits when its stable port is occupied instead of leaving a background timer', async t => {
      const f = await fixture(t); fs.mkdirSync(path.join(f.insightDir, 'inference-proxy'), { recursive: true });
      write(path.join(f.insightDir, 'inference-proxy/runtime.json'), { origin: new URL(f.upstream).origin });
      const child = spawn(process.execPath, [path.resolve('scripts/inference_proxy.mjs'), 'daemon', f.insightDir], { env: f.options.env, stdio: 'ignore' });
      const result = await new Promise<number | null>(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 1500); child.on('exit', code => { clearTimeout(timer); resolve(code); }); });
      assert.equal(result, 1);
  });

  test('the same dotfile discovered through a symlink and OPENCODE_CONFIG is synchronized once', async t => {
      const f = await fixture(t); const file = path.join(f.homeDir, 'dotfiles/opencode.json'); write(file, oc(f.upstream));
      const global = path.join(f.homeDir, '.config/opencode/opencode.json'); fs.mkdirSync(path.dirname(global), { recursive: true }); fs.symlinkSync(file, global);
      await f.api.installProxy({ ...f.options, env: { ...f.options.env, OPENCODE_CONFIG: file } });
      assert.match(read(file).provider.local.options.baseURL, /\/managed\/opencode/);
      assert.ok(fs.lstatSync(global).isSymbolicLink());
      assert.match(read(file).provider.local.options.baseURL, /managed/);
  });

  test('runtime import tolerates the virtual executable path used by embedded Bun', async () => {
      const file = path.resolve('scripts/inference_proxy.mjs');
      const script = `process.argv[1]='/$bunfs/root/src/index.js';await import(${JSON.stringify('file://' + file)});`;
      const result = await new Promise<{ code: number | null, error: string }>((resolve, reject) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', script]); let error = '';
          child.stderr.on('data', b => error += b); child.on('error', reject); child.on('exit', code => resolve({ code, error }));
      });
      assert.equal(result.code, 0, result.error);
  });

  test('OpenCode V2 HTTP preparation starts only known routes and preserves query, body and auth', async t => {
      const f = await fixture(t); const file = path.join(f.homeDir, '.config/opencode/opencode.json'); write(file, oc(f.upstream + '/new'));
      await f.api.installProxy({ ...f.options, agents: ['opencode'] });
      const source = f.upstream + '/new/chat/completions?api-version=probe';
      assert.equal(await f.api.prepareOpenCodeRequest(source, f.options), source);
      const managed = read(file).provider.local.options.baseURL + '/chat/completions?api-version=probe';
      const routed = await f.api.prepareOpenCodeRequest(managed, f.options);
      assert.equal(routed, managed);
      const response = await fetch(routed, { method: 'POST', headers: { authorization: 'Bearer dummy' }, body: JSON.stringify({ model: 'new', messages: [] }) });
      await response.text(); assert.equal(response.status, 200);
      assert.equal(f.seen[0].url, '/v1/new/chat/completions?api-version=probe');
      assert.equal(f.seen[0].headers.authorization, 'Bearer dummy');
      assert.ok(f.seen[0].headers['x-request-id']);
  });


  test('installation exposes no automatic uninstall or configuration restore entry', async t => {
      const f = await fixture(t);
      assert.equal(f.api.restoreProxy, undefined);
      const file = path.join(f.homeDir, '.config/opencode/opencode.json');
      write(file, oc(f.upstream));
      await f.api.installProxy(f.options);
      for (const name of ['restore_inference_proxy.sh', 'uninstall_client.sh']) {
          assert.equal(fs.existsSync(path.join(f.insightDir, name)), false);
      }
  });


  test('a later configuration conflict leaves earlier routes live and never restores user files', async t => {
      const f = await fixture(t);
      const first = path.join(f.homeDir, '.config/opencode/opencode.json');
      const second = path.join(f.homeDir, '.qoder-cn/settings.json');
      write(first, oc(f.upstream)); write(second, qoder(f.upstream));
      const rename = fs.renameSync;
      t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
          rename(from, to);
          if (String(to) === fs.realpathSync(first)) fs.writeFileSync(second, '{concurrent-user-edit');
      });
      await assert.rejects(f.api.installProxy(f.options), /concurrent/i);
      assert.equal(read(path.join(f.insightDir, 'inference-proxy/installation.json')).explicitEnabled, true);
      assert.equal(fs.readFileSync(second, 'utf8'), '{concurrent-user-edit');
      const response = await fetch(read(first).provider.local.options.baseURL + '/chat/completions', { method: 'POST', body: '{}' });
      await response.text();
      assert.equal(response.status, 200);
      assert.ok(f.seen[0].headers['x-request-id']);
  });


  test('explicit-only runtime preparation and hooks never enroll new endpoints or poll user configuration', async t => {
      const f = await fixture(t), file = path.join(f.homeDir, '.config/opencode/opencode.json');
      write(file, oc(f.upstream)); const initial = fs.readFileSync(file);
      assert.equal(typeof f.api.prepareProxy, 'function');
      await f.api.prepareProxy(f.options);
      assert.deepEqual(fs.readFileSync(file), initial);
      assert.equal(fs.existsSync(path.join(f.insightDir, 'inference-proxy/runtime.json')), false);
      await f.api.installProxy(f.options);
      const address = read(file).provider.local.options.baseURL;
      const edited = read(file); edited.provider.new = oc(f.upstream + '/new').provider.local; write(file, edited);
      const before = fs.readFileSync(file);
      await new Promise(r => setTimeout(r, 1250));
      await f.api.prepareOpenCodeConfig(edited, f.options);
      assert.equal(edited.provider.new.options.baseURL, f.upstream + '/new');
      assert.equal(await f.api.prepareOpenCodeRequest(f.upstream + '/new/chat/completions', f.options), f.upstream + '/new/chat/completions');
      assert.deepEqual(fs.readFileSync(file), before);
      await f.api.installProxy(f.options);
      assert.equal(read(file).provider.local.options.baseURL, address);
      assert.match(read(file).provider.new.options.baseURL, /managed/);
      const backups = read(path.join(f.insightDir, 'inference-proxy/config-state.json')).files[fs.realpathSync(file)].backups;
      assert.equal(read(backups.latest).provider.local.options.baseURL, f.upstream);
      assert.equal(read(backups.latest).provider.new.options.baseURL, f.upstream + '/new');
  });


  test('runtime upgrade replaces only a previously owned Qoder wrapper and stops implicit configuration enrollment', async t => {
      const f = await fixture(t); const entry = path.join(f.homeDir, 'qoder-wrapper');
      const original = path.join(f.homeDir, 'qoder-original');
      fs.writeFileSync(original, '#!/bin/sh\nprintf "%s" "$1"\n', { mode: 0o755 });
      const legacy = '#!/bin/sh\necho implicit-old-launcher\n'; fs.writeFileSync(entry, legacy, { mode: 0o755 });
      const crypto = await import('node:crypto');
      write(path.join(f.insightDir, 'inference-proxy/installation.json'), { enabled: true, agents: ['qoder'], files: [], launchers: [{ agent: 'qoder', path: entry, original, managedHash: crypto.createHash('sha256').update(legacy).digest('hex') }] });
      const config = path.join(f.homeDir, '.qoder-cn/settings.json'); write(config, qoder(f.upstream));
      await f.api.prepareProxy(f.options);
      assert.notEqual(fs.readFileSync(entry, 'utf8'), legacy);
      const output = await new Promise<string>((resolve, reject) => {
          const child = spawn(entry, ['forwarded'], { env: f.options.env }); let out = '', error = '';
          child.stdout.on('data', b => out += b); child.stderr.on('data', b => error += b);
          child.on('error', reject); child.on('exit', code => code === 0 ? resolve(out) : reject(new Error(error)));
      });
      assert.equal(output, 'forwarded');
      assert.equal(read(config).providers.local.baseUrl, f.upstream);
  });


  test('explicit configuration and new-provider sync keep mock inference IDs attached to final root and child LLM nodes', async t => {
      const f = await fixture(t); const file = path.join(f.homeDir, '.config/opencode/opencode.json');
      write(file, { providers: { local: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: f.upstream } } } });
      await f.api.prepareProxy(f.options);
      await f.api.installProxy({ ...f.options, agents: ['opencode'] });
      const plugin = await import('../scripts/opencode_plugin_otel');
      const { buildAgentCallTree } = await import('../src/lib/engine/observability/agent-trace');
      const previous = process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN;
      process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN = '1';
      const uploader = await import('../scripts/opencode_uploader_client.js');
      t.after(() => { if (previous === undefined) delete process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN; else process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN = previous; });
      const records: any[] = [];
      const adapter = plugin.createOpenCodeV2Adapter({ session: { context: async () => [] } }, (r: any) => records.push(r),
        async (event: any) => { records.push({ kind: 'event', payload: { type: event.type, event } }); },
        { identityTimeoutMs: 1, prepareRequest: (url: string) => f.api.prepareOpenCodeRequest(url, f.options) });
      for (const sid of ['root', 'child-a', 'child-b']) await adapter.event({ type: 'session.created', created: 1, data: { sessionID: sid, ...(sid !== 'root' ? { parentID: 'root' } : {}), agent: 'build' } });
      const expected = new Map<string, string[]>();
      const invoke = async (sid: string, mid: string, provider = 'local', name = 'one') => {
        const model = { providerID: provider, id: name };
        const metadata: any = { sessionID: sid, agent: 'build', model, kind: 'primary', headers: {} };
        await adapter.modelRequest(metadata);
        const input = { ...metadata, request: new Request(read(file).providers[provider].settings.baseURL + '/chat/completions', { method: 'POST', headers: metadata.headers, body: JSON.stringify({ model: name }) }) };
        await adapter.request(input);
        const response = await fetch(input.request); await response.text();
        await adapter.response({ ...input, response });
        await adapter.event({ type: 'session.step.started', created: 10, data: { sessionID: sid, assistantMessageID: mid, agent: 'build', model, started: 10 } });
        if (response.ok) await adapter.event({ type: 'session.text.ended', created: 20, data: { sessionID: sid, assistantMessageID: mid, ordinal: 0, text: 'mock answer' } });
        const id = response.headers.get('x-request-id')!;
        assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expected.set(mid, [...(expected.get(mid) || []), id]);
        return response.status;
      };
      assert.equal(await invoke('root', 'first'), 200);
      assert.equal(await invoke('root', 'retry', 'local', 'two'), 503);
      assert.equal(await invoke('root', 'retry', 'local', 'two'), 200);
      await Promise.all([invoke('child-a', 'child-a-llm'), invoke('child-b', 'child-b-llm')]);
      const changed = read(file); changed.providers.added = { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: f.upstream + '/added' } }; write(file, changed);
      await f.api.installProxy({ ...f.options, agents: ['opencode'] });
      assert.equal(await invoke('root', 'added-llm', 'added'), 200);
      const tree = buildAgentCallTree(JSON.parse(JSON.stringify(uploader.mergeGraph(uploader.buildState(records), 'root'))))!;
      const nodes = [tree, ...tree.children].flatMap(n => n.events.filter(e => e.kind === 'llm'));
      assert.equal(nodes.length, expected.size);
      for (const node of nodes) assert.deepEqual(node.interaction.inference_call_ids, expected.get((node.interaction as any).messageID));
      const ids = [...expected.values()].flat();
      assert.equal(new Set(ids).size, 6);
      assert.deepEqual(f.seen.map(call => call.headers['x-request-id']).sort(), [...ids].sort());
      assert.equal(f.seen.at(-1)?.url, '/v1/added/chat/completions');
  });


  test('explicit configuration disables the legacy enable flag so cached old runtimes cannot enroll endpoints', async t => {
      const f = await fixture(t); const file = path.join(f.homeDir, '.config/opencode/opencode.json'); write(file, oc(f.upstream));
      await f.api.installProxy(f.options);
      const saved = read(path.join(f.insightDir, 'inference-proxy/installation.json'));
      assert.equal(saved.enabled, false, 'cached old code reads only enabled and must remain inactive');
      assert.equal(saved.explicitEnabled, true);
      await stopFixture(f.insightDir);
      const cfg = read(file); await f.api.prepareOpenCodeConfig(cfg, f.options);
      const response = await fetch(cfg.provider.local.options.baseURL + '/chat/completions', { method: 'POST', body: '{}' });
      await response.text(); assert.equal(response.status, 200, 'new runtime still starts known routes');
  });
});

describe("Collector installation and Shell entry", () => {
  const components = ['inference_gateway.mjs', 'inference_config.mjs', 'inference_proxy.mjs', 'model-proxy.sh'];
  const blockModule = '../src/app/api/ingest/setup/inference-proxy-setup';
  async function getBlock() {
      const loaded = await import(blockModule).catch(() => ({}));
      assert.equal(typeof loaded.INFERENCE_PROXY_UNIX_SETUP_BLOCK, 'string', 'Unix inference setup block must be implemented');
      return loaded.INFERENCE_PROXY_UNIX_SETUP_BLOCK as string;
  }
  async function fixture(t: TestContext, options: { failComponent?: string; proxySource?: string } = {}) {
      const block = await getBlock();
      const dir = temporaryDirectory('inference-setup-');
      const home = path.join(dir, 'home with spaces'); const insight = path.join(home, '.agent-insight'); const bin = path.join(dir, 'bin');
      fs.mkdirSync(insight, { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(path.join(dir, '.git'));
      fs.symlinkSync(process.execPath, path.join(bin, 'node'));
      const cli = path.join(bin, 'qoder-real'); fs.writeFileSync(cli, '#!/bin/sh\nexit 0\n', { mode: 0o700 }); fs.symlinkSync(cli, path.join(bin, 'qoderclicn'));
      const openCodeFile = path.join(home, '.config/opencode/opencode.json'); fs.mkdirSync(path.dirname(openCodeFile), { recursive: true });
      const qoderFile = path.join(home, '.qoder-cn/settings.json'); fs.mkdirSync(path.dirname(qoderFile), { recursive: true });
      const originals = {
          opencode: JSON.stringify({ provider: { local: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://upstream.example/v1', apiKey: 'test-model-key' } } } }),
          qoder: JSON.stringify({ providers: { local: { type: 'openai-compatible', protocol: 'openai', baseUrl: 'https://upstream.example/v1', apiKey: 'test-model-key' } } }),
      };
      fs.writeFileSync(openCodeFile, originals.opencode); fs.writeFileSync(qoderFile, originals.qoder);
      fs.writeFileSync(path.join(insight, '.env'), 'AGENT_INSIGHT_API_KEY=test-collection-key\n');
      const requested: string[] = [];
      const server = http.createServer((req, res) => {
          const component = new URL(req.url!, 'http://localhost').searchParams.get('component') || '';
          requested.push(component);
          if (!components.includes(component) || component === options.failComponent) { res.writeHead(503); res.end('unavailable'); return; }
          res.writeHead(200, { 'content-type': 'text/javascript' });
          res.end(component === 'inference_proxy.mjs' && options.proxySource ? options.proxySource : fs.readFileSync(path.resolve('scripts', component)));
      });
      await listen(server);
      const env: NodeJS.ProcessEnv = {
          NODE_ENV: 'test',
          HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: dir,
          AGENT_INSIGHT_HOME: insight, AGENT_INSIGHT_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
          INSTALL_OPENCODE: 'true', INSTALL_QODER: 'true', FINAL_KEY: 'test-collection-key', SETUP_WORKING_DIR: dir,
      };
      t.after(async () => {
          try {
              const runtime = JSON.parse(fs.readFileSync(path.join(insight, 'inference-proxy/runtime.json'), 'utf8'));
              if (runtime.pid) process.kill(runtime.pid, 'SIGTERM');
          } catch {}
          await closeServer(server);
          fs.rmSync(dir, { recursive: true, force: true });
      });
      return { dir, home, insight, bin, env, requested, originals, openCodeFile, qoderFile, execute: () => run('/bin/bash', ['-c', block], env, dir) };
  }

  test('inference runtime components use the existing explicit setup allowlist', async () => {
      for (const component of components) {
          const response = await getSetup(new Request(`http://localhost/api/ingest/setup?component=${component}`));
          assert.equal(response.status, 200, component);
          assert.equal(await response.text(), fs.readFileSync(path.resolve('scripts', component), 'utf8'));
      }
      assert.equal((await getSetup(new Request('http://localhost/api/ingest/setup?component=..%2Fpackage.json'))).status, 404);
  });

  test('generated Unix setup invokes proxy after final credentials and collectors, while Windows remains unchanged', async () => {
      const block = await getBlock();
      const response = await getSetup(new Request('http://localhost/api/ingest/setup?yes=1&nokey=1&frameworks=opencode,qoder', { headers: { 'x-platform': 'unix' } }));
      const script = await response.text();
      assert.ok(script.includes(block)); assert.ok(script.indexOf(block) > script.indexOf('echo "AGENT_INSIGHT_API_KEY=$FINAL_KEY"'));
      assert.ok(script.indexOf(block) > script.indexOf('Qoder CN CLI/Desktop/JetBrains/Work collectors installed.'));
      assert.equal(spawnSync('bash', ['-n'], { input: script }).status, 0);
      const windows = await (await getSetup(new Request('http://localhost/api/ingest/setup?yes=1&nokey=1&frameworks=qoder', { headers: { 'x-platform': 'windows' } }))).text();
      assert.ok(!windows.includes('inference_proxy.mjs'));
      const auto = await (await getAutoSetup(new Request('http://localhost/api/ingest/setup/auto?apiKey=test-key&host=localhost%3A3000', { headers: { 'x-platform': 'unix' } }))).text();
      assert.ok(auto.includes(block.replaceAll('$FINAL_KEY', '$AGENT_INSIGHT_API_KEY')), 'auto install must also include the inference proxy setup');
      assert.equal(spawnSync('bash', ['-n'], { input: auto }).status, 0);
  });

  test('real Bash downloads optional runtime without rewriting models or launchers and prints an explicit command', async t => {
      const f = await fixture(t); const result = await f.execute();
      assert.equal(result.code, 0, result.stderr + result.stdout); assert.deepEqual(f.requested, components);
      for (const component of components) assert.equal(fs.readFileSync(path.join(f.insight, 'inference-runtime', component), 'utf8'), fs.readFileSync(path.resolve('scripts', component), 'utf8'));
      assert.equal(fs.readFileSync(f.openCodeFile, 'utf8'), f.originals.opencode);
      assert.equal(fs.readFileSync(f.qoderFile, 'utf8'), f.originals.qoder);
      assert.match(result.stdout, /sh .*model-proxy\.sh.*opencode,qoder/);
      assert.equal(fs.existsSync(path.join(f.insight, 'inference-proxy/runtime.json')), false);
      assert.equal(fs.lstatSync(path.join(f.bin, 'qoderclicn')).isSymbolicLink(), true);
      for (const name of ['uninstall_client.sh', 'restore_inference_proxy.sh', 'inference-proxy/backups']) {
          assert.equal(fs.existsSync(path.join(f.insight, name)), false);
      }
      const configured = await run('/bin/sh', [path.join(f.insight, 'model-proxy.sh'), 'opencode'], { ...f.env, PATH: '/empty-path', AGENT_INSIGHT_HOME: '' }, f.dir);
      assert.equal(configured.code, 0, configured.stderr);
      assert.match(fs.readFileSync(f.openCodeFile, 'utf8'), /managed/);
      assert.equal(fs.readFileSync(f.qoderFile, 'utf8'), f.originals.qoder, 'only the explicitly selected Agent is modified');
      assert.match(configured.stderr, /首次原件：.*original.jsonc/);
      assert.match(configured.stderr, /最新原始地址备份：.*latest.jsonc/);
      const report = JSON.parse(configured.stdout);
      assert.equal(fs.readFileSync(report.backups[0].original, 'utf8'), f.originals.opencode);
      assert.equal((await f.execute()).code, 0, 'reinstall can refresh the prepared runtime');
      assert.equal(fs.readFileSync(f.qoderFile, 'utf8'), f.originals.qoder);

  });

  test('failed component download neither calls install nor replaces an existing runtime or Agent config', async t => {
      const f = await fixture(t, { failComponent: 'inference_config.mjs' });
      const prior = path.join(f.dir, 'prior-runtime'); fs.mkdirSync(prior); fs.writeFileSync(path.join(prior, 'keep'), 'old-runtime'); fs.symlinkSync(prior, path.join(f.insight, 'inference-runtime'));
      const result = await f.execute(); assert.equal(result.code, 0); assert.match(result.stderr + result.stdout, /failed|失败/i);
      assert.equal(fs.realpathSync(path.join(f.insight, 'inference-runtime')), prior);
      assert.equal(fs.readFileSync(f.openCodeFile, 'utf8'), f.originals.opencode); assert.equal(fs.readFileSync(f.qoderFile, 'utf8'), f.originals.qoder);
      assert.equal(fs.existsSync(path.join(f.insight, 'inference-proxy/installation.json')), false);
  });

  test('reinstall updates the optional runtime but keeps the vendor Qoder launcher unchanged', async t => {
      const f = await fixture(t);
      assert.equal((await f.execute()).code, 0);
      const before = fs.realpathSync(path.join(f.insight, 'inference-runtime'));
      assert.equal((await f.execute()).code, 0);
      const after = fs.realpathSync(path.join(f.insight, 'inference-runtime'));
      assert.notEqual(after, before);
      const launcher = fs.readFileSync(path.join(f.bin, 'qoderclicn'), 'utf8');
      assert.equal(fs.lstatSync(path.join(f.bin, 'qoderclicn')).isSymbolicLink(), true);
      assert.equal(launcher, '#!/bin/sh\nexit 0\n');
  });

  test('CLI preparation errors warn without failing collection and unrelated framework selections skip it', async t => {
      const f = await fixture(t, { proxySource: 'process.stderr.write("fixture install rejected\\n"); process.exitCode = 23;\n' });
      f.env.INSTALL_QODER = 'false';
      const result = await f.execute(); assert.equal(result.code, 0); assert.match(result.stderr, /fixture install rejected/); assert.match(result.stderr + result.stdout, /failed|失败/i);
      f.env.INSTALL_OPENCODE = 'false'; f.requested.length = 0;
      assert.equal((await f.execute()).code, 0); assert.deepEqual(f.requested, []);
  });

  test('installer passes only selected Agents to the CLI', async t => {
      const f = await fixture(t, { proxySource: 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n' });
      f.env.INSTALL_QODER = 'false'; const result = await f.execute();
      assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /"prepare",.*"opencode"/); assert.doesNotMatch(result.stdout, /opencode,qoder/);
  });

  test('missing original working directory skips optional preparation before the CLI can run', async t => {
      const f = await fixture(t, { proxySource: 'process.stdout.write("CLI_WAS_CALLED\\n");\n' });
      f.env.SETUP_WORKING_DIR = path.join(f.dir, 'missing-project');
      const result = await f.execute(); assert.equal(result.code, 0); assert.match(result.stderr, /Warning:.*optional inference proxy/i); assert.doesNotMatch(result.stdout, /CLI_WAS_CALLED/);
      assert.equal(fs.readFileSync(f.openCodeFile, 'utf8'), f.originals.opencode);
  });


  test('Shell entry reports missing Node before any configuration changes', async t => {
      const f = await fixture(t); assert.equal((await f.execute()).code, 0);
      fs.writeFileSync(path.join(f.insight, 'inference-runtime/node-path'), '/no-longer-installed/node\n');
      const before = fs.readFileSync(f.openCodeFile);
      const result = await run('/bin/sh', [path.join(f.insight, 'model-proxy.sh'), 'opencode'], { ...f.env, PATH: '/empty-path' }, f.dir);
      assert.notEqual(result.code, 0); assert.match(result.stderr, /Node.js 20/);
      assert.deepEqual(fs.readFileSync(f.openCodeFile), before);
      assert.equal(fs.existsSync(path.join(f.insight, 'inference-proxy/backups')), false);
      const help = await run('/bin/sh', [path.join(f.insight, 'model-proxy.sh'), '--help'], { ...f.env, PATH: '/empty-path' }, f.dir);
      assert.equal(help.code, 0); assert.match(help.stdout, /opencode.*qoder/);
  });

  test('Shell entry falls back to a compatible PATH runtime and synchronizes newly added providers', async t => {
      const f = await fixture(t); assert.equal((await f.execute()).code, 0);
      const shell = path.join(f.insight, 'model-proxy.sh');
      assert.equal((await run('/bin/sh', [shell, 'opencode'], f.env, f.dir)).code, 0);
      fs.writeFileSync(path.join(f.insight, 'inference-runtime/node-path'), '/removed-node\n');
      const stateFile = path.join(f.insight, 'inference-proxy/installation.json');
      fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(stateFile, 'utf8')), nodePath: '/removed-node' }));
      const cfg = JSON.parse(fs.readFileSync(f.openCodeFile, 'utf8'));
      const existing = cfg.provider.local.options.baseURL;
      cfg.provider.added = { npm: '@ai-sdk/openai', options: { baseURL: 'https://added.example/v1' } };
      fs.writeFileSync(f.openCodeFile, JSON.stringify(cfg));
      const result = await run('/bin/sh', [shell, 'opencode'], f.env, f.dir);
      assert.equal(result.code, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      const backup = JSON.parse(fs.readFileSync(report.backups[0].latest, 'utf8'));
      assert.equal(backup.provider.added.options.baseURL, 'https://added.example/v1');
      assert.equal(backup.provider.local.options.baseURL, 'https://upstream.example/v1');
      const final = JSON.parse(fs.readFileSync(f.openCodeFile, 'utf8'));
      assert.equal(final.provider.local.options.baseURL, existing);
      assert.match(final.provider.added.options.baseURL, /managed/);
      assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).nodePath, process.execPath);
  });

  test('failed Shell component download leaves the published runtime and model configuration intact', async t => {
      const f = await fixture(t, { failComponent: 'model-proxy.sh' });
      const result = await f.execute(); assert.equal(result.code, 0); assert.match(result.stderr, /Warning:.*optional inference proxy/i);
      assert.equal(fs.existsSync(path.join(f.insight, 'inference-runtime')), false);
      assert.equal(fs.existsSync(path.join(f.insight, 'model-proxy.sh')), false);
      assert.equal(fs.readFileSync(f.openCodeFile, 'utf8'), f.originals.opencode);
  });

  for (const entry of ['/api/setup/auto', '/api/ingest/setup/auto', '/prefix/api/ingest/setup/auto']) {
      test(`auto installer resolves the component base for ${entry}`, async () => {
          const response = await getAutoSetup(new Request(`http://localhost${entry}?apiKey=test&host=localhost&frameworks=opencode`, { headers: { host: 'localhost', 'x-platform': 'unix' } }));
          const script = await response.text();
          assert.match(script, new RegExp('AGENT_INSIGHT_BASE_URL="http://localhost' + (entry.startsWith('/prefix') ? '/prefix' : '') + '"'));
      });
  }

  for (const failure of ['download', 'prepare'] as const) {
      test(`optional gateway ${failure} failure preserves collectors and allows later selected installers to continue`, async t => {
          const f = await fixture(t, failure === 'download'
              ? { failComponent: 'inference_config.mjs' }
              : { proxySource: 'process.stderr.write("fixture prepare rejected\\n"); process.exitCode = 23;\n' });
          const collector = path.join(f.insight, 'opencode_uploader_client.js');
          fs.writeFileSync(collector, 'previously installed collector');
          const result = await run('/bin/bash', ['-c', 'set -e\n' + await getBlock() + '\nprintf "LATER_COLLECTOR_INSTALLED\\n"\n'], f.env, f.dir);
          assert.equal(result.code, 0, result.stderr + result.stdout);
          assert.match(result.stdout, /LATER_COLLECTOR_INSTALLED/);
          assert.match(result.stderr, /Warning:.*optional inference proxy/i);
          assert.equal(fs.readFileSync(collector, 'utf8'), 'previously installed collector');
          assert.equal(fs.readFileSync(f.openCodeFile, 'utf8'), f.originals.opencode);
          assert.equal(fs.readFileSync(f.qoderFile, 'utf8'), f.originals.qoder);
          assert.equal(fs.existsSync(path.join(f.insight, 'inference-proxy/runtime.json')), false);
      });
  }
});

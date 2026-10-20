import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

async function fixture(t: TestContext) {
    const modulePath = '../scripts/inference_proxy.mjs';
    const api = await import(modulePath).catch(() => ({}));
    assert.equal(typeof api.installProxy, 'function', 'managed proxy lifecycle must exist');
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-proxy-'));
    const insightDir = path.join(homeDir, '.agent-insight');
    const seen: { url?: string; headers: http.IncomingHttpHeaders; body: unknown }[] = [];
    const upstream = http.createServer(async (req, res) => {
        let body = ''; for await (const c of req) body += c;
        seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
        res.writeHead(seen.length === 2 ? 503 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(seen.length === 2 ? { error: 'retry' } : { id: `response-${seen.length}` }));
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const options = { homeDir, insightDir, cwd: homeDir, env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: path.join(homeDir, '.config') }, agents: ['opencode', 'qoder'], launchers: [] };
    t.after(async () => { await stopFixture(insightDir); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())); fs.rmSync(homeDir, { recursive: true, force: true }); });
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
function disableFixture(insightDir: string) {
    const file = path.join(insightDir, 'inference-proxy/installation.json');
    write(file, { ...read(file), enabled: false, explicitEnabled: false });
}
function write(file: string, data: unknown) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
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
        assert.equal(response.status, status); ids.push(response.headers.get('x-agent-insight-call-id')!); await response.text();
    }
    assert.equal(new Set(ids).size, 3);
    assert.deepEqual(f.seen.map(x => x.headers['x-agent-insight-call-id']), ids);
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
    assert.equal(f.seen[0].headers['x-agent-insight-call-id'], undefined);
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
    assert.ok(f.seen[0].headers['x-agent-insight-call-id']);
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
    assert.ok(f.seen[0].headers['x-agent-insight-call-id']);
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
      const id = response.headers.get('x-agent-insight-call-id')!;
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
    assert.deepEqual(f.seen.map(call => call.headers['x-agent-insight-call-id']).sort(), [...ids].sort());
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

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { GET as getSetup } from '@/app/api/ingest/setup/route';
import { GET as getAutoSetup } from '@/app/api/ingest/setup/auto/route';

const components = ['inference_gateway.mjs', 'inference_config.mjs', 'inference_proxy.mjs', 'model-proxy.sh'];
const blockModule = '../src/app/api/ingest/setup/inference-proxy-setup';
async function getBlock() {
    const loaded = await import(blockModule).catch(() => ({}));
    assert.equal(typeof loaded.INFERENCE_PROXY_UNIX_SETUP_BLOCK, 'string', 'Unix inference setup block must be implemented');
    return loaded.INFERENCE_PROXY_UNIX_SETUP_BLOCK as string;
}
async function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }));
    });
}
async function fixture(t: TestContext, options: { failComponent?: string; proxySource?: string } = {}) {
    const block = await getBlock();
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inference-setup-')));
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
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
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
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
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
    assert.ok(auto.includes(block), 'auto install must also include the inference proxy setup');
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
    const result = await f.execute(); assert.notEqual(result.code, 0); assert.match(result.stderr + result.stdout, /failed|失败/i);
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

test('CLI installation errors fail the Bash block clearly and unrelated framework selections skip it', async t => {
    const f = await fixture(t, { proxySource: 'process.stderr.write("fixture install rejected\\n"); process.exitCode = 23;\n' });
    f.env.INSTALL_QODER = 'false';
    const result = await f.execute(); assert.notEqual(result.code, 0); assert.match(result.stderr, /fixture install rejected/); assert.match(result.stderr + result.stdout, /failed|失败/i);
    f.env.INSTALL_OPENCODE = 'false'; f.requested.length = 0;
    assert.equal((await f.execute()).code, 0); assert.deepEqual(f.requested, []);
});

test('installer passes only selected Agents to the CLI', async t => {
    const f = await fixture(t, { proxySource: 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n' });
    f.env.INSTALL_QODER = 'false'; const result = await f.execute();
    assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /"prepare",.*"opencode"/); assert.doesNotMatch(result.stdout, /opencode,qoder/);
});

test('missing original working directory fails before the installer CLI can run', async t => {
    const f = await fixture(t, { proxySource: 'process.stdout.write("CLI_WAS_CALLED\\n");\n' });
    f.env.SETUP_WORKING_DIR = path.join(f.dir, 'missing-project');
    const result = await f.execute(); assert.notEqual(result.code, 0); assert.doesNotMatch(result.stdout, /CLI_WAS_CALLED/);
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
    const result = await f.execute(); assert.notEqual(result.code, 0);
    assert.equal(fs.existsSync(path.join(f.insight, 'inference-runtime')), false);
    assert.equal(fs.existsSync(path.join(f.insight, 'model-proxy.sh')), false);
    assert.equal(fs.readFileSync(f.openCodeFile, 'utf8'), f.originals.opencode);
});

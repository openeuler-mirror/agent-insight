import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { GET as getSetup } from '@/app/api/ingest/setup/route';
import { GET as getInstaller } from '@/app/api/ingest/setup/mcts-xgovernor/route';
import { mctsXgovernorCollectorBundle } from '@/app/api/ingest/setup/mcts-xgovernor/bundle';
import { isMctsRepoPath, mctsInstallCommand } from '@/lib/ingest/setup/mcts-install';

const require = createRequire(import.meta.url);
const { readMctsEnvFile, saveMctsRepoDir, mctsPaths, mctsUpstream } = require('../services/executor/src/mcts-config.cjs');
const { loadConfig } = require('../scripts/agent-trace-collectors/mcts-xgovernor-proxy/run.cjs');
const { probeMctsBenchmarkRuntime } = require('../services/executor/src/mcts-runtime.cjs');
const repository = process.cwd();

async function execute(command: string, env: NodeJS.ProcessEnv, cwd: string) {
    const child = spawn('bash', ['-c', command], { env, cwd });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    try {
        const code = await new Promise<number | null>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', resolve);
        });
        return { code, stdout, stderr };
    } finally { clearTimeout(timer); }
}

async function fixture(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcts-single-command-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const repoDir = path.join(root, `MCTS ' " # $(touch forbidden)`);
    const home = path.join(root, 'home');
    const insight = path.join(home, '.agent-insight');
    await fs.mkdir(path.join(repoDir, 'testcases_union', 'core'), { recursive: true });
    await fs.mkdir(path.join(repoDir, '.venv', 'bin'), { recursive: true });
    await fs.mkdir(insight, { recursive: true });
    await fs.writeFile(path.join(repoDir, 'testcases_union', 'run_union.sh'), '#!/bin/bash\nsource "$(dirname "$0")/config.env"\npython -m testcases_union.core.main "$@"\n');
    await fs.writeFile(path.join(repoDir, 'testcases_union', 'core', 'main.py'), '--output-dir');
    await fs.writeFile(path.join(repoDir, '.venv', 'bin', 'python'), '#!/bin/sh\nif [ "$1" = "-c" ]; then echo 3.11; exit 0; fi\nprintf "PYTHON_PROXY=%s\\n" "$XGOVERNOR_BASE_URL"\n', { mode: 0o700 });
    await fs.writeFile(path.join(insight, '.env'), 'OTHER_SETTING=keep\nAGENT_INSIGHT_MCTS_REPO_DIR=/old/path\n');
    await fs.mkdir(path.join(insight, 'collectors/shared'), { recursive: true });
    await fs.writeFile(path.join(insight, 'collectors/shared/trace-transport.cjs'), 'throw Error("unrelated collector transport");\n');
    const requests: string[] = [];
    let setup = '', installer = '';
    const server = http.createServer((req, res) => {
        const url = new URL(req.url!, 'http://localhost');
        requests.push(url.pathname + url.search);
        if (url.pathname === '/setup') res.end(setup);
        else if (url.pathname === '/api/ingest/setup/mcts-xgovernor') res.end(installer);
        else if (url.pathname.endsWith('mcts-xgovernor-collector.zip')) res.end(mctsXgovernorCollectorBundle(repository).buffer);
        else if (url.pathname === '/api/reliability/install-tokens') res.end('{"installToken":"fixture-token","user":"fixture-user"}');
        else if (url.pathname === '/api/ingest/setup/bundle' && url.searchParams.get('name') === 'client') res.end(clientBundle);
        else if (url.pathname.includes('/api/ingest/')) res.end('{}');
        else res.end('fixture');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const configEnv = path.join(repoDir, 'testcases_union', 'config.env');
    await fs.writeFile(configEnv, `export XGOVERNOR_BASE_URL="${origin}"\nexport XGOVERNOR_API_TOKEN="fixture-private-token"\n`);
    const stage = path.join(root, 'client-stub');
    await fs.mkdir(path.join(stage, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(stage, 'scripts', 'install-ras-client.js'), `
      const fs = require('node:fs'), path = require('node:path');
      const home = process.env.AGENT_INSIGHT_HOME;
      const cfg = JSON.parse(fs.readFileSync(path.join(home, 'collectors/mcts-xgovernor-proxy/config.json')));
      const helper = require(path.join(home, 'collectors/mcts-xgovernor-proxy/mcts-config.cjs'));
      if (helper.readMctsEnvFile(home).AGENT_INSIGHT_MCTS_REPO_DIR !== cfg.mctsRepoDir) throw Error('path missing at client startup');
      fs.writeFileSync(path.join(home, 'client-started'), cfg.mctsRepoDir);
      if (process.env.TEST_CLIENT_FAIL === '1') process.exit(1);
    `);
    const archive = spawnSync('tar', ['-czf', '-', '-C', stage, 'scripts']);
    assert.equal(archive.status, 0, archive.stderr.toString());
    const clientBundle = archive.stdout;
    // Skip platform authentication for this local fixture; production still validates the key.
    const response = await getSetup(new Request(`${origin}/api/ingest/setup?yes=1&nokey=1&frameworks=mcts-xgovernor&key=synthetic-key`, { headers: { 'x-platform': 'unix', host: new URL(origin).host, 'x-forwarded-proto': 'http' } }));
    setup = (await response.text()).replace('FORCE_NO_KEY=true', 'FORCE_NO_KEY=false');
    installer = await (await getInstaller(new Request(`${origin}/api/ingest/setup/mcts-xgovernor`))).text();
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, AGENT_INSIGHT_HOME: insight };
    for (const key of ['AGENT_INSIGHT_DATA_DIR', 'AGENT_INSIGHT_MCTS_REPO_DIR', 'AGENT_INSIGHT_MCTS_PYTHON', 'AGENT_INSIGHT_MCTS_TRACE_LAUNCHER', 'AGENT_INSIGHT_MCTS_REQUIRE_REPO', 'AGENT_INSIGHT_NO_KEY', 'AGENT_INSIGHT_FRAMEWORKS', 'AGENT_INSIGHT_CLIENT_SOURCE']) delete env[key];
    return { root, repoDir, insight, origin, configEnv, requests, env };
}

test('MCTS path validation and shell quoting preserve literal special characters', async t => {
    assert.equal(isMctsRepoPath(''), false);
    assert.equal(isMctsRepoPath('~/MCTS'), false);
    assert.equal(isMctsRepoPath('/opt/MCTS\nother'), false);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcts-path-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const repo = `/opt/MCTS ' " # $(touch forbidden)`;
    saveMctsRepoDir(root, repo);
    saveMctsRepoDir(root, repo);
    assert.equal(readMctsEnvFile(root).AGENT_INSIGHT_MCTS_REPO_DIR, repo);
    assert.equal((await fs.readFile(path.join(root, '.env'), 'utf8')).split('AGENT_INSIGHT_MCTS_REPO_DIR=').length, 2);
    assert.equal((await fs.stat(path.join(root, '.env'))).mode & 0o777, 0o600);
    saveMctsRepoDir(root, repo, '/opt/custom python/bin/python');
    assert.equal(readMctsEnvFile(root).AGENT_INSIGHT_MCTS_PYTHON, '/opt/custom python/bin/python');
});

test('one copied command persists configuration before client startup, supports rerun, and protects a fixed upstream', async t => {
    const f = await fixture(t);
    const command = mctsInstallCommand(`${f.origin}/setup`, f.repoDir);
    for (let i = 0; i < 2; i++) {
        const result = await execute(command, f.env, f.root);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.equal(await fs.readFile(path.join(f.insight, 'client-started'), 'utf8'), f.repoDir);
        assert.match(await fs.readFile(path.join(f.insight, '.env'), 'utf8'), /OTHER_SETTING=keep/);
        assert.doesNotMatch(result.stdout + result.stderr, /fixture-private-token/);
    }
    await assert.rejects(fs.access(path.join(f.root, 'forbidden')));
    assert.equal(await fs.readFile(path.join(f.insight, 'collectors/shared/trace-transport.cjs'), 'utf8'), 'throw Error("unrelated collector transport");\n');
    const original = await fs.readFile(f.configEnv, 'utf8');
    const wrapper = path.join(f.env.HOME!, '.local/bin/agent-insight-mcts-run');
    await fs.rm(path.join(f.insight, 'collectors/shared'), { recursive: true });
    assert.deepEqual(probeMctsBenchmarkRuntime({
        mctsRepoDir: f.repoDir,
        mctsTraceLauncher: path.join(f.insight, 'collectors/mcts-xgovernor-proxy/run.cjs'),
    }), { ready: true });
    const result = await execute(`'${wrapper}' --strict -- bash testcases_union/run_union.sh`, f.env, f.repoDir);
    assert.equal(result.code, 0, result.stderr);
    const injected = /PYTHON_PROXY=(http:\/\/127\.0\.0\.1:\d+)/.exec(result.stdout)?.[1];
    assert.ok(injected, result.stdout);
    assert.notEqual(injected, f.origin);
    assert.equal(await fs.readFile(f.configEnv, 'utf8'), original);
    await fs.writeFile(f.configEnv, original.replace(f.origin, 'http://127.0.0.1:9876'));
    const cfg = await loadConfig({}, f.env);
    assert.equal(cfg.upstreamUrl, 'http://127.0.0.1:9876');
});

test('invalid MCTS environment stops the one-command installer before registration or startup', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.repoDir, '.venv/bin/python'), '#!/bin/sh\necho 3.11\nexit 42\n', { mode: 0o700 });
    let result = await execute(mctsInstallCommand(`${f.origin}/setup`, f.repoDir), f.env, f.root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /datasets/);
    assert.equal(f.requests.includes('/api/reliability/install-tokens'), false);
    assert.equal(readMctsEnvFile(f.insight).AGENT_INSIGHT_MCTS_REPO_DIR, '/old/path');
    await fs.writeFile(path.join(f.repoDir, '.venv/bin/python'), '#!/bin/sh\necho 3.11\n', { mode: 0o700 });
    const unused = http.createServer();
    await new Promise<void>(resolve => unused.listen(0, '127.0.0.1', resolve));
    const port = (unused.address() as { port: number }).port;
    await new Promise<void>(resolve => unused.close(() => resolve()));
    await fs.writeFile(f.configEnv, `export XGOVERNOR_BASE_URL=http://127.0.0.1:${port}\n`);
    result = await execute(mctsInstallCommand(`${f.origin}/setup`, f.repoDir), f.env, f.root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /无法连接.*xGovernor/);
    assert.equal(f.requests.includes('/api/reliability/install-tokens'), false);
    await assert.rejects(fs.access(path.join(f.insight, 'client-started')));
});

test('client registration failure is not reported as a ready MCTS experiment client', async t => {
    const f = await fixture(t);
    const result = await execute(mctsInstallCommand(`${f.origin}/setup`, f.repoDir), { ...f.env, TEST_CLIENT_FAIL: '1' }, f.root);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /客户端注册或启动失败/);
    assert.doesNotMatch(result.stdout, /Telemetry: READY/);
});

test('invalid connection configuration reports no credentials or arbitrary shell output', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcts-config-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'testcases_union'));
    await fs.writeFile(path.join(root, 'testcases_union/config.env'), 'echo fixture-secret\nexport XGOVERNOR_BASE_URL=https://user:fixture-secret@example.com\n');
    assert.throws(() => mctsUpstream(mctsPaths({ mctsRepoDir: root })), error => !String(error).includes('fixture-secret'));
});

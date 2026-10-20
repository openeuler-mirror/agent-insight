import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
}

function fixture(t: TestContext) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'insight-entrypoint-runtime-')));
    const home = path.join(root, 'mounted home');
    const packageRoot = path.join(root, 'package');
    const bin = path.join(root, 'bin');
    const workdir = path.join(root, 'source-workdir');
    const markerFile = path.join(root, 'preparation.txt');
    const helper = path.join(root, 'container-runtime.py');
    const entrypoint = path.join(root, 'entrypoint.sh');
    const children: ChildProcess[] = [];
    t.after(async () => {
        for (const child of children) await stop(child);
        fs.rmSync(root, { recursive: true, force: true });
    });
    for (const directory of [home, bin, workdir, path.join(packageRoot, 'scripts'), path.join(packageRoot, '.next/standalone')]) {
        fs.mkdirSync(directory, { recursive: true });
    }
    fs.copyFileSync(path.resolve('scripts/container-runtime.py'), helper);
    const script = fs.readFileSync(path.resolve('scripts/docker-entrypoint.sh'), 'utf8')
        .replace('/usr/local/bin/agent-insight-container-runtime.py', helper)
        .replace('PACKAGE_ROOT="/app/node_modules/agent-insight"', `PACKAGE_ROOT="${packageRoot}"`)
        .replace('SOURCE_WORKDIR="/app/source"', `SOURCE_WORKDIR="${workdir}"`)
        .replaceAll('/app/node_modules/.bin', bin);
    fs.writeFileSync(entrypoint, script);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    fs.writeFileSync(path.join(bin, 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'npx'), '#!/bin/sh\nprintf "generate\\n" >> "$FIXTURE_MARKERS"\n', { mode: 0o700 });
    fs.writeFileSync(path.join(packageRoot, 'scripts/prepare-ras-sqlite-schema.js'),
        'require("node:fs").appendFileSync(process.env.FIXTURE_MARKERS, "prepare\\n");\n');
    fs.writeFileSync(path.join(packageRoot, 'scripts/db_push.sh'), '#!/bin/sh\nprintf "db-push\\n" >> "$FIXTURE_MARKERS"\n');
    fs.writeFileSync(path.join(packageRoot, '.next/standalone/server.js'), `
        const { runtimeOwner } = require(${JSON.stringify(path.resolve('src/lib/runtime-cleanup/ownership.ts'))});
        const { resolveInferenceAnalysisConfig, buildInferenceAnalysisUrl } = require(${JSON.stringify(path.resolve('src/lib/trace/inference-analysis-link.ts'))});
        const owner = runtimeOwner(process.env.AGENT_INSIGHT_HOME);
        const analysisOrigin = process.env.AGENT_INSIGHT_INFERENCE_ANALYSIS_ORIGIN;
        const analysisUrl = buildInferenceAnalysisUrl(resolveInferenceAnalysisConfig(analysisOrigin), 'compose-probe');
        process.stdout.write('RUNTIME_READY ' + JSON.stringify({ owner, pid: process.pid, analysisOrigin, analysisUrl }) + '\\n');
        setInterval(() => {}, 1000);
    `);
    fs.writeFileSync(path.join(home, '.env'), 'AGENT_INSIGHT_RUNTIME_OWNER="forged-by-env-file"\nAGENT_INSIGHT_LOG_DIR=/var/log/agent-insight\n');
    const env: NodeJS.ProcessEnv = {
        NODE_ENV: 'test',
        NODE_OPTIONS: `--import ${path.resolve('node_modules/tsx/dist/loader.mjs')}`,
        PATH: `${bin}${path.delimiter}${process.env.PATH || '/usr/bin:/bin'}`,
        HOME: root,
        AGENT_INSIGHT_HOME: home,
        OPENCODE_BIN: path.join(bin, 'opencode'),
        FIXTURE_MARKERS: markerFile,
    };
    async function launch() {
        const child = spawn('/bin/sh', [entrypoint], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(child);
        let stdout = '';
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += String(chunk); });
        const ready = await new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`entrypoint launch timed out: ${stdout} ${stderr}`)), 10_000);
            child.once('error', error => { clearTimeout(timeout); reject(error); });
            child.once('exit', (code, signal) => { clearTimeout(timeout); reject(new Error(`entrypoint exited (${code ?? signal}): ${stdout} ${stderr}`)); });
            child.stdout.on('data', chunk => {
                stdout += String(chunk);
                const line = stdout.split('\n').slice(0, -1).find(value => value.startsWith('RUNTIME_READY '));
                if (line) { clearTimeout(timeout); resolve(line.slice('RUNTIME_READY '.length)); }
            });
        });
        return { child, ...JSON.parse(ready) as { owner?: { id: string; scope: string; fd: number }; pid: number; analysisOrigin?: string; analysisUrl?: string } };
    }
    return { root, home, env, entrypoint, markerFile, workdir, launch };
}

test('real Docker entrypoint preserves the kernel-owned descriptor through shell re-exec and .env loading', async t => {
    if (process.platform === 'win32') return t.skip('container flock requires a Unix host');
    const setup = fixture(t);
    const running = await setup.launch();
    assert.ok(running.owner, 'the final Node process must pass the actual runtimeOwner validation');
    assert.equal(running.pid, running.child.pid);
    assert.equal(running.owner.scope, setup.home);
    assert.match(running.owner.id, /^[a-f0-9-]{36}$/);
    assert.equal(fs.readFileSync(setup.markerFile, 'utf8'), 'prepare\ndb-push\ngenerate\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(setup.home, '.runtime-owner.lock'), 'utf8')).id, running.owner.id);
    assert.match(fs.readFileSync(path.join(setup.home, '.env'), 'utf8'), /forged-by-env-file/);
});

test('real Docker entrypoint rejects a second instance before database preparation', async t => {
    if (process.platform === 'win32') return t.skip('container flock requires a Unix host');
    const setup = fixture(t);
    await setup.launch();
    const prepared = fs.readFileSync(setup.markerFile, 'utf8');
    const second = spawnSync('/bin/sh', [setup.entrypoint], { env: setup.env, encoding: 'utf8', timeout: 5000 });
    assert.equal(second.error, undefined);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already in use/);
    assert.equal(fs.readFileSync(setup.markerFile, 'utf8'), prepared);
});

test('real Docker entrypoint rejects a second source deployment before validating or clearing its build workdir', async t => {
    if (process.platform === 'win32') return t.skip('container flock requires a Unix host');
    const setup = fixture(t);
    await setup.launch();
    const sentinel = path.join(setup.workdir, 'keep-until-owner-acquired');
    fs.writeFileSync(sentinel, 'untouched');
    const prepared = fs.readFileSync(setup.markerFile, 'utf8');
    const second = spawnSync('/bin/sh', [setup.entrypoint], {
        env: { ...setup.env, AGENT_INSIGHT_SOURCE_DIR: path.join(setup.root, 'not-a-source-tree') },
        encoding: 'utf8', timeout: 5000,
    });
    assert.equal(second.error, undefined);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already in use/);
    assert.doesNotMatch(second.stderr, /package\.json/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
    assert.equal(fs.readFileSync(setup.markerFile, 'utf8'), prepared);
});

test('Compose analysis origin takes precedence over a persisted .env through the complete entrypoint', async t => {
    const setup = fixture(t);
    const envFile = path.join(setup.home, '.env');
    fs.appendFileSync(envFile, 'AGENT_INSIGHT_INFERENCE_ANALYSIS_ORIGIN=http://old.example.test:8080\n');
    const original = fs.readFileSync(envFile, 'utf8');
    setup.env.AGENT_INSIGHT_INFERENCE_ANALYSIS_ORIGIN = 'https://analysis.example.test:9443';
    const running = await setup.launch();
    assert.equal(running.analysisOrigin, 'https://analysis.example.test:9443');
    assert.equal(running.analysisUrl, 'https://analysis.example.test:9443/model-performance?GlobalTrackNO=compose-probe');
    assert.equal(fs.readFileSync(envFile, 'utf8'), original);
});

test('an explicitly empty Compose analysis origin disables links despite a persisted address', async t => {
    const setup = fixture(t);
    fs.appendFileSync(path.join(setup.home, '.env'), 'AGENT_INSIGHT_INFERENCE_ANALYSIS_ORIGIN=http://old.example.test:8080\n');
    setup.env.AGENT_INSIGHT_INFERENCE_ANALYSIS_ORIGIN = '';
    const running = await setup.launch();
    assert.equal(running.analysisOrigin, '');
    assert.equal(running.analysisUrl, undefined);
});

test('legacy deployments keep reading the analysis origin from .env when Compose does not set it', async t => {
    const setup = fixture(t);
    fs.appendFileSync(path.join(setup.home, '.env'), 'AGENT_INSIGHT_INFERENCE_ANALYSIS_ORIGIN=http://existing.example.test:8080\n');
    const running = await setup.launch();
    assert.equal(running.analysisUrl, 'http://existing.example.test:8080/model-performance?GlobalTrackNO=compose-probe');
});

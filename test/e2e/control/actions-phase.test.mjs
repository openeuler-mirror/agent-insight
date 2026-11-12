import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as phase from './actions-phase.mjs';
import { requiredStagesFor } from '../shared/core.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-phase-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'source');fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, '.gitignore'), '.next/\ngenerated/\nexclude/\n');
  fs.writeFileSync(path.join(project, 'source.txt'), 'same source');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']]) assert.equal(spawnSync('git', args, { cwd: project }).status, 0);
  const testedSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).stdout.trim();
  return { root, project, testedSha, runId: 'atomgit-fixture', env: { PATH: process.env.PATH, E2E_ACTION_EVENT: 'Manual', E2E_CASE_MODES: '{"001":"real"}', E2E_MODEL_NAME: 'example-model', E2E_MODEL_BASE_URL: 'https://model.example.com/v1', E2E_MODEL_API_KEY: 'synthetic-phase-key', ATOMGIT_TOKEN: 'synthetic-platform-secret', E2E_ISOLATED_CONTAINER: '1', E2E_JOB_RESULTS_JSON: JSON.stringify(Object.fromEntries(['build','ut','001','002','003','004','005'].map(id => [id,'success']))) } };
}
function fakeBuild(project) {
  for (const name of ['.next/BUILD_ID', '.next/standalone/server.js', '.next/standalone/.next/required-server-files.json', 'generated/trace-datasets/worker.cjs']) {
    const file = path.join(project, name);fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, name.endsWith('BUILD_ID') ? 'fixture-build' : '{}');
  }
  fs.mkdirSync(path.join(project, '.next/static'), { recursive: true });
  fs.mkdirSync(path.join(project, '.next/cache'), { recursive: true });fs.writeFileSync(path.join(project, '.next/cache/private-cache'), 'not exported');
  fs.writeFileSync(path.join(project, '.next/standalone/.env'), 'NEXT_SYNTHETIC_KEY=not-exported-secret');
  fs.writeFileSync(path.join(project, '.next/standalone/generated.db'), 'not-exported-database');
}
async function build(t, runId = 'atomgit-fixture') {
  const options = fixture(t);let builds = 0;
  options.runId = runId;
  options.env.ATOMGIT_OUTPUT = path.join(options.root, 'outputs');
  const result = await phase.runActionsPhase({ ...options, phase: 'build' }, { compile: async (config, { env }) => {
    builds++;assert.equal(env.E2E_MODEL_API_KEY, undefined);assert.equal(env.ATOMGIT_TOKEN, undefined);fakeBuild(options.project);
    assert.match(fs.readFileSync(options.env.ATOMGIT_OUTPUT, 'utf8'), /case_001_mode=real\n/);
    return { status: 'PASS', exitCode: 0, buildId: 'fixture-build', durationMs: 1 };
  } });
  assert.equal(builds, 1);assert.equal(result.status, 'PASS');return options;
}
function installInputs(options, results) {
  for (const [name, result] of Object.entries(results)) {
    const directory = path.join(options.root, 'inputs', name);fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result));
    if (name === 'build') fs.copyFileSync(path.join(options.root, 'public/context.json'), path.join(directory, 'context.json'));
  }
}
function passUt() { return { status: 'PASS', exitCode: 0, runnerCompleted: true, fullSuiteComplete: true, interrupted: false, observedSummary: { tests: 3, pass: 2, fail: 0, cancelled: 0, skipped: 1, todo: 0 }, failures: [], skippedTests: [{ title: 'SQLite fixture', reason: 'deferred' }] }; }
const childRunId = (runId, caseId) => `ag-${createHash('sha256').update(runId).digest('hex').slice(0, 16)}-${caseId}`;
function writeCaseReport(options, args, env, overrides = {}) {
  const caseId = args[args.indexOf('--case') + 1], runId = args[args.indexOf('--run-id') + 1], configuration = JSON.parse(env.E2E_CONFIG_PROVENANCE);
  const directory = path.join(options.project, 'exclude/core-e2e', runId);fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ runId, testedSha: options.testedSha, configuration, mode: configuration.settings.caseModes[caseId], startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), scenarios: [{ id: 'CORE-E2E-' + caseId, status: 'PASS', stages: requiredStagesFor(caseId).map(id => ({ id, status: 'PASS' })) }], ...overrides }));
  return runId;
}

test('build exports one credential-free checked artifact and manual case mode outputs', async t => {
  const options = await build(t);
  const context = JSON.parse(fs.readFileSync(path.join(options.root, 'build-payload/context.json')));
  assert.equal(context.configuration.settings.caseModes['001'], 'real');assert.equal(context.testedSha, options.testedSha);
  assert.equal(context.buildId, 'fixture-build');assert.equal(context.payloadSha256.length, 64);
  const names = spawnSync('tar', ['-tzf', path.join(options.root, 'build-payload/compiled.tar.gz')], { encoding: 'utf8' }).stdout;
  assert.match(names, /manifest.json/);assert.doesNotMatch(names, /cache|private|\.env|\.db/);
  assert.ok(!JSON.stringify(context).includes('synthetic-phase-key'));
  const report = JSON.parse(fs.readFileSync(path.join(options.root, 'public/report.json')));
  assert.equal(report.status, 'PASS');assert.equal(report.resultScope, 'phase');assert.equal(report.phase, 'build');
  assert.ok(report.scenarios.every(row => row.status === 'NOT_RUN'));
  assert.match(fs.readFileSync(path.join(options.root, 'public/summary.md'), 'utf8'), /本 Job 仅表示生产编译结果；整体验证结论见“汇总与门禁” Job/);
  assert.match(fs.readFileSync(path.join(options.root, 'public/report.html'), 'utf8'), /Actions 阶段：生产编译/);
});

test('phase reports retain the platform attempt for safe rerun publication', async t => {
  const options = fixture(t);options.env.ATOMGIT_RUN_ATTEMPT = '2';
  await phase.runActionsPhase({ ...options, phase: 'build' }, { compile: async () => { fakeBuild(options.project);return { status: 'PASS', exitCode: 0, buildId: 'fixture-build' }; } });
  const report = JSON.parse(fs.readFileSync(path.join(options.root, 'public/report.json')));
  assert.equal(report.platformRunAttempt, 2);
});

test('case imports a matching build, runs only its case with file credentials, and preserves a nonzero exit', async t => {
  const options = await build(t);let keyPath;
  const result = await phase.runActionsPhase({ ...options, phase: 'case', caseId: '001' }, { run: async (bin, args, { env, cwd }) => {
    assert.ok(args.includes('test/e2e/run-case.mjs'));assert.ok(args.includes('001'));assert.equal(cwd, options.project);
    assert.equal(env.E2E_MODEL_API_KEY, undefined);assert.equal(env.ATOMGIT_TOKEN, undefined);assert.equal(env.E2E_STATE_ROOT, undefined);
    keyPath = args[args.indexOf('--key-file') + 1];assert.equal(fs.readFileSync(keyPath, 'utf8'), 'synthetic-phase-key');assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
    const childId = args[args.indexOf('--run-id') + 1], directory = path.join(cwd, 'exclude/core-e2e', childId);fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ runId: childId, testedSha: options.testedSha, configuration: JSON.parse(env.E2E_CONFIG_PROVENANCE), mode: 'real', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), scenarios: [{ id: 'CORE-E2E-001', status: 'PASS', stages: requiredStagesFor('001').map(id => ({ id, status: 'PASS' })) }] }));
    return { code: 7 };
  } });
  assert.equal(result.status, 'FAIL', JSON.stringify(result));assert.equal(fs.existsSync(keyPath), false);
  assert.equal(fs.readFileSync(path.join(options.project, '.next/BUILD_ID'), 'utf8'), 'fixture-build');
});

test('case child IDs keep the 003 dataset name within the UI limit and preserve full parent identity', async t => {
  const options = await build(t, 'atomgit-5b420089ded447889a7c47182ef1b517');let childId;
  const result = await phase.runActionsPhase({ ...options, phase: 'case', caseId: '003' }, { run: async (bin, args, { env }) => {
    assert.equal(env.E2E_SUITE_RUN_ID, options.runId);
    childId = writeCaseReport(options, args, env);
    return { code: 0 };
  } });
  const datasetName = `e2e-behavior-${childId}-003`;
  assert.ok(datasetName.length <= 50, `003 dataset name exceeds the UI limit: ${datasetName}`);
  assert.equal(childId, childRunId(options.runId, '003'));assert.equal(childId.length, 23);
  assert.equal(result.status, 'PASS', JSON.stringify(result));assert.equal(result.runId, options.runId);assert.equal(result.payload.runId, childId);
  const context = JSON.parse(fs.readFileSync(path.join(options.root, 'public/context.json'))), report = JSON.parse(fs.readFileSync(path.join(options.root, 'public/report.json')));
  assert.equal(context.runId, options.runId);assert.equal(report.runId, options.runId);assert.equal(report.scenarios.find(row => row.id === '003').runId, childId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(options.project, 'exclude/core-e2e/production-build.json'))).suiteRunId, options.runId);
});

test('case child IDs are stable per parent and unique across the five cases and parent runs', async t => {
  const seen = new Set();
  for (const parentId of ['atomgit-' + '1'.repeat(32), 'atomgit-' + '2'.repeat(32)]) {
    const options = await build(t, parentId), observed = new Map();
    for (const caseId of ['001','002','003','004','005','003']) {
      let childId;
      const result = await phase.runActionsPhase({ ...options, phase: 'case', caseId }, { run: async (bin, args, { env }) => {
        childId = writeCaseReport(options, args, env);return { code: 0 };
      } });
      assert.equal(result.status, 'PASS', JSON.stringify(result));assert.equal(childId, childRunId(parentId, caseId));assert.match(childId, /^ag-[a-f0-9]{16}-00[1-5]$/);
      if (observed.has(caseId)) assert.equal(childId, observed.get(caseId));
      else { assert.ok(!seen.has(childId), 'Child ID must distinguish parent runs and cases');seen.add(childId);observed.set(caseId, childId); }
    }
    const unknown = await phase.runActionsPhase({ ...options, phase: 'case', caseId: '006' }, { run: () => assert.fail('Unknown case must not launch') });
    assert.equal(unknown.status, 'BLOCKED');assert.match(unknown.payload.reason, /Unknown Actions case/);
  }
  assert.equal(seen.size, 10);
});

test('case rejects child reports with a sibling case or another parent identity', async t => {
  const options = await build(t);
  for (const runId of [childRunId(options.runId, '004'), childRunId('atomgit-other-parent', '003')]) {
    const result = await phase.runActionsPhase({ ...options, phase: 'case', caseId: '003' }, { run: async (bin, args, { env }) => {
      writeCaseReport(options, args, env, { runId });return { code: 0 };
    } });
    assert.equal(result.status, 'BLOCKED');assert.match(result.payload.reason, /Expected values to be strictly equal/);
  }
});

test('case progress reads the canonical child report path', async t => {
  const options = await build(t);let progress;
  const schedule = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (callback, ms) => { progress = callback;return schedule(callback, ms); });
  const output = t.mock.method(console, 'log', () => {});
  const result = await phase.runActionsPhase({ ...options, phase: 'case', caseId: '003' }, { run: async (bin, args, { env }) => {
    writeCaseReport(options, args, env);progress();return { code: 0 };
  } });
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  const events = output.mock.calls.filter(call => call.arguments[0] === 'CI_PHASE_PROGRESS').map(call => JSON.parse(call.arguments[1]));
  assert.ok(events.some(event => event.caseId === '003' && event.stage === requiredStagesFor('003').at(-1) && event.stageStatus === 'PASS'));
});

test('altered source and corrupted downloaded archives fail before launching cases', async t => {
  const options = await build(t);fs.writeFileSync(path.join(options.project, 'source.txt'), 'changed');
  const result = await phase.runActionsPhase({ ...options, phase: 'case', caseId: '002' }, { run: () => assert.fail('must not launch') });
  assert.notEqual(result.status, 'PASS');
  fs.writeFileSync(path.join(options.project, 'source.txt'), 'same source');fs.appendFileSync(path.join(options.root, 'build-payload/compiled.tar.gz'), 'corrupt');
  const corrupted = await phase.runActionsPhase({ ...options, phase: 'case', caseId: '002' }, { run: () => assert.fail('must not launch') });
  assert.notEqual(corrupted.status, 'PASS');
});

test('collection requires all phase results, strict identity, stage evidence and process success', async t => {
  const options = await build(t), context = JSON.parse(fs.readFileSync(path.join(options.root, 'public/context.json')));
  const buildResult = JSON.parse(fs.readFileSync(path.join(options.root, 'public/result.json')));
  const envelope = (stage, payload, id) => ({ ...buildResult, phase: stage, ...(id ? { caseId: id } : {}), payload, status: 'PASS', exitCode: 0 });
  const results = { build: buildResult, ut: envelope('ut', passUt()) };
  for (const id of ['001','002','003','004','005']) results[id] = envelope('case', { id, runId: childRunId(options.runId, id), title: id, mode: context.configuration.settings.caseModes[id], status: 'PASS', stages: requiredStagesFor(id).map(id => ({ id, status: 'PASS' })), startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }, id);
  installInputs(options, results);
  const passing = await phase.runActionsPhase({ ...options, phase: 'collect' });assert.equal(passing.status, 'PASS');
  for (const change of [r => { delete r['003']; }, r => { r['003'].testedSha = 'f'.repeat(40); }, r => { r['003'].payload.runId = childRunId(options.runId, '004'); }, r => { r['003'].exitCode = 7; }, r => { r['003'].payload.stages = []; }, r => { r['003'].payload.mode = 'real'; }, r => { r.ut.payload = { ...passUt(), status: 'FAIL', exitCode: 1, observedSummary: { tests: 3, pass: 1, fail: 1, cancelled: 0, skipped: 1, todo: 0 }, failures: [{ file: 'test/example.test.ts', title: 'retained failure' }] };r.ut.status = 'FAIL';r.ut.exitCode = 1; }]) {
    const mutated = structuredClone(results);change(mutated);
    fs.rmSync(path.join(options.root, 'inputs'), { recursive: true });installInputs(options, mutated);
    const result = await phase.runActionsPhase({ ...options, phase: 'collect' });assert.notEqual(result.status, 'PASS');
  }
  const report = JSON.parse(fs.readFileSync(path.join(options.root, 'public/report.json')));
  assert.ok(report.scenarios.every(s => s.status === 'PASS'));assert.equal(report.npmTest.status, 'FAIL');
  assert.match(fs.readFileSync(path.join(options.root, 'public/summary.md'), 'utf8'), /retained failure/);
  fs.rmSync(path.join(options.root, 'inputs'), { recursive: true });installInputs(options, results);
  for (const outcomes of [undefined, '{', JSON.stringify({ build: 'success' }), JSON.stringify({ build: 'success', ut: 'success', '001': 'failure', '002': 'success', '003': 'success', '004': 'success', '005': 'success' })]) {
    const result = await phase.runActionsPhase({ ...options, env: { ...options.env, E2E_JOB_RESULTS_JSON: outcomes }, phase: 'collect' });assert.notEqual(result.status,'PASS');
    for (const file of ['summary.md','report.html']) assert.match(fs.readFileSync(path.join(options.root, 'public', file), 'utf8'), /platform outcome/);
  }
});

test('UT executes a real npm-to-Node child with the exact skip and no platform/model credentials', async t => {
  const options = fixture(t);
  options.env.E2E_SKIP_TRACE_DATASET_CONCURRENCY_UT = '1';
  const bin = path.join(options.root, 'fixture-bin');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexec node --test fixture-ut.test.mjs\n', { mode: 0o700 });
  options.env.PATH = bin + path.delimiter + process.env.PATH;
  fs.writeFileSync(path.join(options.project, 'fixture-ut.test.mjs'), `import test from 'node:test';import assert from 'node:assert/strict';test('UT child receives only expected inputs',()=>{assert.equal(process.env.E2E_SKIP_TRACE_DATASET_CONCURRENCY_UT,'1');assert.equal(process.env.E2E_MODEL_API_KEY,undefined);assert.equal(process.env.ATOMGIT_TOKEN,undefined);assert.ok(process.env.AGENT_INSIGHT_HOME.includes('/private/ut/'));});test('deferred test',{skip:'database refactor'},()=>assert.fail());`);
  assert.equal(spawnSync('git', ['add', '.'], { cwd: options.project }).status, 0);
  assert.equal(spawnSync('git', ['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','UT fixture'], { cwd: options.project }).status, 0);
  options.testedSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: options.project, encoding: 'utf8' }).stdout.trim();
  assert.equal((await phase.runActionsPhase({ ...options, phase: 'build' }, { compile: async () => { fakeBuild(options.project);return { status: 'PASS', exitCode: 0, buildId: 'fixture-build' }; } })).status, 'PASS');
  const result = await phase.runActionsPhase({ ...options, phase: 'ut' });
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.deepEqual(result.payload.observedSummary, { tests: 2, pass: 1, fail: 0, cancelled: 0, skipped: 1, todo: 0 });
  assert.deepEqual(result.payload.skippedTests, [{ title: 'deferred test', reason: 'database refactor' }]);
});

test('invalid contexts and missing results still produce a readable failed public summary', async t => {
  const options = fixture(t);
  fs.mkdirSync(path.join(options.root, 'inputs/build'), { recursive: true });
  fs.writeFileSync(path.join(options.root, 'inputs/build/context.json'), '{');
  const result = await phase.runActionsPhase({ ...options, phase: 'collect' });
  assert.equal(result.status, 'BLOCKED');
  assert.match(fs.readFileSync(path.join(options.root, 'public/summary.md'), 'utf8'), /汇总与门禁：BLOCKED/);
  for (const file of ['summary.md','report.html']) assert.match(fs.readFileSync(path.join(options.root, 'public', file), 'utf8'), /阻塞原因[\s\S]*JSON/);
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(options.root, 'public/report.json'))).status, 'PASS');
  const escaped = await phase.runActionsPhase({ ...options, phase: 'build' }, { compile: async () => { throw Error('<script>alert("unsafe")</script> synthetic-phase-key'); } });
  assert.equal(escaped.status, 'BLOCKED');
  for (const file of ['summary.md','report.html']) {
    const text = fs.readFileSync(path.join(options.root, 'public', file), 'utf8');
    assert.match(text, /&lt;script&gt;/);assert.doesNotMatch(text, /<script>|synthetic-phase-key/);
  }
});

test('unsafe archive links are rejected even when the archive digest matches', async t => {
  const options = await build(t);
  const malicious = path.join(options.root, 'malicious');fs.mkdirSync(malicious);fs.symlinkSync(os.tmpdir(), path.join(malicious, '.next'));
  const archive = path.join(options.root, 'build-payload/compiled.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', malicious, '.next'], { env: { ...process.env, COPYFILE_DISABLE: '1' } }).status, 0);
  const contextFile = path.join(options.root, 'build-payload/context.json'), context = JSON.parse(fs.readFileSync(contextFile));
  const { createHash } = await import('node:crypto');context.payloadSha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');fs.writeFileSync(contextFile, JSON.stringify(context));
  const result = await phase.runActionsPhase({ ...options, phase: 'case', caseId: '002' }, { run: () => assert.fail('Unsafe archive must not execute') });
  assert.equal(result.status, 'BLOCKED');assert.match(result.payload.reason, /Unsafe compiled artifact/);
});

test('a cancelled real CLI removes its temporary model key after stopping the child', async t => {
  const options = fixture(t), script = path.join(options.project, 'test/e2e/run-case.mjs');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "import fs from 'node:fs';process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[process.argv.indexOf('--key-file')+1]+'.ready','ready');setInterval(() => {}, 1000);\n");
  assert.equal(spawnSync('git', ['add', '.'], { cwd: options.project }).status, 0);
  assert.equal(spawnSync('git', ['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','cancellation fixture'], { cwd: options.project }).status, 0);
  options.testedSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: options.project, encoding: 'utf8' }).stdout.trim();
  assert.equal((await phase.runActionsPhase({ ...options, phase: 'build' }, { compile: async () => { fakeBuild(options.project);return { status: 'PASS', exitCode: 0, buildId: 'fixture-build' }; } })).status, 'PASS');
  const child = spawn(process.execPath, [new URL('./actions-phase.mjs', import.meta.url).pathname, '--phase','case','--case','001','--project',options.project,'--root',options.root,'--run-id',options.runId,'--tested-sha',options.testedSha], { env: options.env, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const key = path.join(options.root, 'private/model.key'), deadline = Date.now() + 10000;
  while (!fs.existsSync(key + '.ready') && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(key + '.ready'), 'Real CLI reaches the key-file boundary');
  const closed = once(child, 'close');child.kill('SIGTERM');
  assert.deepEqual(await closed, [143, null]);assert.equal(fs.existsSync(key), false);
});

test('Actions build marks only workload children and records completed scoped cleanup before publishing', async t => {
  const options = fixture(t), marker = 'a'.repeat(64);options.env.E2E_ATOMGIT_JOB = '1';let cleaned = 0, started = 0;
  const original = process.env.E2E_ACTIONS_PROCESS_SCOPE;
  const result = await phase.runActionsPhase({ ...options, phase: 'build' }, {
    createProcessScope: async () => ({ env: { E2E_ACTIONS_PROCESS_SCOPE: marker }, cleanup: async () => { cleaned++;return { status: 'PASS', stopped: 2, remaining: 0 }; } }),
    compile: async (config, { env }) => {
      started++;assert.equal(env.E2E_ACTIONS_PROCESS_SCOPE, marker);assert.equal(process.env.E2E_ACTIONS_PROCESS_SCOPE, original);assert.equal(options.env.E2E_ACTIONS_PROCESS_SCOPE, undefined);
      fakeBuild(options.project);return { status: 'PASS', exitCode: 0, buildId: 'fixture-build' };
    },
  });
  assert.equal(result.status, 'PASS', JSON.stringify(result));assert.equal(started, 1);assert.equal(cleaned, 1);
  assert.deepEqual(result.processCleanup, { status: 'PASS', stopped: 2, remaining: 0 });
  for (const file of ['result.json','report.json','summary.md','context.json']) assert.ok(!fs.readFileSync(path.join(options.root,'public',file),'utf8').includes(marker));
  const report = JSON.parse(fs.readFileSync(path.join(options.root,'public/report.json')));assert.deepEqual(report.processCleanup, result.processCleanup);
  assert.match(fs.readFileSync(path.join(options.root,'public/summary.md'),'utf8'), /Job.*清理.*PASS/);
});

test('Actions fallback runs after success, nonzero exit, hard termination and a thrown child error', async t => {
  for (const kind of ['success','nonzero','killed','throw']) {
    const options = await build(t);options.env.E2E_ATOMGIT_JOB = '1';let cleaned = 0;
    const result = await phase.runActionsPhase({ ...options, phase: 'case', caseId: '002' }, {
      createProcessScope: async () => ({ env: { E2E_ACTIONS_PROCESS_SCOPE: 'b'.repeat(64) }, cleanup: async () => { cleaned++;return { status: 'PASS', stopped: 1, remaining: 0 }; } }),
      run: async (bin, args, { env }) => {
        assert.equal(env.E2E_ACTIONS_PROCESS_SCOPE, 'b'.repeat(64));
        if (kind === 'throw') throw Error('Fixture child spawn failed');
        writeCaseReport(options,args,env);
        return kind === 'killed' ? { code: null, signal: 'SIGKILL', expired: true } : { code: kind === 'nonzero' ? 7 : 0 };
      },
    });
    assert.equal(cleaned, 1, kind);assert.equal(result.processCleanup.status, 'PASS');
    assert.equal(result.status, kind === 'success' ? 'PASS' : kind === 'throw' ? 'BLOCKED' : 'FAIL');
  }
});

test('a failed Actions cleanup blocks an otherwise passing phase without leaking its marker', async t => {
  const options = await build(t), marker = 'c'.repeat(64);options.env.E2E_ATOMGIT_JOB = '1';
  const result = await phase.runActionsPhase({ ...options, phase: 'case', caseId: '002' }, {
    createProcessScope: async () => ({ env: { E2E_ACTIONS_PROCESS_SCOPE: marker }, cleanup: async () => { throw Error('Owned process remains: '+marker); } }),
    run: async (bin, args, { env }) => { writeCaseReport(options,args,env);return { code: 0 }; },
  });
  assert.equal(result.status,'BLOCKED');assert.equal(result.exitCode,1);assert.equal(result.payload.status,'BLOCKED');assert.equal(result.processCleanup.status,'BLOCKED');
  assert.match(result.payload.reason,/cleanup|清理/i);
  for (const file of ['result.json','report.json','summary.md','report.html']) {
    const text=fs.readFileSync(path.join(options.root,'public',file),'utf8');assert.ok(!text.includes(marker));assert.match(text,/BLOCKED/);
  }
});

test('Actions cleanup capability failure stops work before compile and collectors never create a process scope', async t => {
  const options = fixture(t);options.env.E2E_ATOMGIT_JOB='1';let created=0;
  const overrides={createProcessScope:async()=>{created++;throw Error('pidfd unavailable');},compile:()=>assert.fail('Capability failure must stop compile')};
  const failed=await phase.runActionsPhase({...options,phase:'build'},overrides);
  assert.equal(failed.status,'BLOCKED');assert.equal(created,1);assert.match(failed.payload.reason,/pidfd unavailable/);
  await phase.runActionsPhase({...options,phase:'collect'},overrides);assert.equal(created,1);
});

test('Actions collector rejects missing or unsuccessful process cleanup even when workload results pass', async t => {
  const options=await build(t),context=JSON.parse(fs.readFileSync(path.join(options.root,'public/context.json'))),built=JSON.parse(fs.readFileSync(path.join(options.root,'public/result.json')));
  const cleanup={status:'PASS',stopped:0,remaining:0};
  const wrap=(phase,payload,id)=>({...built,phase,...(id?{caseId:id}:{}),payload,status:'PASS',exitCode:0,processCleanup:cleanup});
  const results={build:wrap('build',built.payload),ut:wrap('ut',passUt())};
  for(const id of ['001','002','003','004','005'])results[id]=wrap('case',{id,runId:childRunId(options.runId,id),title:id,mode:context.configuration.settings.caseModes[id],status:'PASS',stages:requiredStagesFor(id).map(id=>({id,status:'PASS'}))},id);
  options.env.E2E_ATOMGIT_JOB='1';installInputs(options,results);
  assert.equal((await phase.runActionsPhase({...options,phase:'collect'})).status,'PASS');
  const combined=JSON.parse(fs.readFileSync(path.join(options.root,'public/report.json')));
  assert.deepEqual(Object.keys(combined.processCleanups).sort(),['001','002','003','004','005','build','ut']);assert.deepEqual(combined.processCleanups['003'],cleanup);
  assert.match(fs.readFileSync(path.join(options.root,'public/summary.md'),'utf8'),/Job.*进程清理.*汇总/);
  for(const cleanup of [undefined,{status:'BLOCKED'},{status:'PASS',stopped:0,remaining:1},{status:'PASS',stopped:-1,remaining:0}]){
    const changed=structuredClone(results);changed['003'].processCleanup=cleanup;installInputs(options,changed);
    assert.notEqual((await phase.runActionsPhase({...options,phase:'collect'})).status,'PASS');
  }
});

test('Actions CLI reaps escaped workload processes after hard failure or cancellation and preserves its Worker sibling', {skip:process.platform!=='linux'}, async t => {
  for(const mode of ['hard','cancel']){
    const options=fixture(t),script=path.join(options.project,'test/e2e/run-case.mjs');fs.mkdirSync(path.dirname(script),{recursive:true});
    const daemon="process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    fs.writeFileSync(script,`import fs from 'node:fs';import {spawn} from 'node:child_process';const daemon=spawn(process.execPath,['-e',${JSON.stringify(daemon)}],{detached:true,stdio:'ignore'});process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[process.argv.indexOf('--key-file')+1]+'.ready',JSON.stringify({root:process.pid,daemon:daemon.pid}));${mode==='hard'?"process.kill(process.pid,'SIGKILL');":"setInterval(()=>{},1000);"}\n`);
    for(const args of [['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','escaped process fixture']])assert.equal(spawnSync('git',args,{cwd:options.project}).status,0);
    options.testedSha=spawnSync('git',['rev-parse','HEAD'],{cwd:options.project,encoding:'utf8'}).stdout.trim();
    assert.equal((await phase.runActionsPhase({...options,phase:'build'},{compile:async()=>{fakeBuild(options.project);return {status:'PASS',exitCode:0,buildId:'fixture-build'};}})).status,'PASS');
    const worker=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],{cwd:options.project,env:options.env,detached:true,stdio:['ignore','pipe','ignore']});
    t.after(()=>{try{process.kill(-worker.pid,'SIGKILL');}catch{}});await once(worker.stdout,'data');
    const child=spawn(process.execPath,[new URL('./actions-phase.mjs',import.meta.url).pathname,'--phase','case','--case','001','--project',options.project,'--root',options.root,'--run-id',options.runId,'--tested-sha',options.testedSha],{env:{...options.env,E2E_ATOMGIT_JOB:'1'},detached:true,stdio:'ignore'});
    const closed=once(child,'close');let owned;
    t.after(()=>{for(const pid of [child.pid,owned?.root,owned?.daemon])if(pid)try{process.kill(-pid,'SIGKILL');}catch{}});
    const key=path.join(options.root,'private/model.key'),deadline=Date.now()+20000;
    while(!fs.existsSync(key+'.ready')&&Date.now()<deadline&&child.exitCode===null)await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(fs.existsSync(key+'.ready'),'CLI starts the escaped workload');owned=JSON.parse(fs.readFileSync(key+'.ready'));
    if(mode==='cancel')child.kill('SIGTERM');
    const stop=setTimeout(()=>child.kill('SIGKILL'),20000);
    try{assert.deepEqual(await closed,[mode==='cancel'?143:1,null]);}finally{clearTimeout(stop);}
    let state='';try{const stat=fs.readFileSync(`/proc/${owned.daemon}/stat`,'utf8');state=stat.slice(stat.lastIndexOf(')')+2).split(' ')[0];}catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}
    assert.ok(!state||state==='Z','Escaped marked daemon remains alive');
    assert.doesNotThrow(()=>process.kill(worker.pid,0),'Unmarked Worker must survive');assert.equal(fs.existsSync(key),false);
    if(mode==='hard'){
      const report=JSON.parse(fs.readFileSync(path.join(options.root,'public/report.json')));assert.equal(report.status,'BLOCKED');assert.equal(report.processCleanup.status,'PASS');assert.ok(report.processCleanup.stopped>=1);
    }
  }
});

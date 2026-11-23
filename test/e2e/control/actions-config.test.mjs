import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadExecutionConfig, configSnapshot, suiteMode } from '../shared/config.mjs';
import * as actions from './actions-config.mjs';

const realEnv = {
  E2E_CASE_MODES: '{"001":"real"}',
  E2E_MODEL_BASE_URL: 'https://model.example.com/v1/',
  E2E_MODEL_NAME: 'example-model',
  E2E_MODEL_API_KEY: 'synthetic-model-key',
};
const allMock = Object.fromEntries(['001', '002', '003', '004', '005'].map(id => [id, 'mock']));

test('PR configuration stays all Mock and ignores manual model settings and injected config', () => {
  const before = configSnapshot(loadExecutionConfig({ env: {} }));
  const config = actions.actionsConfiguration({ event: 'pull_request', env: { ...realEnv, E2E_EXECUTION_CONFIG: 'invalid' } });
  assert.deepEqual(config.caseModes, allMock);
  assert.equal(config.model.baseUrl, before.settings.model.baseUrl);
  assert.equal(config.runUt, true);
  assert.deepEqual(configSnapshot(loadExecutionConfig({ env: {} })), before);
});

test('manual configuration supports per-case modes, model settings and all five cases', () => {
  const config = actions.actionsConfiguration({ event: 'workflow_dispatch', env: realEnv });
  assert.equal(suiteMode(config), 'mixed');
  assert.deepEqual(config.caseModes, { ...allMock, '001': 'real' });
  assert.deepEqual(config.cases, Object.keys(allMock));
  assert.equal(config.model.baseUrl, 'https://model.example.com/v1');
  assert.equal(config.model.modelName, realEnv.E2E_MODEL_NAME);
  assert.deepEqual(config.model.key, { fileEnv: 'E2E_MODEL_KEY_FILE' });
  assert.equal(actions.actionsConfiguration({ event: 'workflow_dispatch', env: {} }).caseModes['001'], 'mock');
});

test('AtomGit Manual event runs configured Real cases with the supplied credential', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-atomgit-manual-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'source');fs.mkdirSync(project);
  let called = false;
  assert.equal(await actions.runActionsSuite({ event: 'Manual', env: realEnv, project,
    expectedConfigFile: path.join(root, 'expected-config.json'), stateDirectory: path.join(root, 'state'), runId: 'fixture',
    run: async (bin, args, { env }) => {
      called = true;
      const config = loadExecutionConfig({ env });
      assert.deepEqual(config.caseModes, { ...allMock, '001': 'real' });
      assert.equal(config.model.modelName, realEnv.E2E_MODEL_NAME);
      assert.equal(fs.readFileSync(env.E2E_MODEL_KEY_FILE, 'utf8'), realEnv.E2E_MODEL_API_KEY);
      assert.equal(env.E2E_MODEL_API_KEY, undefined);
      return 0;
    },
  }), 0);
  assert.equal(called, true);
});

test('manual configuration rejects malformed modes, credential URLs and missing Real model settings', () => {
  for (const value of ['{', 'null', '[]', '{"006":"real"}', '{"001":"REAL"}', '{"001":"mixed"}']) {
    assert.throws(() => actions.actionsConfiguration({ event: 'workflow_dispatch', env: { ...realEnv, E2E_CASE_MODES: value } }));
  }
  for (const E2E_MODEL_BASE_URL of ['', 'https://user:password@example.com', 'https://example.com?key=secret']) {
    assert.throws(() => actions.actionsConfiguration({ event: 'workflow_dispatch', env: { ...realEnv, E2E_MODEL_BASE_URL } }));
  }
  assert.throws(() => actions.actionsConfiguration({ event: 'pull_request_target', env: realEnv }));
});

for (const outcome of [0, 7, 'spawn-error']) {
  test(`Actions launcher keeps keys out of child environment and cleans its input after ${outcome}`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-actions-config-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, 'source');fs.mkdirSync(project);
    const expectedConfigFile = path.join(root, 'expected-config.json');
    let keyFile, called = false;
    const launch = () => actions.runActionsSuite({ event: 'workflow_dispatch', env: realEnv, project,
      expectedConfigFile, stateDirectory: path.join(root, 'state'), runId: 'fixture',
      run: async (bin, args, options) => {
        called = true;keyFile = options.env.E2E_MODEL_KEY_FILE;
        assert.equal(fs.readFileSync(keyFile, 'utf8'), realEnv.E2E_MODEL_API_KEY);
        assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
        assert.equal(options.env.E2E_MODEL_API_KEY, undefined);
        assert.equal(options.env.E2E_MODEL_BASE_URL, undefined);
        assert.ok(!JSON.stringify(options.env).includes(realEnv.E2E_MODEL_API_KEY));
        assert.ok(!args.includes('--mode'));
        assert.ok(args.includes('--all') && args.includes('--ut'));
        const config = loadExecutionConfig({ env: options.env });
        assert.equal(suiteMode(config), 'mixed');
        assert.deepEqual(JSON.parse(fs.readFileSync(expectedConfigFile)), configSnapshot(config));
        if (outcome === 'spawn-error') throw new Error('fixture spawn failed');
        return outcome;
      },
    });
    if (outcome === 'spawn-error') await assert.rejects(launch, /fixture spawn failed/);
    else assert.equal(await launch(), outcome);
    assert.equal(called, true);assert.equal(fs.existsSync(keyFile), false);
  });
}

test('missing Real key fails before launch and Mock runs need no credential', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-actions-no-key-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'source');fs.mkdirSync(project);
  const options = { project, expectedConfigFile: path.join(root, 'expected-config.json'), stateDirectory: path.join(root, 'state'), runId: 'fixture' };
  await assert.rejects(actions.runActionsSuite({ ...options, event: 'workflow_dispatch', env: { ...realEnv, E2E_MODEL_API_KEY: '' }, run: async () => assert.fail('Missing key must not launch tests') }), /credential/i);
  assert.equal(await actions.runActionsSuite({ ...options, event: 'pull_request', env: realEnv, run: async (bin, args, { env }) => {
    assert.equal(env.E2E_MODEL_KEY_FILE, undefined);
    assert.equal(suiteMode(loadExecutionConfig({ env })), 'mock');return 0;
  } }), 0);
});

test('Actions launcher passes file credentials to a real child process and preserves its failure exit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-actions-child-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'source');fs.mkdirSync(path.join(project, 'test/e2e'), { recursive: true });
  fs.writeFileSync(path.join(project, 'test/e2e/run.mjs'), `import fs from 'node:fs';import assert from 'node:assert/strict';assert.equal(process.env.E2E_MODEL_API_KEY,undefined);assert.ok(fs.existsSync(process.env.E2E_MODEL_KEY_FILE));fs.writeFileSync('received-key-path',process.env.E2E_MODEL_KEY_FILE);process.exit(7);`);
  assert.equal(await actions.runActionsSuite({ event: 'workflow_dispatch', env: realEnv, project,
    expectedConfigFile: path.join(root, 'expected-config.json'), stateDirectory: path.join(root, 'state'), runId: 'fixture' }), 7);
  assert.equal(fs.existsSync(fs.readFileSync(path.join(project, 'received-key-path'), 'utf8')), false);
});

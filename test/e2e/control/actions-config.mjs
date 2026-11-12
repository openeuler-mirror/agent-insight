import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { loadExecutionConfig, configSnapshot, caseMode, readModelKey } from '../shared/config.mjs';
import { cases } from '../shared/catalog.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const inputNames = ['E2E_CASE_MODES', 'E2E_MODEL_BASE_URL', 'E2E_MODEL_NAME', 'E2E_MODEL_API_KEY', 'E2E_MODEL_KEY_FILE'];

export function actionsConfiguration({ event, env = process.env }) {
  const manual = ['workflow_dispatch', 'Manual'].includes(event);
  if (!manual && !['pull_request', 'MR'].includes(event)) throw Error('Unsupported Actions E2E event');
  let caseModes = Object.fromEntries(cases.map(({ id }) => [id, 'mock']));
  if (manual && env.E2E_CASE_MODES?.trim()) {
    let selected;
    try { if (env.E2E_CASE_MODES.length > 2048) throw Error();selected = JSON.parse(env.E2E_CASE_MODES); } catch { throw Error('E2E_CASE_MODES must be a JSON object using 001–005 and mock/real'); }
    if (!selected || typeof selected !== 'object' || Array.isArray(selected) || Object.entries(selected).some(([id, mode]) => !Object.hasOwn(caseModes, id) || !['mock', 'real'].includes(mode))) throw Error('E2E_CASE_MODES must be a JSON object using 001–005 and mock/real');
    caseModes = { ...caseModes, ...selected };
  }
  const model = { key: { fileEnv: 'E2E_MODEL_KEY_FILE' } };
  if (manual) {
    if (Object.values(caseModes).includes('real') && (!env.E2E_MODEL_BASE_URL?.trim() || !env.E2E_MODEL_NAME?.trim())) throw Error('Real cases require E2E_MODEL_BASE_URL and E2E_MODEL_NAME');
    if (env.E2E_MODEL_BASE_URL?.trim()) model.baseUrl = env.E2E_MODEL_BASE_URL.trim();
    if (env.E2E_MODEL_NAME?.trim()) model.modelName = env.E2E_MODEL_NAME.trim();
  }
  return loadExecutionConfig({ profile: 'pr', env: {}, overrides: { mode: 'mock', caseModes, model, cases: cases.map(({ id }) => id), runUt: true } });
}

async function launch(bin, args, options) {
  const child = spawn(bin, args, { ...options, stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);process.on('SIGTERM', terminate);
  try { return await new Promise((resolve, reject) => { child.once('error', reject);child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143))); }); }
  finally { process.removeListener('SIGINT', interrupt);process.removeListener('SIGTERM', terminate); }
}

export async function runActionsSuite({ event, env = process.env, project = projectRoot, expectedConfigFile, stateDirectory, runId, run = launch, onConfiguration = () => {} }) {
  if (!path.isAbsolute(expectedConfigFile || '') || !path.relative(project, expectedConfigFile).startsWith('..' + path.sep) || !path.isAbsolute(stateDirectory || '') || !/^[a-z0-9-]{1,80}$/.test(runId || '')) throw Error('Actions E2E requires a fresh external configuration path, state directory and run ID');
  const config = actionsConfiguration({ event, env });
  const directory = fs.mkdtempSync(path.join(path.dirname(project), 'e2e-action-input-'));fs.chmodSync(directory, 0o700);
  try {
    const childEnv = { ...env };
    for (const name of inputNames) delete childEnv[name];
    if (config.cases.some(id => caseMode(config, id) === 'real')) {
      const key = readModelKey({ env: 'E2E_MODEL_API_KEY' }, env);
      const keyFile = path.join(directory, 'model.key');fs.writeFileSync(keyFile, key, { mode: 0o600, flag: 'wx' });childEnv.E2E_MODEL_KEY_FILE = keyFile;
    }
    const snapshot = configSnapshot(config);
    fs.writeFileSync(expectedConfigFile, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
    childEnv.E2E_EXECUTION_CONFIG = JSON.stringify(config);childEnv.E2E_CONFIG_PROVENANCE = JSON.stringify(snapshot);
    onConfiguration(snapshot);
    return await run(process.execPath, [path.join(project, 'test/e2e/run.mjs'), '--all', '--ut', '--lane', 'pr', '--state-dir', stateDirectory, '--run-id', runId], { cwd: project, env: childEnv });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'expected-config': { type: 'string' }, 'state-dir': { type: 'string' }, 'run-id': { type: 'string' } } });
    process.exitCode = await runActionsSuite({ event: process.env.E2E_ACTION_EVENT, expectedConfigFile: values['expected-config'], stateDirectory: values['state-dir'], runId: values['run-id'],
      onConfiguration: snapshot => console.log('Actions E2E configuration:', JSON.stringify({ hash: snapshot.hash, caseModes: snapshot.settings.caseModes, modelName: snapshot.settings.model.modelName })),
    });
  } catch (error) { console.error('Actions E2E configuration failed:', error.message);process.exitCode = 1; }
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as contracts from '../src/lib/diagnosis/contracts';

function fixture(options: { score?: number; mutateSource?: boolean; humanScore?: number; evaluatorChanged?: boolean } = {}) {
  const config = { datasetId: 'dataset', caseIds: ['input'], executionTarget: { workerId: 'worker', model: 'model', timeoutSeconds: 60 } };
  const source: any = { id: 'source', user: 'owner', name: 'source experiment', type: 'single', status: 'done', deletedAt: null, configSnapshotJson: JSON.stringify(config), evaluatorIdsJson: JSON.stringify(options.evaluatorChanged ? ['different'] : ['metric']), evaluatorConfigsJson: '{}' };
  const original: any[] = [{ id: 'case', input: 'question', datasetInput: 'question', referenceOutput: 'expected', actualOutput: 'answer', executionId: 'trace', caseValuesJson: '{"__agentInsightDatasetCase":{"caseId":"input"}}', results: [{ id: 'result', evaluatorId: 'metric', status: 'done', score: 80, humanScore: options.humanScore ?? null, updatedAt: new Date(0) }] }];
  const frozen = { experiment: { config, evaluatorConfigs: {}, evaluatorIds: ['metric'] }, results: [{ id: 'result', updatedAt: new Date(0).toISOString() }] };
  const record: any = { id: 'record', user: 'owner', skillName: 'skill', baseVersion: 1, sourceRefsJson: '[{"type":"diagnosis","id":"run"}]', candidateContentHash: 'candidate', status: 'pending_retest' };
  const calls: any[] = [];
  const state = { record: { ...record }, experiment: null as any };
  const db: any = {
    diagnosisRun: { findFirst: async () => ({ id: 'run', caseId: 'case', inputSnapshotJson: JSON.stringify(frozen) }) },
    experimentCase: { findMany: async () => structuredClone(original) },
    experiment: {
      findUnique: async () => source,
      create: async ({ data }: any) => (state.experiment = { ...data, id: 'retest' }),
      update: async ({ data }: any) => Object.assign(state.experiment, data),
      updateMany: async ({ data }: any) => { Object.assign(state.experiment, data); return { count: 1 }; },
    },
    skillOptimizationRecord: {
      update: async ({ data }: any) => Object.assign(state.record, data),
      updateMany: async ({ where, data }: any) => {
        const matches = Object.entries(where).every(([key, value]) => state.record[key] === value);
        if (matches) Object.assign(state.record, data);
        return { count: matches ? 1 : 0 };
      },
    },
    $transaction: async (work: any) => typeof work === 'function' ? work(db) : Promise.all(work),
  };
  const dependencies: Record<string, unknown> = {
    '@/lib/storage/prisma': { prismaRaw: db },
    '@/lib/skill-workbench/client-execution': { executeSkillCaseOnClient: async (args: any) => {
      calls.push(args);
      if (options.mutateSource) original[0].results[0].updatedAt = new Date(1000);
      return { experimentCaseId: 'candidate-case' };
    } },
    '@/lib/engine/experiment/run-experiment': { evaluateEvalExperimentCase: async () => [{ evaluatorId: 'metric', status: 'done', score: options.score ?? 90, verdict: 'pass' }] },
    '@/server/agent_datasets_storage': { findAgentDataset: async () => ({ cases: [{ id: 'input', input: 'question', expectedOutput: 'expected' }] }) },
    './contracts': contracts,
  };
  const compiled = ts.transpileModule(fs.readFileSync('src/lib/diagnosis/retest.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as any };
  vm.runInNewContext(compiled, { exports: module.exports, module, AbortController, require: (name: string) => {
    if (!(name in dependencies)) throw new Error('Unexpected dependency: ' + name);
    return dependencies[name];
  } });
  return { run: () => module.exports.retestDiagnosisCase(record, source, { 'SKILL.md': 'candidate' }), state, calls, original };
}

test('diagnosis retest uses the original worker, model and cases before allowing publication', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.passed, true);
  assert.equal(f.state.record.status, 'retest_passed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].executionTarget.workerId, 'worker');
  assert.equal(f.calls[0].executionTarget.model, 'model');
  assert.equal(f.calls[0].query, 'question');
  assert.equal(f.calls[0].skill.files['SKILL.md'], 'candidate');
  assert.equal(f.original[0].results[0].score, 80);
  assert.equal(f.state.experiment.sourceExperimentId, 'source');
});

test('a regression cannot pass the diagnosis candidate gate', async () => {
  const f = fixture({ score: 70 });
  const result = await f.run();
  assert.equal(result.passed, false);
  assert.equal(f.state.record.status, 'retest_failed');
});

test('changed source evidence invalidates an otherwise passing retest', async () => {
  const f = fixture({ mutateSource: true });
  await assert.rejects(f.run(), /来源证据发生变化/);
  assert.equal(f.state.record.status, 'retest_failed');
  assert.equal(f.state.experiment.status, 'failed');
});

test('human corrections and evaluator changes require review before running the candidate', async () => {
  for (const options of [{ humanScore: 95 }, { evaluatorChanged: true }]) {
    const f = fixture(options);
    await assert.rejects(f.run(), /人工复核|配置缺失或已变化/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.state.record.status, 'pending_retest');
  }
});

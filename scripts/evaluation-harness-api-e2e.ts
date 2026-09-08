import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { prisma } from '../src/lib/storage/prisma';
import { createAgentDatasetRecord } from '../src/server/agent_datasets_storage';
async function main() {
  assert.match(process.env.DATABASE_URL || '', /harness-e2e/);
  const base = process.env.AGENT_INSIGHT_URL || 'http://127.0.0.1:3019';
  const username = 'harness-api-' + Date.now(),
    apiKey = randomBytes(24).toString('hex');
  await prisma.user.create({
    data: {
      username,
      apiKey
    }
  });
  const call = async (body?: unknown, query = '') => {
    const response = await fetch(base + '/api/evaluation-harness' + query, {
      method: body ? 'POST' : 'GET',
      headers: {
        'x-witty-api-key': apiKey,
        'content-type': 'application/json'
      },
      ...(body ? {
        body: JSON.stringify(body)
      } : {}),
      signal: AbortSignal.timeout(30000)
    });
    return {
      status: response.status,
      data: await response.json()
    };
  };
  const post = async (body: unknown) => {
    const r = await call(body);
    assert.ok(r.status < 300, JSON.stringify(r));
    return r.data;
  };
  assert.equal((await fetch(base + '/api/evaluation-harness')).status, 401);
  await post({
    action: 'bootstrap'
  });
  let catalog = (await call()).data;
  assert.ok(!JSON.stringify(catalog).includes('ciphertext'));
  const target = (v: number) => catalog.assets.find((a: any) => a.assetKey === 'loan-agent' && a.version === v),
    dataset = catalog.assets.find((a: any) => a.kind === 'dataset'),
    rules = catalog.assets.find((a: any) => a.assetKey === 'business-rules');
  const config = {
    name: 'HTTP API 基线',
    targetId: target(1).id,
    datasetId: dataset.id,
    evaluatorIds: [rules.id],
    concurrency: 2,
    timeoutSeconds: 10,
    retries: 1
  };
  const wait = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const r = await call(undefined, '?experimentId=' + id);
      assert.equal(r.status, 200);
      if (!['draft', 'running'].includes(r.data.experiment.status)) return r.data;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('API run did not finish');
  };
  assert.equal((await call({
    action: 'create',
    config: {
      ...config,
      evaluatorIds: [rules.id, rules.id]
    }
  })).status, 400);
  const {
    id
  } = await post({
    action: 'create',
    config
  });
  assert.equal((await call({
    action: 'run',
    id
  })).status, 202);
  const baseline = await wait(id);
  assert.equal(baseline.summary.score, 50);
  assert.equal(baseline.summary.gate, 'blocked');
  assert.ok((await call({
    action: 'run',
    id
  })).status >= 400);
  assert.equal((await fetch(base + '/api/experiments/' + id + '?user=' + username)).status, 401);
  const native = await fetch(base + '/api/experiments/' + id, {
    headers: {
      'x-witty-api-key': apiKey
    }
  });
  assert.equal(native.status, 200);
  assert.equal((await native.json()).configSnapshot.kind, 'evaluation-harness-v1');
  const regression = await post({
    action: 'create',
    config: {
      ...config,
      targetId: target(2).id,
      sourceExperimentId: id,
      name: 'HTTP API 回归'
    }
  });
  await post({
    action: 'run',
    id: regression.id
  });
  const fixed = await wait(regression.id);
  assert.equal(fixed.summary.score, 100);
  assert.equal(fixed.manifest.dataset.id, baseline.manifest.dataset.id);
  assert.equal(fixed.manifest.comparisonHash, baseline.manifest.comparisonHash);
  const single = await post({
    action: 'create',
    config: {
      ...config,
      targetId: target(2).id,
      caseIds: ['loan-high'],
      sourceExperimentId: regression.id
    }
  });
  await post({
    action: 'run',
    id: single.id
  });
  const singleDone = await wait(single.id);
  assert.equal(singleDone.summary.total, 1);
  const highTrace = fixed.experiment.cases.find((c: any) => JSON.parse(c.caseValuesJson).id === 'loan-high').executionId;
  const secondHighTrace = singleDone.experiment.cases[0].executionId;
  const replayConfig = {...config,targetId:target(2).id,traceSource:'existing',traceAssignments:[{traceId:highTrace,caseId:'loan-high'},{traceId:secondHighTrace,caseId:'loan-high'}]};
  const repeated = await post({action:'create',config:replayConfig});
  await post({action:'run',id:repeated.id});
  const repeatedDone = await wait(repeated.id);
  assert.equal(repeatedDone.summary.total,2);
  assert.equal(repeatedDone.summary.score,100);
  assert.deepEqual(new Set(repeatedDone.experiment.cases.map((c:any)=>c.executionId)),new Set([highTrace,secondHighTrace]));
  assert.ok(repeatedDone.experiment.cases.every((c:any)=>JSON.parse(c.caseValuesJson).id==='loan-high'));
  assert.equal((await call({action:'create',config:{...replayConfig,traceAssignments:[{traceId:highTrace,caseId:'loan-high'},{traceId:highTrace,caseId:'loan-high'}]}})).status,400);
  assert.equal((await call({action:'create',config:{...replayConfig,traceAssignments:[{traceId:highTrace,caseId:'missing'}]}})).status,400);
  const originalCase = baseline.results.find((r: any) => r.case.id === 'loan-high').case;
  const revised = await post({
    action: 'revise',
    experimentId: id,
    caseId: 'loan-high',
    case: {
      ...originalCase,
      note: 'API synthetic rule revision',
      turns: originalCase.turns.map((t: any, i: number) => i === 1 ? {
        ...t,
        expectation: {
          ...t.expectation,
          state: 'approved',
          requiredTools: [{
            name: 'approve_loan'
          }],
          forbiddenTools: []
        }
      } : t)
    }
  });
  assert.equal(revised.version, 2);
  const revisedRun = await post({
    action: 'create',
    config: {
      ...config,
      datasetId: revised.id,
      sourceExperimentId: id,
      name: '验证规则修订生效'
    }
  });
  await post({
    action: 'run',
    id: revisedRun.id
  });
  assert.equal((await wait(revisedRun.id)).summary.score, 75);
  assert.equal((await call(undefined, '?experimentId=' + id)).data.summary.score, 50);
  await post({
    action: 'archive',
    id: revised.id,
    archived: true
  });
  assert.equal((await call({
    action: 'create',
    config
  })).status, 400);
  assert.equal((await call(undefined, '?experimentId=' + id)).data.summary.score, 50);
  await post({
    action: 'archive',
    id: revised.id,
    archived: false
  });
  assert.equal((await call({
    action: 'import-trace',
    id: fixed.experiment.cases[0].executionId
  })).status, 400, 'removed target extraction action must be rejected');
  const legacyId = 'legacy-' + Date.now(),
    now = new Date().toISOString();
  await createAgentDatasetRecord({
    id: legacyId,
    user: username,
    name: '已有评测集',
    description: '',
    targetAgent: '',
    targetSkill: '',
    tags: [],
    datasetKind: 'ideal_output',
    fields: [],
    createdAt: now,
    updatedAt: now,
    cases: [{
      id: 'legacy-case',
      input: 'existing input',
      expectedOutput: 'existing expected',
      evaluationFocus: 'existing note',
      tags: [],
      trajectory: ''
    }]
  });
  const imported = await post({
    action: 'import-dataset',
    id: legacyId
  });
  assert.equal(imported.cases[0].turns[0].expectedOutput, 'existing expected');
  const otherKey = randomBytes(24).toString('hex');
  await prisma.user.create({
    data: {
      username: username + '-other',
      apiKey: otherKey
    }
  });
  const denied = await fetch(base + '/api/evaluation-harness?experimentId=' + id, {
    headers: {
      'x-witty-api-key': otherKey
    }
  });
  assert.ok(denied.status >= 400);
  const cli = spawnSync(process.execPath, ['scripts/evaluation-harness-cli.mjs', 'report', regression.id], {
    env: {
      ...process.env,
      AGENT_INSIGHT_URL: base,
      AGENT_INSIGHT_API_KEY: apiKey
    },
    encoding: 'utf8'
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).summary.score, 100);
  console.log('PASS authenticated API and CLI: baseline 50 -> regression 100, single Case rerun, immutable revisions, archive/restore, removed target extraction, existing dataset import, ownership and duplicate-run protection');
  console.log(JSON.stringify({
    username,
    baseline: id,
    regression: regression.id
  }));
  await prisma.$disconnect();
}
main().catch(async error => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});

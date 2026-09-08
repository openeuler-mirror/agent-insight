import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { prisma } from '../src/lib/storage/prisma';
import { createAsset, saveCredential, getAsset } from '../src/lib/evaluation-harness/store';
import { createRun, executeRun, cancelRun, recoverInterruptedRuns, runDetail } from '../src/lib/evaluation-harness/service';
import { readJsonResponse } from '../src/lib/evaluation-harness/transport';
async function main() {
  assert.match(process.env.DATABASE_URL || '', /harness-e2e/);
  process.env.EVALUATION_CREDENTIAL_KEY = randomBytes(32).toString('base64');
  const user = 'harness-resilience-' + Date.now(),
    requests: any[] = [];
  let failures = 0,
    llmCalls = 0;
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/chat/completions') {
      llmCalls++;
      const actual = JSON.parse(body.messages[1].content);
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify(body.model === 'invalid-model' ? {
              score: 100
            } : {
              checks: actual.case.turns.map((_: unknown, i: number) => ({
                turn: i + 1,
                verdict: 'pass',
                reason: 'Contract fixture only'
              }))
            })
          }
        }]
      }));
      return;
    }
    requests.push(body);
    assert.equal(body.expectedOutput, undefined);
    assert.equal(body.expectation, undefined);
    if (body.targetId === 'retry' && body.turn === 2 && failures++ === 0) {
      res.statusCode = 503;
      res.end('{}');
      return;
    }
    if (body.targetId === 'slow') {
      setTimeout(() => {
        if (!res.destroyed) res.end(JSON.stringify({
          output: 'late'
        }));
      }, 1500);
      return;
    }
    if (body.targetId === 'retry') await new Promise(resolve => setTimeout(resolve, 25));
    const pass = body.targetId !== 'wrong';
    res.end(JSON.stringify({
      output: 'actual output',
      systemPrompt: 'Actual fixture prompt',
      state: 'done',
      skill: 'loan',
      sessionId: body.attemptId,
      tools: [{
        name: pass ? 'review' : 'approve',
        arguments: {
          risk: 'high'
        }
      }]
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + (server.address() as any).port;
  try {
    const dataset = await createAsset(user, 'dataset', 'cases', '两轮重试验收', {
      cases: [{
        id: 'case',
        name: 'two turns',
        turns: [{
          input: 'first',
          expectation: {
            state: 'done'
          }
        }, {
          input: 'second',
          expectedOutput: 'actual output',
          expectation: {
            requiredTools: [{
              name: 'review'
            }],
            forbiddenTools: ['approve']
          }
        }]
      }]
    });
    const rules = await createAsset(user, 'evaluator', 'rules', 'Rules', {
      type: 'rules',
      criticalStop: true
    });
    const target = async (name: string) => createAsset(user, 'target', name, name, {
      type: 'agent',
      adapter: 'http',
      endpoint,
      externalId: name
    });
    const retry = await target('retry');
    const config = {
      name: 'resilience',
      targetId: retry.id,
      datasetId: dataset.id,
      evaluatorIds: [rules.id],
      timeoutSeconds: 5,
      retries: 1,
      concurrency: 1
    };
    const id = await createRun(user, config),
      result = await executeRun(user, id);
    assert.equal(result.summary.gate, 'pass');
    const traceRow = await prisma.execution.findUnique({
      where: {
        id: result.experiment.cases[0].executionId!
      }
    });
    assert.ok(traceRow.latency >= 50, 'Execution.latency must be milliseconds, consistent with the native Trace UI');
    assert.equal(result.experiment.cases[0].traceAttempts.length, 2);
    assert.deepEqual(requests.map(r => r.turn), [1, 2, 1, 2]);
    assert.notEqual(requests[0].attemptId, requests[2].attemptId);
    assert.equal(requests[2].history.length, 0);
    assert.equal(requests[3].sessionId, requests[2].attemptId);
    await assert.rejects(() => executeRun(user, id));
    console.log('PASS transient HTTP retry restarts isolated session; no expected-answer leakage; duplicate run rejected');
    const credential = await saveCredential(user, 'Fixture connection', {
      baseUrl: endpoint + '/v1',
      apiKey: 'synthetic-fixture-key',
      model: 'contract-model'
    });
    const judge = await createAsset(user, 'evaluator', 'judge', 'LLM contract', {
      type: 'llm',
      prompt: 'Judge each turn',
      credentialId: credential.id
    });
    const ok = await target('ok');
    const judged = await executeRun(user, await createRun(user, {
      ...config,
      targetId: ok.id,
      evaluatorIds: [rules.id, judge.id]
    }));
    assert.equal(judged.summary.gate, 'pass');
    assert.equal(llmCalls, 1);
    const wrong = await target('wrong');
    const stopped = await executeRun(user, await createRun(user, {
      ...config,
      targetId: wrong.id,
      evaluatorIds: [rules.id, judge.id]
    }));
    assert.equal(stopped.summary.gate, 'blocked');
    assert.equal(llmCalls, 1);
    const invalid = await saveCredential(user, 'Invalid fixture', {
      baseUrl: endpoint + '/v1',
      apiKey: 'synthetic-fixture-key',
      model: 'invalid-model'
    });
    const badJudge = await createAsset(user, 'evaluator', 'invalid', 'Invalid output', {
      type: 'llm',
      prompt: 'test',
      credentialId: invalid.id
    });
    const invalidResult = await executeRun(user, await createRun(user, {
      ...config,
      targetId: ok.id,
      evaluatorIds: [badJudge.id]
    }));
    assert.equal(invalidResult.summary.unknown, 1);
    assert.equal(invalidResult.summary.gate, 'unknown');
    console.log('PASS LLM transport contract, per-turn validation and critical-stop; this fixture is not live-model evaluation');
    const slow = await target('slow');
    const timed = await executeRun(user, await createRun(user, {
      ...config,
      targetId: slow.id,
      timeoutSeconds: 1,
      retries: 0
    }));
    assert.equal(timed.experiment.status, 'failed');
    assert.equal(timed.summary.gate, 'unknown');
    assert.equal(timed.experiment.cases[0].traceAttempts[0].failureCode, 'timeout');
    const cancelledId = await createRun(user, {
      ...config,
      targetId: slow.id
    });
    const running = executeRun(user, cancelledId);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(await cancelRun(user, cancelledId), true);
    const cancelled = await running;
    assert.equal(cancelled.experiment.status, 'cancelled');
    assert.notEqual(cancelled.summary.gate, 'pass');
    const stale = await createRun(user, {
      ...config,
      targetId: ok.id
    });
    await prisma.experiment.update({
      where: {
        id: stale
      },
      data: {
        status: 'running',
        updatedAt: new Date(Date.now() - 180000)
      }
    });
    await recoverInterruptedRuns(user);
    assert.equal((await runDetail(user, stale)).experiment.status, 'failed');
    await assert.rejects(() => runDetail('other-user', id));
    await assert.rejects(() => getAsset('other-user', retry.id));
    await assert.rejects(() => readJsonResponse(new Response('x'.repeat(100)), 10));
    console.log('PASS timeout, cancellation, interrupted-run recovery, user isolation and bounded responses');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.$disconnect();
  }
}
main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});

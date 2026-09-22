import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('all collectors persist receipt time and expose timeout/recovery consistently without writing completion', async context => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-inactivity-'));
  const savedEnv = { ...process.env };
  delete process.env.DB_HOST;
  process.env.AGENT_INSIGHT_DATA_DIR = dir;
  process.env.DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
  fs.writeFileSync(path.join(dir, 'test.db'), '');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { stdio: 'pipe' });
  const { saveExecutionRecord } = await import('@/lib/storage/data-service');
  const { prismaRaw } = await import('@/lib/storage/prisma');
  const { GET, PATCH } = await import('@/app/api/observe/data/route');
  context.after(async () => {
    await prismaRaw.$disconnect();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await context.test('Goal Plus terminal failures survive every observe read mode', async () => {
    const taskId = 'goal-plus-failed';
    await saveExecutionRecord({ task_id: taskId, framework: 'pi-agent', user: 'timeout-tester', query: taskId,
      timestamp: new Date(), trace_completed_at: new Date(), final_result: 'partial output',
      failures: [{ failure_type: 'goal_plus_pi_session_failed', description: 'aborted', context: '', recovery: '' }],
      interactions: [{ role: 'assistant', content: 'partial output' }], skip_evaluation: true });
    for (const query of ['fields=light&skipAutoEvalReady=1', 'skipAutoEvalReady=0', 'fields=light&skipAutoEvalReady=1&paginated=1&databasePagination=1&status=failed']) {
      const response = await GET(new Request(`http://localhost/api/observe/data?taskId=${taskId}&${query}`));
      assert.equal(response.status, 200);
      const payload = await response.json();
      const record = (Array.isArray(payload) ? payload : payload.records)[0];
      assert.equal(record.trace_status, 'failed', query);
      assert.equal(record.trace_status_reason, 'goal-plus-session-failed', query);
    }
  });
  await context.test('database pagination counts only completed AcTrail and Goal Plus failures', async () => {
    for (const framework of ['actrail', 'pi-agent']) {
      for (const completed of [false, true]) {
        const taskId = `failure-stats-${framework}-${completed}`;
        await saveExecutionRecord({ task_id: taskId, framework, user: 'failure-stats-tester', query: taskId,
          timestamp: new Date(), ...(completed ? { trace_completed_at: new Date() } : {}),
          failures: [{ failure_type: framework === 'actrail' ? 'agent-process-exit' : 'goal_plus_pi_session_failed', description: 'exit', context: '', recovery: '' }],
          interactions: [{ role: 'user', content: 'question' }], skip_evaluation: true }, { receivedAt: new Date(Date.now() - 601_000) });
      }
    }
    for (const status of ['all', 'failed', 'timed_out']) {
      const response = await GET(new Request(`http://localhost/api/observe/data?user=failure-stats-tester&fields=light&skipAutoEvalReady=1&paginated=1&databasePagination=1&pageSize=1&status=${status}`));
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.total, status === 'all' ? 4 : 2, status);
      assert.equal(payload.stats.failedCount, status === 'timed_out' ? 0 : 2, status);
    }
  });
  const frameworks = ['actrail', 'opencode', 'claudecode', 'hermes', 'openclaw', 'jiuwenswarm', 'langfuse-langgraph', 'new-framework'];
  const receivedAt = new Date(Date.now() - 601_000);
  for (const framework of frameworks) {
    const taskId = `timeout-${framework}`;
    await saveExecutionRecord({ task_id: taskId, framework, user: 'timeout-tester', query: taskId, timestamp: new Date(), interactions: [{ role: 'user', content: 'still waiting for the first answer' }], skip_evaluation: true }, { receivedAt });
    for (const query of ['fields=light&skipAutoEvalReady=1', 'skipAutoEvalReady=0', 'fields=light&skipAutoEvalReady=1&paginated=1&databasePagination=1&status=timed_out']) {
      const response = await GET(new Request(`http://localhost/api/observe/data?user=timeout-tester&taskId=${taskId}&${query}`));
      assert.equal(response.status, 200);
      const payload = await response.json();
      const records = Array.isArray(payload) ? payload : payload.records;
      assert.equal(records.length, 1, `${framework}: ${query}`);
      assert.equal(records[0].trace_status, 'timed_out', `${framework}: ${query}`);
      assert.equal(records[0].trace_completed_at, null);
      assert.equal(records[0].trace_last_received_at, receivedAt.toISOString());
      if (query === 'skipAutoEvalReady=0') assert.equal(records[0].auto_eval_ready, false);
    }
    assert.equal((await prismaRaw.session.findUnique({ where: { taskId } }))?.endTime, null);
  }
  const metadata = await PATCH(new Request('http://localhost/api/observe/data', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task_id: 'timeout-actrail', label: 'reviewed' }) }));
  assert.equal(metadata.status, 200);
  assert.equal((await prismaRaw.execution.findFirst({ where: { taskId: 'timeout-actrail' } }))?.lastIngestedAt?.toISOString(), receivedAt.toISOString());
  const fresh = new Date();
  await saveExecutionRecord({ task_id: 'timeout-actrail', framework: 'actrail', user: 'timeout-tester', interactions: [{ role: 'user', content: 'new telemetry arrived' }], skip_evaluation: true }, { receivedAt: fresh });
  const response = await GET(new Request('http://localhost/api/observe/data?taskId=timeout-actrail&fields=light&skipAutoEvalReady=1'));
  assert.equal((await response.json())[0].trace_status, 'running');
  await saveExecutionRecord({ task_id: 'timeout-actrail', framework: 'actrail', user: 'timeout-tester', skip_evaluation: true }, { receivedAt });
  assert.equal((await prismaRaw.execution.findFirst({ where: { taskId: 'timeout-actrail' } }))?.lastIngestedAt?.toISOString(), fresh.toISOString(), 'older background work cannot move the receipt clock backwards');
});

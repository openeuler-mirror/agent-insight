import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('trace timing isolates overlapping async work, emits stage starts and includes failed query time', async () => {
  assert.ok(fs.existsSync('src/lib/logger/trace-timing.ts'), 'trace timing implementation is missing');
  const { withTraceTiming, timeTraceStage, traceTimingEvent } = await import('../src/lib/logger/trace-timing');
  const old = process.env.AGENT_INSIGHT_LOG_LEVEL;
  process.env.AGENT_INSIGHT_LOG_LEVEL = 'debug';
  const original = console.debug;
  const lines: any[] = [];
  console.debug = (line: string) => lines.push(JSON.parse(line.slice('[TraceTiming] '.length)));
  try {
    await Promise.all(['a', 'b'].map(traceId => withTraceTiming({ scope: 'save', traceId }, async () => {
      await timeTraceStage('identity-query', async () => {
        await new Promise(resolve => setTimeout(resolve, 8));
        if (traceId === 'b') throw Object.assign(new Error('SECRET_DB'), { code: 'P1008' });
      }).catch(() => {});
      traceTimingEvent('persisted', { executionId: traceId });
    })));
    for (const id of ['a', 'b']) {
      const events = lines.filter(x => x.traceId === id);
      assert.ok(events.some(x => x.event === 'stage-start' && x.stage === 'identity-query'));
      assert.ok(events.some(x => x.event === 'stage-end' && x.durationMs >= 1));
      assert.equal(events.find(x => x.event === 'persisted')?.executionId, id);
      assert.equal(new Set(events.map(x => x.runId)).size, 1);
    }
    const failed = lines.find(x => x.traceId === 'b' && x.event === 'stage-end');
    assert.equal(failed.outcome, 'failed');
    assert.equal(failed.errorCode, 'P1008');
    assert.doesNotMatch(JSON.stringify(lines), /SECRET_DB/);
    process.env.AGENT_INSIGHT_LOG_LEVEL = 'error';
    const length = lines.length;
    assert.equal(await withTraceTiming({ scope: 'save', traceId: 'c' }, () => timeTraceStage('test', async () => 5)), 5);
    assert.equal(lines.length, length);
    process.env.AGENT_INSIGHT_LOG_LEVEL = 'debug';
    console.debug = () => { throw new Error('sink failure'); };
    assert.equal(await withTraceTiming({ scope: 'save' }, async () => 6), 6);
  } finally {
    console.debug = original;
    if (old === undefined) delete process.env.AGENT_INSIGHT_LOG_LEVEL;
    else process.env.AGENT_INSIGHT_LOG_LEVEL = old;
  }
});

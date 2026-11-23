/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startOtelSpoolConsumer, stopOtelSpoolConsumer } from '../src/lib/ingest/otel-consumer/consumer';
import { getFileCursor, toCheckpointRelPath } from '../src/lib/ingest/otel-consumer/checkpoint';
import { saveExecutionRecord } from '../src/lib/storage/data-service';
import { db } from '../src/lib/storage/prisma';

test('consumer timings cannot block a real spool file with corrupt receipt metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-timing-consumer-'));
  const original = console.debug;
  const level = process.env.AGENT_INSIGHT_LOG_LEVEL;
  process.env.AGENT_INSIGHT_LOG_LEVEL = 'debug';
  const lines: any[] = [];
  console.debug = (text: string) => { if (text.startsWith('[TraceTiming] ')) lines.push(JSON.parse(text.slice(14))); };
  stopOtelSpoolConsumer();
  try {
    const day = path.join(dir, new Date().toISOString().slice(0, 10));
    fs.mkdirSync(day);
    const file = path.join(day, 'traces.jsonl');
    fs.writeFileSync(file, '{"sessionId":"timing-session"}\n');
    for (const child of ['states', 'uses', 'locks']) fs.mkdirSync(path.join(dir, '.retention-v1', child), { recursive: true });
    fs.writeFileSync(path.join(dir, '.retention-v1/states', createHash('sha256').update('timing-session').digest('hex') + '.json'), 'invalid json');
    startOtelSpoolConsumer({
      sources: [{ id: 'timing-source', spoolDir: () => dir, listFiles: () => [file], defaultSkipEvaluation: () => true,
        aggregate: sessionId => ({ sessionId, disposition: 'persisted', eventCount: 1,
          record: { task_id: sessionId, user: 'test-user', framework: 'langfuse', query: 'SECRET_QUERY' } }),
      }],
      saveExecution: async record => { await new Promise(resolve => setTimeout(resolve, 5)); return { success: true, record }; },
      shortMs: 5, longMs: 30, maxWaitMs: 60, tickMs: 5, aggCooldownFactor: 0,
      aggGlobalFactor: 0, seedOnStart: false, log: () => {}, warn: () => {},
    });
    const deadline = Date.now() + 4000;
    while (getFileCursor(dir, toCheckpointRelPath(dir, file)).bytes < fs.statSync(file).size && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(getFileCursor(dir, toCheckpointRelPath(dir, file)).bytes, fs.statSync(file).size);
    for (const stage of ['aggregate', 'save', 'checkpoint']) assert.ok(lines.some(x => x.stage === stage && x.event === 'stage-end'), stage);
    assert.ok(lines.some(x => x.scope === 'consumer' && x.event === 'start' && x.waitAfterDueMs >= 0));
    assert.ok(lines.some(x => x.event === 'save-returned' && x.mode === 'evaluated'));
    assert.doesNotMatch(JSON.stringify(lines), /SECRET_QUERY/);
  } finally {
    stopOtelSpoolConsumer(); console.debug = original;
    if (level === undefined) delete process.env.AGENT_INSIGHT_LOG_LEVEL; else process.env.AGENT_INSIGHT_LOG_LEVEL = level;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real save path records history lookup and subsequent lookup failure without swallowing the failure', async () => {
  const before = process.env.AGENT_INSIGHT_LOG_LEVEL;
  process.env.AGENT_INSIGHT_LOG_LEVEL = 'debug';
  const original = console.debug;
  const lines: any[] = [];
  console.debug = (text: string) => { if (text.startsWith('[TraceTiming] ')) lines.push(JSON.parse(text.slice(14))); };
  const findMany = db.findExecutions, findOne = db.findExecutionById;
  db.findExecutions = async () => { await new Promise(resolve => setTimeout(resolve, 5)); return []; };
  db.findExecutionById = async () => { throw Object.assign(new Error('SECRET_ERROR'), { code: 'P1008' }); };
  try {
    await assert.rejects(saveExecutionRecord({ task_id: 'timing-db', framework: 'langfuse' }), { code: 'P1008' });
    assert.ok(lines.some(x => x.stage === 'identity-query' && x.event === 'stage-end' && x.durationMs >= 1));
    assert.ok(lines.some(x => x.stage === 'execution-read' && x.outcome === 'failed' && x.errorCode === 'P1008'));
    assert.doesNotMatch(JSON.stringify(lines), /SECRET_ERROR/);
  } finally {
    db.findExecutions = findMany; db.findExecutionById = findOne; console.debug = original;
    if (before === undefined) delete process.env.AGENT_INSIGHT_LOG_LEVEL; else process.env.AGENT_INSIGHT_LOG_LEVEL = before;
  }
});

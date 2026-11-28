import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isStorageCoreEnabled } from '../src/lib/storage-core/mode';
import { preflight } from '../scripts/storage-core-preflight.cjs';

test('missing mode selects Core and conflicting legacy modes are rejected', () => {
  assert.equal(isStorageCoreEnabled({}), true);
  assert.equal(isStorageCoreEnabled({ AGENT_INSIGHT_TRACE_STORAGE: 'core' }), true);
  for (const value of ['sqlite', 'legacy', 'false', 'postgresql', 'opengauss']) {
    assert.throws(() => isStorageCoreEnabled({ AGENT_INSIGHT_TRACE_STORAGE: value }), /Legacy storage/);
    assert.throws(() => isStorageCoreEnabled({ AGENT_INSIGHT_TRACE_STORAGE: 'core', NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE: value }), /Legacy storage/);
  }
});

test('Web readiness requires both databases and refuses a Core service that only checks transaction schema', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'core-only-readiness-'));
  const controller = path.join(dir, 'controller');
  writeFileSync(controller, 'a'.repeat(64), { mode: 0o600 });
  const env = { NODE_ENV: 'test' as const, AGENT_INSIGHT_STORAGE_CORE_URL: 'http://127.0.0.1:4319', AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE: controller };
  try {
    await assert.rejects(preflight({NODE_ENV: 'test'}, async () => { throw Error('must not request'); }), /CORE_URL/);
    await assert.rejects(preflight(env, async () => new Response(null, { status: 503 })), /not ready/);
    await assert.rejects(preflight(env, async () => Response.json({ status: 'ready', schema_version: 21 })), /ClickHouse/);
    await assert.rejects(preflight(env, async () => Response.json({ status: 'ready', schema_version: 21, clickhouse: { schema_version: 4, tables: 18 } })), /ClickHouse/);
    const health = { status: 'ready', schema_version: 21, clickhouse: { schema_version: 4, tables: 19 } };
    assert.deepEqual(await preflight(env, async () => Response.json(health)), health);
    await assert.rejects(preflight(env, async () => Response.json({...health,schema_version:20})), /schema 021/);
    assert.equal(existsSync(path.join(dir, 'witty_insight.db')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('control facade never touches an old client and rejects SQL and analytical delegates', async () => {
  const { withControlDelegates, controlClient } = await import('../src/lib/storage-core/control-repository');
  const trap = new Proxy({}, { get() { throw Error('old database accessed'); } });
  assert.equal(withControlDelegates(trap), controlClient);
  for (const name of ['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe', '$extends']) {
    assert.throws(() => controlClient[name], /Unsupported Core operation/);
  }
  for (const model of ['session', 'execution', 'experiment', 'agentEvalDataset']) {
    assert.throws(() => controlClient[model].findMany(), /typed Storage Core API/);
  }
  await controlClient.$disconnect();
});

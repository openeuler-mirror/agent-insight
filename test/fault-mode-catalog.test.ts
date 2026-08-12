import assert from 'node:assert/strict';
import test from 'node:test';

import { getRasCapabilityCatalog } from '@/lib/ingest/ras/catalog-engine';
import {
  FAULT_MODE_SUB_LABEL_STORAGE_KEY,
  loadFaultModeSubLabelOverrides,
  resetFaultModeSubLabel,
  resolveFaultModeSubLabel,
  saveFaultModeSubLabelOverrides,
} from '@/lib/ingest/ras/fault-mode-label-store';

/**
 * Static RAS_FAULT_MODE_CATALOG is deprecated (fixture only).
 * Runtime truth is getRasCapabilityCatalog / GET /api/agent-ras/catalog.
 */
test('capability catalog engine covers the seven implemented sub-modes', async () => {
  const catalog = await getRasCapabilityCatalog({ force: true });
  assert.equal(catalog.submodes.length, 7);
  for (const row of catalog.submodes) {
    assert.ok(row.parent.zh.trim(), `${row.id} parent.zh`);
    assert.ok(row.parent.en.trim(), `${row.id} parent.en`);
    assert.ok(row.subMode.zh.trim(), `${row.id} subMode.zh`);
    assert.ok(row.subMode.en.trim(), `${row.id} subMode.en`);
    assert.ok(row.detects.zh.trim(), `${row.id} detects.zh`);
    assert.ok(row.recoverySummary.zh.trim(), `${row.id} recoverySummary.zh`);
    assert.ok(row.severities.length > 0, `${row.id} severities`);
    assert.ok(row.anomalyKind.trim(), `${row.id} anomalyKind`);
  }
  const parents = new Set(catalog.submodes.map((row) => row.parentId));
  assert.ok(parents.has('thinking_loop') || parents.has('thinking_dead_loop'));
  assert.ok(parents.has('tool_repeat_dead_loop'));
});

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
    removeItem(key: string) {
      map.delete(key);
    },
    _map: map,
  };
}

test('fault-mode label store saves and loads string-id overrides', () => {
  const storage = memoryStorage();
  saveFaultModeSubLabelOverrides(
    { plan_execution: '规划执行（自定义）', ping_pong: '  ', custom_mode: '任意 id' },
    storage,
  );
  const loaded = loadFaultModeSubLabelOverrides(storage);
  assert.equal(loaded.plan_execution, '规划执行（自定义）');
  assert.equal(loaded.ping_pong, undefined);
  assert.equal(loaded.custom_mode, '任意 id');
  assert.equal(
    storage._map.get(FAULT_MODE_SUB_LABEL_STORAGE_KEY),
    JSON.stringify({ plan_execution: '规划执行（自定义）', custom_mode: '任意 id' }),
  );
});

test('fault-mode label store resets to provided default', () => {
  const storage = memoryStorage();
  const id = 'plan_execution';
  let overrides = { [id]: '自定义逻辑死循环' };
  saveFaultModeSubLabelOverrides(overrides, storage);
  overrides = resetFaultModeSubLabel(id, overrides, storage);
  assert.equal(overrides[id], undefined);
  assert.equal(
    resolveFaultModeSubLabel(id, 'zh', overrides, '规划执行语义判定'),
    '规划执行语义判定',
  );
  assert.equal(storage._map.has(FAULT_MODE_SUB_LABEL_STORAGE_KEY), false);
});

test('fault-mode label store ignores bad JSON and non-string values', () => {
  const bad = memoryStorage({ [FAULT_MODE_SUB_LABEL_STORAGE_KEY]: '{not-json' });
  assert.deepEqual(loadFaultModeSubLabelOverrides(bad), {});

  const mixed = memoryStorage({
    [FAULT_MODE_SUB_LABEL_STORAGE_KEY]: JSON.stringify({
      not_a_mode: 'x',
      suffix_cycle: '字面循环改名',
      bad: 12,
    }),
  });
  assert.deepEqual(loadFaultModeSubLabelOverrides(mixed), {
    not_a_mode: 'x',
    suffix_cycle: '字面循环改名',
  });
});

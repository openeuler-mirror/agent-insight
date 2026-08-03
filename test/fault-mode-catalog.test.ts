import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANOMALY_KIND_LABEL,
} from '@/lib/ingest/ras/normalize';
import {
  RAS_FAULT_MODE_CATALOG,
  RAS_FAULT_MODE_IDS,
  type RasFaultModeId,
} from '@/lib/ingest/ras/fault-mode-catalog';
import {
  FAULT_MODE_SUB_LABEL_STORAGE_KEY,
  loadFaultModeSubLabelOverrides,
  resetFaultModeSubLabel,
  resolveFaultModeSubLabel,
  saveFaultModeSubLabelOverrides,
} from '@/lib/ingest/ras/fault-mode-label-store';

test('fault-mode catalog covers the nine implemented sub-modes', () => {
  assert.equal(RAS_FAULT_MODE_CATALOG.length, 9);
  assert.deepEqual(
    RAS_FAULT_MODE_CATALOG.map((row) => row.id).sort(),
    [...RAS_FAULT_MODE_IDS].sort(),
  );
});

test('fault-mode catalog rows have required bilingual fields and known anomaly kinds', () => {
  const kindKeys = new Set(Object.keys(ANOMALY_KIND_LABEL));
  for (const row of RAS_FAULT_MODE_CATALOG) {
    assert.ok(row.parent.zh.trim(), `${row.id} parent.zh`);
    assert.ok(row.parent.en.trim(), `${row.id} parent.en`);
    assert.ok(row.subMode.zh.trim(), `${row.id} subMode.zh`);
    assert.ok(row.subMode.en.trim(), `${row.id} subMode.en`);
    assert.ok(row.detects.zh.trim(), `${row.id} detects.zh`);
    assert.ok(row.recoverySummary.zh.trim(), `${row.id} recoverySummary.zh`);
    assert.ok(row.severities.length > 0, `${row.id} severities`);
    assert.ok(kindKeys.has(row.anomalyKind), `${row.id} anomalyKind ${row.anomalyKind}`);
  }
});

test('fault-mode catalog parents cover thinking and tool families', () => {
  const parents = new Set(RAS_FAULT_MODE_CATALOG.map((row) => row.parentId));
  assert.deepEqual(
    [...parents].sort(),
    ['thinking_dead_loop', 'thinking_loop', 'tool_repeat_dead_loop'],
  );
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

test('fault-mode label store saves and loads overrides', () => {
  const storage = memoryStorage();
  saveFaultModeSubLabelOverrides(
    { text_degradation: '输出崩溃（自定义）', ping_pong: '  ' },
    storage,
  );
  const loaded = loadFaultModeSubLabelOverrides(storage);
  assert.equal(loaded.text_degradation, '输出崩溃（自定义）');
  assert.equal(loaded.ping_pong, undefined);
  assert.equal(
    storage._map.get(FAULT_MODE_SUB_LABEL_STORAGE_KEY),
    JSON.stringify({ text_degradation: '输出崩溃（自定义）' }),
  );
});

test('fault-mode label store resets to catalog default', () => {
  const storage = memoryStorage();
  const id = 'semantic_deadlock' as RasFaultModeId;
  let overrides = { [id]: '自定义逻辑死循环' };
  saveFaultModeSubLabelOverrides(overrides, storage);
  overrides = resetFaultModeSubLabel(id, overrides, storage);
  assert.equal(overrides[id], undefined);
  assert.equal(resolveFaultModeSubLabel(id, 'zh', overrides), '输出崩溃-规划执行死锁');
  assert.equal(storage._map.has(FAULT_MODE_SUB_LABEL_STORAGE_KEY), false);
});

test('fault-mode label store ignores unknown keys and bad JSON', () => {
  const bad = memoryStorage({ [FAULT_MODE_SUB_LABEL_STORAGE_KEY]: '{not-json' });
  assert.deepEqual(loadFaultModeSubLabelOverrides(bad), {});

  const unknown = memoryStorage({
    [FAULT_MODE_SUB_LABEL_STORAGE_KEY]: JSON.stringify({
      not_a_mode: 'x',
      suffix_cycle: '字面循环改名',
    }),
  });
  assert.deepEqual(loadFaultModeSubLabelOverrides(unknown), {
    suffix_cycle: '字面循环改名',
  });
});

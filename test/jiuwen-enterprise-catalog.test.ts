/* Copyright (c) 2026 Huawei Technologies Co., Ltd. SPDX-License-Identifier: Apache-2.0 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCapabilities } from '@/lib/reliability/client-registry';
import { listClientTraceGenerationAvailability } from '@/lib/engine/experiment/execution-targets';
import { prisma } from '@/lib/storage/prisma';

test('enterprise catalog normalization whitelists metadata, targets use their own model list and omit unready Agents', async () => {
  const raw = { platforms: [{ id: 'jiuwenswarm', agents: ['ee-a', 'ee-b', 'ee-c'], models: ['wrong-global'],
    actions: ['RUN_EXPERIMENT_CASE'], runExperimentCase: { version: 2, returnsTraceId: true, ready: true },
    agentCatalog: [{ id: 'ee-a', label: 'test1 · A', models: ['model-a'], ready: true, password: 'no-secret' },
      { id: 'ee-b', label: 'test1 · B', models: ['model-b'], ready: true },
      { id: 'ee-c', label: 'unready', models: [], ready: false, unavailableReason: '没有模型' }] }] };
  const normalized = normalizeCapabilities(raw) as any;
  assert.equal(normalized.platforms[0].agentCatalog[0].label, 'test1 · A');
  assert.doesNotMatch(JSON.stringify(normalized), /no-secret|password/);
  const original = prisma.reliabilityClient.findMany;
  prisma.reliabilityClient.findMany = async () => [{ clientId: 'client-ee', user: 'alice', lastSeenAt: new Date(),
    status: 'online', serviceHealth: 'healthy', capabilitiesJson: JSON.stringify(raw), hostname: 'client-host' }] as any;
  try {
    const result = await listClientTraceGenerationAvailability('alice');
    assert.deepEqual(result.targets.map(t => [t.agent, t.agentLabel, t.models.map(m => m.id)]),
      [['ee-a', 'test1 · A', ['', 'model-a']], ['ee-b', 'test1 · B', ['', 'model-b']]]);
    assert.ok(result.diagnostics.some(d => d.message.includes('没有模型')));
  } finally { prisma.reliabilityClient.findMany = original; }
});

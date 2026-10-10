import assert from 'node:assert/strict';
import test from 'node:test';

import {
  goalPlusBatchSchema,
  goalPlusSnapshotId,
  goalPlusSnapshotEnvelopeSchema,
  validateGoalPlusSnapshotIdentity,
} from '@/lib/ingest/goal-plus/contracts';
import { sanitizeGoalPlusLabel, sanitizeGoalPlusPayload } from '@/lib/ingest/goal-plus/normalize';

function snapshot() {
  const sourceId = 'gpsrc_contract';
  const kind = 'run' as const;
  const objectKey = 'run_contract';
  const contentHash = `sha256:${'a'.repeat(64)}`;
  return {
    format: 'agent-insight.goal-plus-snapshot' as const,
    version: 1 as const,
    snapshotId: goalPlusSnapshotId(sourceId, kind, objectKey, contentHash),
    sourceId,
    kind,
    objectKey,
    parentKeys: { runId: objectKey },
    sourceSchemaVersion: 1,
    contentHash,
    observedAt: '2026-09-01T00:00:00.000Z',
    payload: {
      runId: objectKey,
      sourcePath: '/Users/example/private/workspace/spec.json',
      authorization: 'Bearer top-secret-value',
      maxTokens: 2000,
      summary: 'token=top-secret-value path=/home/example/private/file',
      hiddenAnswer: 'never upload this',
    },
    redaction: { contentMode: 'bounded' as const, truncatedFields: [], removedFields: [] },
  };
}

test('Goal Plus snapshot identity is deterministic and tamper evident', () => {
  const value = snapshot();
  assert.equal(goalPlusSnapshotEnvelopeSchema.safeParse(value).success, true);
  assert.equal(validateGoalPlusSnapshotIdentity(value), true);
  assert.equal(validateGoalPlusSnapshotIdentity({ ...value, objectKey: 'other' }), false);
});

test('Goal Plus batch validates outer shape separately from individual snapshots', () => {
  const value = snapshot();
  const parsed = goalPlusBatchSchema.safeParse({
    format: 'agent-insight.goal-plus-batch',
    version: 1,
    source: {
      sourceId: value.sourceId,
      workspaceFingerprint: `sha256:${'b'.repeat(64)}`,
      collectorVersion: 'test',
    },
    snapshots: [value, { malformed: true }],
  });
  assert.equal(parsed.success, true);
});

test('server-side sanitization removes secret fields and absolute paths but keeps token counts', () => {
  const sanitized = sanitizeGoalPlusPayload(snapshot());
  assert.equal(sanitized.payload.authorization, undefined);
  assert.equal(sanitized.payload.hiddenAnswer, undefined);
  assert.equal(sanitized.payload.maxTokens, 2000);
  assert.equal(sanitized.payload.sourcePath, '[LOCAL_PATH]');
  assert.doesNotMatch(String(sanitized.payload.summary), /top-secret-value|\/home\/example/);
  assert.ok(sanitized.removedFields.includes('authorization'));
});

test('source labels are bounded and do not retain local paths or inline secrets', () => {
  const label = sanitizeGoalPlusLabel('workspace /Users/example/private token=secret-value');
  assert.doesNotMatch(String(label), /\/Users\/example|secret-value/);
  assert.ok(String(label).length <= 160);
});

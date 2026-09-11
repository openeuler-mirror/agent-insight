import { createHash } from 'node:crypto';
import { z } from 'zod';

export const GOAL_PLUS_SNAPSHOT_FORMAT = 'agent-insight.goal-plus-snapshot' as const;
export const GOAL_PLUS_BATCH_FORMAT = 'agent-insight.goal-plus-batch' as const;
export const GOAL_PLUS_SNAPSHOT_VERSION = 1 as const;
export const GOAL_PLUS_MAX_SNAPSHOTS = 100;
export const GOAL_PLUS_MAX_SNAPSHOT_BYTES = 256 * 1024;
export const GOAL_PLUS_MAX_BATCH_BYTES = 4 * 1024 * 1024;

export const goalPlusSnapshotKinds = [
  'goal',
  'goal_event',
  'frozen_spec',
  'run',
  'candidate',
  'agent_session',
  'best',
  'report_meta',
] as const;

export type GoalPlusSnapshotKind = typeof goalPlusSnapshotKinds[number];

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const objectId = z.string().trim().min(1).max(240);

export const goalPlusParentKeysSchema = z.object({
  goalId: objectId.optional(),
  goalRevision: z.number().int().positive().optional(),
  specId: objectId.optional(),
  runId: objectId.optional(),
  candidateId: objectId.optional(),
  agentSessionId: objectId.optional(),
}).strict();

export const goalPlusSnapshotEnvelopeSchema = z.object({
  format: z.literal(GOAL_PLUS_SNAPSHOT_FORMAT),
  version: z.literal(GOAL_PLUS_SNAPSHOT_VERSION),
  snapshotId: z.string().regex(/^gpsnap_[a-f0-9]{64}$/),
  sourceId: z.string().trim().min(1).max(160),
  kind: z.enum(goalPlusSnapshotKinds),
  objectKey: objectId,
  parentKeys: goalPlusParentKeysSchema,
  sourceSchemaVersion: z.number().int().positive().optional(),
  contentHash: digest,
  observedAt: z.string().datetime({ offset: true }),
  payload: z.record(z.unknown()),
  redaction: z.object({
    contentMode: z.enum(['bounded', 'metadata-only']),
    truncatedFields: z.array(z.string().max(240)).max(256),
    removedFields: z.array(z.string().max(240)).max(256),
  }).strict(),
}).strict();

export const goalPlusBatchSchema = z.object({
  format: z.literal(GOAL_PLUS_BATCH_FORMAT),
  version: z.literal(GOAL_PLUS_SNAPSHOT_VERSION),
  source: z.object({
    sourceId: z.string().trim().min(1).max(160),
    workspaceFingerprint: digest,
    collectorVersion: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(160).optional(),
    scanCompletedAt: z.string().datetime({ offset: true }).optional(),
    semanticCheckpoint: z.record(z.unknown()).optional(),
  }).strict(),
  snapshots: z.array(z.unknown()).max(GOAL_PLUS_MAX_SNAPSHOTS),
}).strict();

export type GoalPlusSnapshotEnvelopeV1 = z.infer<typeof goalPlusSnapshotEnvelopeSchema>;
export type GoalPlusBatchV1 = Omit<z.infer<typeof goalPlusBatchSchema>, 'snapshots'> & {
  snapshots: GoalPlusSnapshotEnvelopeV1[];
};

export function goalPlusSnapshotId(
  sourceId: string,
  kind: GoalPlusSnapshotKind,
  objectKey: string,
  contentHash: string,
): string {
  const value = [sourceId, kind, objectKey, contentHash].join('\u001f');
  return `gpsnap_${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function validateGoalPlusSnapshotIdentity(snapshot: GoalPlusSnapshotEnvelopeV1): boolean {
  return snapshot.snapshotId === goalPlusSnapshotId(
    snapshot.sourceId,
    snapshot.kind,
    snapshot.objectKey,
    snapshot.contentHash,
  );
}


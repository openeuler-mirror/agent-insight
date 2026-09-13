import { NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import {
  GOAL_PLUS_MAX_BATCH_BYTES,
  GOAL_PLUS_MAX_SNAPSHOT_BYTES,
  goalPlusBatchSchema,
  goalPlusSnapshotEnvelopeSchema,
  validateGoalPlusSnapshotIdentity,
  type GoalPlusBatchV1,
  type GoalPlusSnapshotEnvelopeV1,
} from '@/lib/ingest/goal-plus/contracts';
import {
  GoalPlusSourceConflictError,
  persistGoalPlusBatch,
  type GoalPlusPersistResult,
  type GoalPlusRejectedSnapshot,
} from '@/lib/ingest/goal-plus/persist';
import { relinkGoalPlusSource } from '@/lib/ingest/goal-plus/correlate';
import { prismaRaw } from '@/lib/storage/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export async function POST(request: Request) {
  const { username, apiKey } = await resolveUser(request);
  if (!apiKey || !username) {
    return NextResponse.json({ error: 'A valid x-witty-api-key is required' }, { status: 401 });
  }
  const declaredSize = Number(request.headers.get('content-length') || 0);
  if (declaredSize > GOAL_PLUS_MAX_BATCH_BYTES) {
    return NextResponse.json({ error: 'Goal Plus snapshot batch is too large' }, { status: 413 });
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ error: 'Unable to read request body' }, { status: 400 });
  }
  if (Buffer.byteLength(raw, 'utf8') > GOAL_PLUS_MAX_BATCH_BYTES) {
    return NextResponse.json({ error: 'Goal Plus snapshot batch is too large' }, { status: 413 });
  }

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const outer = goalPlusBatchSchema.safeParse(input);
  if (!outer.success) {
    return NextResponse.json({ error: 'Invalid Goal Plus batch envelope', issues: outer.error.issues }, { status: 422 });
  }

  const snapshots: GoalPlusSnapshotEnvelopeV1[] = [];
  const originalIndexes: number[] = [];
  const rejected: GoalPlusRejectedSnapshot[] = [];
  outer.data.snapshots.forEach((candidate, index) => {
    if (jsonSize(candidate) > GOAL_PLUS_MAX_SNAPSHOT_BYTES) {
      rejected.push({ index, code: 'snapshot_too_large', message: 'Snapshot exceeds the per-item size limit' });
      return;
    }
    const parsed = goalPlusSnapshotEnvelopeSchema.safeParse(candidate);
    if (!parsed.success) {
      rejected.push({ index, code: 'invalid_snapshot', message: parsed.error.issues[0]?.message || 'Invalid snapshot' });
      return;
    }
    if (parsed.data.sourceId !== outer.data.source.sourceId) {
      rejected.push({ index, snapshotId: parsed.data.snapshotId, code: 'source_mismatch', message: 'Snapshot sourceId differs from batch sourceId' });
      return;
    }
    if (!validateGoalPlusSnapshotIdentity(parsed.data)) {
      rejected.push({ index, snapshotId: parsed.data.snapshotId, code: 'identity_mismatch', message: 'Snapshot identity does not match its immutable content key' });
      return;
    }
    snapshots.push(parsed.data);
    originalIndexes.push(index);
  });

  if (outer.data.snapshots.length > 0 && snapshots.length === 0) {
    return NextResponse.json({
      status: 'rejected',
      accepted: 0,
      duplicate: 0,
      rejected,
      retryable: false,
    }, { status: 422 });
  }
  const batch: GoalPlusBatchV1 = {
    ...outer.data,
    source: rejected.length
      ? { ...outer.data.source, scanCompletedAt: undefined, semanticCheckpoint: undefined }
      : outer.data.source,
    snapshots,
  };
  let result: GoalPlusPersistResult;
  try {
    result = await persistGoalPlusBatch(username, batch);
  } catch (error) {
    if (error instanceof GoalPlusSourceConflictError) {
      return NextResponse.json({ error: error.message, retryable: false }, { status: 409 });
    }
    throw error;
  }
  rejected.push(...result.rejected.map(item => ({ ...item, index: originalIndexes[item.index] ?? item.index })));
  const source = await prismaRaw.goalPlusSource.findUnique({
    where: { user_sourceId: { user: username, sourceId: batch.source.sourceId } },
    select: { id: true },
  });
  const correlation = source ? await relinkGoalPlusSource(source.id) : { linked: 0, ambiguous: 0, unresolved: 0 };

  return NextResponse.json({
    status: rejected.length ? 'partially_accepted' : 'accepted',
    accepted: result.accepted,
    duplicate: result.duplicate,
    rejected,
    correlation,
    retryable: false,
  }, { status: rejected.length && result.accepted === 0 && result.duplicate === 0 ? 422 : 200 });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}

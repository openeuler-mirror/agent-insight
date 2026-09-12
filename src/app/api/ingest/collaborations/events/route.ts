import { NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import {
  COLLABORATION_MAX_BODY_BYTES,
  reportedCollaborationEventSchema,
} from '@/lib/ingest/collaboration/contracts';
import {
  CollaborationConflictError,
  CollaborationSourceConflictError,
  persistCollaborationEvent,
  type CollaborationPersistResult,
} from '@/lib/ingest/collaboration/persist';
import {
  collaborationEventResolution,
  resolveCollaborationEventByDbId,
} from '@/lib/ingest/collaboration/resolve';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function error(code: string, message: string, status: number, field?: string) {
  return NextResponse.json({ error: { code, message, ...(field ? { field } : {}) } }, { status });
}

export async function POST(request: Request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return error('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json', 415);
  }
  const { username, apiKey } = await resolveUser(request);
  if (!username || !apiKey) return error('UNAUTHORIZED', 'A valid x-witty-api-key is required', 401);
  const declaredSize = Number(request.headers.get('content-length') || 0);
  if (declaredSize > COLLABORATION_MAX_BODY_BYTES) {
    return error('PAYLOAD_TOO_LARGE', 'Request body exceeds 64 KiB', 413);
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return error('INVALID_ARGUMENT', 'Unable to read request body', 400);
  }
  if (Buffer.byteLength(raw, 'utf8') > COLLABORATION_MAX_BODY_BYTES) {
    return error('PAYLOAD_TOO_LARGE', 'Request body exceeds 64 KiB', 413);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return error('INVALID_ARGUMENT', 'Request body must be valid JSON', 400);
  }
  const parsed = reportedCollaborationEventSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || undefined;
    const locatorError = field?.startsWith('fromLocator');
    return error(
      locatorError ? 'INVALID_LOCATOR' : 'INVALID_ARGUMENT',
      issue?.message || 'Invalid collaboration event',
      400,
      field,
    );
  }
  let persisted: CollaborationPersistResult;
  try {
    persisted = await persistCollaborationEvent(username, {
      ...parsed.data,
      sourceType: 'reported',
    });
  } catch (caught) {
    if (caught instanceof CollaborationConflictError) {
      return error(caught.code, '该事件编号已保存不同内容，不能覆盖', 409);
    }
    if (caught instanceof CollaborationSourceConflictError) {
      return error(caught.code, caught.message, 409);
    }
    console.error('[Collaboration-Ingest] failed:', caught);
    return error('INTERNAL_ERROR', 'Unable to persist collaboration event', 500);
  }
  try {
    await resolveCollaborationEventByDbId(persisted.eventDbId);
  } catch (caught) {
    console.warn('[Collaboration-Ingest] event saved but resolution failed:', caught);
  }
  const resolution = await collaborationEventResolution(persisted.eventDbId).catch(() => ({
    traceResolution: { from: 'pending', to: 'pending' },
    endpointResolutions: {
      from: { status: 'pending' },
      to: { status: 'pending' },
    },
    fromAnchor: { status: 'pending', message: '事件已保存，定位稍后重试' },
  }));
  return NextResponse.json({
    collaborationId: persisted.collaborationId,
    eventId: persisted.eventId,
    result: persisted.result,
    receivedAt: persisted.receivedAt,
    ...resolution,
    detailPath: `/observe/collaborations/${encodeURIComponent(persisted.collaborationId)}`,
  }, { status: persisted.result === 'created' ? 201 : 200 });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { 'Access-Control-Allow-Headers': 'Content-Type, x-witty-api-key' },
  });
}

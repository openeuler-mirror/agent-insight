import { prismaRaw } from '@/lib/storage/prisma';

import {
  collaborationEventBody,
  collaborationEventHash,
  normalizeCollaborationEvent,
  type CollaborationEventInput,
} from './contracts';

export type CollaborationEndpointSide = 'from' | 'to';
export type CollaborationLinkState = 'pending' | 'linked' | 'ambiguous' | 'superseded';

export interface CollaborationEndpointHint {
  state: CollaborationLinkState;
  executionId?: string;
  method?: string;
  evidence?: Record<string, unknown>;
}

export interface CollaborationPersistOptions {
  endpointHints?: Partial<Record<CollaborationEndpointSide, CollaborationEndpointHint>>;
}

export interface CollaborationPersistResult {
  result: 'created' | 'duplicate';
  collaborationDbId: string;
  eventDbId: string;
  collaborationId: string;
  eventId: string;
  receivedAt: string;
}

export class CollaborationConflictError extends Error {
  readonly code = 'EVENT_CONFLICT';
}

export class CollaborationSourceConflictError extends Error {
  readonly code = 'COLLABORATION_SOURCE_CONFLICT';
}

export async function ensureCollaborationRecord(
  user: string,
  metadata: { collaborationId: string; sourceType: CollaborationEventInput['sourceType']; sourceRef?: string },
): Promise<{ id: string }> {
  const existing = await prismaRaw.collaboration.findUnique({
    where: { user_collaborationId: { user, collaborationId: metadata.collaborationId } },
    select: { id: true, sourceType: true, sourceRef: true },
  });
  if (existing) {
    if (existing.sourceType !== metadata.sourceType || (existing.sourceRef || undefined) !== metadata.sourceRef) {
      throw new CollaborationSourceConflictError('Collaboration ID is already owned by another source');
    }
    return existing;
  }
  if (metadata.sourceRef) {
    const bySource = await prismaRaw.collaboration.findUnique({
      where: {
        user_sourceType_sourceRef: {
          user,
          sourceType: metadata.sourceType,
          sourceRef: metadata.sourceRef,
        },
      },
      select: { id: true, collaborationId: true },
    });
    if (bySource && bySource.collaborationId !== metadata.collaborationId) {
      throw new CollaborationSourceConflictError('Source reference is already bound to another collaboration');
    }
    if (bySource) return bySource;
  }
  try {
    const now = new Date().toISOString();
    return await prismaRaw.collaboration.create({
      data: {
        user,
        collaborationId: metadata.collaborationId,
        sourceType: metadata.sourceType,
        sourceRef: metadata.sourceRef,
        createdAt: now,
        updatedAt: now,
      },
      select: { id: true },
    });
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
    const raced = await prismaRaw.collaboration.findUnique({
      where: { user_collaborationId: { user, collaborationId: metadata.collaborationId } },
      select: { id: true, sourceType: true, sourceRef: true },
    });
    if (!raced || raced.sourceType !== metadata.sourceType || (raced.sourceRef || undefined) !== metadata.sourceRef) {
      throw new CollaborationSourceConflictError('Collaboration ID is already owned by another source');
    }
    return raced;
  }
}

export async function updateCollaborationDiagnostics(
  user: string,
  metadata: { collaborationId: string; sourceType: CollaborationEventInput['sourceType']; sourceRef?: string },
  diagnostics: unknown[],
): Promise<{ id: string }> {
  const collaboration = await ensureCollaborationRecord(user, metadata);
  await prismaRaw.collaboration.update({
    where: { id: collaboration.id },
    data: { diagnosticsJson: JSON.stringify(diagnostics), updatedAt: new Date().toISOString() },
  });
  return collaboration;
}

export async function upsertCollaborationEndpointResolution(
  eventDbId: string,
  side: CollaborationEndpointSide,
  hint: CollaborationEndpointHint,
): Promise<void> {
  const executionId = hint.state === 'linked' ? hint.executionId || null : null;
  if (hint.state === 'linked' && !executionId) {
    throw new Error(`A linked ${side} endpoint requires executionId`);
  }
  const data = {
    executionId,
    linkState: hint.state,
    linkMethod: hint.method || null,
    evidenceJson: JSON.stringify(hint.evidence || {}),
    resolvedAt: hint.state === 'pending' ? null : new Date(),
  };
  await prismaRaw.collaborationEndpointResolution.upsert({
    where: { eventDbId_side: { eventDbId, side } },
    create: { eventDbId, side, ...data },
    update: data,
  });
}

export async function persistCollaborationEvent(
  user: string,
  rawInput: CollaborationEventInput,
  options: CollaborationPersistOptions = {},
): Promise<CollaborationPersistResult> {
  const input = normalizeCollaborationEvent(rawInput);
  const eventBodyJson = collaborationEventBody(input);
  const contentHash = collaborationEventHash(input);
  const collaboration = await ensureCollaborationRecord(user, {
    collaborationId: input.collaborationId,
    sourceType: input.sourceType,
    sourceRef: input.collaborationSourceRef ?? input.sourceRef,
  });
  let event = await prismaRaw.collaborationEvent.findUnique({
    where: {
      collaborationDbId_eventId: {
        collaborationDbId: collaboration.id,
        eventId: input.eventId,
      },
    },
  });
  let result: CollaborationPersistResult['result'] = 'duplicate';
  if (event) {
    if (event.contentHash !== contentHash || event.eventBodyJson !== eventBodyJson) {
      throw new CollaborationConflictError('Event ID is already stored with different content');
    }
  } else {
    try {
      event = await prismaRaw.collaborationEvent.create({
        data: {
          collaborationDbId: collaboration.id,
          user,
          collaborationId: input.collaborationId,
          eventId: input.eventId,
          fromSessionId: input.fromSessionId,
          toSessionId: input.toSessionId,
          description: input.description,
          observedAt: input.observedAt ? new Date(input.observedAt) : null,
          content: input.content,
          fromLocatorJson: input.fromLocator ? JSON.stringify(input.fromLocator) : null,
          sourceType: input.sourceType,
          sourceRef: input.sourceRef,
          relationKind: input.relationKind,
          role: input.role,
          eventBodyJson,
          contentHash,
          receivedAt: new Date().toISOString(),
          endpointResolutions: {
            create: [
              { side: 'from', linkState: 'pending' },
              { side: 'to', linkState: 'pending' },
            ],
          },
        },
      });
      result = 'created';
      await prismaRaw.collaboration.update({
        where: { id: collaboration.id },
        data: { updatedAt: new Date().toISOString() },
        select: { id: true },
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      event = await prismaRaw.collaborationEvent.findUnique({
        where: {
          collaborationDbId_eventId: {
            collaborationDbId: collaboration.id,
            eventId: input.eventId,
          },
        },
      });
      if (!event || event.contentHash !== contentHash || event.eventBodyJson !== eventBodyJson) {
        throw new CollaborationConflictError('Event ID is already stored with different content');
      }
    }
  }
  for (const side of ['from', 'to'] as const) {
    const hint = options.endpointHints?.[side];
    if (hint) await upsertCollaborationEndpointResolution(event.id, side, hint);
  }
  return {
    result,
    collaborationDbId: collaboration.id,
    eventDbId: event.id,
    collaborationId: input.collaborationId,
    eventId: input.eventId,
    receivedAt: event.receivedAt,
  };
}

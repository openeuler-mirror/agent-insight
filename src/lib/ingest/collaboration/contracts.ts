import { createHash } from 'node:crypto';
import { z } from 'zod';

import { sanitizeGoalPlusText } from '@/lib/ingest/goal-plus/normalize';

export const COLLABORATION_MAX_BODY_BYTES = 64 * 1024;
export const COLLABORATION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

const meaningfulString = (maximum: number) => z.string()
  .max(maximum)
  .refine(value => value.trim().length > 0, 'must not be blank');

export const collaborationLocatorSchema = z.discriminatedUnion('recordType', [
  z.object({
    recordType: z.literal('tool'),
    name: meaningfulString(200),
  }).strict(),
  z.object({
    recordType: z.literal('shell'),
    commandContains: meaningfulString(512),
  }).strict(),
]);

export const reportedCollaborationEventSchema = z.object({
  collaborationId: z.string()
    .regex(COLLABORATION_ID_PATTERN)
    .refine(value => !value.startsWith('collab_gp_'), 'collab_gp_ is reserved for internal Goal Plus projection'),
  eventId: z.string().regex(COLLABORATION_ID_PATTERN),
  fromSessionId: meaningfulString(512),
  toSessionId: meaningfulString(512),
  description: meaningfulString(500),
  observedAt: z.string().datetime({ offset: true }).optional(),
  content: z.string().max(4000).optional(),
  fromLocator: collaborationLocatorSchema.optional(),
}).strict();

export type CollaborationLocator = z.infer<typeof collaborationLocatorSchema>;
export type ReportedCollaborationEventInput = z.infer<typeof reportedCollaborationEventSchema>;
export type CollaborationSourceType = 'reported' | 'goal-plus-semantic';

export interface CollaborationEventInput extends ReportedCollaborationEventInput {
  sourceType: CollaborationSourceType;
  collaborationSourceRef?: string;
  sourceRef?: string;
  relationKind?: string;
  role?: string;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') return 'null';
  const object = value as Record<string, unknown>;
  const fields = Object.keys(object)
    .filter(key => object[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
  return `{${fields.join(',')}}`;
}

export function normalizeCollaborationEvent(input: CollaborationEventInput): CollaborationEventInput {
  const fromLocator = input.fromLocator?.recordType === 'tool'
    ? {
      recordType: 'tool' as const,
      name: sanitizeGoalPlusText(input.fromLocator.name, 'fromLocator.name', 200),
    }
    : input.fromLocator?.recordType === 'shell'
      ? {
        recordType: 'shell' as const,
        commandContains: sanitizeGoalPlusText(
          input.fromLocator.commandContains,
          'fromLocator.commandContains',
          512,
        ),
      }
      : undefined;
  return {
    ...input,
    description: sanitizeGoalPlusText(input.description.trim(), 'description', 500),
    content: input.content === undefined
      ? undefined
      : sanitizeGoalPlusText(input.content, 'content', 4000),
    fromLocator,
  };
}

export function collaborationEventBody(input: CollaborationEventInput): string {
  return canonicalJson(normalizeCollaborationEvent(input));
}

export function collaborationEventHash(input: CollaborationEventInput): string {
  return `sha256:${createHash('sha256').update(collaborationEventBody(input), 'utf8').digest('hex')}`;
}

export function deterministicCollaborationId(...parts: string[]): string {
  return `collab_gp_${createHash('sha256').update(parts.join('\u001f'), 'utf8').digest('hex')}`;
}

export function deterministicCollaborationEventId(...parts: string[]): string {
  return `evt_gp_${createHash('sha256').update(parts.join('\u001f'), 'utf8').digest('hex')}`;
}

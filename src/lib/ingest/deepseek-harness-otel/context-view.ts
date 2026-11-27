import type { RawInteraction } from '@/lib/engine/observability/agent-trace';
import { dshContextTokens, validateDshContext } from './context-membership';

export type ContextRequest = NonNullable<RawInteraction['harnessRequests']>[number];
export type ContextEntry = { request: ContextRequest; key: string; usage?: RawInteraction['usage'] };
export type ContextViewEvent = { source: string; seq: number; kind: string; body: Record<string, unknown>; projected: boolean; bodies?: NativeContextBodyRef[]; target?: ContextEntry };

export function contextViewEvents(entries: ContextEntry[]): ContextViewEvent[] {
  const records = new Map<string, ContextViewEvent>();
  for (const { request } of entries) {
    const projection = validateDshContext(request.dshContext, request.sourceSessionId, request.eventSequence, request.turn, request.step);
    for (const event of projection?.events ?? []) {
      if (!Number.isSafeInteger(event.seq) || !['compaction', 'prune', 'model'].includes(event.kind)) continue;
      records.set(`${request.sourceSessionId}:${event.seq}`, { source: request.sourceSessionId, seq: event.seq, kind: event.kind, body: event, projected: true });
    }
  }
  const bodies = entries.flatMap(entry=>nativeContextBodies(entry.request));
  return [...records.values()].map(event => {
    const summary=bodies.find(body=>body.sourceSessionId===event.source && body.sourceEventSeq===event.seq && body.kind==='compaction-summary');
    return ({ ...event, bodies:summary ? bodies.filter(body=>body.sourceSessionId===event.source && (body.sourceEventSeq===summary.sourceEventSeq || !!summary.compactionId && body.compactionId===summary.compactionId)) : [], target: entries.filter(e => e.request.sourceSessionId === event.source && e.request.eventSequence >= event.seq).sort((a, b) => a.request.eventSequence - b.request.eventSequence)[0] });}).sort((a, b) => a.source.localeCompare(b.source) || a.seq - b.seq);
}

export function requestContextEvents(events: ContextViewEvent[], request: ContextRequest) {
  return events.filter(e => e.source === request.sourceSessionId && e.target?.request.eventSequence === request.eventSequence);
}

export function adjacentContextDiff(entries: ContextEntry[], current: ContextRequest) {
  const previous = entries.filter(e => e.request.sourceSessionId === current.sourceSessionId && e.request.eventSequence < current.eventSequence)
    .sort((a, b) => b.request.eventSequence - a.request.eventSequence)[0]?.request;
  const projection = validateDshContext(current.dshContext, current.sourceSessionId, current.eventSequence, current.turn, current.step)?.delta;
  const reason = !current.dshContext ? 'projection-not-collected'
    : current.dshContext.status !== 'available' ? `projection-${validateDshContext(current.dshContext, current.sourceSessionId, current.eventSequence, current.turn, current.step)?.status ?? 'invalid'}`
    : !dshContextTokens(current) ? 'invalid-or-unavailable-projection'
    : projection?.status === 'no-previous-request' ? 'projection-no-previous-request' : `projection-${projection?.status ?? 'delta-not-collected'}`;
  if (dshContextTokens(current) && projection?.status === 'available' && previous?.eventSequence === projection.baseSeq)
    return { source: 'dsh-context' as const, previous, projection, reason: null };
  const projectionReason = projection?.status === 'available' ? 'projection-base-not-adjacent' : reason;
  if (!previous) return { source: 'unavailable' as const, reason: 'no-previous-captured-request', projectionReason };
  return { source: 'unavailable' as const, previous, projectionReason, reason: 'existing-source-diff-unavailable' };
}

export type NativeContextBodyRef = {sourceSessionId:string;sourceEventSeq:number;kind:string;bodyRef?:string;bodyStorageStatus:string;compactionId?:string;truncated?:boolean;expiresAt?:string};
export function nativeContextBodies(request:ContextRequest):NativeContextBodyRef[] {
  return (request.contextEvents??[]).flatMap(event=>{
    const meta=event.body?.contextBody as any;
    if(event.sourceSessionId!==request.sourceSessionId || !meta || meta.source!=='harness-native'
      || meta.sourceSessionId!==request.sourceSessionId || meta.sourceEventSeq!==event.eventSequence
      || !['compaction-summary','checkpoint'].includes(meta.kind))return [];
    return [{sourceSessionId:meta.sourceSessionId,sourceEventSeq:meta.sourceEventSeq,kind:meta.kind,
      bodyStorageStatus:meta.bodyStorageStatus,bodyRef:meta.bodyRef,compactionId:meta.compactionId,truncated:meta.truncated,expiresAt:meta.expiresAt}];
  });
}

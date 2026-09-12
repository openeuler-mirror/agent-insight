import { prismaRaw } from '@/lib/storage/prisma';

import type { CollaborationLocator } from './contracts';
import { upsertCollaborationEndpointResolution, type CollaborationEndpointSide } from './persist';

type LocatorMatch = {
  recordType: 'tool' | 'shell';
  recordId?: string;
  startedAt?: number;
  trustedTime: boolean;
};

type StoredEvent = {
  id: string;
  collaborationDbId: string;
  fromSessionId: string;
  toSessionId: string;
  fromLocatorJson: string | null;
  observedAt: Date | null;
  sourceType: string;
  collaboration: { user: string };
};

function parseLocator(raw: string | null): CollaborationLocator | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.recordType === 'tool' && typeof parsed.name === 'string') return parsed;
    if (parsed?.recordType === 'shell' && typeof parsed.commandContains === 'string') return parsed;
  } catch {}
  return undefined;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function shellCommand(call: Record<string, unknown>): string {
  const fn = call.function && typeof call.function === 'object'
    ? call.function as Record<string, unknown>
    : {};
  const args = parseArguments(fn.arguments ?? call.arguments ?? call.args);
  for (const key of ['command', 'cmd', 'script']) {
    if (typeof args[key] === 'string') return args[key] as string;
  }
  return '';
}

function toolName(call: Record<string, unknown>): string {
  const fn = call.function && typeof call.function === 'object'
    ? call.function as Record<string, unknown>
    : {};
  return typeof fn.name === 'string' ? fn.name : typeof call.name === 'string' ? call.name : '';
}

function toolStartedAt(call: Record<string, unknown>): { value?: number; trusted: boolean } {
  const timing = call.timing && typeof call.timing === 'object'
    ? call.timing as Record<string, unknown>
    : {};
  const value = timing.started_at;
  const source = typeof timing.source === 'string' ? timing.source.toLowerCase() : '';
  const trusted = ['execution', 'native', 'otel', 'framework', 'exact'].includes(source);
  return typeof value === 'number' && Number.isFinite(value) ? { value, trusted } : { trusted: false };
}

export function findCollaborationLocatorMatches(
  interactions: unknown,
  locator: CollaborationLocator,
): LocatorMatch[] {
  if (!Array.isArray(interactions)) return [];
  const shellTools = new Set(['bash', 'shell', 'terminal', 'exec_command', 'execute_command', 'run_command']);
  const matches: LocatorMatch[] = [];
  interactions.forEach((interaction, interactionIndex) => {
    if (!interaction || typeof interaction !== 'object') return;
    const calls = Array.isArray((interaction as Record<string, unknown>).tool_calls)
      ? (interaction as Record<string, unknown>).tool_calls as unknown[]
      : [];
    calls.forEach((rawCall, callIndex) => {
      if (!rawCall || typeof rawCall !== 'object') return;
      const call = rawCall as Record<string, unknown>;
      const name = toolName(call);
      const matchesLocator = locator.recordType === 'tool'
        ? name === locator.name
        : shellTools.has(name.toLowerCase()) && shellCommand(call).includes(locator.commandContains);
      if (!matchesLocator) return;
      const timing = toolStartedAt(call);
      matches.push({
        recordType: locator.recordType,
        recordId: typeof call.id === 'string' && call.id ? call.id : undefined,
        startedAt: timing.value,
        trustedTime: timing.trusted,
      });
      void interactionIndex;
      void callIndex;
    });
  });
  return matches;
}

async function resolveReportedEndpoint(event: StoredEvent, side: CollaborationEndpointSide): Promise<void> {
  if (event.sourceType !== 'reported') return;
  const sessionId = side === 'from' ? event.fromSessionId : event.toSessionId;
  const matches = await prismaRaw.execution.findMany({
    where: {
      user: event.collaboration.user,
      OR: [{ taskId: sessionId }, { agentSessionId: sessionId }],
    },
    select: { id: true, taskId: true, agentSessionId: true, framework: true },
  });
  const unique = [...new Map(matches.map(match => [match.id, match])).values()];
  if (unique.length === 1) {
    await upsertCollaborationEndpointResolution(event.id, side, {
      state: 'linked',
      executionId: unique[0].id,
      method: 'native_session_id',
      evidence: { sessionId, framework: unique[0].framework },
    });
    return;
  }
  await upsertCollaborationEndpointResolution(event.id, side, {
    state: unique.length ? 'ambiguous' : 'pending',
    method: unique.length ? 'native_session_id' : undefined,
    evidence: unique.length
      ? { sessionId, candidateExecutionIds: unique.map(match => match.id) }
      : { sessionId },
  });
}

async function setAnchor(
  eventDbId: string,
  state: string,
  value: Record<string, unknown>,
): Promise<void> {
  await prismaRaw.collaborationEndpointResolution.update({
    where: { eventDbId_side: { eventDbId, side: 'from' } },
    data: { anchorState: state, anchorJson: JSON.stringify(value) },
  });
}

async function resolveReportedAnchor(event: StoredEvent): Promise<void> {
  if (event.sourceType !== 'reported') return;
  const resolutions = await prismaRaw.collaborationEndpointResolution.findMany({
    where: { eventDbId: event.id },
    include: {
      execution: {
        select: { id: true, taskId: true, parentExecutionId: true },
      },
    },
  });
  const from = resolutions.find(item => item.side === 'from');
  const to = resolutions.find(item => item.side === 'to');
  if (from?.linkState !== 'linked' || !from.execution) {
    await setAnchor(event.id, 'waiting_trace', {
      message: '发起方 Trace 尚未唯一关联',
    });
    return;
  }
  const locator = parseLocator(event.fromLocatorJson);
  if (!locator) {
    const directParent = to?.linkState === 'linked'
      && to.execution?.parentExecutionId === from.execution.id;
    await setAnchor(event.id, directParent ? 'confirmed' : 'not_provided', directParent
      ? { message: '复用现有 Execution 直接父子关系', evidence: 'execution-parent' }
      : { message: '未提供发起位置条件，保留 Session 级关系' });
    return;
  }
  const session = from.execution.taskId
    ? await prismaRaw.session.findUnique({
      where: { taskId: from.execution.taskId },
      select: { interactions: true },
    })
    : null;
  let interactions: unknown[] = [];
  try {
    const parsed = session?.interactions ? JSON.parse(session.interactions) : [];
    interactions = Array.isArray(parsed) ? parsed : [];
  } catch {
    await setAnchor(event.id, 'pending', { message: '发起方 Trace 暂时无法解析，稍后重试' });
    return;
  }
  const matches = findCollaborationLocatorMatches(interactions, locator);
  const group = await prismaRaw.collaborationEvent.findMany({
    where: {
      collaborationDbId: event.collaborationDbId,
      fromSessionId: event.fromSessionId,
      fromLocatorJson: event.fromLocatorJson,
      sourceType: 'reported',
    },
    select: { id: true, observedAt: true },
  });
  if (matches.length === 0) {
    await Promise.all(group.map(item => setAnchor(item.id, 'not_found', {
      candidateCount: 0,
      message: '定位条件未匹配到已采集的调用记录',
    })));
    return;
  }
  if (group.length === 1 && matches.length === 1) {
    await setAnchor(event.id, 'candidate', {
      candidateCount: 1,
      matchedRecord: matches[0].recordId
        ? { recordType: matches[0].recordType, recordId: matches[0].recordId }
        : undefined,
      message: '定位条件唯一命中，作为候选位置展示',
    });
    return;
  }
  const observedTimes = group.map(item => item.observedAt?.getTime());
  const callTimes = matches.map(item => item.startedAt);
  const canOrder = group.length > 1
    && group.length === matches.length
    && observedTimes.every((value): value is number => value !== undefined && Number.isFinite(value))
    && callTimes.every((value): value is number => value !== undefined && Number.isFinite(value))
    && matches.every(item => item.trustedTime)
    && new Set(observedTimes).size === observedTimes.length
    && new Set(callTimes).size === callTimes.length;
  if (!canOrder) {
    await Promise.all(group.map(item => setAnchor(item.id, 'ambiguous', {
      candidateCount: matches.length,
      message: '命中数量、时间完整性或可信时间条件不足，未推定具体位置',
    })));
    return;
  }
  const orderedEvents = [...group].sort((left, right) => left.observedAt!.getTime() - right.observedAt!.getTime());
  const orderedCalls = [...matches].sort((left, right) => left.startedAt! - right.startedAt!);
  await Promise.all(orderedEvents.map((item, index) => {
    const match = orderedCalls[index];
    return setAnchor(item.id, 'time_ordered', {
      candidateCount: matches.length,
      orderIndex: index + 1,
      matchedRecord: match.recordId
        ? { recordType: match.recordType, recordId: match.recordId }
        : undefined,
      message: `同组 ${matches.length} 次调用与关系事件按可信时间顺序推定，后续数据到达后会重算`,
    });
  }));
}

export async function resolveCollaborationEventByDbId(eventDbId: string): Promise<void> {
  const event = await prismaRaw.collaborationEvent.findUnique({
    where: { id: eventDbId },
    include: { collaboration: { select: { user: true } } },
  });
  if (!event) return;
  await Promise.all([
    resolveReportedEndpoint(event, 'from'),
    resolveReportedEndpoint(event, 'to'),
  ]);
  await resolveReportedAnchor(event);
}

export async function resolveCollaboration(
  user: string,
  collaborationId: string,
): Promise<void> {
  const collaboration = await prismaRaw.collaboration.findUnique({
    where: { user_collaborationId: { user, collaborationId } },
    select: { events: { select: { id: true } } },
  });
  if (!collaboration) return;
  for (const event of collaboration.events) await resolveCollaborationEventByDbId(event.id);
}

export async function resolveCollaborationEndpointsForExecution(
  user: string,
  sessionIds: string[],
): Promise<void> {
  const ids = [...new Set(sessionIds.filter(Boolean))];
  if (!ids.length) return;
  const events = await prismaRaw.collaborationEvent.findMany({
    where: {
      sourceType: 'reported',
      collaboration: { user },
      OR: [{ fromSessionId: { in: ids } }, { toSessionId: { in: ids } }],
    },
    select: { id: true },
  });
  for (const event of events) await resolveCollaborationEventByDbId(event.id);
}

export async function collaborationEventResolution(eventDbId: string) {
  const rows = await prismaRaw.collaborationEndpointResolution.findMany({
    where: { eventDbId },
    select: {
      side: true,
      linkState: true,
      executionId: true,
      linkMethod: true,
      evidenceJson: true,
      anchorState: true,
      anchorJson: true,
    },
  });
  const endpoint = (side: CollaborationEndpointSide) => {
    const row = rows.find(item => item.side === side);
    return {
      status: row?.linkState === 'linked' ? 'resolved'
        : row?.linkState === 'ambiguous' ? 'ambiguous'
          : 'unresolved',
      executionId: row?.executionId || undefined,
      method: row?.linkMethod || undefined,
    };
  };
  const fromEndpoint = endpoint('from');
  const toEndpoint = endpoint('to');
  const from = rows.find(item => item.side === 'from');
  let fromAnchor: Record<string, unknown> = {
    status: from?.anchorState || 'pending',
    message: '定位尚未完成',
  };
  if (from?.anchorJson) {
    try { fromAnchor = { status: from.anchorState || 'pending', ...JSON.parse(from.anchorJson) }; } catch {}
  }
  return {
    traceResolution: { from: fromEndpoint.status, to: toEndpoint.status },
    endpointResolutions: { from: fromEndpoint, to: toEndpoint },
    fromAnchor,
  };
}

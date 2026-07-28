import { guardAttribution } from '@/lib/ingest/claude-otel/attribution-guard';
import { readNewLinesSince, type SpoolCursor } from '@/lib/ingest/claude-otel/spool';
import { saveExecutionRecord, type ExecutionRecord } from '@/lib/storage/data-service';
import {
  getFileCursor,
  saveFileCursor,
  seedToEof,
  toCheckpointRelPath,
} from './checkpoint';
import { compactProcessedSpoolFiles } from './retention';
import { listSources, type SpoolSource } from './sources';
import { scheduleResultEvaluation as scheduleQualityResultEvaluation } from '@/lib/engine/evaluation/result-quality-evaluator';

type TimerHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;
type SaveExecution = (data: ExecutionRecord) => Promise<{ success: boolean; record: ExecutionRecord }>;
type ScheduleResultEvaluation = (executionId: string, user?: string | null) => Promise<unknown>;

type PendingFile = {
  source: SpoolSource;
  spoolDir: string;
  relPath: string;
  nextCursor: SpoolCursor;
  sessions: Set<string>;
  done: Set<string>;
};

type SessionState = {
  sessionId: string;
  pendingFileKeys: Set<string>;
  sourceIds: Set<string>;
  failures: number;
  parked: boolean;
  shortTimer?: TimerHandle;
  longTimer?: TimerHandle;
  maxTimer?: TimerHandle;
  /** 上一轮聚合结束时刻/耗时——聚合冷却的依据(见 aggregateCooldownRemaining) */
  lastAggregateEndedAt?: number;
  lastAggregateCostMs?: number;
};

export type OtelSpoolConsumerState = {
  interval?: IntervalHandle;
  ticking: boolean;
  sources: SpoolSource[];
  sourcesById: Map<string, SpoolSource>;
  pendingFiles: Map<string, PendingFile>;
  sessions: Map<string, SessionState>;
  saveExecution: SaveExecution;
  scheduleResultEvaluation: ScheduleResultEvaluation;
  shortMs: number;
  longMs: number;
  maxWaitMs: number;
  tickMs: number;
  parkAfter: number;
  retentionDays: number;
  seedOnStart: boolean;
  aggCooldownFactor: number;
  aggCooldownCapMs: number;
  aggGlobalFactor: number;
  /** 全局(跨 session)最近一轮聚合的结束时刻/耗时——多会话并发时的总量闸 */
  lastGlobalAggEndedAt?: number;
  lastGlobalAggCostMs?: number;
  /** 有聚合正在进行(含 await 写库)。并发到期的其他会话顺延重试,聚合全局串行。 */
  aggInFlight: boolean;
  log: (...args: any[]) => void;
  warn: (...args: any[]) => void;
};

export type OtelSpoolConsumerOptions = {
  sources?: SpoolSource[];
  saveExecution?: SaveExecution;
  scheduleResultEvaluation?: ScheduleResultEvaluation;
  shortMs?: number;
  longMs?: number;
  maxWaitMs?: number;
  tickMs?: number;
  parkAfter?: number;
  retentionDays?: number;
  seedOnStart?: boolean;
  aggCooldownFactor?: number;
  aggCooldownCapMs?: number;
  aggGlobalFactor?: number;
  log?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
};

declare global {
  // eslint-disable-next-line no-var
  var __otelSpoolConsumer: OtelSpoolConsumerState | undefined;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function createState(options: OtelSpoolConsumerOptions = {}): OtelSpoolConsumerState {
  const sources = options.sources || listSources();
  return {
    ticking: false,
    sources,
    sourcesById: new Map(sources.map((source) => [source.id, source])),
    pendingFiles: new Map(),
    sessions: new Map(),
    saveExecution: wrapSaveExecutionWithAttributionGuard(options.saveExecution || saveExecutionRecord, options.log || console.log),
    scheduleResultEvaluation: options.scheduleResultEvaluation || scheduleQualityResultEvaluation,
    shortMs: options.shortMs ?? envNumber('AGENT_INSIGHT_OTEL_CONSUMER_SHORT_MS', 3000),
    longMs: options.longMs ?? envNumber('AGENT_INSIGHT_OTEL_CONSUMER_LONG_MS', 30000),
    maxWaitMs: options.maxWaitMs ?? envNumber('AGENT_INSIGHT_OTEL_CONSUMER_MAX_WAIT_MS', 120000),
    tickMs: options.tickMs ?? envNumber('AGENT_INSIGHT_OTEL_CONSUMER_TICK_MS', 1000),
    parkAfter: options.parkAfter ?? envNumber('AGENT_INSIGHT_OTEL_CONSUMER_PARK_AFTER', 3),
    retentionDays: options.retentionDays ?? envNumber('AGENT_INSIGHT_OTEL_SPOOL_RETENTION_DAYS', 7),
    seedOnStart: options.seedOnStart ?? true,
    // 聚合冷却:下一轮聚合至少要等 上轮耗时×factor(封顶 cap)。上轮聚合花 5s → 至少歇 50s,
    // 把"活跃大 session 每来一批数据就全量重聚合"的 CPU 占比压到 ~1/factor 以内。
    aggCooldownFactor: options.aggCooldownFactor ?? envNumber('AGENT_INSIGHT_OTEL_AGG_COOLDOWN_FACTOR', 10),
    aggCooldownCapMs: options.aggCooldownCapMs ?? envNumber('AGENT_INSIGHT_OTEL_AGG_COOLDOWN_CAP_MS', 300000),
    // 全局闸:任意两轮聚合(跨 session)之间至少歇 上轮耗时×globalFactor。
    // per-session 冷却管单会话独占,这个管"几十个并发会话各自 10% 叠满单核"(线上 22 并发实测)。
    // 总 CPU 占比上限 ≈ 1/(1+globalFactor),默认 3 → ~25%。
    aggGlobalFactor: options.aggGlobalFactor ?? envNumber('AGENT_INSIGHT_OTEL_AGG_GLOBAL_FACTOR', 3),
    aggInFlight: false,
    log: options.log || console.log,
    warn: options.warn || console.warn,
  };
}

/**
 * 在 saveExecution 外层包裹归属防线。
 * 对所有 OTLP 框架生效，不修改端点鉴权语义。
 * 若 user 无法解析到真实用户，直接丢弃（不落库）+ 结构化日志。
 */
function wrapSaveExecutionWithAttributionGuard(
  inner: SaveExecution,
  log: (...args: any[]) => void,
): SaveExecution {
  return async (data) => {
    const result = guardAttribution({
      user: data.user,
      taskId: data.task_id,
      framework: data.framework,
    });

    if (!result.pass) {
      log('[AttributionGuard] dropping unattributed session', {
        taskId: result.taskId,
        framework: result.framework,
        eventCount: result.eventCount,
        reason: result.reason,
      });
      // 丢弃不可恢复 — 仍返回 success 以避免消费者重试循环
      return { success: true, record: data };
    }

    return inner(data);
  };
}

function getSession(state: OtelSpoolConsumerState, sessionId: string): SessionState {
  let session = state.sessions.get(sessionId);
  if (!session) {
    session = {
      sessionId,
      pendingFileKeys: new Set(),
      sourceIds: new Set(),
      failures: 0,
      parked: false,
    };
    state.sessions.set(sessionId, session);
  }
  return session;
}

function clearSessionTimers(session: SessionState): void {
  if (session.shortTimer) clearTimeout(session.shortTimer);
  if (session.longTimer) clearTimeout(session.longTimer);
  if (session.maxTimer) clearTimeout(session.maxTimer);
  session.shortTimer = undefined;
  session.longTimer = undefined;
  session.maxTimer = undefined;
}

function scheduleSession(state: OtelSpoolConsumerState, sessionId: string, source: SpoolSource, fileKey: string, resetTimers: boolean): void {
  const session = getSession(state, sessionId);
  session.pendingFileKeys.add(fileKey);
  session.sourceIds.add(source.id);
  if (session.parked || !resetTimers) return;

  if (session.shortTimer) clearTimeout(session.shortTimer);
  session.shortTimer = setTimeout(() => {
    session.shortTimer = undefined;
    void saveFast(state, sessionId);
  }, state.shortMs);

  if (session.longTimer) clearTimeout(session.longTimer);
  session.longTimer = setTimeout(() => {
    session.longTimer = undefined;
    if (session.maxTimer) {
      clearTimeout(session.maxTimer);
      session.maxTimer = undefined;
    }
    void saveEvaluated(state, sessionId);
  }, state.longMs);

  if (!session.maxTimer) {
    session.maxTimer = setTimeout(() => {
      session.maxTimer = undefined;
      if (session.longTimer) {
        clearTimeout(session.longTimer);
        session.longTimer = undefined;
      }
      void saveEvaluated(state, sessionId);
    }, state.maxWaitMs);
  }
}

function markSourceDone(state: OtelSpoolConsumerState, sessionId: string, sourceId: string): void {
  const session = state.sessions.get(sessionId);
  if (!session) return;

  for (const fileKey of Array.from(session.pendingFileKeys)) {
    const pending = state.pendingFiles.get(fileKey);
    if (!pending || pending.source.id !== sourceId) continue;
    pending.done.add(sessionId);
    if ([...pending.sessions].every((sid) => pending.done.has(sid))) {
      saveFileCursor(pending.spoolDir, pending.relPath, pending.nextCursor);
      state.pendingFiles.delete(fileKey);
      for (const sid of pending.sessions) {
        const other = state.sessions.get(sid);
        other?.pendingFileKeys.delete(fileKey);
      }
    }
  }
}

function handleSessionFailure(state: OtelSpoolConsumerState, sessionId: string, err: unknown): void {
  const session = getSession(state, sessionId);
  session.failures += 1;
  state.warn('[OTelConsumer] session processing failed', {
    sessionId,
    failures: session.failures,
    message: (err as Error)?.message || String(err),
  });
  if (session.failures >= state.parkAfter) {
    session.parked = true;
    clearSessionTimers(session);
    state.warn('[OTelConsumer] parked poisoned session', { sessionId, failures: session.failures });
  }
}

/** 距离允许下一轮聚合还要等多久 = max(本会话冷却, 全局冷却)。冷却 = min(cap, 上轮耗时 × factor)。 */
function aggregateCooldownRemaining(state: OtelSpoolConsumerState, session: SessionState): number {
  const now = Date.now();
  let wait = 0;
  if (session.lastAggregateEndedAt && session.lastAggregateCostMs) {
    const cooldown = Math.min(state.aggCooldownCapMs, session.lastAggregateCostMs * state.aggCooldownFactor);
    wait = Math.max(wait, session.lastAggregateEndedAt + cooldown - now);
  }
  if (state.lastGlobalAggEndedAt && state.lastGlobalAggCostMs) {
    const globalCooldown = Math.min(state.aggCooldownCapMs, state.lastGlobalAggCostMs * state.aggGlobalFactor);
    wait = Math.max(wait, state.lastGlobalAggEndedAt + globalCooldown - now);
  }
  return Math.max(0, wait);
}

/** 记录一轮聚合的耗时(会话级 + 全局);聚合明显偏慢时打 warn,给未来的排查留证据。 */
function finishAggregateRound(state: OtelSpoolConsumerState, session: SessionState, startedAt: number): void {
  session.lastAggregateEndedAt = Date.now();
  session.lastAggregateCostMs = session.lastAggregateEndedAt - startedAt;
  state.lastGlobalAggEndedAt = session.lastAggregateEndedAt;
  state.lastGlobalAggCostMs = session.lastAggregateCostMs;
  if (session.lastAggregateCostMs > 1000) {
    state.warn('[OTelConsumer] slow aggregate', {
      sessionId: session.sessionId,
      costMs: session.lastAggregateCostMs,
      nextAllowedInMs: Math.min(state.aggCooldownCapMs, session.lastAggregateCostMs * state.aggCooldownFactor),
    });
  }
}

async function saveFast(state: OtelSpoolConsumerState, sessionId: string): Promise<void> {
  const session = state.sessions.get(sessionId);
  if (!session || session.parked) return;

  // 冷却未过 / 有别的聚合在途:不立刻聚合,顺延重试(timer 槽空着才排,避免叠加)。
  const cooldownMs = aggregateCooldownRemaining(state, session);
  const deferMs = state.aggInFlight ? Math.max(cooldownMs, 50) : cooldownMs;
  if (deferMs > 0) {
    if (!session.shortTimer) {
      session.shortTimer = setTimeout(() => {
        session.shortTimer = undefined;
        void saveFast(state, sessionId);
      }, deferMs);
    }
    return;
  }

  const startedAt = Date.now();
  state.aggInFlight = true;
  try {
    for (const sourceId of Array.from(session.sourceIds)) {
      const source = state.sourcesById.get(sourceId);
      if (!source) continue;
      try {
        const result = source.aggregate(sessionId);
        if (result.record) {
          await state.saveExecution({
            ...result.record,
            skip_evaluation: source.defaultSkipEvaluation(),
          });
        }
        session.failures = 0;
        markSourceDone(state, sessionId, sourceId);
      } catch (err) {
        handleSessionFailure(state, sessionId, err);
      }
    }
  } finally {
    state.aggInFlight = false;
    finishAggregateRound(state, session, startedAt);
  }
}

async function saveEvaluated(state: OtelSpoolConsumerState, sessionId: string): Promise<void> {
  const session = state.sessions.get(sessionId);
  if (!session || session.parked) return;

  const cooldownMs = aggregateCooldownRemaining(state, session);
  const deferMs = state.aggInFlight ? Math.max(cooldownMs, 50) : cooldownMs;
  if (deferMs > 0) {
    if (!session.longTimer) {
      session.longTimer = setTimeout(() => {
        session.longTimer = undefined;
        void saveEvaluated(state, sessionId);
      }, deferMs);
    }
    return;
  }

  const startedAt = Date.now();
  state.aggInFlight = true;
  try {
    for (const sourceId of Array.from(session.sourceIds)) {
      const source = state.sourcesById.get(sourceId);
      if (!source) continue;
      try {
        const result = source.aggregate(sessionId);
        if (!result.record) continue;
        const saved = await state.saveExecution({
          ...result.record,
          skip_evaluation: false,
          skip_internal_judgment: true,
          force_judgment: true,
        });
        const executionId = saved.record.upload_id || saved.record.task_id;
        if (executionId && result.record.trace_completed_at && result.record.final_result) {
          await state.scheduleResultEvaluation(executionId, result.record.user);
        }
        session.failures = 0;
      } catch (err) {
        handleSessionFailure(state, sessionId, err);
      }
    }
  } finally {
    state.aggInFlight = false;
    finishAggregateRound(state, session, startedAt);
  }
}

export async function runOtelSpoolConsumerTick(state: OtelSpoolConsumerState): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  let discovered = 0;
  let parseErrors = 0;

  try {
    for (const source of state.sources) {
      const spoolDir = source.spoolDir();
      const files = source.listFiles();
      for (const file of files) {
        const relPath = toCheckpointRelPath(spoolDir, file);
        const fileKey = `${source.id}:${relPath}`;
        const inflight = state.pendingFiles.get(fileKey);
        // 活跃文件优先用内存读位增量读。磁盘 cursor 只在聚合完成后推进,若每 tick 都
        // 从磁盘位重读,聚合冷却期间会反复 parse 整段未落盘 backlog(大会话 = 每秒
        // 重复 parse 几十 MB,CPU 直接烧满——线上踩过)。崩溃重启后从磁盘位重放一次,语义不变。
        const cursor = inflight ? inflight.nextCursor : getFileCursor(spoolDir, relPath);
        const read = readNewLinesSince<any>(file, cursor);
        parseErrors += read.parseErrors;
        if (read.lineCount === 0) continue;

        const sessionIds = new Set(
          read.events
            .map((event) => event?.sessionId)
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
        );

        if (sessionIds.size === 0) {
          if (inflight) {
            // 在途文件的新增量不含 session:只推进内存读位;磁盘 cursor 必须等
            // 聚合完成后统一推进,否则会越过尚未聚合的数据。
            inflight.nextCursor = read.nextCursor;
          } else {
            saveFileCursor(spoolDir, relPath, read.nextCursor);
          }
          continue;
        }

        let pending = inflight;
        let resetTimers = false;
        if (!pending) {
          pending = {
            source,
            spoolDir,
            relPath,
            nextCursor: read.nextCursor,
            sessions: new Set(),
            done: new Set(),
          };
          state.pendingFiles.set(fileKey, pending);
          resetTimers = true;
        } else if (read.nextCursor.bytes !== pending.nextCursor.bytes) {
          pending.nextCursor = read.nextCursor;
          resetTimers = true;
        }

        for (const sessionId of sessionIds) {
          if (!pending.sessions.has(sessionId)) {
            pending.sessions.add(sessionId);
            resetTimers = true;
          }
          discovered += 1;
          scheduleSession(state, sessionId, source, fileKey, resetTimers);
        }
      }
      try {
        const retention = compactProcessedSpoolFiles(spoolDir, files, state.retentionDays);
        if (retention.archived > 0) {
          state.log('[OTelConsumer] retention archived processed spool files', {
            source: source.id,
            archived: retention.archived,
          });
        }
      } catch (err) {
        state.warn('[OTelConsumer] retention failed', {
          source: source.id,
          message: (err as Error)?.message || String(err),
        });
      }
    }
  } finally {
    state.ticking = false;
  }

  const parked = [...state.sessions.values()].filter((session) => session.parked).length;
  const failed = [...state.sessions.values()].filter((session) => session.failures > 0).length;
  if (discovered || state.pendingFiles.size || parked || failed || parseErrors) {
    state.log('[OTelConsumer] tick', {
      discovered,
      backlog: state.pendingFiles.size,
      parked,
      failed,
      parseErrors,
    });
  }
}

export function startOtelSpoolConsumer(options: OtelSpoolConsumerOptions = {}): void {
  stopOtelSpoolConsumer();
  const state = createState(options);

  if (state.seedOnStart) {
    for (const source of state.sources) {
      try {
        seedToEof(source.spoolDir(), source.listFiles());
      } catch (err) {
        state.warn('[OTelConsumer] checkpoint seed failed', {
          source: source.id,
          message: (err as Error)?.message || String(err),
        });
      }
    }
  }

  state.interval = setInterval(() => {
    void runOtelSpoolConsumerTick(state);
  }, state.tickMs);
  globalThis.__otelSpoolConsumer = state;
  void runOtelSpoolConsumerTick(state);
  state.log('[OTelConsumer] started', { sources: state.sources.map((source) => source.id) });
}

export function stopOtelSpoolConsumer(): void {
  const state = globalThis.__otelSpoolConsumer;
  if (!state) return;
  if (state.interval) clearInterval(state.interval);
  for (const session of state.sessions.values()) clearSessionTimers(session);
  globalThis.__otelSpoolConsumer = undefined;
}

export function getOtelSpoolConsumerForTest(): OtelSpoolConsumerState | undefined {
  return globalThis.__otelSpoolConsumer;
}

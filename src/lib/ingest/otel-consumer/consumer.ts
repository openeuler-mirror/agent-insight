import path from 'node:path';
import { guardAttribution } from '@/lib/ingest/claude-otel/attribution-guard';
import { currentSpoolDay, readNewLinesSince, type SpoolCursor } from '@/lib/ingest/claude-otel/spool';
import { saveExecutionRecord, type ExecutionRecord } from '@/lib/storage/data-service';
import {
  getFileCursor,
  saveFileCursor,
  seedToEof,
  toCheckpointRelPath,
} from './checkpoint';
import { compactProcessedSpoolFiles } from './retention';
import { listSources, type SpoolAggregationResult, type SpoolSource } from './sources';
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

type AggregateSnapshot = {
  sourceId: string;
  signature: string;
  result: SpoolAggregationResult;
};

type SessionState = {
  sessionId: string;
  pendingFileKeys: Set<string>;
  sourceIds: Set<string>;
  failures: number;
  parked: boolean;
  /** 到点时刻。取代原来的三个 per-session timer——调度统一由中央 dispatcher 决定。 */
  fastDueAt?: number;
  evaluatedDueAt?: number;
  maxDueAt?: number;
  /** 最近一次收到新数据的时刻,用于 live/recovery 公平调度。 */
  lastDataAt: number;
  /** 上一轮聚合结束时刻/耗时——本会话冷却的依据(见 sessionCooldownRemaining) */
  lastAggregateEndedAt?: number;
  lastAggregateCostMs?: number;
  /** fast 阶段的聚合快照:evaluated 阶段若数据没变就直接复用,不重复聚合。 */
  lastAggregate?: AggregateSnapshot;
};

type FileListCache = {
  files: string[];
  fullScanAt: number;
};

export type OtelSpoolConsumerState = {
  interval?: IntervalHandle;
  ticking: boolean;
  sources: SpoolSource[];
  sourcesById: Map<string, SpoolSource>;
  pendingFiles: Map<string, PendingFile>;
  sessions: Map<string, SessionState>;
  fileLists: Map<string, FileListCache>;
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
  /** 全局冷却的绝对上限。没有它,一次慢聚合会按倍数把整条流水线冻住(2026-07-28 事故)。 */
  aggGlobalMaxWaitMs: number;
  /** backlog 到这个量级就进排空模式:此时的聚合是必要工作而非重复劳动,再限流只会加剧积压。 */
  drainBacklog: number;
  draining: boolean;
  liveWindowMs: number;
  liveQuota: number;
  historyScanMs: number;
  maxTrackedSessions: number;
  stallMs: number;
  /** 全局(跨 session)最近一轮聚合的结束时刻/耗时——多会话并发时的总量闸 */
  lastGlobalAggEndedAt?: number;
  lastGlobalAggCostMs?: number;
  /** 中央调度:同一时刻只允许一轮聚合(含 await 写库),SQLite 保持单写。 */
  dispatching: boolean;
  dispatchTimer?: TimerHandle;
  activeSessionId?: string;
  activeStartedAt?: number;
  lastStallWarnAt?: number;
  liveServed: number;
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
  aggGlobalMaxWaitMs?: number;
  drainBacklog?: number;
  liveWindowMs?: number;
  liveQuota?: number;
  historyScanMs?: number;
  maxTrackedSessions?: number;
  stallMs?: number;
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
    fileLists: new Map(),
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
    aggCooldownCapMs: options.aggCooldownCapMs ?? envNumber('AGENT_INSIGHT_OTEL_AGG_COOLDOWN_CAP_MS', 60000),
    // 全局闸:任意两轮聚合(跨 session)之间至少歇 上轮耗时×globalFactor。
    // per-session 冷却管单会话独占,这个管"几十个并发会话各自 10% 叠满单核"(线上 22 并发实测)。
    aggGlobalFactor: options.aggGlobalFactor ?? envNumber('AGENT_INSIGHT_OTEL_AGG_GLOBAL_FACTOR', 3),
    // 但倍数必须封顶:2026-07-28 线上单轮 51s × 3 = 全局冻结 153s,吞吐塌到 0.3 条/分钟。
    // 有了绝对上限,无论单轮多慢,全局吞吐都不会低于 1/(cost+cap)。
    aggGlobalMaxWaitMs: options.aggGlobalMaxWaitMs ?? envNumber('AGENT_INSIGHT_OTEL_AGG_GLOBAL_MAX_WAIT_MS', 2000),
    drainBacklog: options.drainBacklog ?? envNumber('AGENT_INSIGHT_OTEL_AGG_DRAIN_BACKLOG', 200),
    draining: false,
    liveWindowMs: options.liveWindowMs ?? envNumber('AGENT_INSIGHT_OTEL_CONSUMER_LIVE_WINDOW_MS', 60000),
    liveQuota: options.liveQuota ?? envNumber('AGENT_INSIGHT_OTEL_CONSUMER_LIVE_QUOTA', 3),
    historyScanMs: options.historyScanMs ?? envNumber('AGENT_INSIGHT_OTEL_CONSUMER_HISTORY_SCAN_MS', 60000),
    maxTrackedSessions: options.maxTrackedSessions ?? envNumber('AGENT_INSIGHT_OTEL_CONSUMER_MAX_SESSIONS', 20000),
    stallMs: options.stallMs ?? envNumber('AGENT_INSIGHT_OTEL_CONSUMER_STALL_MS', 15000),
    dispatching: false,
    liveServed: 0,
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
    // Qoder uploads carry server-stamped credential provenance. In a
    // single-user installation the valid API key commonly belongs to `admin`,
    // which the generic guard otherwise treats as an internal service owner.
    // Keep this exception framework-scoped so every existing collector retains
    // the original attribution policy.
    const authenticatedQoderIngest =
      data.framework === 'qoder' && data.authenticated_ingest === true;
    const result = guardAttribution({
      user: data.user,
      taskId: data.task_id,
      framework: data.framework,
    });

    if (!result.pass && !authenticatedQoderIngest) {
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
      lastDataAt: Date.now(),
    };
    state.sessions.set(sessionId, session);
  }
  return session;
}

/**
 * 会话彻底闲下来(没有待处理文件、没有到点任务)就从表里摘掉。
 * 原实现只增不删,长跑进程里 sessions 无界增长;现在还要缓存聚合快照,更不能留着。
 */
function evictIdleSession(state: OtelSpoolConsumerState, session: SessionState): void {
  if (session.pendingFileKeys.size > 0) return;
  if (session.fastDueAt !== undefined || session.evaluatedDueAt !== undefined || session.maxDueAt !== undefined) return;
  if (session.parked) return;
  session.lastAggregate = undefined;
  state.sessions.delete(session.sessionId);
}

function scheduleSession(state: OtelSpoolConsumerState, sessionId: string, source: SpoolSource, fileKey: string, resetTimers: boolean): void {
  const session = getSession(state, sessionId);
  session.pendingFileKeys.add(fileKey);
  session.sourceIds.add(source.id);
  if (session.parked || !resetTimers) return;

  const now = Date.now();
  session.lastDataAt = now;
  session.fastDueAt = now + state.shortMs;
  session.evaluatedDueAt = now + state.longMs;
  if (session.maxDueAt === undefined) session.maxDueAt = now + state.maxWaitMs;
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
        if (!other) continue;
        other.pendingFileKeys.delete(fileKey);
        // 一个文件里有几百个会话时(旧格式整日平铺文件就是这样),文件完成的那一刻这些会话
        // 才真正闲下来。只回收"当前这个"会有几百个会话对象永久留在内存里(实测 legacy 文件
        // 处理完后 sessions 长期停在 420 不降)。
        evictIdleSession(state, other);
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
    session.fastDueAt = undefined;
    session.evaluatedDueAt = undefined;
    session.maxDueAt = undefined;
    state.warn('[OTelConsumer] parked poisoned session', { sessionId, failures: session.failures });
  }
}

/** 本会话距离允许下一轮聚合还要等多久 = min(cap, 上轮耗时 × factor)。 */
function sessionCooldownRemaining(state: OtelSpoolConsumerState, session: SessionState, now: number): number {
  if (!session.lastAggregateEndedAt || !session.lastAggregateCostMs) return 0;
  const cooldown = Math.min(state.aggCooldownCapMs, session.lastAggregateCostMs * state.aggCooldownFactor);
  return Math.max(0, session.lastAggregateEndedAt + cooldown - now);
}

/**
 * 全局闸距离放行还要多久。
 *
 * 与旧实现的区别有两点,都是 2026-07-28 事故的直接教训:
 *   1) 倍数封顶到 aggGlobalMaxWaitMs —— 慢聚合不再能把整条流水线按比例冻住;
 *   2) backlog 越过阈值进排空模式 —— 此时单飞已经把 CPU 锁在 1 核以内,再节流只会让积压更久。
 */
function globalGateRemaining(state: OtelSpoolConsumerState, now: number): number {
  const backlog = state.pendingFiles.size;
  if (state.draining) {
    if (backlog < state.drainBacklog / 2) state.draining = false;
  } else if (backlog >= state.drainBacklog) {
    state.draining = true;
  }
  if (state.draining) return 0;

  if (!state.lastGlobalAggEndedAt || !state.lastGlobalAggCostMs) return 0;
  const cooldown = Math.min(state.aggGlobalMaxWaitMs, state.lastGlobalAggCostMs * state.aggGlobalFactor);
  return Math.max(0, state.lastGlobalAggEndedAt + cooldown - now);
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
      backlog: state.pendingFiles.size,
      draining: state.draining,
    });
  }
}

type Job = { session: SessionState; mode: 'fast' | 'evaluated' };

function evaluatedDueAt(session: SessionState): number | undefined {
  if (session.evaluatedDueAt === undefined) return session.maxDueAt;
  if (session.maxDueAt === undefined) return session.evaluatedDueAt;
  return Math.min(session.evaluatedDueAt, session.maxDueAt);
}

/**
 * 选下一个要处理的任务。live(最近还在上报) 与 recovery(历史积压) 按 liveQuota:1 轮转,
 * 保证 backlog 有上千条时新来的 trace 也能很快入库,而不是排在队尾。
 */
function pickJob(state: OtelSpoolConsumerState, now: number): { job: Job | null; nextWakeAt: number } {
  let nextWakeAt = Number.POSITIVE_INFINITY;
  let live: Job | null = null;
  let liveDueAt = Number.POSITIVE_INFINITY;
  let recovery: Job | null = null;
  let recoveryDueAt = Number.POSITIVE_INFINITY;

  for (const session of state.sessions.values()) {
    if (session.parked) continue;

    const fastAt = session.fastDueAt;
    const evalAt = evaluatedDueAt(session);
    let dueAt: number | undefined;
    let mode: 'fast' | 'evaluated' = 'fast';
    // evaluated 到点优先:它是这个会话的终态处理,fast 只是提前让用户看到。
    if (evalAt !== undefined && evalAt <= now) {
      dueAt = evalAt;
      mode = 'evaluated';
    } else if (fastAt !== undefined && fastAt <= now) {
      dueAt = fastAt;
      mode = 'fast';
    } else {
      const soonest = Math.min(fastAt ?? Number.POSITIVE_INFINITY, evalAt ?? Number.POSITIVE_INFINITY);
      if (soonest < nextWakeAt) nextWakeAt = soonest;
      continue;
    }

    const cooldown = sessionCooldownRemaining(state, session, now);
    if (cooldown > 0) {
      if (now + cooldown < nextWakeAt) nextWakeAt = now + cooldown;
      continue;
    }

    const candidate: Job = { session, mode };
    if (now - session.lastDataAt <= state.liveWindowMs) {
      if (dueAt < liveDueAt) { live = candidate; liveDueAt = dueAt; }
    } else if (dueAt < recoveryDueAt) {
      recovery = candidate;
      recoveryDueAt = dueAt;
    }
  }

  let job: Job | null = null;
  if (live && recovery) {
    if (state.liveServed >= state.liveQuota) {
      job = recovery;
      state.liveServed = 0;
    } else {
      job = live;
      state.liveServed += 1;
    }
  } else {
    job = live || recovery;
    if (job && live) state.liveServed += 1;
  }

  return { job, nextWakeAt };
}

function armDispatch(state: OtelSpoolConsumerState, delayMs: number): void {
  if (state.dispatchTimer) clearTimeout(state.dispatchTimer);
  state.dispatchTimer = setTimeout(() => {
    state.dispatchTimer = undefined;
    void pumpDispatch(state);
  }, Math.max(1, Math.min(delayMs, state.tickMs)));
}

/**
 * 中央调度泵:全局只有这一个入口驱动聚合。
 *
 * 旧实现是每个 session 各自持有 timer,聚合在途时全体按 50ms 重排——backlog 上千时
 * 就是每 50ms 上千次无效唤醒,且先到先得没有公平性。现在唤醒次数是 O(1)/次调度。
 */
async function pumpDispatch(state: OtelSpoolConsumerState): Promise<void> {
  if (state.dispatching) return;

  const now = Date.now();
  const gate = globalGateRemaining(state, now);
  if (gate > 0) {
    armDispatch(state, gate);
    return;
  }

  const { job, nextWakeAt } = pickJob(state, now);
  if (!job) {
    if (Number.isFinite(nextWakeAt)) armDispatch(state, Math.max(1, nextWakeAt - now));
    return;
  }

  state.dispatching = true;
  state.activeSessionId = job.session.sessionId;
  state.activeStartedAt = now;
  const startedAt = now;
  const { session, mode } = job;

  if (mode === 'evaluated') {
    session.evaluatedDueAt = undefined;
    session.maxDueAt = undefined;
    session.fastDueAt = undefined;
  } else {
    session.fastDueAt = undefined;
  }

  try {
    await runJob(state, session, mode);
  } catch (err) {
    handleSessionFailure(state, session.sessionId, err);
  } finally {
    finishAggregateRound(state, session, startedAt);
    state.dispatching = false;
    state.activeSessionId = undefined;
    state.activeStartedAt = undefined;
    evictIdleSession(state, session);
    armDispatch(state, 1);
  }
}

/** 取聚合结果:数据指纹没变就复用 fast 阶段的快照,避免同一份数据聚合两次。 */
function aggregateForSession(
  state: OtelSpoolConsumerState,
  session: SessionState,
  source: SpoolSource,
): SpoolAggregationResult {
  const signature = source.statSession?.(session.sessionId);
  if (signature !== undefined && session.lastAggregate
    && session.lastAggregate.sourceId === source.id
    && session.lastAggregate.signature === signature) {
    return session.lastAggregate.result;
  }
  const result = source.aggregate(session.sessionId);
  if (signature !== undefined) {
    session.lastAggregate = { sourceId: source.id, signature, result };
  }
  return result;
}

async function runJob(state: OtelSpoolConsumerState, session: SessionState, mode: 'fast' | 'evaluated'): Promise<void> {
  for (const sourceId of Array.from(session.sourceIds)) {
    const source = state.sourcesById.get(sourceId);
    if (!source) continue;
    try {
      const result = aggregateForSession(state, session, source);
      if (!result.record) {
        markSourceDone(state, session.sessionId, sourceId);
        continue;
      }

      if (mode === 'fast') {
        await state.saveExecution({
          ...result.record,
          skip_evaluation: source.defaultSkipEvaluation(),
        });
        session.failures = 0;
        markSourceDone(state, session.sessionId, sourceId);
      } else {
        const saved = await state.saveExecution({
          ...result.record,
          skip_evaluation: false,
          skip_internal_judgment: true,
          force_judgment: true,
        });
        session.failures = 0;
        // 存量积压场景下 fast 和 evaluated 会同时到点，dispatcher 直接跑 evaluated 跳过 fast，
        // 所以这里必须也推进文件归属簿记 —— 否则 pendingFiles 永远不减、checkpoint 游标永不推进，
        // 那些 spool 文件每次重启都要重读，retention 也永远归档不掉（实测 backlog 卡在 520 不动）。
        markSourceDone(state, session.sessionId, sourceId);
        session.lastAggregate = undefined;

        const executionId = saved.record.upload_id || saved.record.task_id;
        if (executionId && result.record.trace_completed_at && result.record.final_result) {
          await state.scheduleResultEvaluation(executionId, result.record.user);
        }
      }
    } catch (err) {
      handleSessionFailure(state, session.sessionId, err);
    }
  }
}

/**
 * 分层列文件:当天目录每 tick 扫,历史目录每 historyScanMs 扫一次。
 * 线上有几千个会话分片时,每秒全量递归遍历本身就是常态 CPU 开销。
 */
function sourceFiles(state: OtelSpoolConsumerState, source: SpoolSource): string[] {
  const now = Date.now();
  const cached = state.fileLists.get(source.id);
  if (!cached || now - cached.fullScanAt >= state.historyScanMs || !source.listFilesForDay) {
    const files = source.listFiles();
    state.fileLists.set(source.id, { files, fullScanAt: now });
    return files;
  }

  const day = currentSpoolDay();
  const dayPrefix = path.join(source.spoolDir(), day) + path.sep;
  const historical = cached.files.filter((file) => !file.startsWith(dayPrefix));
  const files = [...historical, ...source.listFilesForDay(day)].sort();
  state.fileLists.set(source.id, { files, fullScanAt: cached.fullScanAt });
  return files;
}

export async function runOtelSpoolConsumerTick(state: OtelSpoolConsumerState): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  let discovered = 0;
  let parseErrors = 0;

  try {
    for (const source of state.sources) {
      const spoolDir = source.spoolDir();
      const files = sourceFiles(state, source);
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
          state.fileLists.delete(source.id);
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

  void pumpDispatch(state);

  const parked = [...state.sessions.values()].filter((session) => session.parked).length;
  const failed = [...state.sessions.values()].filter((session) => session.failures > 0).length;
  if (discovered || state.pendingFiles.size || parked || failed || parseErrors) {
    state.log('[OTelConsumer] tick', {
      discovered,
      backlog: state.pendingFiles.size,
      sessions: state.sessions.size,
      draining: state.draining,
      parked,
      failed,
      parseErrors,
    });
  }

  // 卡住告警:同一个在途任务每分钟最多一条,不按 tick 刷屏。
  if (state.dispatching && state.activeStartedAt) {
    const age = Date.now() - state.activeStartedAt;
    if (age >= state.stallMs && (!state.lastStallWarnAt || Date.now() - state.lastStallWarnAt >= 60000)) {
      state.lastStallWarnAt = Date.now();
      state.warn('[OTelConsumer] stalled dispatch', {
        sessionId: state.activeSessionId,
        ageMs: age,
        backlog: state.pendingFiles.size,
      });
    }
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
  if (state.dispatchTimer) clearTimeout(state.dispatchTimer);
  globalThis.__otelSpoolConsumer = undefined;
}

export function getOtelSpoolConsumerForTest(): OtelSpoolConsumerState | undefined {
  return globalThis.__otelSpoolConsumer;
}

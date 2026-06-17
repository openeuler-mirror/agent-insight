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

type TimerHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;
type SaveExecution = (data: ExecutionRecord) => Promise<{ success: boolean; record: ExecutionRecord }>;

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
};

export type OtelSpoolConsumerState = {
  interval?: IntervalHandle;
  ticking: boolean;
  sources: SpoolSource[];
  sourcesById: Map<string, SpoolSource>;
  pendingFiles: Map<string, PendingFile>;
  sessions: Map<string, SessionState>;
  saveExecution: SaveExecution;
  shortMs: number;
  longMs: number;
  maxWaitMs: number;
  tickMs: number;
  parkAfter: number;
  retentionDays: number;
  seedOnStart: boolean;
  log: (...args: any[]) => void;
  warn: (...args: any[]) => void;
};

export type OtelSpoolConsumerOptions = {
  sources?: SpoolSource[];
  saveExecution?: SaveExecution;
  shortMs?: number;
  longMs?: number;
  maxWaitMs?: number;
  tickMs?: number;
  parkAfter?: number;
  retentionDays?: number;
  seedOnStart?: boolean;
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
    saveExecution: options.saveExecution || saveExecutionRecord,
    shortMs: options.shortMs ?? envNumber('AGENT_INSIGHT_OTEL_CONSUMER_SHORT_MS', 3000),
    longMs: options.longMs ?? envNumber('AGENT_INSIGHT_OTEL_CONSUMER_LONG_MS', 30000),
    maxWaitMs: options.maxWaitMs ?? envNumber('AGENT_INSIGHT_OTEL_CONSUMER_MAX_WAIT_MS', 120000),
    tickMs: options.tickMs ?? envNumber('AGENT_INSIGHT_OTEL_CONSUMER_TICK_MS', 1000),
    parkAfter: options.parkAfter ?? envNumber('AGENT_INSIGHT_OTEL_CONSUMER_PARK_AFTER', 3),
    retentionDays: options.retentionDays ?? envNumber('AGENT_INSIGHT_OTEL_SPOOL_RETENTION_DAYS', 7),
    seedOnStart: options.seedOnStart ?? true,
    log: options.log || console.log,
    warn: options.warn || console.warn,
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

async function saveFast(state: OtelSpoolConsumerState, sessionId: string): Promise<void> {
  const session = state.sessions.get(sessionId);
  if (!session || session.parked) return;

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
}

async function saveEvaluated(state: OtelSpoolConsumerState, sessionId: string): Promise<void> {
  const session = state.sessions.get(sessionId);
  if (!session || session.parked) return;

  for (const sourceId of Array.from(session.sourceIds)) {
    const source = state.sourcesById.get(sourceId);
    if (!source) continue;
    try {
      const result = source.aggregate(sessionId);
      if (!result.record) continue;
      await state.saveExecution({
        ...result.record,
        skip_evaluation: false,
        force_judgment: true,
      });
      session.failures = 0;
    } catch (err) {
      handleSessionFailure(state, sessionId, err);
    }
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
        const cursor = getFileCursor(spoolDir, relPath);
        const read = readNewLinesSince<any>(file, cursor);
        parseErrors += read.parseErrors;
        if (read.lineCount === 0) continue;

        const sessionIds = new Set(
          read.events
            .map((event) => event?.sessionId)
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
        );

        if (sessionIds.size === 0) {
          saveFileCursor(spoolDir, relPath, read.nextCursor);
          continue;
        }

        const fileKey = `${source.id}:${relPath}`;
        let pending = state.pendingFiles.get(fileKey);
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

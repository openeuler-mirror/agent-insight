import { readCleanupConfig, type CleanupEvent } from './policy';
import { roundRobin, startCleanupScheduler } from './scheduler';

type Sweep = AsyncGenerator<CleanupEvent>;
type Controller = ReturnType<typeof startCleanupScheduler>;
const KEY = Symbol.for('@agent-insight/runtime-cleanup');
const globalState = globalThis as unknown as { [KEY]?: Controller };

function warn(category: string, error: unknown) {
  try {
    console.warn('[runtime-cleanup] category failed', {
      category,
      code: (error as { code?: string })?.code || 'CLEANUP_FAILED',
    });
  } catch { /* Cleanup diagnostics cannot affect application availability. */ }
}

async function* guarded(category: string, create: () => Sweep): Sweep {
  try { yield* create(); }
  catch (error) { warn(category, error); yield { kind: 'skipped', reason: `${category}-failed` }; }
}

export function createCleanupSweep(config: ReturnType<typeof readCleanupConfig>): Sweep {
  const now = Date.now();
  return roundRobin([
    guarded('logs', async function* () {
      const { cleanupLogs } = await import('./logs');
      yield* cleanupLogs({ directory: process.env.AGENT_INSIGHT_LOG_DIR || '/var/log/agent-insight', now, dryRun: config.dryRun,
        retentionDays: config.logRetentionDays, rotateAfterMs: config.logRotateMs,
        maxFileBytes: config.logMaxFileBytes, maxTotalBytes: config.logMaxTotalBytes });
    }),
    guarded('temporary-homes', async function* () {
      const { cleanupTemporaryHomes } = await import('./temp');
      const { resolveAgentInsightDataPath } = await import('@/lib/env');
      yield* cleanupTemporaryHomes({ root: resolveAgentInsightDataPath('.opencode-runtime'), now, dryRun: config.dryRun,
        retentionMs: config.temporaryHomeRetentionMs });
    }),
    guarded('spool', async function* () {
      const { cleanupSpool } = await import('./spool');
      const { listSources } = await import('@/lib/ingest/otel-consumer/sources');
      const { forgetOtelSpoolFile } = await import('@/lib/ingest/otel-consumer/consumer');
      const { getJiuwenSpoolDir } = await import('@/lib/ingest/otel/jiuwen/spool');
      const sources = listSources();
      const sweeps = sources.map(source => guarded(`spool-${source.id}`, async function* () {
        const root = source.spoolDir();
        yield* cleanupSpool({ root, now, normalDays: config.normalDays, abnormalDays: config.abnormalDays, dryRun: config.dryRun,
          onDelete: file => forgetOtelSpoolFile(root, file) });
      }));
      sweeps.push(guarded('spool-jiuwen', async function* () {
        yield* cleanupSpool({ root: getJiuwenSpoolDir(), now, normalDays: config.normalDays, abnormalDays: config.abnormalDays, dryRun: config.dryRun });
      }));
      yield* roundRobin(sweeps);
    }),
  ]);
}

export function startRuntimeCleanup(): Controller | undefined {
  if (globalState[KEY]) return globalState[KEY];
  try {
    const config = readCleanupConfig();
    const fresh = () => ({ scanned: 0, deleted: 0, rotated: 0, skipped: 0, freedBytes: 0, readBytes: 0 });
    let counts = fresh();
    const controller = startCleanupScheduler({
      config,
      createSweep: () => { counts = fresh(); return createCleanupSweep(config); },
      onEvent: event => {
        counts[event.kind]++;
        if (event.kind === 'deleted') counts.freedBytes += event.bytes || 0;
        counts.readBytes += event.scannedBytes || 0;
      },
      onComplete: () => console.info('[runtime-cleanup] sweep complete', { ...counts, dryRun: config.dryRun }),
      onError: error => warn('scheduler', error),
    });
    globalState[KEY] = controller;
    return controller;
  } catch (error) { warn('startup', error); return undefined; }
}

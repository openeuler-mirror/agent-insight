import { mkdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { flushAllSpool } from './uploader.mjs';
import { collectorRoot } from './storage.mjs';

const watch = process.argv.includes('--watch');
const intervalMs = Math.max(1_000, Number(process.env.AGENT_INSIGHT_QWEN_UPLOAD_INTERVAL_MS) || 15_000);
const idleExitMs = Math.max(intervalMs, Number(process.env.AGENT_INSIGHT_QWEN_UPLOADER_IDLE_EXIT_MS) || 300_000);
const storageRoot = collectorRoot();
const watcherLock = join(storageRoot, 'locks', 'watcher.lock');
const uploadFailurePath = join(storageRoot, 'logs', 'last-upload-failures.json');
const watcherStaleMs = idleExitMs + intervalMs;
const watcherHeartbeatMs = Math.min(intervalMs, 30_000);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeFailureMessage(error) {
  return String(error?.message || error || 'Unknown upload failure')
    .replace(/(api[ _-]?key|x-witty-api-key|authorization)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 500);
}

async function recordUploadFailures(results) {
  const failures = results
    .filter((result) => result?.error)
    .map((result) => ({
      sessionId: result.sessionId || null,
      error: safeFailureMessage(result.error),
    }));

  if (!failures.length) {
    await rm(uploadFailurePath, { force: true });
    return;
  }

  await mkdir(dirname(uploadFailurePath), { recursive: true });
  const temporaryPath = `${uploadFailurePath}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ recordedAt: new Date().toISOString(), failures }, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, uploadFailurePath);
}

async function acquireWatcherLock() {
  await mkdir(join(storageRoot, 'locks'), { recursive: true });
  try {
    await mkdir(watcherLock, { recursive: false });
    return true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    try {
      const info = await stat(watcherLock);
      if (Date.now() - info.mtimeMs < watcherStaleMs) return false;
      await rm(watcherLock, { recursive: true, force: true });
      await mkdir(watcherLock, { recursive: false });
      return true;
    } catch (retryError) {
      if (retryError?.code === 'ENOENT' || retryError?.code === 'EEXIST') return false;
      throw retryError;
    }
  }
}

let ownsWatcherLock = false;
let watcherHeartbeat;
let watcherHeartbeatError;
try {
  if (watch) {
    ownsWatcherLock = await acquireWatcherLock();
    if (!ownsWatcherLock) process.exit(0);
    const refreshWatcherLock = async () => {
      const now = new Date();
      await utimes(watcherLock, now, now);
    };
    await refreshWatcherLock();
    watcherHeartbeat = setInterval(() => {
      void refreshWatcherLock().catch((error) => { watcherHeartbeatError ??= error; });
    }, watcherHeartbeatMs);
    watcherHeartbeat.unref?.();
  }

  let lastWorkAt = Date.now();
  do {
    if (watcherHeartbeatError) throw watcherHeartbeatError;
    const results = await flushAllSpool({ attempts: 4, baseDelayMs: 250 });
    await recordUploadFailures(results);
    if (results.some((item) => item.uploaded > 0 || item.error)) lastWorkAt = Date.now();
    if (!watch || Date.now() - lastWorkAt >= idleExitMs) break;
    await delay(intervalMs);
  } while (true);
} catch (error) {
  await recordUploadFailures([{ error }]);
  console.error('[qwencode-collector] Flush failed:', error.message);
  process.exitCode = 1;
} finally {
  if (watcherHeartbeat) clearInterval(watcherHeartbeat);
  if (ownsWatcherLock) await rm(watcherLock, { recursive: true, force: true });
}

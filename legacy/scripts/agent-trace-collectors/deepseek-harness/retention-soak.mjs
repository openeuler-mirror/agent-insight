import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireProcessLock } from './process-lock.mjs';

export function assessRetentionSample(config, observation, now = Date.now()) {
  const start = Date.parse(config.capturedAt), expiry = Date.parse(config.expiresAt);
  if (!Number.isFinite(start) || !Number.isFinite(expiry) || expiry <= start || now < start) return 'inconclusive-clock-or-contract';
  if (config.expectedDurationMs && Math.abs(expiry - start - config.expectedDurationMs) > 1000) return 'inconclusive-clock-or-contract';
  if (observation.filePresent && observation.fileSha256 !== config.fileSha256) return 'failed-file-changed';
  if (now < expiry && !observation.filePresent) return 'failed-early-deletion';
  if (observation.apiStatus === 401 || observation.apiStatus === 403) return 'inconclusive-identity';
  if (!observation.apiStatus || observation.apiStatus >= 500) return 'inconclusive-service';
  if (now < expiry) {
    if (observation.apiStatus !== 200) return 'failed-early-unreadable';
    return observation.sentinelPresent && observation.expiresAtMatches && observation.noStore ? 'retained-readable' : 'failed-body-contract';
  }
  if (observation.apiStatus === 200) return 'failed-readable-after-expiry';
  if (observation.apiStatus !== 410 || !observation.noStore) return 'failed-expiry-contract';
  return observation.filePresent ? 'expired-cleanup-pending' : 'expired-and-cleaned';
}

export function summarizeRetentionRun(config, observations) {
  const failures = observations.filter(row => row.verdict.startsWith('failed-')).length;
  let gaps = observations.filter(row => row.verdict.startsWith('inconclusive-') || row.gapMs < 0 || row.gapMs > config.intervalMs * 1.75).length;
  if (observations.length && observations[0].verdict !== 'retained-readable') gaps++;
  const last = observations.at(-1);
  let status = failures ? 'running-with-failures' : 'running';
  if (last?.verdict === 'expired-and-cleaned') status = failures ? 'failed' : gaps ? 'completed-with-gaps' : 'completed-observed';
  else if (last && Date.parse(last.at) >= Date.parse(config.expiresAt) + config.cleanupGraceMs) status = 'incomplete-after-deadline';
  return { status, failures, gaps, samples: observations.length, last: last?.at, verdict: last?.verdict };
}

export async function sampleRetention(configFile) {
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const directory = path.dirname(configFile), stateFile = path.join(directory, 'state.json'), history = path.join(directory, 'samples.jsonl');
  const release = acquireProcessLock(path.join(directory, '.sampler.lock'));
  if (!release) return { status: 'sampler-busy' };
  try {
    const previous = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
    if (['failed', 'completed-observed', 'completed-with-gaps', 'incomplete-after-deadline'].includes(previous?.status)) return previous;
    const now = Date.now();
    const observation = { at: new Date(now).toISOString(), gapMs: now - Date.parse(previous?.last ?? config.capturedAt), apiStatus: 0, filePresent: existsSync(config.bodyPath), fileSha256: null, sentinelPresent: false, expiresAtMatches: false, noStore: false };
    if (observation.filePresent) observation.fileSha256 = createHash('sha256').update(readFileSync(config.bodyPath)).digest('hex');
    try {
      const env = readFileSync(config.credentialFile, 'utf8');
      const line = /^AGENT_INSIGHT_API_KEY=(.*)$/m.exec(env)?.[1];
      if (!line) throw new Error('Credential unavailable');
      let key; try { key = JSON.parse(line); } catch { key = line.trim(); }
      const url = new URL('/api/observe/session', config.baseUrl);
      for (const [name, value] of Object.entries({ taskId: config.taskId, view: 'context-body', sourceSessionId: config.sourceSessionId, contextRequestId: config.attemptId })) url.searchParams.set(name, value);
      const response = await fetch(url, { headers: { 'x-witty-api-key': key }, signal: AbortSignal.timeout(15000) });
      observation.apiStatus = response.status;
      observation.noStore = response.headers.get('cache-control') === 'no-store';
      if (response.ok) {
        const body = await response.json();
        observation.sentinelPresent = body.items?.some(item => typeof item.text === 'string' && item.text.includes(config.sentinel)) === true;
        observation.expiresAtMatches = body.expiresAt === config.expiresAt;
      }
    } catch { /* Only availability is recorded; credentials and body text never enter the journal. */ }
    observation.verdict = assessRetentionSample(config, observation, now);
    appendFileSync(history, JSON.stringify(observation) + '\n', { mode: 0o600 });
    const rows = readFileSync(history, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const state = { ...summarizeRetentionRun(config, rows), capturedAt: config.capturedAt, expiresAt: config.expiresAt, taskId: config.taskId, realClock: true };
    writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(stateFile + '.tmp', stateFile);
    return state;
  } finally { release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node retention-soak.mjs /absolute/path/config.json');
  console.log(JSON.stringify(await sampleRetention(path.resolve(process.argv[2]))));
}

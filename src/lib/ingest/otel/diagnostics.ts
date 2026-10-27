import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { isLogEnabled, sanitizeLogValue, type LogLevel } from '@/lib/logger/server';

type Stage = 'received' | 'api-key-auth' | 'decode' | 'partition' | 'langfuse-auth' | 'normalize' | 'spool' | 'jiuwen';
type AuthMode = 'api-key' | 'basic' | 'langfuse-headers' | 'none';
type Reason = 'accepted' | 'ignored-codeagent' | 'invalid-api-key' | 'missing-api-key'
  | 'missing-langfuse-credentials' | 'unknown-langfuse-user' | 'langfuse-secret-mismatch'
  | 'decode-failed' | 'spool-identity-limit' | 'handler-error';
type Result = { reason: Reason; spooled?: number; deduplicated?: number; rejected?: number; error?: unknown };
type Options = {
  now?: () => number;
  emit?: (level: LogLevel, line: string) => void;
  debug?: () => boolean;
  schedule?: (callback: () => void, delay: number) => void;
};

const INTERVAL_MS = 60_000;
const DETAIL_LIMIT = 4;
const SUMMARY_ERROR_CODES = new Set([
  'P1000', 'P1001', 'P1002', 'P1008', 'P1017', 'P2002', 'P2024', 'P2028',
  'ENOSPC', 'EACCES', 'EROFS', 'EIO', 'SQLITE_BUSY',
]);
const authCounts = (): Record<AuthMode, number> => ({ 'api-key': 0, basic: 0, 'langfuse-headers': 0, none: 0 });

function authMode(headers: Headers): AuthMode {
  if (headers.get('x-witty-api-key')) return 'api-key';
  if (headers.get('authorization')?.slice(0, 6).toLowerCase() === 'basic ') return 'basic';
  if (headers.has('x-langfuse-public-key') || headers.has('x-langfuse-secret-key')) return 'langfuse-headers';
  return 'none';
}

function requestMetadata(req: Request) {
  const rawType = (req.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  const rawEncoding = (req.headers.get('content-encoding') || 'identity').trim().toLowerCase();
  const length = req.headers.get('content-length') || '';
  const forwarded = (req.headers.get('x-forwarded-for') || '').slice(0, 128).split(',', 1)[0].trim();
  return {
    path: new URL(req.url).pathname === '/api/public/otel/v1/traces' ? 'public' : 'ingest',
    authMode: authMode(req.headers),
    contentType: ['application/json', 'application/x-protobuf', 'application/protobuf'].includes(rawType) ? rawType : 'other',
    contentEncoding: ['identity', 'gzip', 'deflate'].includes(rawEncoding) ? rawEncoding : 'other',
    contentLength: /^\d{1,12}$/.test(length) ? Number(length) : undefined,
    forwardedFor: isIP(forwarded) ? forwarded : undefined,
  };
}

function traceSample(body: any) {
  const ids = new Set<string>();
  let budget = 256;
  let truncated = false;
  const resources = Array.isArray(body?.resourceSpans) ? body.resourceSpans : [];
  scan: for (let i = 0; i < resources.length; i++) {
    if (--budget < 0) { truncated = true; break; }
    const scopes = Array.isArray(resources[i]?.scopeSpans) ? resources[i].scopeSpans : [];
    for (let j = 0; j < scopes.length; j++) {
      if (--budget < 0) { truncated = true; break scan; }
      const spans = Array.isArray(scopes[j]?.spans) ? scopes[j].spans : [];
      for (let k = 0; k < spans.length; k++) {
        if (--budget < 0) { truncated = true; break scan; }
        const id = spans[k]?.traceId;
        if (typeof id !== 'string' || !/^[a-f\d]{32}$/i.test(id)) continue;
        ids.add(id.toLowerCase());
        if (ids.size > 3) { ids.delete(id.toLowerCase()); truncated = true; break scan; }
      }
    }
  }
  return { traceIds: [...ids], traceIdsTruncated: truncated };
}

function errorCode(error: unknown): string | undefined {
  if (!error) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && (/^P\d{4}$/.test(code) || ['ENOSPC', 'EACCES', 'EROFS', 'EIO', 'SQLITE_BUSY'].includes(code))
    ? code : 'UNCLASSIFIED';
}

export class OtelIngestDiagnostics {
  private readonly now: () => number;
  private readonly emit: NonNullable<Options['emit']>;
  private readonly schedule: NonNullable<Options['schedule']>;
  private readonly debug: () => boolean;
  private windowStart: number;
  private scheduled = false;
  private inFlight = 0;
  private received = 0;
  private completed = 0;
  private spooled = 0;
  private deduplicated = 0;
  private rejected = 0;
  private receivedByAuth = authCounts();
  private authenticatedByAuth = authCounts();
  private http: Record<string, number> = {};
  private errorsByStage: Partial<Record<Stage, number>> = {};
  private errorsByCode: Record<string, number> = {};
  private errorsByReason: Partial<Record<Reason, number>> = {};
  private receivedSamples = new Set<AuthMode>();
  private successSamples = 0;
  private errorSamples = new Set<string>();
  private suppressedErrors = 0;

  constructor(options: Options = {}) {
    this.now = options.now || Date.now;
    this.emit = options.emit || ((level, line) => { if (isLogEnabled(level)) console[level](line); });
    this.debug = options.debug || (() => isLogEnabled('debug'));
    this.schedule = options.schedule || ((callback, delay) => { setTimeout(callback, delay).unref(); });
    this.windowStart = this.now();
  }

  private write(level: LogLevel, data: Record<string, unknown>) {
    try { this.emit(level, `[OTelIngest] ${JSON.stringify({ pid: process.pid, ...data })}`); } catch {}
  }

  private scheduleSummary() {
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      this.write(Object.keys(this.errorsByStage).length ? 'error' : 'info', {
        event: 'summary', windowStart: new Date(this.windowStart).toISOString(), windowEnd: new Date(this.now()).toISOString(),
        received: this.received, completed: this.completed, inFlight: this.inFlight,
        receivedByAuth: this.receivedByAuth, authenticatedByAuth: this.authenticatedByAuth,
        http: this.http, errorsByStage: this.errorsByStage,
        errorsByCode: this.errorsByCode, errorsByReason: this.errorsByReason, spooled: this.spooled,
        deduplicated: this.deduplicated, rejected: this.rejected, suppressedErrors: this.suppressedErrors,
        detailsSampled: !this.debug(),
      });
      this.windowStart = this.now();
      this.received = this.completed = this.spooled = this.deduplicated = this.rejected = this.suppressedErrors = 0;
      this.receivedByAuth = authCounts();
      this.authenticatedByAuth = authCounts();
      this.http = {};
      this.errorsByStage = {};
      this.errorsByCode = {};
      this.errorsByReason = {};
      this.receivedSamples.clear();
      this.successSamples = 0;
      this.errorSamples.clear();
      if (this.inFlight > 0) this.scheduleSummary();
    }, INTERVAL_MS);
  }

  begin(req: Request) {
    if (!this.scheduled) this.windowStart = this.now();
    const started = this.now();
    const debug = this.debug();
    const metadata = { requestId: randomUUID(), ...requestMetadata(req) };
    const sampled = debug || !this.receivedSamples.has(metadata.authMode);
    let stage: Stage = 'received';
    let authenticated = false;
    let finished = false;
    let stageStarted = started;
    const stageDurationsMs: Partial<Record<Stage, number>> = {};
    const finishStage = () => {
      const durationMs = Math.max(0, this.now() - stageStarted);
      stageDurationsMs[stage] = (stageDurationsMs[stage] || 0) + durationMs;
      if (debug) this.write('debug', { event: 'stage-end', ...metadata, stage, durationMs });
    };
    let traces: ReturnType<typeof traceSample> = { traceIds: [], traceIdsTruncated: false };
    this.received++;
    this.inFlight++;
    this.receivedByAuth[metadata.authMode]++;
    if (sampled) {
      this.receivedSamples.add(metadata.authMode);
      this.write('info', { event: 'received', ...metadata });
    }
    this.scheduleSummary();
    return {
      stage: (next: Stage) => {
        if (finished) return;
        if (debug) finishStage();
        stage = next;
        stageStarted = this.now();
        if (debug) this.write('debug', { event: 'stage-start', ...metadata, stage });
      },
      decoded: (body: any) => {
        traces = traceSample(body);
        if (!debug) return;
        const ids = new Set<string>();
        for (const resource of Array.isArray(body?.resourceSpans) ? body.resourceSpans : []) {
          for (const scope of Array.isArray(resource?.scopeSpans) ? resource.scopeSpans : []) {
            for (const span of Array.isArray(scope?.spans) ? scope.spans : []) {
              if (typeof span?.traceId === 'string' && /^[a-f\d]{32}$/i.test(span.traceId)) ids.add(span.traceId.toLowerCase());
            }
          }
        }
        const all = [...ids];
        for (let offset = 0; offset < all.length; offset += 32) {
          this.write('debug', { event: 'trace-ids', requestId: metadata.requestId, traceIds: all.slice(offset, offset + 32), offset, total: all.length });
        }
      },
      mapped: (events: Array<{ traceId?: string; sessionId: string }>) => {
        if (!debug) return;
        const seen = new Set<string>();
        for (const event of events) {
          const key = JSON.stringify([event.traceId, event.sessionId]);
          if (seen.has(key)) continue;
          seen.add(key);
          this.write('debug', { event: 'trace-session', requestId: metadata.requestId, traceId: event.traceId, sessionId: event.sessionId });
        }
      },
      authenticated: () => {
        if (authenticated || finished) return;
        authenticated = true;
        this.authenticatedByAuth[metadata.authMode]++;
      },
      finish: (status: number, result: Result) => {
        if (finished) return;
        if (debug) finishStage();
        finished = true;
        this.inFlight--;
        this.completed++;
        const key = [200, 400, 401, 413, 415, 500].includes(status) ? String(status) : 'other';
        this.http[key] = (this.http[key] || 0) + 1;
        this.spooled += result.spooled || 0;
        this.deduplicated += result.deduplicated || 0;
        this.rejected += result.rejected || 0;
        const code = errorCode(result.error);
        const failure = status >= 400;
        let print = false;
        if (failure) {
          this.errorsByStage[stage] = (this.errorsByStage[stage] || 0) + 1;
          const codeBucket = !code ? 'NO_CODE' : SUMMARY_ERROR_CODES.has(code) ? code
            : code.startsWith('P') ? 'PRISMA_OTHER' : 'UNCLASSIFIED';
          this.errorsByCode[codeBucket] = (this.errorsByCode[codeBucket] || 0) + 1;
          this.errorsByReason[result.reason] = (this.errorsByReason[result.reason] || 0) + 1;
          const signature = `${stage}:${status}:${result.reason}:${code || ''}`;
          if (debug || (!this.errorSamples.has(signature) && this.errorSamples.size < DETAIL_LIMIT)) {
            if (!debug) this.errorSamples.add(signature);
            print = true;
          } else this.suppressedErrors++;
        } else if (debug || (sampled && this.successSamples < DETAIL_LIMIT)) {
          this.successSamples++;
          print = true;
        }
        if (print) this.write(failure ? 'error' : 'info', {
          event: failure ? 'failed' : 'completed', ...metadata, ...traces, stage, authenticated,
          status, reason: result.reason, errorCode: code, durationMs: Math.max(0, this.now() - started),
          spooled: result.spooled, deduplicated: result.deduplicated, rejected: result.rejected,
          ...(debug ? { stageDurationsMs, errorDetails: result.error ? sanitizeLogValue(stage === 'decode'
            ? { name: (result.error as Error).name, code, message: '[decoder source excerpt omitted]' }
            : result.error) : undefined } : {}),
        });
      },
    };
  }
}

const diagnosticsGlobal = globalThis as typeof globalThis & { __otelIngestDiagnostics?: OtelIngestDiagnostics };

export function beginOtelTraceRequest(req: Request) {
  diagnosticsGlobal.__otelIngestDiagnostics ??= new OtelIngestDiagnostics();
  return diagnosticsGlobal.__otelIngestDiagnostics.begin(req);
}

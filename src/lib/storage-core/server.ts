import type { CoreProfile } from './types';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { decodeOtlpRequest, OtlpDecodeError } from '@/lib/ingest/otel/decode';

const JSON_LIMIT = 4 * 1024 * 1024;
const INPUT_LIMIT = 8 * 1024 * 1024;
const SESSION = /^session_[A-Za-z0-9_-]{43}$/;
const API = /^api_[A-Za-z0-9_-]{43}$/;
class CoreError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}
function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
}
function failure(error: unknown): Response {
  return error instanceof CoreError ? json({ error: error.message }, error.status) : json({ error: 'Storage core unavailable' }, 502);
}
export function coreServiceOrigin(value = process.env.AGENT_INSIGHT_STORAGE_CORE_URL): string {
  if (!value) throw new CoreError(503, 'Storage core URL is not configured');
  let url: URL;
  try { url = new URL(value); } catch { throw new CoreError(503, 'Invalid storage core URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new CoreError(503, 'Storage core requires an explicit loopback origin');
  }
  return url.origin;
}
export function coreCookieName(origin = coreServiceOrigin()): string {
  return 'ai_core_session_' + createHash('sha256').update(origin).digest('hex').slice(0, 16);
}
function bearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header !== null) {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(header);
    return match && (SESSION.test(match[1]) || API.test(match[1])) ? match[1] : null;
  }
  const name = coreCookieName();
  const matches = (request.headers.get('cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return SESSION.test(value) ? value : null;
}
async function bytes(body: ReadableStream<Uint8Array> | null, limit: number, status = 413): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { void reader.cancel(); throw new CoreError(status, status === 413 ? 'Request body too large' : 'Invalid storage core response'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
async function upstream(path: string, options: { token?: string; method?: string; body?: string; headers?: Record<string, string>; responseLimit?: number; timeoutMs?: number }, fetcher: typeof fetch): Promise<{ data: Record<string, unknown>; status: number }> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const response = await fetcher(coreServiceOrigin() + path, {
      method: options.method || 'GET', redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: { accept: 'application/json', ...(options.token ? { authorization: 'Bearer ' + options.token } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers }, body: options.body,
    });
    if (!response.ok) {
      let code:string|undefined;
      if(path.startsWith('/v1/compat/datasets/generation?')){
        try{
          const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bytes(response.body,4096,502)));
          if(value&&typeof value==='object'&&['REQUEST_EXPIRED','QUEUE_LIMIT','SOURCE_NOT_AVAILABLE','IDEMPOTENCY_CONFLICT','ALREADY_COMPLETED','INVALID_CONFIG','NOT_FOUND','DATASET_DELETING','DATASET_NOT_READY'].includes(value.code))code=value.code;
        }catch{}
      }else void response.body?.cancel();
      const status = [400, 401, 403, 404, 409, 410, 413, 415, 422, 429, 501, 503].includes(response.status) ? response.status : 502;
      throw new CoreError(status, status === 401 ? 'Authentication required' : status === 403 ? 'Forbidden' : 'Storage core request failed',code);
    }
    const raw = await bytes(response.body, options.responseLimit || JSON_LIMIT, 502);
    let data: unknown;
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { throw new CoreError(502, 'Invalid storage core response'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CoreError(502, 'Invalid storage core response');
    return { data: data as Record<string, unknown>, status: response.status };
  } finally { clearTimeout(timer); }
}
function segment(value: string): string {
  if (value === '.' || value === '..' || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new CoreError(400, 'Invalid resource identifier');
  return encodeURIComponent(value);
}
function copyQuery(source: URLSearchParams, fields: string[]): string {
  const params = new URLSearchParams();
  for (const key of fields) { const value = source.get(key); if (value !== null) params.set(key, value); }
  return params.size ? '?' + params.toString() : '';
}
export function coreUnsupported(): Response { return json({ error: 'This operation is not available in storage core mode' }, 501); }
async function proxy(request: Request, path: string, fetcher: typeof fetch): Promise<Response> {
  const token = bearer(request); if (!token) throw new CoreError(401, 'Authentication required');
  return json((await upstream(path, { token }, fetcher)).data);
}
export async function handleCoreList(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  try { return await proxy(request, '/v1/traces' + copyQuery(new URL(request.url).searchParams, ['workspace_id', 'status', 'agent', 'search', 'cursor', 'limit']), fetcher); } catch (error) { return failure(error); }
}
export async function handleCoreSession(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams; const action = params.get('action') || 'summary';
    if (!['summary', 'spans', 'span', 'payload', 'batch'].includes(action)) return coreUnsupported();
    if (action === 'batch') {
      const batch = params.get('batch_id'); if (!batch) throw new CoreError(400, 'Missing batch_id');
      return await proxy(request, '/v1/batches/' + segment(batch) + copyQuery(params, ['workspace_id']), fetcher);
    }
    const trace = params.get('trace_id'); if (!trace) throw new CoreError(400, 'Missing trace_id');
    let path = '/v1/traces/' + segment(trace);
    if (action === 'spans') path += '/spans';
    if (action === 'span' || action === 'payload') {
      const span = params.get('span_id'); if (!span) throw new CoreError(400, 'Missing span_id');
      path += '/spans/' + segment(span) + (action === 'payload' ? '/payload' : '');
    }
    const fields = action === 'spans' ? ['workspace_id', 'limit', 'after_span_id', 'status', 'parent_span_id', 'search'] : action === 'payload' ? ['workspace_id', 'revision', 'section', 'after_chunk', 'limit'] : ['workspace_id'];
    return await proxy(request, path + copyQuery(params, fields), fetcher);
  } catch (error) { return failure(error); }
}
function cookie(request: Request, token: string, clear = false): string {
  return `${coreCookieName()}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 86400}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export async function handleCoreAuth(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  try {
    if (request.method === 'POST' || request.method === 'DELETE') {
      if (request.headers.get('origin') !== new URL(request.url).origin) throw new CoreError(403, 'Same-origin request required');
    }
    if (request.method === 'POST') {
      let body: Record<string, unknown>;
      try { body = JSON.parse(Buffer.from(await bytes(request.body, 16384)).toString('utf8')); } catch (error) { if (error instanceof CoreError) throw error; throw new CoreError(400, 'Invalid login request'); }
      if (typeof body?.username !== 'string' || typeof body?.password !== 'string' || !body.username || !body.password) throw new CoreError(400, 'Username and password required');
      const { data } = await upstream('/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: body.username, password: body.password }) }, fetcher);
      if (typeof data.session_token !== 'string' || !SESSION.test(data.session_token) || !validProfile(data.profile)) throw new CoreError(502, 'Invalid storage core response');
      return json(publicProfile(data.profile as CoreProfile), 200, { 'set-cookie': cookie(request, data.session_token) });
    }
    const token = bearer(request); if (!token || !SESSION.test(token)) throw new CoreError(401, 'Authentication required');
    if (request.method === 'GET') {
      const { data } = await upstream('/v1/auth/me', { token }, fetcher);
      if (!validProfile(data)) throw new CoreError(502, 'Invalid storage core response');
      return json(publicProfile(data as CoreProfile));
    }
    if (request.method === 'DELETE') {
      try { await upstream('/v1/auth/logout', { token, method: 'POST', body: '{}' }, fetcher); }
      catch (error) { if (!(error instanceof CoreError) || error.status !== 401) throw error; }
      return json({ ok: true }, 200, { 'set-cookie': cookie(request, '', true) });
    }
    return json({ error: 'Method not allowed' }, 405);
  } catch (error) { return failure(error); }
}
function publicProfile(p: CoreProfile): CoreProfile {
  return { username: p.username, principal_id: p.principal_id, display_name: p.display_name,
    project_id: p.project_id, workspace_id: p.workspace_id,
    workspaces: p.workspaces.map(w => ({ workspace_id: w.workspace_id, name: w.name, role: w.role })) };
}
function validProfile(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return typeof p.username === 'string' && typeof p.principal_id === 'string' && typeof p.display_name === 'string'
    && p.project_id === 'default' && typeof p.workspace_id === 'string' && Array.isArray(p.workspaces)
    && p.workspaces.every(w => w && typeof w.workspace_id === 'string' && typeof w.name === 'string' && typeof w.role === 'string');
}
export async function handleCoreIngest(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  try {
    const auth = request.headers.get('authorization');
    const match = auth === null ? null : /^Bearer (api_[A-Za-z0-9_-]{43})$/i.exec(auth);
    const token = auth === null ? request.headers.get('x-witty-api-key') : match?.[1];
    if (!token || !API.test(token)) throw new CoreError(401, 'API credential required');
    let raw = await bytes(request.body, INPUT_LIMIT);
    const encoding = request.headers.get('content-encoding')?.toLowerCase();
    if (encoding === 'gzip') {
      try { raw = gunzipSync(raw, { maxOutputLength: INPUT_LIMIT }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new CoreError(413, 'Request body too large'); throw new CoreError(400, 'Invalid compressed OTLP request'); }
    } else if (encoding && encoding !== 'identity') throw new CoreError(415, 'Unsupported content encoding');
    let body: unknown;
    try { body = await decodeOtlpRequest(new Request(request.url, { method: 'POST', headers: { 'content-type': request.headers.get('content-type') || '' }, body: Buffer.from(raw) }), 'traces'); }
    catch (error) { if (error instanceof OtlpDecodeError) throw new CoreError(error.status, 'Invalid OTLP request'); throw error; }
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > JSON_LIMIT) throw new CoreError(413, 'Decoded OTLP request too large');
    const headers: Record<string, string> = {};
    for (const name of ['x-workspace-id', 'idempotency-key']) { const value = request.headers.get(name); if (value) headers[name] = value; }
    const { data } = await upstream('/v1/ingest/otlp', { token, method: 'POST', body: serialized, headers }, fetcher);
    if (typeof data.batch_id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(data.batch_id) || typeof data.state !== 'string' || !['accepted', 'prepared', 'indexed'].includes(data.state)) throw new CoreError(502, 'Invalid durable ingestion acknowledgement');
    const outHeaders = { 'x-storage-batch-id': data.batch_id, 'x-storage-state': data.state, 'cache-control': 'no-store' };
    const protobuf = /application\/(x-)?protobuf/i.test(request.headers.get('content-type') || '');
    return protobuf ? new Response(null, { status: 200, headers: { ...outHeaders, 'content-type': 'application/x-protobuf' } }) : json({}, 200, outHeaders);
  } catch (error) { return failure(error); }
}

export { upstream as requestCore, bytes as readCoreBytes };

import { randomUUID } from 'node:crypto';
import { collaborationLog, failureDetails } from './log';
import { CollaborationError, identifier, invalid, parseBinding, parseEvent, readBody } from './contracts';
import { CollaborationService } from './service';
import { resolveCollaboration } from '@/lib/ingest/collaboration/resolve';

export type CollaborationDependencies = { service: CollaborationService; authenticate: (apiKey: string) => Promise<string | null> };
export function createCollaborationHandlers({ service, authenticate }: CollaborationDependencies) {
    const buckets = new Map<string, { start: number; count: number }>();
    async function user(request: Request, context: Record<string, unknown>) {
        const key = request.headers.get('x-witty-api-key');
        const username = key ? await authenticate(key) : null;
        if (!username) throw new CollaborationError(401, 'UNAUTHORIZED', '需要有效采集凭据');
        context.user = username;
        const now = Date.now();
        for (const [name, entry] of buckets) if (now - entry.start >= 60000) buckets.delete(name);
        const bucket = buckets.get(username) ?? { start: now, count: 0 };
        if (bucket.count >= 120 || (!buckets.has(username) && buckets.size >= 10000)) throw new CollaborationError(429, 'RATE_LIMITED', '请求过于频繁，请稍后原样重试');
        bucket.count++; buckets.set(username, bucket);
        return username;
    }
    const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...(status === 429 ? { 'Retry-After': '60' } : {}) } });
    async function handle(operation: string, work: (context: Record<string, unknown>) => Promise<Response>) {
        const startedAt = Date.now();
        const context: Record<string, unknown> = { requestId: randomUUID(), operation };
        let result: Response;
        try {
            result = await work(context);
            collaborationLog.info('请求成功', { ...context, httpStatus: result.status, durationMs: Date.now() - startedAt });
        } catch (error) {
            const details = error instanceof CollaborationError
                ? { code: error.code, reason: error.message, field: error.field }
                : { code: 'INTERNAL_ERROR', ...failureDetails(error) };
            const status = error instanceof CollaborationError ? error.status : 500;
            const entry = { ...context, httpStatus: status, durationMs: Date.now() - startedAt, ...details };
            if (status >= 500) collaborationLog.error('请求失败', entry);
            else collaborationLog.warn('请求被拒绝', entry);
            result = error instanceof CollaborationError
                ? response({ error: { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) } }, status)
                : response({ error: { code: 'INTERNAL_ERROR', message: '内部处理失败，请使用原编号和正文重试' } }, 500);
        }
        result.headers.set('x-collaboration-request-id', String(context.requestId));
        return result;
    }
    return {
        report: (request: Request) => handle('report_event', async context => {
            const username = await user(request, context);
            const event = parseEvent(await readBody(request));
            Object.assign(context, { collaborationId: event.collaborationId, eventId: event.eventId, fromSessionId: event.fromSessionId, toSessionId: event.toSessionId });
            const result = await service.report(username, event, String(context.requestId));
            const anchor = result.fromAnchor;
            Object.assign(context, { result: result.result, anchorStatus: anchor.status, anchorReason: anchor.message, traceResolution: result.traceResolution });
            return response(result, result.result === 'created' ? 201 : 200);
        }),
        bind: (request: Request) => handle('bind_session', async context => {
            const username = await user(request, context);
            const binding = parseBinding(await readBody(request));
            Object.assign(context, { collaborationId: binding.collaborationId, sessionId: binding.sessionId, traceSessionId: binding.traceSessionId });
            const result = await service.store.bind(username, binding);
            context.result = result.result;
            return response(result, result.result === 'created' ? 201 : 200);
        }),
        graph: (request: Request, id: string) => handle('query_graph', async context => {
            const username = await user(request, context);
            identifier(id, 'collaborationId');
            context.collaborationId = id;
            const params = new URL(request.url).searchParams;
            for (const key of params.keys()) if (!['offset', 'limit'].includes(key)) invalid('不支持的查询参数', key);
            const number = (key: string, fallback: number, max: number, min: number) => {
                if (params.getAll(key).length > 1) invalid('重复查询参数', key);
                const raw = params.get(key);
                if (raw !== null && !/^\d+$/.test(raw)) invalid('需要非负整数', key);
                const value = raw === null ? fallback : Number(raw);
                if (!Number.isSafeInteger(value) || value < min || value > max) invalid('分页参数超出范围', key);
                return value;
            };
            try { await resolveCollaboration(username, id); }
            catch (error) {
                collaborationLog.warn('查询前端点重算暂不可用', { ...context, user: username, collaborationId: id, stage: 'endpoint_resolution', ...failureDetails(error) });
            }
            const graph = await service.graph(username, id, number('offset', 0, 10000000, 0), number('limit', 100, 100, 1), String(context.requestId));
            Object.assign(context, { total: graph.total, offset: graph.offset, returned: graph.events.length, resolutionComplete: graph.resolutionComplete });
            return response(graph);
        }),
    };
}

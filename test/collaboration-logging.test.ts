import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CollaborationService } from '../src/lib/collaboration/service';

test('request logs distinguish create, duplicate, rejection and database failure without logging secrets', async () => {
    process.env.AGENT_INSIGHT_LOG_DIR = await mkdtemp(path.join(tmpdir(), 'collaboration-logs-'));
    process.env.AGENT_INSIGHT_LOG_LEVEL = 'info';
    const { createCollaborationHandlers } = await import('../src/lib/collaboration/http');
    const { failureDetails } = await import('../src/lib/collaboration/log');
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = (...args: unknown[]) => { lines.push(args.join(' ')); };
    let result = 'created';
    let failure = false;
    const service = {
        async report() {
            if (failure) throw Object.assign(new Error('SECRET_DATABASE_CONNECTION'), { code: 'P2021' });
            return { result, fromAnchor: { status: 'candidate', message: '唯一候选' }, traceResolution: { from: 'resolved', to: 'unresolved' } };
        },
    } as unknown as CollaborationService;
    const handlers = createCollaborationHandlers({ service, authenticate: async key => key === 'SECRET_API_KEY' ? 'log-user' : null });
    const body = { collaborationId: 'log-c', eventId: 'log-e', fromSessionId: 'A', toSessionId: 'B', description: 'SECRET_DESCRIPTION', content: 'SECRET_CONTENT', fromLocator: { recordType: 'shell', commandContains: 'SECRET_COMMAND' } };
    const request = (payload: unknown = body, key = 'SECRET_API_KEY') => new Request('http://localhost/api/ingest/collaborations/events', { method: 'POST', headers: { 'content-type': 'application/json', 'x-witty-api-key': key }, body: JSON.stringify(payload) });
    try {
        const created = await handlers.report(request());
        assert.equal(created.status, 201);
        const requestId = created.headers.get('x-collaboration-request-id');
        assert.ok(requestId);
        result = 'duplicate';
        assert.equal((await handlers.report(request())).status, 200);
        assert.equal((await handlers.report(request(body, 'BAD_KEY'))).status, 401);
        assert.equal((await handlers.report(request({ ...body, content: null }))).status, 400);
        failure = true;
        assert.equal((await handlers.report(request())).status, 500);
        const logs = lines.map(line => JSON.parse(line));
        assert.ok(logs.every(log => log.scope === 'collaboration' && log.ts && log.context.requestId));
        assert.equal(logs[0].context.requestId, requestId);
        assert.equal(logs[0].context.result, 'created');
        assert.equal(logs[1].context.result, 'duplicate');
        assert.equal(logs[2].context.code, 'UNAUTHORIZED');
        assert.equal(logs[3].context.field, 'content');
        assert.equal(logs[4].context.causeCode, 'P2021');
        assert.match(logs[4].context.reason, /数据库表不存在/);
        assert.ok(!lines.join('\n').includes('SECRET_'));
        assert.equal(failureDetails(new SyntaxError('SECRET_BODY')).causeCode, 'INVALID_TRACE_JSON');
        const rawError = { code: 'P2010', meta: { message: 'no such table: SECRET_TABLE' } };
        assert.match(failureDetails(rawError).reason, /数据库表不存在/);
        assert.ok(!JSON.stringify(failureDetails(rawError)).includes('SECRET_'));
    } finally { Object.assign(console, original); }
});

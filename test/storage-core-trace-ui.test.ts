import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';

async function model() {
    assert.ok(existsSync(new URL('../src/components/observe/storage-core-trace-model.ts', import.meta.url)), 'core Trace view model is implemented');
    return import('../src/components/observe/storage-core-trace-model');
}

test('unknown metrics stay unknown and 64-bit counts retain every digit', async () => {
    const { formatCoreCount } = await model();
    assert.equal(formatCoreCount(null), '—');
    assert.equal(formatCoreCount(undefined), '—');
    assert.equal(formatCoreCount(''), '—');
    assert.equal(formatCoreCount(0), '0');
    assert.equal(formatCoreCount('18446744073709551615').replace(/\D/g, ''), '18446744073709551615');
    assert.equal(formatCoreCount(Number.MAX_SAFE_INTEGER + 1), '—');
});

test('Span microseconds and Trace epoch milliseconds use explicit units', async () => {
    const { coreDurationMs, formatCoreDuration, formatCoreTime } = await model();
    assert.equal(coreDurationMs({ duration_us: '1250' }), 1.25);
    assert.equal(coreDurationMs({ started_at_ms: '1700000000000', ended_at_ms: '1700000001250' }), 1250);
    assert.equal(coreDurationMs({ started_at_ms: '1700000000000', ended_at_ms: null }), null);
    assert.equal(coreDurationMs({ duration_us: '0' }), 0);
    assert.equal(formatCoreDuration({ duration_us: '0' }), '0 ms');
    assert.equal(formatCoreDuration({ duration_us: '1250' }), '1.25 ms');
    assert.equal(formatCoreDuration({ duration_us: '1' }), '1 µs');
    assert.equal(formatCoreTime('1700000000000000000'), '—');
    assert.equal(coreDurationMs({ started_at_ms: '1700000000000000000', ended_at_ms: '1700000000001000000' }), null);
});

test('switching Trace invalidates late responses even when transport ignores abort', async () => {
    const { LatestCoreRequest, readCoreJSON } = await model();
    const gate = new LatestCoreRequest();
    const a = gate.begin();
    let finishOld!: (response: Response) => void;
    const delayed = new Promise<Response>(resolve => { finishOld = resolve; });
    const displayed: string[] = [];
    const oldRead = readCoreJSON<{ name: string }>(async () => delayed, '/api/observe/session?trace_id=old', a.signal)
        .then(data => { if (a.isCurrent()) displayed.push(data.name); });
    const b = gate.begin();
    assert.equal(a.signal.aborted, true);
    const current = await readCoreJSON<{ name: string }>(async () => new Response('{"name":"new Trace"}'), '/api/observe/session?trace_id=new', b.signal);
    if (b.isCurrent()) displayed.push(current.name);
    finishOld(new Response('{"name":"stale Trace"}'));
    await oldRead;
    assert.deepEqual(displayed, ['new Trace']);
    gate.cancel();
    assert.equal(b.signal.aborted, true);
    assert.equal(b.isCurrent(), false);
});

test('core reads send bounded same-origin requests and expose permission/service errors', async () => {
    const { readCoreJSON, CoreRequestError } = await model();
    const controller = new AbortController();
    let captured: RequestInit | undefined;
    const result = await readCoreJSON(async (_url: string, options?: RequestInit) => {
        captured = options;
        return new Response('{"items":[]}');
    }, '/api/observe/data?limit=50', controller.signal);
    assert.deepEqual(result, { items: [] });
    assert.equal(captured?.signal, controller.signal);
    assert.equal(captured?.cache, 'no-store');
    assert.equal(captured?.credentials, 'same-origin');
    for (const status of [401, 403, 503]) {
        await assert.rejects(readCoreJSON(async () => new Response('internal details', { status }), '/api/observe/data', controller.signal), (error: unknown) => error instanceof CoreRequestError && error.status === status && !error.message.includes('internal details'));
    }
});

test('payload view pages move forward and back without accumulating content', async () => {
    const helpers = await model();
    assert.equal(typeof helpers.initialPayloadPage, 'function');
    const first = helpers.initialPayloadPage();
    const second = helpers.nextPayloadPage(first, 3);
    const third = helpers.nextPayloadPage(second, 7);
    assert.deepEqual(first, { after: -1, previous: [] });
    assert.deepEqual(third, { after: 7, previous: [-1, 3] });
    assert.deepEqual(helpers.previousPayloadPage(third), second);
    assert.deepEqual(helpers.previousPayloadPage(second), first);
    assert.equal(helpers.previousPayloadPage(first), first);
    assert.equal(helpers.nextPayloadPage(second, null), second);
    assert.equal(helpers.nextPayloadPage(second, 3), second);
    assert.equal(helpers.nextPayloadPage(second, -1), second);
    assert.deepEqual(helpers.initialPayloadPage(), first);
});

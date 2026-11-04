import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import type { RawInteraction } from '../src/lib/engine/observability/agent-trace';
import { collaborationSource, sameCollaborationSource } from '../src/lib/collaboration/display-tree';

import * as helper from '../src/lib/client/trace-interaction-loader';
const source = fs.readFileSync(new URL('../src/components/observe/AgentTraceView.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('view.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = '';
function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'ensureInteractionLoaded') callback = node.initializer!.getText(ast);
    ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(callback);
const js = ts.transpileModule(`const callback = ${callback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
type Interaction = RawInteraction & { _payloadDeferred?: boolean };
const preview = (version = 'v1', messageID: string | undefined = 'message-1'): Interaction => ({ role: 'assistant', messageID, content: 'preview', _payloadDeferred: true, _payloadVersion: version });

function harness(initial: Interaction[] = [preview()]) {
    let state: Interaction[] = initial;
    let applied = 0;
    let error: string | null = null;
    let trace = 'trace-1';
    const sourceRef = { current: initial };
    const traceRef = { current: trace };
    const loader = helper?.createTraceInteractionLoader();
    loader?.sync(trace, initial);
    const pending: Array<{ resolve: (value: Interaction) => void; reject: (error: Error) => void; signal?: AbortSignal }> = [];
    const scope: Record<string, unknown> = {
        React: { useCallback: (fn: unknown) => fn }, langfuseProjection: null, locale: 'zh',
        previousTraceIdentityRef: traceRef, sourceInteractionsRef: sourceRef,
        sameTraceReloadRef: { current: false },
        interactionLoader: loader, activeInteractionLoadRef: { current: null },
        sameTraceInteraction: helper?.sameTraceInteraction,
        collaborationSource, sameCollaborationSource,
        setInteractionLoadError: (value: string | null) => { error = value; },
        setInteractions: (update: (previous: Interaction[]) => Interaction[]) => {
            const next = update(state); if (next !== state) applied++; state = next;
        },
        loadInteraction: (_index: number, signal?: AbortSignal) => new Promise<RawInteraction>((resolve, reject) => pending.push({ resolve, reject, signal })),
    };
    return {
        pending,
        invoke: (index = 0) => new Function(...Object.keys(scope), 'interactions', `${js}; return callback;`)(...Object.values(scope), state)(index),
        refresh: (next: Interaction[] = [preview()], nextTrace = trace) => {
            trace = nextTrace; state = next; sourceRef.current = next; traceRef.current = trace;
            loader?.sync(trace, next); loader?.reconcile();
        },
        resolve: async (position = 0, value: Interaction = { ...preview(), content: 'complete', _payloadDeferred: undefined }) => {
            pending[position].resolve(value); await flush();
        },
        state: () => state, applied: () => applied, error: () => error,
        cancel: () => loader?.cancel(),
    };
}

test('successful detail response survives a refreshed array with the same message and payload version', async () => {
    const h = harness(); const request = h.invoke(); await flush(); h.refresh();
    await h.resolve(); await request;
    assert.equal(h.applied(), 1); assert.equal(h.state()[0].content, 'complete');
});

test('repeated selection and refresh share one in-flight request and one state application', async () => {
    const h = harness(); const a = h.invoke(); await flush(); h.refresh(); const b = h.invoke(); await flush();
    assert.equal(h.pending.length, 1);
    await h.resolve(); await Promise.all([a, b]); assert.equal(h.applied(), 1);
});

test('switching Trace aborts obsolete transport and rejects its late response', async () => {
    const h = harness(); const request = h.invoke(); await flush(); h.refresh([preview()], 'trace-2');
    assert.equal(h.pending[0].signal?.aborted, true);
    await h.resolve(); await request; assert.equal(h.applied(), 0);
});

test('updated payload cannot be overwritten by an older successful response', async () => {
    const h = harness(); const old = h.invoke(); await flush(); h.refresh([preview('v2')]);
    const current = h.invoke(); await flush(); assert.equal(h.pending.length, 2);
    await h.resolve(); assert.equal(h.applied(), 0);
    await h.resolve(1, { ...preview('v2'), content: 'new body', _payloadDeferred: false });
    await Promise.all([old, current]); assert.equal(h.state()[0].content, 'new body');
});

test('message replacement with the same reported version cannot receive the old body', async () => {
    const initial = [preview()]; const h = harness(initial); const request = h.invoke(); await flush();
    initial[0] = preview('v1', 'different-message'); h.refresh(initial);
    await h.resolve(); await request; assert.equal(h.applied(), 0);
});

test('late errors from a cancelled Trace do not replace the active detail state', async () => {
    const h = harness(); const request = h.invoke(); await flush(); h.refresh([preview()], 'trace-2');
    h.pending[0].reject(new Error('old request failed')); await request;
    assert.equal(h.error(), null);
});

test('request failure releases the in-flight slot for an explicit retry', async () => {
    const h = harness(); const first = h.invoke(); await flush(); h.pending[0].reject(new Error('offline')); await first;
    assert.equal(h.error(), 'offline');
    const retry = h.invoke(); await flush(); assert.equal(h.pending.length, 2);
    await h.resolve(1); await retry; assert.equal(h.error(), null); assert.equal(h.applied(), 1);
});

test('an appended message does not invalidate an unchanged in-flight detail', async () => {
    const h = harness(); const request = h.invoke(); await flush(); h.refresh([preview(), preview('v2', 'message-2')]);
    await h.resolve(); await request; assert.equal(h.state().length, 2); assert.equal(h.applied(), 1);
});

test('legacy messages without a messageID still require matching payload versions', async () => {
    const item = { ...preview(), messageID: undefined }; const h = harness([item]); const request = h.invoke(); await flush();
    h.refresh([{ ...item }]); await h.resolve(0, { ...item, content: 'legacy body', _payloadDeferred: false }); await request;
    assert.equal(h.state()[0].content, 'legacy body');
});

test('changing collaboration provenance cancels a worker detail request', async () => {
    const worker = (taskId: string) => ({ ...preview(), _collaboration: { taskId, index: 1, version: 'worker-v1' } });
    const h = harness([worker('worker-a')]); const request = h.invoke(); await flush(); h.refresh([worker('worker-b')]);
    assert.equal(h.pending[0].signal?.aborted, true); await h.resolve(); await request; assert.equal(h.applied(), 0);
});

test('an unexpected response body version produces an error rather than leaving an unexplained skeleton', async () => {
    const h = harness(); const request = h.invoke(); await flush(); await h.resolve(0, { ...preview('wrong-version'), _payloadDeferred: false });
    await request; assert.equal(h.applied(), 0); assert.match(h.error()!, /changed/);
});

test('unmount cancellation ignores a late error', async () => {
    const h = harness(); const request = h.invoke(); await flush(); h.cancel(); h.pending[0].reject(new Error('transport aborted'));
    await request; assert.equal(h.error(), null); assert.equal(h.applied(), 0);
});

test('a timed-out request settles, aborts transport and releases its slot', async () => {
    assert.ok(helper); const loader = helper.createTraceInteractionLoader({ timeoutMs: 10 }); loader.sync('trace', [preview()]);
    let error: Error | undefined; let signal: AbortSignal | undefined;
    await loader.load(0, (_index: number, value: AbortSignal) => { signal = value; return new Promise(() => {}); }, () => assert.fail('timed-out response applied'), (value: Error) => { error = value; });
    assert.equal(signal?.aborted, true); assert.equal(error?.name, 'TimeoutError');
    let applied = false;
    await loader.load(0, async () => ({ ...preview(), _payloadDeferred: false }), () => { applied = true; }, () => assert.fail('retry failed'));
    assert.equal(applied, true);
});

test('selecting a cached detail clears the previous selection error', async () => {
    const h = harness([preview(), { ...preview('v2', 'message-2'), content: 'cached body', _payloadDeferred: false }]);
    const request = h.invoke(); await flush(); h.pending[0].reject(new Error('offline')); await request;
    assert.equal(h.error(), 'offline'); await h.invoke(1);
    assert.equal(h.error(), null); assert.equal(h.pending.length, 1);
});

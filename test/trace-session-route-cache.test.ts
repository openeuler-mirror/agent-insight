import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { createSessionBodyCache, memoizeSessionReads } from '../src/lib/trace/session-body-cache';
import * as payload from '../src/lib/trace/session-payload';

const text = fs.readFileSync(new URL('../src/app/api/observe/session/route.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('route.ts', text, ts.ScriptTarget.Latest, true);
const executable = ast.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(ast).replace(/^export /, '')).join('\n');
const compiled = ts.transpileModule(executable, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
    const raw = JSON.stringify([{ role: 'user', content: 'question' }, { role: 'assistant', content: 'answer' }]);
    const session = { taskId: 'root', user: 'alice', label: 'initial', query: 'question', startTime: new Date(1000), interactions: raw, langfuseTraceNodes: '[]' };
    const execution = { framework: 'opencode', tokens: 1, latency: 2, cost: 3, timestamp: new Date(1000) };
    let parses = 0; let reads = 0; let versioned = 0; let linked = false; let childText = 'child-v1'; let plans = 0;
    const scope = {
        createHash, createSessionBodyCache, memoizeSessionReads,
        createTracePayloadSnapshot: payload.createTracePayloadSnapshot,
        withTracePayloadVersions: (rows: unknown[]) => { versioned += rows.length; return payload.withTracePayloadVersions(rows); },
        toTraceStructureInteractions: payload.toTraceStructureInteractions,
        JSON: { ...JSON, parse: (raw: string) => { parses++; return JSON.parse(raw); } },
        db: {
            findSessionByTaskId: async (id: string) => { reads++; return id === 'root' ? { ...session } : { ...session, taskId: id, interactions: JSON.stringify([{ role: 'assistant', content: childText }]) }; },
            findExecutions: async () => [{ ...execution }],
        },
        inferSubagentNamesFromInteractions: (rows: unknown[]) => rows,
        normalizeClaudeCodeInteractionsForStorage: (rows: unknown[]) => rows,
        resolveUser: async () => ({ username: 'alice' }),
        findGoalPlusTraceProjectionMembers: async () => ({ members: [] }),
        composeCollaborationTrace: () => { throw Error('unexpected semantic projection'); },
        analyzeSession: () => { throw Error('unexpected analysis'); },
        NextResponse: { json: Response.json },
        collaborationTraceProjection: {
            plan: async () => { plans++; return {}; },
            interactions: async (_user: string, id: string, load: (id: string) => Promise<{ interactions: unknown[] }>) => {
                if (!linked) return null;
                const root = await load(id); const child = await load('child');
                return [...root.interactions, ...child.interactions];
            },
        },
    };
    const get = new Function(...Object.keys(scope), compiled + '\nreturn GET;')(...Object.values(scope)) as (request: Request) => Promise<Response>;
    return {
        session, execution,
        read: async (view = 'structure', index = 1, source = '') => {
            const response = await get(new Request(`http://localhost/api/observe/session?taskId=root&view=${view}&index=${index}${source}`));
            return { status: response.status, body: await response.json() };
        },
        stats: () => ({ parses, reads, versioned, plans }),
        link: () => { linked = true; }, child: (next: string) => { childText = next; },
    };
}

test('real route checks current ownership and metadata even with unchanged cached body', async () => {
    const h = harness();
    const a = await h.read(); assert.equal(a.status, 200);
    h.session.label = 'renamed'; h.session.query = 'new query';
    const b = await h.read(); assert.equal(b.body.label, 'renamed'); assert.equal(b.body.query, 'new query');
    h.session.user = 'bob';
    assert.equal((await h.read()).status, 403);
});

test('real route reuses parsed body and previews when only execution statistics change', async () => {
    const h = harness(); const a = await h.read(); const parses = h.stats().parses;
    h.execution.tokens = 99; h.execution.latency = 88; h.execution.cost = 77;
    const b = await h.read();
    assert.equal(b.body.execution.tokens, 99); assert.equal(b.body.execution.latency, 88); assert.equal(b.body.execution.cost, 77);
    assert.equal(b.body.interactions[1]._payloadVersion, a.body.interactions[1]._payloadVersion);
    assert.equal(h.stats().parses, parses);
    assert.equal(h.stats().reads, 2);
});

test('real single route avoids whole-array versioning and invalidates same-length changes', async () => {
    const h = harness(); const a = await h.read('interaction');
    assert.equal(a.body.interaction.content, 'answer'); assert.equal(h.stats().versioned, 0);
    h.session.interactions = h.session.interactions.replace('answer', 'edited');
    const b = await h.read('interaction'); assert.equal(b.body.interaction.content, 'edited');
    assert.notEqual(b.body.interaction._payloadVersion, a.body.interaction._payloadVersion);
    assert.equal((await h.read('interaction', 2)).status, 400);
});

test('real route refreshes collaboration members and child content with request-local shared reads', async () => {
    const h = harness(); assert.equal((await h.read()).body.interactions.length, 2);
    h.link(); const linked = await h.read('interaction', 2);
    assert.equal(linked.body.interaction.content, 'child-v1');
    assert.equal(h.stats().reads, 3); // First root + second root and child; no duplicate root.
    h.child('child-v2'); const changed = await h.read('interaction', 2);
    assert.equal(changed.body.interaction.content, 'child-v2');
    assert.notEqual(changed.body.interaction._payloadVersion, linked.body.interaction._payloadVersion);
    assert.equal(h.stats().plans, 3);
    const raw = await h.read('structure', 1, '&source=raw');
    assert.equal(raw.body.interactions.length, 2); assert.equal(h.stats().plans, 3);
});

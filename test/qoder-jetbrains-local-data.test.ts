import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildQoderOtlpPayload, readQoderLocalTokenUsage, resolveQoderLocalTokenDatabase } from '../scripts/qoder_trace_collector.mjs';
import { normalizeOtlpTraces } from '@/lib/ingest/otel/normalize';
import { aggregateOtelTraceEvents } from '@/lib/ingest/otel/aggregate';
import { buildAgentCallTree, type RawInteraction } from '@/lib/engine/observability/agent-trace';

async function fixture(t: TestContext, directory: string) {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-jetbrains-db-'));
    t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
    const databasePath = path.join(homeDir, directory, 'shared_client/cache/db/local.db');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const moduleName = 'node:sqlite';
    const sqlite = await import(moduleName);
    const db = new sqlite.DatabaseSync(databasePath);
    db.exec('CREATE TABLE chat_message (id TEXT, session_id TEXT, request_id TEXT, role TEXT, token_info TEXT, model_info TEXT, gmt_create INTEGER)');
    const insert = db.prepare('INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const [session, role, id] of [['session-1', 'assistant', 'message-1'], ['session-2', 'assistant', 'message-2'], ['session-1', 'user', 'user-1']]) {
        insert.run(id, session, 'request-1', role, JSON.stringify({ prompt_tokens: 123, completion_tokens: 7, cached_tokens: 80 }), JSON.stringify({ model_key: 'auto' }), Date.parse('2026-10-19T07:00:01Z'));
    }
    db.close();
    return { homeDir, databasePath };
}

test('JetBrains reads the CN runtime database without an explicit path', async t => {
    const { homeDir, databasePath } = await fixture(t, '.qoder-cn');
    const usage = await readQoderLocalTokenUsage('jetbrains', 'session-1', { homeDir });
    assert.equal(usage.length, 1);
    assert.equal(usage[0].messageId, 'message-1');
    assert.equal(usage[0].inputTokens, 123);
    assert.equal(resolveQoderLocalTokenDatabase('jetbrains', { homeDir }), databasePath);
});

test('JetBrains retains the legacy database fallback', async t => {
    const { homeDir, databasePath } = await fixture(t, '.qoder');
    assert.equal(resolveQoderLocalTokenDatabase('jetbrains', { homeDir }), databasePath);
    assert.equal((await readQoderLocalTokenUsage('jetbrains', 'session-1', { homeDir })).length, 1);
});

test('JetBrains prefers an existing CN database while respecting an explicit database override', async t => {
    const { homeDir, databasePath } = await fixture(t, '.qoder-cn');
    const legacy = path.join(homeDir, '.qoder/shared_client/cache/db/local.db');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.copyFileSync(databasePath, legacy);
    assert.equal(resolveQoderLocalTokenDatabase('jetbrains', { homeDir }), databasePath);
    assert.equal(resolveQoderLocalTokenDatabase('jetbrains', { homeDir, databasePath: legacy }), legacy);
});

test('A SQLite-only GUI LLM keeps its local message identity without claiming an inference response ID', async t => {
    const { homeDir, databasePath } = await fixture(t, '.qoder-cn');
    const localTokenUsage = await readQoderLocalTokenUsage('jetbrains', 'session-1', { homeDir, databasePath });
    const payload = buildQoderOtlpPayload({
        product: 'jetbrains', localTokenUsage,
        hookEvents: [
            { capturedAt: '2026-10-19T07:00:00Z', event: { hook_event_name: 'UserPromptSubmit', session_id: 'session-1', prompt: 'probe' } },
            { capturedAt: '2026-10-19T07:00:02Z', event: { hook_event_name: 'Stop', session_id: 'session-1' } },
        ],
    });
    const record = aggregateOtelTraceEvents('session-1', normalizeOtlpTraces(payload));
    assert.ok(record);
    const llm = (record.interactions as RawInteraction[]).find(item => item.role === 'assistant');
    assert.ok(llm);
    assert.equal(llm.messageID, 'message-1');
    assert.equal(record.input_tokens, 123);
    assert.equal(record.output_tokens, 7);
    assert.equal(llm.inference_response_id, undefined);
    assert.equal(llm.inference_response_unavailable, true);
    assert.ok(!llm.inference_call_ids?.length);
    assert.equal(llm.content, '');
    const tree = buildAgentCallTree(JSON.parse(JSON.stringify(record.interactions)));
    assert.ok(tree);
    const nodes = tree.events.filter(event => event.kind === 'llm');
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].interaction?.messageID, 'message-1');
    assert.equal(nodes[0].summary, '未采集到模型输出');
});

test('Empty assistant placeholders and synthetic records do not become LLM nodes', () => {
    const tree = buildAgentCallTree([
        { role: 'user', content: 'probe' },
        { role: 'assistant', content: '', messageID: 'placeholder' },
        { role: 'assistant', content: '', trace_kind: 'llm', trace_synthetic: true },
    ]);
    assert.ok(tree);
    assert.equal(tree.events.filter(event => event.kind === 'llm').length, 0);
});

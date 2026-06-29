import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the jiuwen spool at an isolated temp dir BEFORE importing the module
// (getJiuwenSpoolDir reads this env lazily, so setting it here is enough).
const TMP_SPOOL = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuwen-spool-'));
process.env.AGENT_INSIGHT_JIUWEN_SPOOL_DIR = TMP_SPOOL;

import {
    appendJiuwenSpans,
    readJiuwenSessionIndex,
    readJiuwenSpansForKeys,
    pruneJiuwenSpool,
    getJiuwenSpoolDir,
} from '@/lib/ingest/otel/jiuwen/spool';
import type { JiuwenSpan } from '@/lib/ingest/otel/jiuwen/aggregate';

function span(over: Partial<JiuwenSpan> & { spanId: string }): JiuwenSpan {
    return {
        name: 'agent.step',
        traceId: 'trace',
        parentSpanId: undefined,
        attrs: {},
        startNs: 0,
        endNs: 1,
        ...over,
    };
}

// 单 agent 隔离：两条 trace 复用硬编码 session（acp_cli_session）且无 team/task 标记，
// 不应被缝合到一起——各自独立成桶/独立聚合组。
test('single-agent traces sharing the hard-coded session are NOT stitched', () => {
    appendJiuwenSpans([
        span({ spanId: 'a1', traceId: 'traceA', attrs: { 'agentteam.session.id': 'acp_cli_session' } }),
        span({ spanId: 'b1', traceId: 'traceB', attrs: { 'agentteam.session.id': 'acp_cli_session' } }),
    ]);

    const { multiTraceSessions, sessionToKeys, keyToSession } = readJiuwenSessionIndex();
    // 没有 marker → 该 session 不是多 trace run
    assert.equal(multiTraceSessions.has('acp_cli_session'), false);
    assert.equal(keyToSession.get('traceA'), 'acp_cli_session');
    // session→keys 仍记录了两条，但因非多 trace，再聚合时各自独立（见下）
    assert.deepEqual([...(sessionToKeys.get('acp_cli_session') ?? [])].sort(), ['traceA', 'traceB']);

    // 单独读回 traceA 只拿到 traceA 的 span，不混入 traceB
    const aSpans = readJiuwenSpansForKeys(['traceA']);
    assert.deepEqual(aSpans.map((s) => s.spanId), ['a1']);
});

// team / fan-out：多条 trace 共享真实 session 且带 team.* 标记 → 应按 session 缝合。
test('team run with a marker span stitches sibling traces by session', () => {
    appendJiuwenSpans([
        span({ spanId: 'c1', traceId: 'traceC', name: 'team.start', attrs: { 'agentteam.session.id': 'sess_x' } }),
        span({ spanId: 'd1', traceId: 'traceD', name: 'agent.step', attrs: { 'agentteam.session.id': 'sess_x' } }),
    ]);

    const { multiTraceSessions, sessionToKeys } = readJiuwenSessionIndex();
    assert.equal(multiTraceSessions.has('sess_x'), true);
    assert.deepEqual([...(sessionToKeys.get('sess_x') ?? [])].sort(), ['traceC', 'traceD']);

    // 缝合组读回两条 trace 的全部 span
    const group = readJiuwenSpansForKeys(['traceC', 'traceD']);
    assert.deepEqual(group.map((s) => s.spanId).sort(), ['c1', 'd1']);
});

// 跨批 spanId 去重：同一 span 在两批到达，读回只算一次。
test('spanId is deduped across batches on read-back', () => {
    appendJiuwenSpans([span({ spanId: 'dup', traceId: 'traceDup' })]);
    appendJiuwenSpans([span({ spanId: 'dup', traceId: 'traceDup', endNs: 999 })]);

    const got = readJiuwenSpansForKeys(['traceDup']);
    assert.equal(got.length, 1);
    assert.equal(got[0].spanId, 'dup');
});

// 落盘即持久：桶文件与 session-index 真实写到磁盘（重启后可读回）。
test('spans and index are written to disk (survive restart)', () => {
    appendJiuwenSpans([
        span({ spanId: 'p1', traceId: 'tracePersist', name: 'team.x', attrs: { 'agentteam.session.id': 'sess_p' } }),
    ]);
    const bucket = path.join(getJiuwenSpoolDir(), 'buckets', 'tracePersist.jsonl');
    const index = path.join(getJiuwenSpoolDir(), 'session-index.jsonl');
    assert.equal(fs.existsSync(bucket), true);
    assert.equal(fs.existsSync(index), true);
    assert.match(fs.readFileSync(index, 'utf8'), /sess_p/);
});

// 过期清理：mtime 超过保留期的桶被删除，且 index 里对应行被剔除。
test('pruneJiuwenSpool removes stale buckets and prunes their index rows', () => {
    appendJiuwenSpans([
        span({ spanId: 'old1', traceId: 'traceOld', attrs: { 'agentteam.session.id': 'sess_old' } }),
    ]);
    const oldBucket = path.join(getJiuwenSpoolDir(), 'buckets', 'traceOld.jsonl');
    assert.equal(fs.existsSync(oldBucket), true);

    // 把桶文件 mtime 调到 10 天前（默认保留 7 天）
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldBucket, new Date(tenDaysAgo), new Date(tenDaysAgo));

    pruneJiuwenSpool(); // 进程内首次调用，throttle 放行

    assert.equal(fs.existsSync(oldBucket), false, 'stale bucket should be deleted');
    const indexAfter = fs.readFileSync(path.join(getJiuwenSpoolDir(), 'session-index.jsonl'), 'utf8');
    assert.equal(/traceOld/.test(indexAfter), false, 'index rows for deleted bucket should be gone');
    // 仍存活的桶（前面用例写的）其 index 行应保留
    assert.match(indexAfter, /traceC/);
});

test.after(() => {
    try {
        fs.rmSync(TMP_SPOOL, { recursive: true, force: true });
    } catch {
        // best-effort cleanup
    }
});

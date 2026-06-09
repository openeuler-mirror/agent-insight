import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildOpencodeTelemetryIndex } from '@/lib/observe/opencode-telemetry-index';

// 看护"有界扫描"——这是把 119 服务跑崩的 OOM 的根因修复:旧实现把整个 spool(实测 3.1GB)
// 读进内存,这里改成只读最近活动文件 + 总量/单文件封顶。

const NOW = 1_700_000_000_000;

function mkSpool(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'otel-spool-'));
}
function writeJsonl(dir: string, day: string, name: string, content: string, mtimeMs: number): void {
    const dayDir = path.join(dir, day);
    fs.mkdirSync(dayDir, { recursive: true });
    const file = path.join(dayDir, name);
    fs.writeFileSync(file, content);
    const t = mtimeMs / 1000;
    fs.utimesSync(file, t, t);
}

test('telemetry index: 识别 plugin.start(pid) + plugin.shutdown', () => {
    const spool = mkSpool();
    try {
        writeJsonl(spool, '2026-06-09', 'a.jsonl', [
            '{"kind":"plugin.start","pid":12345}',
            '{"kind":"event","sessionID":"ses_A"}',
            '{"kind":"plugin.shutdown","sessionID":"ses_A"}',
        ].join('\n'), NOW - 1000);
        const { sessions, scannedFiles } = buildOpencodeTelemetryIndex(spool, { nowMs: NOW });
        assert.equal(scannedFiles, 1);
        const a = sessions.get('ses_A');
        assert.ok(a, 'ses_A 应被索引');
        assert.equal(a!.hasShutdown, true);
        assert.ok(a!.pids.has(12345));
    } finally {
        fs.rmSync(spool, { recursive: true, force: true });
    }
});

test('telemetry index: 超龄文件(mtime 超过 maxAgeMs)被跳过', () => {
    const spool = mkSpool();
    try {
        writeJsonl(spool, '2026-06-09', 'recent.jsonl', '{"kind":"event","sessionID":"ses_R"}', NOW - 1000);
        writeJsonl(spool, '2026-06-01', 'old.jsonl', '{"kind":"plugin.shutdown","sessionID":"ses_OLD"}', NOW - 48 * 3600 * 1000);
        const { sessions, skippedFiles } = buildOpencodeTelemetryIndex(spool, { nowMs: NOW, maxAgeMs: 12 * 3600 * 1000 });
        assert.ok(sessions.has('ses_R'));
        assert.ok(!sessions.has('ses_OLD'), '48h 前的老文件不该被扫(就是这种堆积撑爆内存)');
        assert.ok(skippedFiles >= 1);
    } finally {
        fs.rmSync(spool, { recursive: true, force: true });
    }
});

test('telemetry index: 单文件超 maxFileBytes 被跳过', () => {
    const spool = mkSpool();
    try {
        const big = '{"kind":"event","sessionID":"ses_BIG"}\n'.repeat(2000);
        writeJsonl(spool, '2026-06-09', 'big.jsonl', big, NOW - 1000);
        const { sessions, skippedFiles, scannedFiles } = buildOpencodeTelemetryIndex(spool, { nowMs: NOW, maxFileBytes: 100 });
        assert.ok(!sessions.has('ses_BIG'));
        assert.equal(scannedFiles, 0);
        assert.equal(skippedFiles, 1);
    } finally {
        fs.rmSync(spool, { recursive: true, force: true });
    }
});

test('telemetry index: 总预算用尽后停止(内存有界,新文件优先)', () => {
    const spool = mkSpool();
    try {
        const newer = '{"kind":"event","sessionID":"ses_NEWER______"}'; // 固定长度
        const older = '{"kind":"event","sessionID":"ses_OLDER______"}';
        writeJsonl(spool, '2026-06-09', 'newer.jsonl', newer, NOW - 1000);
        writeJsonl(spool, '2026-06-09', 'older.jsonl', older, NOW - 5000);
        // 预算只够一个文件(每个 ~46 bytes)
        const { sessions, scannedFiles, skippedFiles } = buildOpencodeTelemetryIndex(spool, { nowMs: NOW, maxTotalBytes: newer.length + 5 });
        assert.equal(scannedFiles, 1, '只应扫到 1 个文件');
        assert.ok(sessions.has('ses_NEWER______'), '新文件优先扫到');
        assert.ok(!sessions.has('ses_OLDER______'), '预算用尽,旧文件不扫');
        assert.ok(skippedFiles >= 1);
    } finally {
        fs.rmSync(spool, { recursive: true, force: true });
    }
});

test('telemetry index: spool 不存在 → 空结果、不抛错', () => {
    const { sessions, scannedFiles, skippedFiles } = buildOpencodeTelemetryIndex(path.join(os.tmpdir(), 'no-such-spool-xyz-123'), { nowMs: NOW });
    assert.equal(sessions.size, 0);
    assert.equal(scannedFiles, 0);
    assert.equal(skippedFiles, 0);
});

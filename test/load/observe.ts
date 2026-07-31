/**
 * 压测观测器：外部视角采样，不依赖被测进程内部状态。
 *
 * 每 2 秒采一次：
 *   - DB 里 Execution 行数（真实入库吞吐）
 *   - 每个 taskId 的首次可见时刻（对齐 reporter 的 sentAt 即得端到端可见延迟）
 *   - spool 文件数与字节数（待处理积压的外部代理指标）
 *
 * 用法：node --import tsx test/load/observe.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CONFIG = {
  dbPath: process.env.OBSERVE_DB || '',
  spoolDir: process.env.OBSERVE_SPOOL || '',
  intervalMs: Number(process.env.OBSERVE_INTERVAL_MS || 2000),
  durationSec: Number(process.env.OBSERVE_DURATION || 240),
  outDir: process.env.OBSERVE_OUT || path.join(process.cwd(), 'load-results'),
};

if (!CONFIG.dbPath || !CONFIG.spoolDir) {
  console.error('需要 OBSERVE_DB 和 OBSERVE_SPOOL');
  process.exit(1);
}

fs.mkdirSync(CONFIG.outDir, { recursive: true });
const sampleStream = fs.createWriteStream(path.join(CONFIG.outDir, 'observe.jsonl'), { flags: 'a' });
const firstSeenStream = fs.createWriteStream(path.join(CONFIG.outDir, 'db-firstseen.jsonl'), { flags: 'a' });

const seen = new Set<string>();

function sqlite(sql: string): string {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return execFileSync('sqlite3', ['-readonly', CONFIG.dbPath, sql], { encoding: 'utf8' }).trim();
    } catch {
      // 写入中被锁住时重试；连续失败就当本轮采样缺失
    }
  }
  return '';
}

function spoolStats(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (current: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files += 1;
        try { bytes += fs.statSync(full).size; } catch {}
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

const startedAt = Date.now();
console.log(`[observe] db=${CONFIG.dbPath} spool=${CONFIG.spoolDir} 每 ${CONFIG.intervalMs}ms 采样，共 ${CONFIG.durationSec}s`);

const timer = setInterval(() => {
  const now = Date.now();
  const elapsed = Math.round((now - startedAt) / 1000);

  const count = Number(sqlite('SELECT COUNT(*) FROM Execution;') || '0');
  const newIds = sqlite("SELECT taskId FROM Execution WHERE taskId IS NOT NULL;")
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const id of newIds) {
    if (!seen.has(id)) {
      seen.add(id);
      firstSeenStream.write(`${JSON.stringify({ taskId: id, seenAt: now })}\n`);
    }
  }

  const spool = spoolStats(CONFIG.spoolDir);
  const line = { t: elapsed, executions: count, spoolFiles: spool.files, spoolMB: Number((spool.bytes / 1024 / 1024).toFixed(2)) };
  sampleStream.write(`${JSON.stringify(line)}\n`);
  if (elapsed % 20 === 0) {
    console.log(`[observe] t=${elapsed}s 入库=${count} spool 文件=${spool.files} spool=${line.spoolMB}MB`);
  }

  if (now - startedAt >= CONFIG.durationSec * 1000) {
    clearInterval(timer);
    sampleStream.end();
    firstSeenStream.end();
    console.log(`[observe] 结束：入库 ${count} 条，spool ${spool.files} 文件 / ${line.spoolMB}MB`);
    process.exit(0);
  }
}, CONFIG.intervalMs);

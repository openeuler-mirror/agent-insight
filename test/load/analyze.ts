/**
 * 压测结果分析：把 reporter / observer / server 日志汇成一张可对比的表。
 *
 * 用法：node --import tsx test/load/analyze.ts <结果目录> [<结果目录2> ...]
 */
import fs from 'node:fs';
import path from 'node:path';

type Row = Record<string, any>;

function readJsonl(file: string): Row[] {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((row): row is Row => row !== null);
  } catch {
    return [];
  }
}

function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function analyze(dir: string) {
  const sent = readJsonl(path.join(dir, 'sent-traces.jsonl'));
  const firstSeen = readJsonl(path.join(dir, 'db-firstseen.jsonl'));
  const samples = readJsonl(path.join(dir, 'observe.jsonl'));
  const cpu = readJsonl(path.join(dir, 'cpu.jsonl'));

  const seenAt = new Map<string, number>();
  for (const row of firstSeen) if (!seenAt.has(row.taskId)) seenAt.set(row.taskId, row.seenAt);

  const latencies: number[] = [];
  let missing = 0;
  for (const row of sent) {
    const seen = seenAt.get(row.traceId);
    if (seen === undefined) missing += 1;
    else latencies.push(seen - row.sentAt);
  }

  const last = samples[samples.length - 1] || {};
  const peakSpool = samples.reduce((max, s) => Math.max(max, s.spoolFiles || 0), 0);
  const peakMB = samples.reduce((max, s) => Math.max(max, s.spoolMB || 0), 0);

  // 上报窗口(前 180s)内的稳态入库速率：取 t=60..180 的斜率，避开冷启动
  const window = samples.filter((s) => s.t >= 60 && s.t <= 180);
  const throughput = window.length >= 2
    ? ((window[window.length - 1].executions - window[0].executions) / (window[window.length - 1].t - window[0].t)) * 60
    : NaN;

  const cpuValues = cpu.map((row) => Number(row.cpu)).filter((n) => Number.isFinite(n));

  return {
    label: path.basename(dir),
    上报条数: sent.length,
    最终入库: last.executions ?? 0,
    入库占比: sent.length ? `${((100 * (last.executions ?? 0)) / sent.length).toFixed(1)}%` : '-',
    稳态入库速率: Number.isFinite(throughput) ? `${throughput.toFixed(0)} 条/分钟` : '-',
    spool峰值文件数: peakSpool,
    spool峰值: `${peakMB.toFixed(1)}MB`,
    可见延迟P50: latencies.length ? `${(percentile(latencies, 0.5) / 1000).toFixed(1)}s` : '-',
    可见延迟P95: latencies.length ? `${(percentile(latencies, 0.95) / 1000).toFixed(1)}s` : '-',
    可见延迟最大: latencies.length ? `${(Math.max(...latencies) / 1000).toFixed(1)}s` : '-',
    观察窗内仍不可见: missing,
    CPU均值: cpuValues.length ? `${(cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length).toFixed(0)}%` : '-',
    CPU峰值: cpuValues.length ? `${Math.max(...cpuValues).toFixed(0)}%` : '-',
  };
}

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error('用法：node --import tsx test/load/analyze.ts <结果目录> ...');
  process.exit(1);
}

const results = dirs.map(analyze);
console.table(results);

for (const dir of dirs) {
  const serverLog = path.join(dir, 'server.log');
  if (!fs.existsSync(serverLog)) continue;
  const text = fs.readFileSync(serverLog, 'utf8');
  const costs = [...text.matchAll(/slow aggregate[\s\S]{0,200}?costMs:\s*\x1b?\[?\d*m?(\d+)/g)].map((m) => Number(m[1]));
  const backlogs = [...text.matchAll(/backlog:\s*\x1b?\[?\d*m?(\d+)/g)].map((m) => Number(m[1]));
  console.log(`\n[${path.basename(dir)}] slow aggregate 样本 ${costs.length} 个` +
    (costs.length ? `：P50 ${percentile(costs, 0.5)}ms / P95 ${percentile(costs, 0.95)}ms / 最大 ${Math.max(...costs)}ms` : '') +
    (backlogs.length ? `；backlog 峰值 ${Math.max(...backlogs)}` : ''));
}

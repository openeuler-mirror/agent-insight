import assert from 'node:assert/strict';
import test from 'node:test';

import { CSV_COLUMNS, README_COLUMN, csvFileName, toCsv, type ExportContext } from '@/lib/infra/export-csv';
import { buildExportRows } from '@/lib/infra/history';
import type { Histogram, InfraMetricSample } from '@/lib/infra/types';

function hist(le: number, count: number): Histogram {
  return { buckets: [{ le, count }, { le: Infinity, count }], sum: le * count, count };
}
// hc=累计完成数（相邻帧不同 → 直方图差分非零）；withHist=false 模拟「这一帧没有延迟数据」
function snap(tsMs: number, counters: Record<string, number>, hc = 0): InfraMetricSample {
  const histograms: Record<string, Histogram> = {};
  if (hc > 0) {
    for (const k of ['vllm:time_to_first_token_seconds', 'vllm:request_queue_time_seconds',
      'vllm:request_prefill_time_seconds', 'vllm:e2e_request_latency_seconds',
      'vllm:inter_token_latency_seconds', 'vllm:request_time_per_output_token_seconds']) {
      histograms[k] = hist(0.5, hc);
    }
  }
  return {
    tsMs, source: 't', target: 'http://x:8000', model: 'M',
    gauges: { 'vllm:num_requests_running': 4, 'vllm:num_requests_waiting': 2, 'vllm:kv_cache_usage_perc': 0.42 },
    counters, histograms, waitingByReason: { capacity: 2, deferred: 0 },
  };
}
const ctx: ExportContext = {
  endpoint: 'http://100.125.177.5:8000', model: 'Qwen3-Coder-30B-A3B-Instruct-FP8',
  hardwareName: 'NVIDIA GB10', memBandwidthGBs: 273,
  fromMs: 1782885600000, toMs: 1782886200000, rateWindowMs: 30_000,
  sampleCount: 2, generatedAtMs: 1782886300000,
};
// 极简 CSV 解析：够用即可，只需处理带引号的 _readme 字段
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function parse(csv: string) {
  const lines = csv.trimEnd().split('\n');
  const cols = splitCsvLine(lines[0]);
  const rows = lines.slice(1).map((l) => Object.fromEntries(splitCsvLine(l).map((v, i) => [cols[i], v])));
  return { cols, rows, notes: rows.map((r) => r[README_COLUMN]).filter(Boolean) };
}

test('CSV：列名自带单位，且与写入顺序严格一致', () => {
  const rows = buildExportRows([
    snap(0, { 'vllm:prompt_tokens_total': 0, 'vllm:generation_tokens_total': 0 }, 10),
    snap(10_000, { 'vllm:prompt_tokens_total': 10_000, 'vllm:generation_tokens_total': 500 }, 20),
  ]);
  const { cols, rows: recs } = parse(toCsv(rows, ctx));
  // 单位写在列名里：秒 vs 毫秒不能靠猜
  for (const c of ['ttft_p95_s', 'e2e_p99_s', 'itl_p50_ms', 'tpot_p95_ms', 'kv_usage_pct', 'prompt_tok_per_s']) {
    assert.ok(cols.includes(c), `缺列 ${c}`);
  }
  assert.deepEqual(cols, [...CSV_COLUMNS], '表头必须与 CSV_COLUMNS 一致');
  assert.equal(recs.length, 2, '一行一个原始采样点，不降采样');
  // 速率 = 10000 token / 10s
  assert.equal(recs[1].prompt_tok_per_s, '1000');
  assert.equal(recs[1].gen_tok_per_s, '50');
  assert.equal(recs[1].kv_usage_pct, '42');
});

test('CSV：无数据的格子留空，绝不填 0（0 会被读成「延迟降到 0」）', () => {
  // 两帧都没有直方图 → 分位全空；prefix 计数器不动 → 命中率也应为空
  const rows = buildExportRows([
    snap(0, { 'vllm:prefix_cache_queries_total': 500, 'vllm:prefix_cache_hits_total': 400 }),
    snap(2000, { 'vllm:prefix_cache_queries_total': 500, 'vllm:prefix_cache_hits_total': 400 }),
  ]);
  const { rows: recs } = parse(toCsv(rows, ctx));
  for (const c of ['ttft_p50_s', 'ttft_p95_s', 'e2e_p99_s', 'itl_p95_ms', 'prefix_hit_pct']) {
    assert.equal(recs[1][c], '', `${c} 应留空，实际=${JSON.stringify(recs[1][c])}`);
  }
  // 但 gauge 类是真实读数 0/有值，不该被当成缺失
  assert.equal(recs[1].running, '4');
});

test('CSV：裸累计计数器可独立复核速率列 + 精确算区间总量', () => {
  const rows = buildExportRows([
    snap(0, { 'vllm:prompt_tokens_total': 1_000_000, 'vllm:generation_tokens_total': 20_000 }),
    snap(30_000, { 'vllm:prompt_tokens_total': 1_030_000, 'vllm:generation_tokens_total': 20_600 }),
  ]);
  const { rows: recs } = parse(toCsv(rows, ctx));
  const dPrompt = Number(recs[1].prompt_tokens_total) - Number(recs[0].prompt_tokens_total);
  const dtS = (Number(recs[1].ts_ms) - Number(recs[0].ts_ms)) / 1000;
  assert.equal(dPrompt, 30_000, '首尾相减 = 区间精确总量');
  assert.equal(Number(recs[1].prompt_tok_per_s), dPrompt / dtS, '速率列应能被裸计数器复现');
});

test('CSV：第 1 行就是真表头（Excel 能认），口径说明在最右 _readme 列', () => {
  const samples = Array.from({ length: 30 }, (_, i) => snap(i * 2000, {}));
  const csv = toCsv(buildExportRows(samples), ctx);
  const { cols, rows: recs, notes } = parse(csv);

  assert.equal(cols[0], 'ts_iso', '第 1 行第 1 格必须是数据表头，不能是注释');
  assert.equal(cols[cols.length - 1], README_COLUMN, '说明列在最后');
  assert.ok(!csv.split('\n')[0].startsWith('#'), '不应再有 # 注释块占据开头');
  assert.equal(recs.length, samples.length, '说明列不得增加或减少数据行');

  const text = notes.join('\n');
  assert.match(text, /30s 回看窗口内的端点差分/, '必须说明速率不是相邻帧瞬时差分');
  assert.match(text, /不是开机至今的累计分位/, '必须说明分位是窗口口径');
  assert.match(text, /空单元格 = 该点无数据/, '必须说明空值语义');
  assert.match(text, /100\.125\.177\.5:8000/);
  assert.match(text, /NVIDIA GB10/);
});

test('CSV：说明含逗号也不会撑破列数（RFC4180 引号转义）', () => {
  const samples = Array.from({ length: 30 }, (_, i) => snap(i * 2000, {}));
  const csv = toCsv(buildExportRows(samples), ctx);
  const expected = CSV_COLUMNS.length;
  for (const [i, line] of csv.trimEnd().split('\n').entries()) {
    assert.equal(splitCsvLine(line).length, expected, `第 ${i + 1} 行列数应为 ${expected}`);
  }
});

test('CSV：说明行比数据行多时，剩余说明并进最后一格，不造空数据行', () => {
  const samples = [snap(0, {}), snap(2000, {}), snap(4000, {})]; // 只有 3 行，说明有 15 条
  const { rows: recs, notes } = parse(toCsv(buildExportRows(samples), ctx));
  assert.equal(recs.length, 3, '绝不为了塞说明而增加数据行');
  assert.match(notes.join(' '), /空单元格 = 该点无数据/, '被截掉的说明应并入最后一格而非丢失');
});

test('CSV：分位单调 p50 ≤ p95 ≤ p99', () => {
  const multi = (c1: number, c2: number, c3: number): Histogram => ({
    buckets: [{ le: 1, count: c1 }, { le: 5, count: c2 }, { le: 20, count: c3 }, { le: Infinity, count: c3 }],
    sum: 0, count: c3,
  });
  const mk = (tsMs: number, c1: number, c2: number, c3: number): InfraMetricSample => ({
    tsMs, source: 't', target: 't', model: 'M', gauges: {}, counters: {},
    histograms: { 'vllm:e2e_request_latency_seconds': multi(c1, c2, c3) }, waitingByReason: {},
  });
  const rows = buildExportRows([mk(0, 0, 0, 0), mk(5000, 50, 90, 100)]);
  const r = rows[1].e2e;
  assert.ok(r.p50 != null && r.p95 != null && r.p99 != null);
  assert.ok(r.p50! <= r.p95! && r.p95! <= r.p99!, `分位应单调: ${r.p50} / ${r.p95} / ${r.p99}`);
});

test('文件名安全且带时间戳', () => {
  const n = csvFileName(ctx);
  assert.match(n, /^infra-100\.125\.177\.5_8000-2026-07-01_.*\.csv$/);
  assert.ok(!/[^A-Za-z0-9._-]/.test(n), `文件名含不安全字符: ${n}`);
  assert.ok(!n.includes('--') && !n.includes('-.csv'), `不应有多余横杠: ${n}`);
});

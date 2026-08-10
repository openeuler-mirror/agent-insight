import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALL_GROUPS, METRIC_GROUPS, README_COLUMN, exportFileName, parseGroups,
  selectColumns, toCsv, toMarkdown, type ExportContext, type MetricGroup,
} from '@/lib/infra/export';
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
  assert.deepEqual(cols, [...selectColumns(ALL_GROUPS).map((c) => c.key), README_COLUMN], '表头必须与列规格一致');
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
  const expected = selectColumns(ALL_GROUPS).length + 1; // +1 = _readme
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

test('文件名安全且带时间戳，扩展名随格式', () => {
  for (const fmt of ['csv', 'md'] as const) {
    const n = exportFileName(ctx, fmt);
    assert.match(n, new RegExp(`^infra-100\\.125\\.177\\.5_8000-2026-07-01_.*\\.${fmt}$`));
    assert.ok(!/[^A-Za-z0-9._-]/.test(n), `文件名含不安全字符: ${n}`);
    assert.ok(!n.includes('--') && !n.includes(`-.${fmt}`), `不应有多余横杠: ${n}`);
  }
});

// ——————————————— 指标选择 ———————————————

test('指标选择：只勾吞吐 → 只出吞吐列，时间列仍在', () => {
  const rows = buildExportRows([
    snap(0, { 'vllm:prompt_tokens_total': 0 }, 10),
    snap(10_000, { 'vllm:prompt_tokens_total': 10_000 }, 20),
  ]);
  const { cols } = parse(toCsv(rows, ctx, ['throughput']));
  assert.deepEqual(cols, ['ts_iso', 'ts_ms', 'prompt_tok_per_s', 'gen_tok_per_s', README_COLUMN]);
});

test('指标选择：时间列永远在（它是索引，没它整份数据没法用）', () => {
  const rows = buildExportRows([snap(0, {}), snap(2000, {})]);
  for (const g of ALL_GROUPS) {
    const { cols } = parse(toCsv(rows, ctx, [g]));
    assert.equal(cols[0], 'ts_iso', `分组 ${g} 缺 ts_iso`);
    assert.equal(cols[1], 'ts_ms', `分组 ${g} 缺 ts_ms`);
    assert.ok(cols.length > 3, `分组 ${g} 应至少带出一个数据列`);
  }
});

test('指标选择：每个分组都真的映射到列，且分组之间不重叠、并集=全集', () => {
  const seen = new Set<string>();
  for (const g of ALL_GROUPS) {
    const keys = selectColumns([g]).map((c) => c.key).filter((k) => !k.startsWith('ts_'));
    assert.ok(keys.length > 0, `分组 ${g} 没有任何列`);
    for (const k of keys) {
      assert.ok(!seen.has(k), `列 ${k} 同时属于多个分组`);
      seen.add(k);
    }
  }
  const all = selectColumns(ALL_GROUPS).map((c) => c.key).filter((k) => !k.startsWith('ts_'));
  assert.deepEqual([...seen].sort(), [...all].sort(), '各分组的并集应等于全集');
});

test('parseGroups：缺省/空/全非法 → 全选（宁可多给也不给缺列的数据）', () => {
  assert.deepEqual(parseGroups(null), ALL_GROUPS);
  assert.deepEqual(parseGroups(''), ALL_GROUPS);
  assert.deepEqual(parseGroups('nonsense,alsobad'), ALL_GROUPS);
  assert.deepEqual(parseGroups('throughput,kv'), ['kv', 'throughput'], '应按固定顺序返回，与勾选先后无关');
  assert.deepEqual(parseGroups(' throughput , bogus '), ['throughput'], '容忍空格、忽略非法项');
});

test('口径说明只讲导出了的列：挑了两个指标就不该读到讲别的列的条款', () => {
  const rows = buildExportRows([snap(0, {}, 5), snap(2000, {}, 9)]);
  const md = toMarkdown(rows, ctx, ['throughput', 'kv']);
  assert.match(md, /回看窗口内的端点差分/, '选了吞吐 → 必须讲速率口径');
  assert.match(md, /kv_usage_pct 已由 0~1 换算/, '选了 KV → 必须讲换算');
  assert.match(md, /空单元格 = 该点无数据/, '空值语义永远要讲');
  // 这些列压根没导出，讲了就是噪声，还会诱导模型去找不存在的字段
  assert.ok(!md.includes('prefix_hit_pct 是窗口口径'), '没选 prefix 却讲了 prefix');
  assert.ok(!md.includes('*_total 列是 vLLM 启动至今'), '没选计数器却讲了计数器');
  assert.ok(!md.includes('ITL/TPOT 是毫秒'), '没选延迟却讲了延迟单位');
  assert.ok(!md.includes('直方图桶差分'), '没选延迟却讲了分位口径');
});

test('口径条款编号连续，不会因为条件过滤而跳号', () => {
  for (const groups of [['kv'], ['throughput', 'prefix'], ALL_GROUPS] as MetricGroup[][]) {
    const md = toMarkdown(buildExportRows([snap(0, {}), snap(2000, {})]), ctx, groups);
    const nums = [...md.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    assert.deepEqual(nums, nums.map((_, i) => i + 1), `分组 ${groups} 的条款编号应为 1..n 连续`);
  }
});

test('指标选择：口径说明里写明了本次导出包含哪些指标', () => {
  const rows = buildExportRows([snap(0, {}), snap(2000, {})]);
  assert.match(toMarkdown(rows, ctx, ['throughput']), /metrics: 吞吐 tok\/s/);
  assert.match(toMarkdown(rows, ctx, ALL_GROUPS), /metrics: 全部指标/);
});

// ——————————————— Markdown ———————————————

function mdTable(md: string) {
  const lines = md.split('\n');
  const i = lines.findIndex((l) => l.startsWith('| ts_iso'));
  if (i < 0) return { header: [], rows: [] as string[][] };
  const cell = (l: string) => l.slice(1, -1).split('|').map((s) => s.trim());
  const rows: string[][] = [];
  for (let j = i + 2; j < lines.length && lines[j].startsWith('|'); j++) rows.push(cell(lines[j]));
  return { header: cell(lines[i]), rows };
}

test('Markdown：口径说明是独立章节（这正是相对 CSV 的优势），且列说明齐全', () => {
  const rows = buildExportRows([snap(0, {}, 5), snap(2000, {}, 9)]);
  const md = toMarkdown(rows, ctx, ALL_GROUPS);
  assert.match(md, /^# vLLM 推理 Infra 时序数据导出/, '有一级标题');
  for (const sec of ['## 采集上下文', '## 口径说明', '## 列说明', '## 数据']) {
    assert.ok(md.includes(sec), `缺章节 ${sec}`);
  }
  assert.match(md, /30s 回看窗口内的端点差分/);
  assert.match(md, /不是开机至今的累计分位/);
  assert.match(md, /空单元格 = 该点无数据/);
  // 列说明必须覆盖每一个导出的列，否则模型读到不认识的列名
  for (const c of selectColumns(ALL_GROUPS)) {
    assert.ok(md.includes(`\`${c.key}\``), `列说明缺 ${c.key}`);
  }
});

test('Markdown：表格结构合法，每行单元格数 = 表头数', () => {
  const rows = buildExportRows(Array.from({ length: 12 }, (_, i) => snap(i * 2000, {}, i + 1)));
  const { header, rows: recs } = mdTable(toMarkdown(rows, ctx, ALL_GROUPS));
  assert.equal(header.length, selectColumns(ALL_GROUPS).length);
  assert.equal(recs.length, 12, '一行一个采样点');
  for (const [i, r] of recs.entries()) {
    assert.equal(r.length, header.length, `第 ${i + 1} 行单元格数不符`);
  }
});

test('Markdown：与 CSV 同源——同样的行、同样的数值', () => {
  const samples = [
    snap(0, { 'vllm:prompt_tokens_total': 0, 'vllm:generation_tokens_total': 0 }, 10),
    snap(10_000, { 'vllm:prompt_tokens_total': 10_000, 'vllm:generation_tokens_total': 500 }, 20),
  ];
  const rows = buildExportRows(samples);
  const groups: MetricGroup[] = ['throughput', 'kv'];
  const { rows: csvRecs, cols } = parse(toCsv(rows, ctx, groups));
  const { header, rows: mdRecs } = mdTable(toMarkdown(rows, ctx, groups));
  const dataCols = cols.filter((c) => c !== README_COLUMN);
  assert.deepEqual(header, dataCols, '两种格式列集必须一致');
  assert.equal(mdRecs.length, csvRecs.length);
  for (const [i, r] of mdRecs.entries()) {
    for (const [j, c] of dataCols.entries()) {
      assert.equal(r[j], csvRecs[i][c], `第 ${i + 1} 行 ${c} 两格式不一致`);
    }
  }
});

test('Markdown：空数据段给出明确说明，而不是一张空表', () => {
  const md = toMarkdown([], { ...ctx, sampleCount: 0 }, ALL_GROUPS);
  assert.match(md, /没有采样数据/);
  assert.ok(!md.includes('| ts_iso'), '不该渲染空表头');
});

test('Markdown：单元格里的 | 被转义，不会撑破表格', () => {
  const weird = { ...ctx, model: 'a|b|c' };
  const md = toMarkdown(buildExportRows([snap(0, {}), snap(2000, {})]), weird, ALL_GROUPS);
  const { header, rows } = mdTable(md);
  for (const r of rows) assert.equal(r.length, header.length);
});

test('分组标签与 key 一一对应，无重复', () => {
  const keys = METRIC_GROUPS.map((g) => g.key);
  assert.equal(new Set(keys).size, keys.length, 'key 不得重复');
  assert.deepEqual(keys, ALL_GROUPS, 'ALL_GROUPS 应与 METRIC_GROUPS 同序');
  for (const g of METRIC_GROUPS) assert.ok(g.label.length > 0, `${g.key} 缺标签`);
});

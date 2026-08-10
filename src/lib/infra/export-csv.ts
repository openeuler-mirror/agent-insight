// Infra 时序数据导出成 CSV。使用场景是「把这段时间的数据丢给大模型分析」，
// 所以有三条不太常规但很关键的约定：
//
//   ① **列名自带单位**（ttft_p95_s / itl_p95_ms / kv_usage_pct …）。
//      裸列名递给 LLM 必被误读 —— ttft 是秒、itl 是毫秒，挨在一起就是陷阱。
//   ② **空值留空，绝不填 0**。窗口内无新完成请求时分位是 null，填 0 会让下游得出
//      「延迟降到 0」「命中率跌到 0」这种反向结论。留空 → pandas 读成 NaN，语义正确。
//   ③ **口径说明放在最右的 _readme 列**，不放文件开头的 # 注释块。
//      口径本身必须随数据走（速率是回看窗口端点差分、分位是窗口差分而非累计，
//      不写清楚下游一定按瞬时值理解），但放在开头会占掉前 20 行、Excel 就认不出
//      表头了。挪到右侧后第 1 行仍是真表头，Excel/pandas 都正常，说明也还在文件里。

import type { ExportRow, Q } from '@/lib/infra/history';

export interface ExportContext {
  endpoint: string;
  model: string | null;
  hardwareName: string | null;
  memBandwidthGBs: number | null;
  fromMs: number;
  toMs: number;
  rateWindowMs: number;
  /** 落库的原始样本数（= CSV 数据行数，本导出不做降采样） */
  sampleCount: number;
  /** 生成时刻，由调用方传入（保持本模块是纯函数，便于测试） */
  generatedAtMs: number;
}

// 列顺序即语义分组：时间 → 调度 → 显存 → 缓存 → 吞吐 → 延迟 → 异常 → 裸计数器 → 说明
const DATA_COLUMNS = [
  'ts_iso', 'ts_ms',
  'running', 'waiting', 'waiting_capacity', 'waiting_deferred',
  'kv_usage_pct',
  'prefix_hit_pct',
  'prompt_tok_per_s', 'gen_tok_per_s',
  'ttft_p50_s', 'ttft_p95_s', 'ttft_p99_s',
  'queue_p50_s', 'queue_p95_s', 'queue_p99_s',
  'prefill_p50_s', 'prefill_p95_s', 'prefill_p99_s',
  'e2e_p50_s', 'e2e_p95_s', 'e2e_p99_s',
  'itl_p50_ms', 'itl_p95_ms', 'itl_p99_ms',
  'tpot_p50_ms', 'tpot_p95_ms', 'tpot_p99_ms',
  'preempt_per_s',
  'prompt_tokens_total', 'generation_tokens_total',
  'prefix_cache_queries_total', 'prefix_cache_hits_total', 'num_preemptions_total',
] as const;
/** 口径说明列。放最后一列，前面全是数据列，Excel 里往右拉一屏就能看到。 */
export const README_COLUMN = '_readme';
export const CSV_COLUMNS = [...DATA_COLUMNS, README_COLUMN] as const;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
// null → 空字符串（见约定②）。保留至多 4 位小数并去掉尾随 0，避免 0.30000000000000004 这种噪声。
function num(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '';
  return String(Number(v.toFixed(4)));
}
function q3(q: Q): string[] {
  return [num(q.p50), num(q.p95), num(q.p99)];
}
// RFC4180 转义：含逗号/引号/换行的字段必须加引号，内部引号翻倍。
// 数据列都是数字进不来，但 _readme 是中文长句，必须走这条。
function esc(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** 口径说明的逐行文本，写进 _readme 列。 */
function readmeLines(ctx: ExportContext): string[] {
  const hw = ctx.hardwareName
    ? `${ctx.hardwareName}${ctx.memBandwidthGBs ? ` (显存带宽 ${ctx.memBandwidthGBs} GB/s)` : ''}`
    : '未登记';
  return [
    'vLLM 推理 Infra 时序数据导出（agent-insight）。本列仅为说明，不是数据。',
    `endpoint: ${ctx.endpoint}`,
    `model: ${ctx.model ?? '(未指定)'}`,
    `hardware: ${hw}`,
    `time_range: ${iso(ctx.fromMs)} ~ ${iso(ctx.toMs)}（ts_iso 为 UTC）`,
    `rows: ${ctx.sampleCount} —— 每行 = 一个原始采样点，未做降采样`,
    `generated_at: ${iso(ctx.generatedAtMs)}`,
    '—— 口径说明（不看这段容易误读）——',
    `1) *_tok_per_s / preempt_per_s 是速率，算法为 ${ctx.rateWindowMs / 1000}s 回看窗口内的端点差分（counter 末值减首值 ÷ 实际跨度），不是相邻两帧的瞬时差分。vLLM 的 token 计数器是突发式跳变且推送间隔抖动，用相邻帧差分会把读数放大 1~2 个数量级。`,
    '2) *_p50/p95/p99 来自「该窗口内新完成请求」的直方图桶差分，不是开机至今的累计分位。窗口内无新完成请求时留空（不是 0）。',
    '3) 单位看列名：TTFT/queue/prefill/e2e 是秒（_s），ITL/TPOT 是毫秒（_ms）。',
    '4) prefix_hit_pct 是窗口口径（窗口内新增命中 ÷ 新增查询），不是累计命中率。',
    '5) kv_usage_pct 已由 0~1 换算成百分比。',
    '6) *_total 列是 vLLM 启动至今的累计原值，未经加工：可独立复核上面的速率，也可首尾相减精确得到区间总量（用速率列积分会有误差）。',
    '7) 空单元格 = 该点无数据，请按缺失值处理，不要当 0。',
  ];
}

/** ExportRow[] + 上下文 → CSV 文本。纯函数。 */
export function toCsv(rows: ExportRow[], ctx: ExportContext): string {
  const notes = readmeLines(ctx);
  // 说明行比数据行还多时（导出窗口极短），把剩余说明并进最后一格，绝不为了塞说明而造空数据行。
  if (rows.length > 0 && notes.length > rows.length) {
    const head = notes.slice(0, rows.length - 1);
    notes.splice(0, notes.length, ...head, notes.slice(rows.length - 1).join(' '));
  }

  const lines: string[] = [CSV_COLUMNS.join(',')];
  rows.forEach((r, i) => {
    lines.push([
      iso(r.tsMs), String(r.tsMs),
      num(r.running), num(r.waiting), num(r.waitingCapacity), num(r.waitingDeferred),
      num(r.kvPerc),
      num(r.prefixHitPerc),
      num(r.promptTokPerS), num(r.genTokPerS),
      ...q3(r.ttft), ...q3(r.queue), ...q3(r.prefill), ...q3(r.e2e),
      ...q3(r.itlMs), ...q3(r.tpotMs),
      num(r.preemptRate),
      num(r.promptTokensTotal), num(r.generationTokensTotal),
      num(r.prefixCacheQueriesTotal), num(r.prefixCacheHitsTotal), num(r.numPreemptionsTotal),
      esc(notes[i] ?? ''),
    ].join(','));
  });
  // 一条数据都没有时，至少让说明能被看到（否则用户拿到一个只有表头的空文件，无从判断是没数据还是导错了）
  if (rows.length === 0) {
    for (const n of notes) lines.push(`${','.repeat(DATA_COLUMNS.length)}${esc(n)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** 下载文件名：infra-<host>-<起>-<止>.csv，只保留文件名安全字符。 */
export function csvFileName(ctx: ExportContext): string {
  let host = ctx.endpoint;
  try { host = new URL(ctx.endpoint).host; } catch { /* endpoint 可能不是合法 URL，原样用 */ }
  // 2026-07-01T04:00:00.000Z → 2026-07-01_04-00（到分钟，且不留尾部横杠）
  const stamp = (ms: number) => iso(ms).replace(/:/g, '-').replace('T', '_').slice(0, 16);
  const safe = `${host}-${stamp(ctx.fromMs)}_${stamp(ctx.toMs)}`.replace(/[^A-Za-z0-9._-]+/g, '_');
  return `infra-${safe}.csv`.slice(0, 160);
}

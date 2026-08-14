// Infra 时序数据导出。两种格式共用一套列规格与口径文案：
//   · CSV      —— 给 Excel / pandas，也能喂模型；体积小
//   · Markdown —— 给大模型直读。优势在于口径说明可以写成正经的章节散文，
//                 而不必像 CSV 那样挤在一列里（CSV 没有"表外元信息"的位置）。
//
// 贯穿两种格式的约定（都是为了「下游是大模型」这个前提）：
//   ① **列名自带单位**（ttft_p95_s / itl_p95_ms / kv_usage_pct）。裸列名必被误读
//      —— TTFT 是秒、ITL 是毫秒，挨在一起就是陷阱。
//   ② **列名自带聚合方式**（降采样时加 _max / _avg / _last 后缀）。不同列的聚合
//      口径不同（峰值保 max、吞吐取 avg），混在一张表里而不标注，下游会拿桶内
//      最大值当瞬时值做相关分析。列名不同 = 数据确实不同，自解释、不依赖读说明。
//   ③ **空值留空，绝不填 0**。窗口内无新完成请求时分位是 null；填 0 会让下游得出
//      「延迟降到 0」「命中率跌到 0」这种反向结论。
//   ④ **口径必须随数据走**，且只讲导出了的列——讲不存在的列是纯噪声。

import type { ExportRow, Q } from '@/lib/infra/history';

export interface ExportContext {
  endpoint: string;
  model: string | null;
  hardwareName: string | null;
  memBandwidthGBs: number | null;
  fromMs: number;
  toMs: number;
  rateWindowMs: number;
  /** 落库的原始样本数 */
  sampleCount: number;
  /** 生成时刻，由调用方传入（保持本模块是纯函数，便于测试） */
  generatedAtMs: number;
}

// ——— 指标分组：与源详情页那 8 张面板一一对应 ———
// 用户是「看完图之后」才导出的，所以按面板分组比按单列勾选更贴合心智模型。
export const METRIC_GROUPS = [
  { key: 'scheduling', label: '调度：并发 / 排队' },
  { key: 'queue_reason', label: '排队原因：容量 / 延后' },
  { key: 'kv', label: 'KV 使用率' },
  { key: 'prefix', label: 'Prefix 命中率' },
  { key: 'throughput', label: '吞吐 tok/s' },
  { key: 'ttft', label: '首 token 延迟分段：TTFT / queue / prefill' },
  { key: 'decode', label: 'decode 延迟：ITL / TPOT' },
  { key: 'e2e', label: '端到端延迟' },
  { key: 'preempt', label: '抢占' },
  { key: 'counters', label: '裸累计计数器（可复核速率 / 算区间总量）' },
] as const;
export type MetricGroup = (typeof METRIC_GROUPS)[number]['key'];
export const ALL_GROUPS: MetricGroup[] = METRIC_GROUPS.map((g) => g.key);

/** 降采样时的桶内聚合方式。沿用图表 mergeBucket 的口径，保证采样后的导出与屏幕上的曲线对应。 */
export type Agg = 'max' | 'avg' | 'last';
export const AGG_DESC: Record<Agg, string> = {
  max: '桶内最大值（保住尖峰，诊断要看最坏）',
  avg: '桶内平均值（吞吐用平均才不高估）',
  last: '桶内最后一个值（累计计数器单调递增，取末值）',
};

interface ColumnSpec {
  /** 基础列名，不含聚合后缀 */
  key: string;
  group: MetricGroup;
  agg: Agg;
  pick: (r: ExportRow) => number | null;
  desc: string;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
// null → 空字符串（见约定③）。保留至多 4 位小数并去掉尾随 0，避免 0.30000000000000004 这种噪声。
function num(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '';
  return String(Number(v.toFixed(4)));
}
function q3(name: string, group: MetricGroup, unit: 's' | 'ms', pickQ: (r: ExportRow) => Q, what: string): ColumnSpec[] {
  return ([['p50', 'p50'], ['p95', 'p95'], ['p99', 'p99']] as const).map(([suffix, field]) => ({
    key: `${name}_${suffix}_${unit}`,
    group,
    agg: 'max' as Agg, // 分位取桶内最坏子窗口，与图表一致
    pick: (r: ExportRow) => pickQ(r)[field],
    desc: `${what} ${suffix}（单位：${unit === 's' ? '秒' : '毫秒'}）`,
  }));
}

// 时间列不参与分组选择，也不参与聚合——它是索引，恒在。
// ts_ms 曾经与 ts_iso 并存，是同一信息的两种写法，纯冗余且占掉每行约 22% 的宽度，已移除。
const TS_COLUMN = 'ts_iso';

const COLUMNS: ColumnSpec[] = [
  { key: 'running', group: 'scheduling', agg: 'max', pick: (r) => r.running, desc: '正在推理的请求数' },
  { key: 'waiting', group: 'scheduling', agg: 'max', pick: (r) => r.waiting, desc: '在排队、尚未开始计算的请求数' },

  { key: 'waiting_capacity', group: 'queue_reason', agg: 'max', pick: (r) => r.waitingCapacity, desc: '因显存/KV 容量不足而排队的请求数（>0 = 容量瓶颈）' },
  { key: 'waiting_deferred', group: 'queue_reason', agg: 'max', pick: (r) => r.waitingDeferred, desc: '被调度策略主动延后的请求数' },

  { key: 'kv_usage_pct', group: 'kv', agg: 'max', pick: (r) => r.kvPerc, desc: 'KV cache 显存占用百分比（已由 0~1 换算，>90 危险）' },

  { key: 'prefix_hit_pct', group: 'prefix', agg: 'avg', pick: (r) => r.prefixHitPerc, desc: '前缀缓存命中率百分比（窗口口径，非累计）' },

  { key: 'prompt_tok_per_s', group: 'throughput', agg: 'avg', pick: (r) => r.promptTokPerS, desc: '输入侧吞吐（回看窗口端点差分）' },
  { key: 'gen_tok_per_s', group: 'throughput', agg: 'avg', pick: (r) => r.genTokPerS, desc: '输出侧吞吐（回看窗口端点差分）' },

  ...q3('ttft', 'ttft', 's', (r) => r.ttft, '首 token 延迟（= 排队 + prefill）'),
  ...q3('queue', 'ttft', 's', (r) => r.queue, '排队耗时'),
  ...q3('prefill', 'ttft', 's', (r) => r.prefill, 'prefill 耗时'),

  ...q3('itl', 'decode', 'ms', (r) => r.itlMs, '相邻输出 token 间隔'),
  ...q3('tpot', 'decode', 'ms', (r) => r.tpotMs, '每输出 token 摊薄耗时'),

  ...q3('e2e', 'e2e', 's', (r) => r.e2e, '单请求端到端耗时'),

  { key: 'preempt_per_s', group: 'preempt', agg: 'max', pick: (r) => r.preemptRate, desc: '每秒被驱逐重算的序列数（应 ≈0）' },

  { key: 'prompt_tokens_total', group: 'counters', agg: 'last', pick: (r) => r.promptTokensTotal, desc: '累计输入 token（vLLM 启动至今，未加工）' },
  { key: 'generation_tokens_total', group: 'counters', agg: 'last', pick: (r) => r.generationTokensTotal, desc: '累计输出 token（同上）' },
  { key: 'prefix_cache_queries_total', group: 'counters', agg: 'last', pick: (r) => r.prefixCacheQueriesTotal, desc: '累计前缀缓存查询次数' },
  { key: 'prefix_cache_hits_total', group: 'counters', agg: 'last', pick: (r) => r.prefixCacheHitsTotal, desc: '累计前缀缓存命中次数' },
  { key: 'num_preemptions_total', group: 'counters', agg: 'last', pick: (r) => r.numPreemptionsTotal, desc: '累计抢占次数' },
];

/** 解析 metrics 参数 → 分组集合。空/缺省/全非法 → 全选（宁可多给也不给一份缺列的数据）。 */
export function parseGroups(raw: string | null | undefined): MetricGroup[] {
  if (!raw) return ALL_GROUPS;
  const want = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  const picked = ALL_GROUPS.filter((g) => want.has(g));
  return picked.length > 0 ? picked : ALL_GROUPS;
}
/** 选中分组 → 列集合（不含时间列，时间列由渲染层恒定加在最前）。 */
export function selectColumns(groups: MetricGroup[]): ColumnSpec[] {
  const want = new Set<MetricGroup>(groups);
  return COLUMNS.filter((c) => want.has(c.group));
}
/**
 * 解析 sample 参数 → 分桶时长（毫秒）。raw / 0 / 非法 → 0（= 不降采样）。
 * 按**时间**分桶而不是按行数：采集间隔本来就不均匀（实测 131ms ~ 51 分钟的断层都有），
 * 按行数分桶会让一个桶跨 51 分钟、另一个跨 2 秒，桶与桶不可比；按时间分桶则每行的
 * 时间跨度恒定，也正好是用户唯一关心的口径（"每 10 秒一行"）。
 */
export function parseSample(raw: string | null | undefined): number {
  if (!raw || raw === 'raw') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1000 ? Math.min(86_400_000, Math.floor(n)) : 0;
}
/** 分桶时长的人话表述，进文件名与口径说明。 */
export function bucketLabel(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`;
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  return `${ms / 1000} 秒`;
}
/** 降采样后列名带聚合后缀；不降采样时就是基础列名。 */
export function columnHeader(c: ColumnSpec, sampled: boolean): string {
  return sampled ? `${c.key}_${c.agg}` : c.key;
}

// ——— 行的构建：原始 or 分桶聚合 ———
function aggregate(vals: (number | null)[], agg: Agg): number | null {
  const nn = vals.filter((v): v is number => v != null && Number.isFinite(v));
  if (nn.length === 0) return null; // 全空 → 留空，不要退化成 0
  if (agg === 'avg') return nn.reduce((a, b) => a + b, 0) / nn.length;
  if (agg === 'last') return nn[nn.length - 1];
  return Math.max(...nn);
}

export interface OutRow { tsIso: string; cells: string[] }
export interface BuildResult { rows: OutRow[]; sampled: boolean; bucketMs: number; srcRows: number }

/**
 * rows → 待渲染的字符串行。bucketMs>0 时按时间分桶聚合。
 * 桶边界对齐到 bucketMs 的整数倍，这样同一时间段无论怎么导、导几次，桶都落在同一位置。
 * 没有采样点的时间段**不产生行**——不造假数据，断层在结果里就是一段时间的缺失。
 */
export function buildOutRows(rows: ExportRow[], cols: ColumnSpec[], bucketMs: number): BuildResult {
  if (bucketMs <= 0) {
    return {
      rows: rows.map((r) => ({ tsIso: iso(r.tsMs), cells: cols.map((c) => num(c.pick(r))) })),
      sampled: false, bucketMs: 0, srcRows: rows.length,
    };
  }
  const buckets = new Map<number, ExportRow[]>();
  for (const r of rows) {
    const k = Math.floor(r.tsMs / bucketMs) * bucketMs;
    const g = buckets.get(k);
    if (g) g.push(r); else buckets.set(k, [r]);
  }
  const out: OutRow[] = [...buckets.keys()].sort((a, b) => a - b).map((k) => ({
    tsIso: iso(k), // 桶起始时刻（已对齐到边界）
    cells: cols.map((c) => num(aggregate(buckets.get(k)!.map((r) => c.pick(r)), c.agg))),
  }));
  return { rows: out, sampled: true, bucketMs, srcRows: rows.length };
}

// ——— 口径文案 ———
const QUANTILE_GROUPS: MetricGroup[] = ['ttft', 'decode', 'e2e'];
interface Caveat { when: (g: Set<MetricGroup>, b: BuildResult) => boolean; text: (ctx: ExportContext, b: BuildResult, cols: ColumnSpec[]) => string }

// 每条只在**相关列真的被导出时**才出现——挑了两个指标却读到一堆讲不存在列的说明，
// 对下游（尤其是模型）是纯噪声，还会诱导它去找不存在的字段。
const CAVEATS: Caveat[] = [
  {
    when: (_, b) => b.sampled,
    text: (_ctx, b, cols) => {
      const used = [...new Set(cols.map((c) => c.agg))];
      const how = used.map((a) => `_${a} = ${AGG_DESC[a]}`).join('；');
      return `本文件**已降采样**：每行 = 每 ${bucketLabel(b.bucketMs)}一个时间桶的聚合（由 ${b.srcRows} 个原始采样点聚成 ${b.rows.length} 行），ts_iso 为桶的起始时刻、已对齐到 ${bucketLabel(b.bucketMs)}边界。没有采样点的时间桶不产生行，所以时间轴上的空缺就是真实的采集断层。列名后缀标明聚合方式——${how}。不同列聚合方式不同，跨列做相关分析前请留意。需要逐点原值请改用「原始全量」导出。`;
    },
  },
  {
    when: (g) => g.has('throughput') || g.has('preempt'),
    text: (ctx) => `*_tok_per_s / preempt_per_s 是速率，算法为 ${ctx.rateWindowMs / 1000}s 回看窗口内的端点差分（counter 末值减首值 ÷ 实际跨度），不是相邻两帧的瞬时差分。vLLM 的 token 计数器是突发式跳变且推送间隔抖动，用相邻帧差分会把读数放大 1~2 个数量级。`,
  },
  {
    when: (g) => QUANTILE_GROUPS.some((k) => g.has(k)),
    text: () => '*_p50/p95/p99 来自「该窗口内新完成请求」的直方图桶差分，不是开机至今的累计分位。窗口内无新完成请求时留空（不是 0）。',
  },
  {
    when: (g) => QUANTILE_GROUPS.some((k) => g.has(k)),
    text: () => '单位看列名：TTFT/queue/prefill/e2e 是秒（_s），ITL/TPOT 是毫秒（_ms）。',
  },
  {
    when: (g) => QUANTILE_GROUPS.some((k) => g.has(k)),
    text: () => '延迟分位由直方图桶内线性插值得到，高位桶很宽（如 160s / 640s / 2560s），因此数值的量级可信、小数位不可信。',
  },
  { when: (g) => g.has('prefix'), text: () => 'prefix_hit_pct 是窗口口径（窗口内新增命中 ÷ 新增查询），不是累计命中率。' },
  { when: (g) => g.has('kv'), text: () => 'kv_usage_pct 已由 0~1 换算成百分比。' },
  { when: (g) => g.has('counters'), text: () => '*_total 列是 vLLM 启动至今的累计原值，未经加工：可独立复核上面的速率，也可首尾相减精确得到区间总量（用速率列积分会有误差）。' },
  { when: () => true, text: () => '空单元格 = 该点无数据，请按缺失值处理，不要当 0。' },
];

export function caveatLines(ctx: ExportContext, groups: MetricGroup[], build: BuildResult, cols: ColumnSpec[]): string[] {
  const set = new Set(groups);
  return CAVEATS.filter((c) => c.when(set, build)).map((c) => c.text(ctx, build, cols));
}

export function contextLines(ctx: ExportContext, groups: MetricGroup[], build: BuildResult): string[] {
  const hw = ctx.hardwareName
    ? `${ctx.hardwareName}${ctx.memBandwidthGBs ? `（显存带宽 ${ctx.memBandwidthGBs} GB/s）` : ''}`
    : '未登记';
  const picked = groups.length === ALL_GROUPS.length
    ? '全部指标'
    : METRIC_GROUPS.filter((g) => groups.includes(g.key)).map((g) => g.label).join('、');
  return [
    `endpoint: ${ctx.endpoint}`,
    `model: ${ctx.model ?? '(未指定)'}`,
    `hardware: ${hw}`,
    `time_range: ${iso(ctx.fromMs)} ~ ${iso(ctx.toMs)}（ts_iso 为 UTC）`,
    build.sampled
      ? `rows: ${build.rows.length}（每 ${bucketLabel(build.bucketMs)} 一行，由 ${ctx.sampleCount} 个原始采样点聚合而来）`
      : `rows: ${ctx.sampleCount} —— 每行 = 一个原始采样点，未做降采样`,
    `metrics: ${picked}`,
    `generated_at: ${iso(ctx.generatedAtMs)}`,
  ];
}

// ——— CSV ———
// RFC4180 转义：含逗号/引号/换行的字段必须加引号，内部引号翻倍。
// 数据列都是数字进不来，但 _readme 是中文长句，必须走这条。
function esc(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
/** 口径说明列。放最后一列——放文件开头的 # 注释块会占掉前若干行，Excel 就认不出表头了。 */
export const README_COLUMN = '_readme';

export function toCsv(rows: ExportRow[], ctx: ExportContext, groups: MetricGroup[] = ALL_GROUPS, bucketMs = 0): string {
  const cols = selectColumns(groups);
  const build = buildOutRows(rows, cols, bucketMs);
  const notes = [
    ...contextLines(ctx, groups, build),
    '—— 口径说明（不看这段容易误读）——',
    ...caveatLines(ctx, groups, build, cols).map((c, i) => `${i + 1}) ${c}`),
  ];
  // 说明行比数据行还多时（导出窗口极短），把剩余说明并进最后一格，
  // 绝不为了塞说明而造空数据行——那种假行会被 pandas 读成全 NaN 的数据点。
  const fitted = build.rows.length > 0 && notes.length > build.rows.length
    ? [...notes.slice(0, build.rows.length - 1), notes.slice(build.rows.length - 1).join(' ')]
    : notes;

  const header = [TS_COLUMN, ...cols.map((c) => columnHeader(c, build.sampled)), README_COLUMN];
  const lines: string[] = [header.join(',')];
  build.rows.forEach((r, i) => {
    lines.push([r.tsIso, ...r.cells, esc(fitted[i] ?? '')].join(','));
  });
  // 一条数据都没有时，至少让说明能被看到（否则用户拿到一个只有表头的空文件，
  // 无从判断是没数据还是导错了时间段）
  if (build.rows.length === 0) {
    for (const n of fitted) lines.push(`${','.repeat(cols.length + 1)}${esc(n)}`);
  }
  return `${lines.join('\n')}\n`;
}

// ——— Markdown ———
// 表格单元格里的 | 会破坏表格结构，转义掉。数据列是数字进不来，属防御性处理。
function mdCell(v: string): string {
  return v.replace(/\|/g, '\\|');
}

export function toMarkdown(rows: ExportRow[], ctx: ExportContext, groups: MetricGroup[] = ALL_GROUPS, bucketMs = 0): string {
  const cols = selectColumns(groups);
  const build = buildOutRows(rows, cols, bucketMs);
  const header = [TS_COLUMN, ...cols.map((c) => columnHeader(c, build.sampled))];

  const out: string[] = [
    '# vLLM 推理 Infra 时序数据导出',
    '',
    '> 由 agent-insight 生成。下面「口径说明」一节务必先读——本文件里的速率与分位都不是',
    '> 朴素的瞬时值，按字面理解会得出错误结论。',
    '',
    '## 采集上下文',
    '',
    ...contextLines(ctx, groups, build).map((m) => `- ${m}`),
    '',
    '## 口径说明（不看这段容易误读）',
    '',
    ...caveatLines(ctx, groups, build, cols).map((c, i) => `${i + 1}. ${c}`),
    '',
    '## 列说明',
    '',
    '| 列 | 含义 |',
    '| --- | --- |',
    `| \`${TS_COLUMN}\` | 采样时刻（UTC，ISO8601）${build.sampled ? '——降采样后为该桶的起始时刻' : ''} |`,
    ...cols.map((c) => `| \`${columnHeader(c, build.sampled)}\` | ${mdCell(c.desc)}${build.sampled ? `；${AGG_DESC[c.agg]}` : ''} |`),
    '',
    `## 数据（${build.rows.length} 行）`,
    '',
  ];
  if (build.rows.length === 0) {
    out.push('_该时间段内没有采样数据。请确认 collector 是否在推送，或换一个时间范围。_', '');
    return out.join('\n');
  }
  out.push(
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...build.rows.map((r) => `| ${[r.tsIso, ...r.cells].map(mdCell).join(' | ')} |`),
    '',
  );
  return out.join('\n');
}

// ——— 文件名 ———
export function exportFileName(ctx: ExportContext, format: 'csv' | 'md'): string {
  let host = ctx.endpoint;
  try { host = new URL(ctx.endpoint).host; } catch { /* endpoint 可能不是合法 URL，原样用 */ }
  // 2026-07-01T04:00:00.000Z → 2026-07-01_04-00（到分钟，且不留尾部横杠）
  const stamp = (ms: number) => iso(ms).replace(/:/g, '-').replace('T', '_').slice(0, 16);
  const safe = `${host}-${stamp(ctx.fromMs)}_${stamp(ctx.toMs)}`.replace(/[^A-Za-z0-9._-]+/g, '_');
  return `infra-${safe}.${format}`.slice(0, 160);
}

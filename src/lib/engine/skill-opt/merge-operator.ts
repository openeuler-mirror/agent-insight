/**
 * 优化点归并算子（merge operator）。
 *
 * 在一轮 skill-opt 会话入口处，把 (skill, baseVersion) 下全部未解决的聚合 issue
 * 归并成一份统一的优化计划（SkillOptPlan/SkillOptPlanItem）：
 *   - 语义去重：同义 issue 合为一条，rationale 引用全部源 issue id
 *   - 冲突消解：同区域方向矛盾的综合或标 conflict 交用户仲裁
 *   - 三路路由：core（本轮必做，预算 K 条）/ reference（长尾进 references/）/ backlog（顺延）
 *
 * SkillIssue 是不可变台账，算子只读不写；plan 的生命周期 = 一轮会话 + 一个 baseVersion。
 * 规模：单 skill 优化点可达 240 条 → 分批（B≈30）+ 树归并（⌈log_B N⌉ 层）。
 *
 * 设计文档：docs/plans/2026-06-10-skill-issue-merge-conflict-plan-design.md
 */

import { OpenAI } from 'openai';
import { jsonrepair } from 'jsonrepair';
import { getProxyConfig } from '@/lib/ingest/proxy-config';
import type { ModelConfig } from '@/lib/storage/server-config';
import type { Severity } from '@/lib/engine/skill-issues/prevalence';

// ── 类型 ──────────────────────────────────────────────────────────────────────

/** 算子输入的 issue（IssueWithPrevalence 的子集，足够归并用） */
export interface MergeIssueInput {
  id: string;
  source: 'static' | 'dynamic' | 'feedback' | 'trigger';
  severity: Severity;
  category: string | null;
  summary: string;
  evidence: string | null;
  suggestedFix: string | null;
  prevalenceCount: number;
}

export type PlanRoute = 'core' | 'reference' | 'backlog';

export interface MergedPlanItemDraft {
  rank: number;
  route: PlanRoute;
  status: 'pending' | 'conflict';
  title: string;
  rationale: string;
  severity: Severity;
  targetFile: string | null;
  anchorText: string | null;
  proposedEdit: string | null;
  conflictNote: string | null;
  sourceIssueIds: string[];
  sourcesBreakdown: Record<string, number>;
  prevalence: number;
}

export interface MergeOperatorMeta {
  inputIssues: number;
  batches: number;
  levels: number;
  model: string;
  durationMs: number;
  llmCalls: number;
  /** 算子丢弃的（无任何 item 引用的）源 issue 数——这些留在台账里下轮再归并 */
  unreferencedIssues: number;
}

export interface MergeOperatorResult {
  items: MergedPlanItemDraft[];
  meta: MergeOperatorMeta;
}

export interface RunMergeOperatorArgs {
  skillName: string;
  baseVersion: number;
  issues: MergeIssueInput[];
  /** baseVersion 全量文件快照 { relPath: content }，锚点校验 + prompt 上下文用 */
  files: Record<string, string>;
  config: ModelConfig;
  /** core 路由每轮硬上限（textual learning rate），默认 4 */
  coreBudget?: number;
  /** 单批 issue 上限，默认 30 */
  batchSize?: number;
  /** 批内 LLM 并发，默认 2（deepseek 实测并发高了会拖垮 judge） */
  concurrency?: number;
}

// ── 常量 ──────────────────────────────────────────────────────────────────────

const DEFAULT_CORE_BUDGET = 4;
const DEFAULT_BATCH_SIZE = 30;
const DEFAULT_CONCURRENCY = 2;
const LLM_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_TOKENS = 4096;
const SKILL_MD_PROMPT_CAP = 8_000; // prompt 里 SKILL.md 截断上限（字符）

/** 失败类 category：先归并定调；表达/格式类后归并让位（SkillOpt failure-first） */
const FAILURE_CATEGORIES = new Set(['轨迹偏差', '工具误用', '静态扫描', '关键观点遗漏']);

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

// ── 纯函数（导出供单测） ────────────────────────────────────────────────────────

/** failure-first 排序：失败类在前；同类内 severity 高在前、prevalence 大在前 */
export function orderIssuesFailureFirst(issues: MergeIssueInput[]): MergeIssueInput[] {
  return [...issues].sort((a, b) => {
    const fa = FAILURE_CATEGORIES.has(a.category || '') || a.source === 'static' ? 0 : 1;
    const fb = FAILURE_CATEGORIES.has(b.category || '') || b.source === 'static' ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    return b.prevalenceCount - a.prevalenceCount;
  });
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** LLM 原始输出 → item 草稿。容错：jsonrepair 兜底；丢非法引用；同一源 id 只归首个 item */
export function parseOperatorOutput(
  raw: string,
  validIds: Set<string>,
): Array<Omit<MergedPlanItemDraft, 'rank' | 'sourcesBreakdown' | 'prevalence'>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(raw));
    } catch {
      return [];
    }
  }
  const itemsField = (parsed as { items?: unknown } | null)?.items;
  const list: Array<Record<string, unknown>> = Array.isArray(itemsField)
    ? itemsField.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    : [];
  const seen = new Set<string>();
  const out: Array<Omit<MergedPlanItemDraft, 'rank' | 'sourcesBreakdown' | 'prevalence'>> = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const title = String(it.title || '').trim();
    if (!title) continue;
    const ids = (Array.isArray(it.sourceIssueIds) ? it.sourceIssueIds : [])
      .map((x: unknown) => String(x))
      .filter((x: string) => validIds.has(x) && !seen.has(x));
    if (ids.length === 0) continue; // 无源引用的 item 不可审计，丢弃
    for (const id of ids) seen.add(id);
    const route: PlanRoute = it.route === 'core' || it.route === 'reference' || it.route === 'backlog'
      ? it.route : 'backlog';
    const severity: Severity = it.severity === 'high' || it.severity === 'medium' || it.severity === 'low'
      ? it.severity : 'medium';
    const conflictNote = typeof it.conflictNote === 'string' ? it.conflictNote.trim() : '';
    const isConflict = it.conflict === true && conflictNote.length > 0;
    out.push({
      route,
      status: isConflict ? 'conflict' : 'pending',
      title,
      rationale: String(it.rationale || '').trim(),
      severity,
      targetFile: typeof it.targetFile === 'string' && it.targetFile.trim() ? it.targetFile.trim() : null,
      anchorText: typeof it.anchorText === 'string' && it.anchorText.trim() ? it.anchorText.trim() : null,
      proposedEdit: typeof it.proposedEdit === 'string' && it.proposedEdit.trim() ? it.proposedEdit.trim() : null,
      conflictNote: isConflict ? conflictNote : null,
      sourceIssueIds: ids,
    });
  }
  return out;
}

/** 锚点防幻觉：targetFile 必须在快照里、anchorText 必须能在该文件中定位，否则清掉降级 */
export function validateAnchors<T extends { targetFile: string | null; anchorText: string | null }>(
  items: T[],
  files: Record<string, string>,
): T[] {
  return items.map((it) => {
    let targetFile = it.targetFile;
    let anchorText = it.anchorText;
    if (targetFile && !(targetFile in files)) {
      targetFile = null;
      anchorText = null;
    }
    if (anchorText && targetFile && !files[targetFile].includes(anchorText)) {
      anchorText = null;
    }
    if (anchorText && !targetFile) anchorText = null;
    return { ...it, targetFile, anchorText };
  });
}

/**
 * 终整理：算 prevalence/sourcesBreakdown、排 rank、执行 core 预算。
 * core 超预算的按 rank 自动降 backlog（conflict 也占预算——仲裁通过后它就是 core 改动）。
 */
export function finalizeItems(
  drafts: Array<Omit<MergedPlanItemDraft, 'rank' | 'sourcesBreakdown' | 'prevalence'>>,
  issueById: Map<string, MergeIssueInput>,
  coreBudget: number,
): MergedPlanItemDraft[] {
  const enriched = drafts.map((d) => {
    const breakdown: Record<string, number> = {};
    let prevalence = 0;
    let maxSev: Severity = d.severity;
    for (const id of d.sourceIssueIds) {
      const src = issueById.get(id);
      if (!src) continue;
      breakdown[src.source] = (breakdown[src.source] || 0) + 1;
      prevalence += src.prevalenceCount;
      if (SEVERITY_RANK[src.severity] < SEVERITY_RANK[maxSev]) maxSev = src.severity;
    }
    return { ...d, severity: maxSev, sourcesBreakdown: breakdown, prevalence: Math.max(1, prevalence), rank: 0 };
  });

  const routeRank: Record<PlanRoute, number> = { core: 0, reference: 1, backlog: 2 };
  enriched.sort((a, b) => {
    const r = routeRank[a.route] - routeRank[b.route];
    if (r !== 0) return r;
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    return b.prevalence - a.prevalence;
  });

  let coreCount = 0;
  for (const it of enriched) {
    if (it.route === 'core') {
      coreCount += 1;
      if (coreCount > coreBudget) it.route = 'backlog';
    }
  }
  // 降级后重排一次，保证 rank 与 route 分组一致
  enriched.sort((a, b) => {
    const r = routeRank[a.route] - routeRank[b.route];
    if (r !== 0) return r;
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    return b.prevalence - a.prevalence;
  });
  enriched.forEach((it, i) => { it.rank = i + 1; });
  return enriched;
}

// ── prompt 构造 ────────────────────────────────────────────────────────────────

function formatFilesContext(files: Record<string, string>): string {
  const paths = Object.keys(files).sort();
  const skillMd = files['SKILL.md'] ?? '';
  const lines = [
    '## Skill 当前内容（baseVersion 快照）',
    '',
    `文件清单：${paths.join('、') || '（空）'}`,
    '',
    '### SKILL.md',
    '```markdown',
    skillMd.length > SKILL_MD_PROMPT_CAP ? skillMd.slice(0, SKILL_MD_PROMPT_CAP) + '\n…（截断）' : skillMd,
    '```',
  ];
  return lines.join('\n');
}

function formatIssueLines(issues: MergeIssueInput[], shortIdOf: Map<string, string>): string {
  return issues.map((it) => {
    const parts = [
      `- ${shortIdOf.get(it.id)} [${it.severity}/${it.source}${it.category ? `/${it.category}` : ''}] ${it.summary}`,
    ];
    if (it.evidence) parts.push(`  证据：${truncate(it.evidence, 200)}`);
    if (it.suggestedFix) parts.push(`  既有建议：${truncate(it.suggestedFix, 200)}`);
    if (it.prevalenceCount > 1) parts.push(`  检出次数：${it.prevalenceCount}`);
    return parts.join('\n');
  }).join('\n');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

const OUTPUT_SCHEMA_SPEC = [
  '输出 JSON（只输出 JSON，不要任何额外文字）：',
  '{',
  '  "items": [{',
  '    "title": "一句话标题",',
  '    "rationale": "为什么这些 issue 是同一件事 + 综合后的修改方向（必须引用全部源 id）",',
  '    "severity": "high|medium|low",',
  '    "route": "core|reference|backlog",',
  '    "conflict": false,',
  '    "conflictNote": "仅 conflict=true 时填：矛盾双方各自的主张与证据",',
  '    "targetFile": "SKILL.md 或 scripts/xxx 等快照内真实存在的路径，不确定就省略",',
  '    "anchorText": "目标位置的原文片段（必须逐字摘自该文件，10-80字），不确定就省略",',
  '    "proposedEdit": "具体修改建议（在哪段加/改什么）",',
  '    "sourceIssueIds": ["i3", "i17"]',
  '  }]',
  '}',
].join('\n');

const MERGE_RULES = [
  '## 归并规则',
  '',
  '1. **语义去重**：描述同一问题的 issue（即使措辞不同）必须合为一条 item，保留最具体、证据最强的表述。',
  '2. **冲突消解**：两条 issue 对同一区域提出矛盾方向的修改时——若一方依据明显更强，综合成一条并在 rationale 说明取舍；',
  '   若无法判断，输出 conflict=true 的 item 并在 conflictNote 写清矛盾双方，交用户仲裁。',
  '3. **失败优先**：失败类（轨迹偏差/工具误用/关键观点遗漏/静态扫描）优先定调；表达/格式类与之矛盾时让位。',
  '4. **路由**：',
  '   - core：高频/高严重度、值得本轮直接改 SKILL.md 主文件的 SoP 级修改（宁缺毋滥）；',
  '   - reference：有价值但低频的长尾，应写入 references/ 按需查阅而不占主文件；',
  '   - backlog：信号不足或本轮不值得动的，顺延下轮。',
  '5. **core 质检（三维，缺一不可，不满足就降 backlog）**：',
  '   ① 失败机制编码——写清"什么情况下会怎么坏"，不是泛泛建议；',
  '   ② 可执行具体性——目标模型能直接照做的指令；',
  '   ③ 高危操作如适用须显式列入黑名单表述。',
  '6. **锚点诚实**：targetFile/anchorText 只在确定时给出；anchorText 必须逐字摘自快照原文，禁止编造。',
  '7. 笼统到无法行动的 issue（如只有一个名词、无证据无建议）路由 backlog，rationale 注明"信号不足"。',
  '8. 每条输入 issue 至多归入一个 item；确属噪音的可以不引用（它会留在台账里下轮再看）。',
].join('\n');

export function buildBatchMergePrompt(args: {
  skillName: string;
  baseVersion: number;
  issues: MergeIssueInput[];
  files: Record<string, string>;
  shortIdOf: Map<string, string>;
}): string {
  return [
    `你是 skill 优化点归并算子。目标 skill：**${args.skillName}** v${args.baseVersion}。`,
    '下面是一批从多次评估中累积的待优化 issue。你的任务不是修改 skill，而是把这批 issue',
    '归并成一份更少、更强、可执行的优化计划条目（items）。',
    '',
    formatFilesContext(args.files),
    '',
    '## 待归并 issues',
    '',
    formatIssueLines(args.issues, args.shortIdOf),
    '',
    MERGE_RULES,
    '',
    OUTPUT_SCHEMA_SPEC,
  ].join('\n');
}

export function buildConsolidatePrompt(args: {
  skillName: string;
  baseVersion: number;
  intermediate: Array<{ shortId: string; item: Omit<MergedPlanItemDraft, 'rank' | 'sourcesBreakdown' | 'prevalence'> }>;
  files: Record<string, string>;
}): string {
  const lines = args.intermediate.map(({ shortId, item }) => {
    const parts = [
      `- ${shortId} [${item.severity}/route=${item.route}${item.status === 'conflict' ? '/CONFLICT' : ''}] ${item.title}`,
      `  理由：${truncate(item.rationale, 200)}`,
    ];
    if (item.proposedEdit) parts.push(`  建议：${truncate(item.proposedEdit, 160)}`);
    if (item.targetFile) parts.push(`  锚点：${item.targetFile}${item.anchorText ? ` @ "${truncate(item.anchorText, 60)}"` : ''}`);
    return parts.join('\n');
  }).join('\n');
  return [
    `你是 skill 优化点归并算子（第二层）。目标 skill：**${args.skillName}** v${args.baseVersion}。`,
    '下面的条目来自多个批次的初步归并，批与批之间可能仍有重复或矛盾。',
    '请做跨批次的最终归并，输出统一的优化计划。sourceIssueIds 引用下面给出的条目 id（如 p3）。',
    '',
    formatFilesContext(args.files),
    '',
    '## 待归并条目（中间结果）',
    '',
    lines,
    '',
    MERGE_RULES,
    '',
    OUTPUT_SCHEMA_SPEC,
  ].join('\n');
}

// ── LLM 调用 ──────────────────────────────────────────────────────────────────

async function callOperatorLlm(client: OpenAI, model: string, prompt: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const resp = await client.chat.completions.create(
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' as const },
        max_tokens: MAX_OUTPUT_TOKENS,
      },
      { signal: controller.signal },
    );
    return resp.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

/** 带小并发的 map（deepseek 并发高了会互相拖慢，默认 2） */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

export async function runMergeOperator(args: RunMergeOperatorArgs): Promise<MergeOperatorResult> {
  const startedAt = Date.now();
  const coreBudget = args.coreBudget ?? DEFAULT_CORE_BUDGET;
  const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;
  const concurrency = args.concurrency ?? DEFAULT_CONCURRENCY;

  const { customFetch } = getProxyConfig();
  const client = new OpenAI({
    apiKey: args.config.apiKey || 'no-api-key-required',
    baseURL: args.config.baseUrl || 'https://api.deepseek.com',
    fetch: customFetch as unknown as typeof fetch,
    timeout: LLM_TIMEOUT_MS,
    maxRetries: 2,
  });
  const model = args.config.model || 'deepseek-chat';

  const issueById = new Map(args.issues.map((it) => [it.id, it]));
  const ordered = orderIssuesFailureFirst(args.issues);

  // 真实 cuid 太长且 LLM 容易抄错——prompt 里用短 id（i1..iN），解析后映射回真 id
  const shortIdOf = new Map<string, string>();
  const realIdOf = new Map<string, string>();
  ordered.forEach((it, i) => {
    const sid = `i${i + 1}`;
    shortIdOf.set(it.id, sid);
    realIdOf.set(sid, it.id);
  });

  const batches = chunk(ordered, batchSize);
  let llmCalls = 0;

  /** 单批：prompt → LLM →（空结果重试一次，deepseek 偶发无视 json_object）→ 解析为草稿（短 id 域） */
  async function runBatch(batchIssues: MergeIssueInput[], label: string) {
    const prompt = buildBatchMergePrompt({
      skillName: args.skillName,
      baseVersion: args.baseVersion,
      issues: batchIssues,
      files: args.files,
      shortIdOf,
    });
    const valid = new Set(batchIssues.map((it) => shortIdOf.get(it.id)!));
    let raw = await callOperatorLlm(client, model, prompt);
    llmCalls += 1;
    let drafts = parseOperatorOutput(raw, valid);
    if (drafts.length === 0 && batchIssues.length > 0) {
      console.warn(`[merge-operator] ${label} empty items on attempt 1 (raw len=${raw.length}), retrying`);
      raw = await callOperatorLlm(client, model, prompt);
      llmCalls += 1;
      drafts = parseOperatorOutput(raw, valid);
    }
    return drafts;
  }

  // L0：分批归并（短 id 域）
  let levels = 1;
  const level0 = await mapWithConcurrency(batches, concurrency, (b, i) => runBatch(b, `batch#${i + 1}`));
  // 短 id → 真 id
  let merged = level0.flat().map((d) => ({
    ...d,
    sourceIssueIds: d.sourceIssueIds.map((sid) => realIdOf.get(sid)!).filter(Boolean),
  }));

  // L1+：跨批次归并，直到中间条目能装进单次调用
  while (batches.length > 1 && merged.length > 1 && levels < 4) {
    levels += 1;
    const pseudo = merged.map((item, i) => ({ shortId: `p${i + 1}`, item }));
    const pseudoSources = new Map(pseudo.map(({ shortId, item }) => [shortId, item.sourceIssueIds]));
    const groups = chunk(pseudo, batchSize);
    const consolidated = await mapWithConcurrency(groups, concurrency, async (group, gi) => {
      const prompt = buildConsolidatePrompt({
        skillName: args.skillName,
        baseVersion: args.baseVersion,
        intermediate: group,
        files: args.files,
      });
      const valid = new Set(group.map((g) => g.shortId));
      let raw = await callOperatorLlm(client, model, prompt);
      llmCalls += 1;
      let drafts = parseOperatorOutput(raw, valid);
      if (drafts.length === 0 && group.length > 0) {
        console.warn(`[merge-operator] consolidate#${gi + 1} empty items on attempt 1, retrying`);
        raw = await callOperatorLlm(client, model, prompt);
        llmCalls += 1;
        drafts = parseOperatorOutput(raw, valid);
      }
      // 解析失败兜底：这组中间条目原样透传，不丢源引用
      if (drafts.length === 0) return group.map((g) => g.item);
      // pseudo id → 真实源 id 并集
      return drafts.map((d) => ({
        ...d,
        sourceIssueIds: Array.from(new Set(d.sourceIssueIds.flatMap((pid) => pseudoSources.get(pid) || []))),
      }));
    });
    merged = consolidated.flat();
    if (groups.length === 1) break; // 已经是单组，归并完成
  }

  // 同一源 issue 若被多个 item 引用（跨批可能重复），保留首个引用
  const claimed = new Set<string>();
  merged = merged.map((d) => ({
    ...d,
    sourceIssueIds: d.sourceIssueIds.filter((id) => {
      if (claimed.has(id) || !issueById.has(id)) return false;
      claimed.add(id);
      return true;
    }),
  })).filter((d) => d.sourceIssueIds.length > 0);

  const anchored = validateAnchors(merged, args.files);
  const items = finalizeItems(anchored, issueById, coreBudget);

  return {
    items,
    meta: {
      inputIssues: args.issues.length,
      batches: batches.length,
      levels,
      model,
      durationMs: Date.now() - startedAt,
      llmCalls,
      unreferencedIssues: args.issues.length - claimed.size,
    },
  };
}

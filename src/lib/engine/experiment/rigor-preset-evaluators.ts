/**
 * “内容严谨性”预置评估器（rigor 族，当前唯一成员）。
 *
 * Judge Prompt：src/prompts/rigor-content-prompt.ts
 *
 * 总原则：**Judge 只做离散判断，代码负责一切计分与裁决。** 无参考答案场景下判断依据只能
 * 来自模型自身知识，因此凡是文本内部就能确定的事，一律不交给模型自觉。
 *
 * 一、计分（确定性公式，同一组 findings 每次算出的分数完全一致）
 *   1. 累计扣分：事实/数值/逻辑/操作四维 low=10、medium=30、high=60；误导性表述
 *      low=5、medium=15、high=30（需求要求「误导 < 明确错误」）。
 *   2. 严重问题封顶：high 级事实或数值封顶 40，high 级逻辑或操作封顶 30，high 级误导
 *      封顶 50，3 处及以上 high 封顶 20。
 *   3. 总分 = clamp(min(100 − Σ扣分, 已触发封顶中的最小值), 0, 100)；
 *      维度分 = clamp(100 − 该维度扣分, 0, 100)，与总分同源、可互相解释。
 *      口径调整只改上面三张常量表与对应测试期望，公式不动。
 *
 * 二、把 Judge 锚回原文（防误判，见 groundFindings）
 *   引用必须逐字出现在实际输出中，否则丢弃（discardedFindings）；引用只是首尾黏了碎片时
 *   先尝试片段修复（repairedFindings）；high 档必须给出正确值，给不出降档
 *   （downgradedFindings）；同一维度同一处只计一次；自称数值有误却给不出不同数值的丢弃。
 *
 * 三、四张审计表（防漏判，见 applyAuditVerdicts / backfillFromClaimAudit）
 *   提示词强制 Judge 对命令、算术、单位、高风险断言逐项填表——填表与转录比自由判断难逃避，
 *   且算术对错、单位量纲这类确定性事实改由代码裁定。代码交叉校验后有四种落地动作：
 *   审计判不通过而 Judge 没记 → 回填（backfilledFindings）；记了但档位低于判据 → 升档
 *   （upgradedFindings）；记错维度 → 改判（reclassifiedFindings）；同一处重复记 → 去重
 *   （dedupedFindings）。“看见了不记”“记了但记轻”“换个维度记”是同一种静默丢失。
 *   断言的维度归属由代码按文本内信号裁定：句中含推理连接词 → 逻辑正确性，否则 → 事实准确性。
 *
 * 四、契约违约抛错而非兜底（见 assertJudgeContracts）
 *   文本含技术单位却给空 unit_audit、事实/数值 finding 跨句引用（多处错误并成一条会少扣分），
 *   均抛 JudgeOutputParseError 走既有重试链路——“没判出来”与“判为正常”是两种结果。
 *
 * 五、呈现同源
 *   summary / verdict 一律由存活 findings 推导，Judge 原话只作留档写进证据末尾；
 *   「总分封顶说明」只在封顶实际压低了分数时输出。
 *   评估器级 evidence 上报**自然语言 md**（buildEvidenceMd），把「模型说了什么 → 代码改了
 *   什么 → 为什么是这个分」讲成一条链路；原来那坨原始 JSON 明细改走 rigorDetailOf 旁路，
 *   只供测试与排障读取，不进上报契约、不落库。
 *
 * 不变量：所有代码侧裁决只会降低或保持分数，不存在“换个维度分数反而变高”的路径
 * （由 1024 组合单调性穷举测试守住）。
 */
import { z } from 'zod';
import {
  normalizeEvaluatorOutput,
  type EvalPoint,
  type EvalPointStatus,
  type EvaluatorOutput,
} from '@/lib/evaluators/eval-output';
import {
  CONTENT_RIGOR_DIMENSIONS,
  CONTENT_RIGOR_DIMENSION_KEYS,
  CONTENT_RIGOR_SEVERITIES,
  generateContentRigorPrompt,
  type ContentRigorDimension,
  type ContentRigorSeverity,
} from '@/prompts/rigor-content-prompt';
import { JudgeOutputParseError } from '@/lib/evaluators/judge-assembly';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';
import { invokeSpecializedJudge, uniqueStrings } from './specialized-evaluator-common';

export const RIGOR_PRESET_ID = 'preset-rigor-content' as const;
export const RIGOR_PRESET_IDS = [RIGOR_PRESET_ID] as const;
export type RigorPresetId = (typeof RIGOR_PRESET_IDS)[number];

export function isRigorPresetId(id: string): id is RigorPresetId {
  return id === RIGOR_PRESET_ID;
}

const RIGOR_RUBRIC_VERSION = '1.9.1';

// ── 计分参数（口径调整只改这三张表，公式不动）────────────────────────────────

/** 明确错误类维度的扣分梯度。 */
const ERROR_DEDUCTION: Record<ContentRigorSeverity, number> = { low: 10, medium: 30, high: 60 };
/** 误导性表述扣分轻于明确错误（需求：误导 < 错误）。 */
const MISLEADING_DEDUCTION: Record<ContentRigorSeverity, number> = { low: 5, medium: 15, high: 30 };

const DEDUCTIONS: Record<ContentRigorDimension, Record<ContentRigorSeverity, number>> = {
  factual_accuracy: ERROR_DEDUCTION,
  numerical_precision: ERROR_DEDUCTION,
  logical_correctness: ERROR_DEDUCTION,
  operational_correctness: ERROR_DEDUCTION,
  misleading_statements: MISLEADING_DEDUCTION,
};

/** 出现 high 级问题时，该维度对应的总分封顶值。 */
const HIGH_SEVERITY_CAPS: Record<ContentRigorDimension, number> = {
  factual_accuracy: 40,
  numerical_precision: 40,
  logical_correctness: 30,
  operational_correctness: 30,
  misleading_statements: 50,
};

/** 多处严重问题叠加时的额外封顶。 */
const MULTI_HIGH_CAP = { threshold: 3, value: 20 } as const;

const SEVERITY_LABEL: Record<ContentRigorSeverity, string> = {
  high: '🔴 高严重度',
  medium: '🟡 中严重度',
  low: '🟢 低严重度',
};

/** 纯文字严重度名：emoji 版在成段的叙述里读着别扭，md 证据统一用这套。 */
const SEVERITY_NAME: Record<ContentRigorSeverity, string> = {
  high: '严重',
  medium: '中等',
  low: '轻微',
};

// ── Judge 契约 ──────────────────────────────────────────────────────────────

const findingSchema = z.object({
  dimension: z.enum(CONTENT_RIGOR_DIMENSION_KEYS),
  severity: z.enum(CONTENT_RIGOR_SEVERITIES),
  quote: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  // 允许为空：high 档缺正确值走降档而非抛错（模型给不出正确值时判断本就不可信）
  correction: z.string(),
  suggestion: z.string().trim().min(1),
});

const commandAuditSchema = z.object({
  command: z.string().trim().min(1),
  exists: z.boolean().optional(),
  achieves_goal: z.boolean().optional(),
  destructive: z.boolean().optional(),
  risk_warned: z.boolean().optional(),
  note: z.string().optional(),
});

const CALC_OPS = ['+', '-', '*', '/'] as const;
const calculationAuditSchema = z.object({
  quote: z.string().trim().min(1),
  left: z.number(),
  op: z.enum(CALC_OPS),
  right: z.number(),
  stated_result: z.number(),
  note: z.string().optional(),
});

const unitAuditSchema = z.object({
  quote: z.string().trim().min(1),
  concept: z.string().trim().min(1),
  concept_measures: z.string().trim().min(1),
  unit: z.string().trim().min(1),
  unit_measures: z.string().trim().min(1),
  matches: z.boolean(),
  note: z.string().optional(),
});

const CLAIM_DOMAINS = ['health', 'safety', 'legal', 'finance'] as const;
export type RigorClaimDomain = (typeof CLAIM_DOMAINS)[number];

const claimAuditSchema = z.object({
  quote: z.string().trim().min(1),
  domain: z.enum(CLAIM_DOMAINS),
  // 必须先写出「权威共识怎么说」再判断是否一致，避免模型跳过依据直接下结论
  consensus: z.string().trim().min(1),
  text_agrees_with_consensus: z.boolean(),
  hedged: z.boolean().optional(),
  note: z.string().optional(),
});

const rigorJudgeSchema = z.object({
  summary: z.string().trim().min(1).max(200).optional(),
  // 模型对命令/操作的逐项核查；缺失按空数组处理（旧格式兼容）
  command_audit: z.array(commandAuditSchema).max(30).default([]),
  // 模型对每步计算的转录；由代码重算裁定对错
  calculation_audit: z.array(calculationAuditSchema).max(30).default([]),
  // 模型对「数值 + 单位」的逐处核查；缺失按空数组处理（旧格式兼容）
  unit_audit: z.array(unitAuditSchema).max(30).default([]),
  // 模型对高风险领域断言的逐条核查；缺失按空数组处理（旧格式兼容）
  claim_audit: z.array(claimAuditSchema).max(30).default([]),
  findings: z.array(findingSchema).max(60).default([]),
});

export interface RigorCommandAudit {
  command: string;
  exists?: boolean;
  achieves_goal?: boolean;
  destructive?: boolean;
  risk_warned?: boolean;
  note?: string;
}

export type RigorCalcOp = (typeof CALC_OPS)[number];
export interface RigorCalculationAudit {
  quote: string;
  left: number;
  op: RigorCalcOp;
  right: number;
  stated_result: number;
  note?: string;
}

export interface RigorFinding {
  dimension: ContentRigorDimension;
  severity: ContentRigorSeverity;
  quote: string;
  reason: string;
  correction: string;
  suggestion: string;
}

export interface RigorUnitAudit {
  quote: string;
  concept: string;
  concept_measures: string;
  unit: string;
  unit_measures: string;
  matches: boolean;
  note?: string;
}

export interface RigorClaimAudit {
  quote: string;
  domain: RigorClaimDomain;
  consensus: string;
  text_agrees_with_consensus: boolean;
  hedged?: boolean;
  note?: string;
}

export interface RigorJudgeResult {
  summary?: string;
  commandAudit?: RigorCommandAudit[];
  calculationAudit?: RigorCalculationAudit[];
  unitAudit?: RigorUnitAudit[];
  claimAudit?: RigorClaimAudit[];
  findings: RigorFinding[];
}

interface DiscardedFinding extends RigorFinding {
  discardReason: string;
}

interface DowngradedFinding extends RigorFinding {
  originalSeverity: ContentRigorSeverity;
  downgradeReason: string;
}

const SEVERITY_RANK: Record<ContentRigorSeverity, number> = { low: 1, medium: 2, high: 3 };

interface UpgradedFinding extends RigorFinding {
  originalSeverity: ContentRigorSeverity;
  upgradeReason: string;
}

/** 审计判据要求的严重度地板：模型已记 finding 但档位低于判据时，由代码升档而非跳过。 */
interface SeverityFloorUpgrade {
  target: RigorFinding;
  severity: ContentRigorSeverity;
  correction: string;
  upgradeReason: string;
}

interface DedupedFinding extends RigorFinding {
  dedupReason: string;
}

interface RepairedFinding extends RigorFinding {
  originalQuote: string;
  repairReason: string;
}

/** 引用修复的最短可信片段：绝对长度 ≥10 且不短于原引用的 60%。 */
const repairThreshold = (needleLength: number): number =>
  Math.max(10, Math.ceil(needleLength * 0.6));

/**
 * quote 未逐字命中时，尝试其最长前缀 / 最长后缀在原文中的连续匹配；
 * 命中片段达到阈值则以该片段作为核验后的引用（典型场景：模型在引用末尾黏进思维碎片）。
 */
function repairQuoteNeedle(haystack: string, needle: string): string | null {
  const minLength = repairThreshold(needle.length);
  for (let length = needle.length - 1; length >= minLength; length--) {
    const prefix = needle.slice(0, length);
    if (haystack.includes(prefix)) return prefix;
    const suffix = needle.slice(needle.length - length);
    if (haystack.includes(suffix)) return suffix;
  }
  return null;
}

/** 两段引文（归一化后）指向同一处原文：互相包含即视为同一处。 */
const overlapsQuote = (finding: RigorFinding, needle: string): boolean => {
  const quote = compact(finding.quote);
  return quote.includes(needle) || needle.includes(quote);
};

// ── 事实校验：把 Judge 的判断锚回实际输出 ────────────────────────────────────

/** 比对用归一化：忽略空白、各类引号与代码标记，避免模型顺手改了标点（或漏掉命令外的反引号）就判成幻觉引用。 */
const compact = (text: string): string =>
  text.replace(/\s+/g, '').replace(/[「」『』“”"'‘’`《》〈〉]/g, '');

/** 抽取文本里的数值串（含小数），用于判断更正是否真的提出了不同的数。 */
const extractNumbers = (text: string): string[] =>
  (text.match(/\d+(?:\.\d+)?/g) ?? []).map((value) => String(Number(value)));

/** 判官自我否定的措辞：写着“基本准确/与原文一致”却仍记了 finding，属于自相矛盾。 */
const SELF_NEGATING_PHRASES = [
  '基本准确', '基本符合', '基本一致', '表述基本', '与公认数据一致', '并无错误', '没有错误', '不构成错误',
] as const;

/**
 * 事实维度的“空更正”判定：原文含数值、更正却没有引入任何原文之外的新数值，
 * 或更正/原因里直接写着“基本准确”这类自我否定措辞 —— 两者都说明判官并没有真的发现错误。
 * 只作用于 factual_accuracy：数值与单位类错误由算术/单位审计负责，其更正常常不含新数字
 * （例如把 MB 改成 Mbps），不能套用本规则。
 */
function isEmptyCorrection(finding: RigorFinding): boolean {
  if (finding.dimension !== 'factual_accuracy') return false;
  const text = `${finding.reason}${finding.correction}`;
  if (SELF_NEGATING_PHRASES.some((phrase) => text.includes(phrase))) return true;
  const quoteNumbers = extractNumbers(finding.quote);
  if (!quoteNumbers.length) return false;
  const correctionNumbers = extractNumbers(finding.correction);
  if (!correctionNumbers.length) return false;
  return correctionNumbers.every((value) => quoteNumbers.includes(value));
}

/** 相对限定语：带这类措辞的表述按「不扣分边界」不作绝对断言处理。 */
const RELATIVE_LIMITERS = [
  '最被广泛接受', '被广泛接受', '多数研究', '大多数研究', '部分研究', '通常认为', '一般认为',
  '普遍认为', '主流观点', '之一', '目前最', '可能', '倾向于', '在多数情况下',
] as const;

const hasRelativeLimiter = (text: string): boolean =>
  RELATIVE_LIMITERS.some((limiter) => text.includes(limiter));

function groundFindings(actualOutput: string, findings: RigorFinding[]): {
  findings: RigorFinding[];
  discarded: DiscardedFinding[];
  downgraded: DowngradedFinding[];
  repaired: RepairedFinding[];
} {
  const haystack = compact(actualOutput);
  const kept: RigorFinding[] = [];
  const discarded: DiscardedFinding[] = [];
  const downgraded: DowngradedFinding[] = [];
  const repaired: RepairedFinding[] = [];

  for (const original of findings) {
    let raw = original;
    let needle = compact(raw.quote);
    if (!needle || !haystack.includes(needle)) {
      // 丢弃前先尝试引用修复：模型偶发把思维碎片黏进 quote 首尾，足够长的连续片段仍可核验
      const salvage = needle ? repairQuoteNeedle(haystack, needle) : null;
      if (!salvage) {
        discarded.push({ ...raw, discardReason: 'quote 未逐字出现在实际输出中，判断无法核验。' });
        continue;
      }
      raw = { ...raw, quote: salvage };
      needle = salvage;
      repaired.push({
        ...raw,
        originalQuote: original.quote,
        repairReason: '原引用未逐字命中，取其在原文中连续匹配的最长片段核验通过。',
      });
    }
    // 同一维度下引文互相包含即视为同一处错误（模型常把同一句话截成长短两段各记一条）
    if (kept.some((existing) => existing.dimension === raw.dimension && overlapsQuote(existing, needle))) {
      discarded.push({ ...raw, discardReason: '同一维度下重复引用同一处原文。' });
      continue;
    }

    // 自称错误却给不出不同数值的更正 = 没有真正发现错误（判官幻觉的典型形态）
    if (isEmptyCorrection(raw)) {
      discarded.push({
        ...raw,
        discardReason: '声称数值有误，但更正值与原文数值相同，未提出可核验的更正。',
      });
      continue;
    }

    // high 档必须说明“正确的应该是什么”，否则只是断言错误，降档处理
    if (raw.severity === 'high' && !raw.correction.trim()) {
      const finding: RigorFinding = { ...raw, severity: 'medium' };
      downgraded.push({
        ...finding,
        originalSeverity: 'high',
        downgradeReason: 'high 级问题未给出正确值，降为 medium。',
      });
      kept.push(finding);
      continue;
    }
    kept.push(raw);
  }

  return { findings: kept, discarded, downgraded, repaired };
}

// ── 审计回填：三类审计（命令 / 算术 / 单位）共用同一套落地规则 ────────────────
//
// 每类审计只负责把自己的核查结论翻译成「判据裁定」（AuditVerdict）：哪一处原文、
// 属于哪个维度、判据规定的严重度是多少、正确值与建议是什么。裁定之后的三件事
// ——原文校验、模型已记则升档、模型没记则回填——三类审计完全一致，由
// applyAuditVerdicts 统一执行，避免同样的规则写三遍、改一处漏两处。

interface BackfilledFinding extends RigorFinding {
  backfillReason: string;
}

/** 一条审计得出的判据裁定，尚未与模型的 findings 比对。 */
interface AuditVerdict {
  /** 原文引用，逐字取自审计条目，落成 finding 时直接用作 quote。 */
  quote: string;
  dimension: ContentRigorDimension;
  /** 判据规定的严重度，同时用作严重度地板。 */
  severity: ContentRigorSeverity;
  reason: string;
  correction: string;
  suggestion: string;
  /** 审计表名，用于生成回填与升档的说明文字。 */
  source: string;
}

interface AuditBackfillResult {
  added: RigorFinding[];
  backfilled: BackfilledFinding[];
  upgrades: SeverityFloorUpgrade[];
}

function applyAuditVerdicts(
  actualOutput: string,
  verdicts: AuditVerdict[],
  existing: RigorFinding[],
): AuditBackfillResult {
  const haystack = compact(actualOutput);
  const added: RigorFinding[] = [];
  const backfilled: BackfilledFinding[] = [];
  const upgrades: SeverityFloorUpgrade[] = [];

  for (const verdict of verdicts) {
    const needle = compact(verdict.quote);
    // 引用必须真实出现在实际输出中，否则该核查条目本身不可信，忽略
    if (!needle || !haystack.includes(needle)) continue;

    const covering = [...existing, ...added].find(
      (finding) => finding.dimension === verdict.dimension && overlapsQuote(finding, needle),
    );
    if (covering) {
      // 模型记了但记轻了：按判据升档，而不是因“已覆盖”就跳过
      if (SEVERITY_RANK[covering.severity] < SEVERITY_RANK[verdict.severity]) {
        upgrades.push({
          target: covering,
          severity: verdict.severity,
          correction: verdict.correction,
          upgradeReason: `${verdict.source} 判定该处不通过（判据为 ${verdict.severity}），`
            + `模型仅记为 ${covering.severity}，由代码升档。`,
        });
      }
      continue;
    }

    const finding: RigorFinding = {
      dimension: verdict.dimension,
      severity: verdict.severity,
      quote: verdict.quote,
      reason: verdict.reason,
      correction: verdict.correction,
      suggestion: verdict.suggestion,
    };
    added.push(finding);
    backfilled.push({
      ...finding,
      backfillReason: `${verdict.source} 判定该处不通过，但模型未输出对应 finding，由代码按判据回填。`,
    });
  }
  return { added, backfilled, upgrades };
}

/** 命令核查 → 判据裁定：命令不存在、破坏性无提示、达不到目的三类。 */
function commandVerdicts(audit: RigorCommandAudit[]): AuditVerdict[] {
  const verdicts: AuditVerdict[] = [];
  for (const entry of audit) {
    const base = { quote: entry.command, dimension: 'operational_correctness' as const, source: 'command_audit' };
    if (entry.exists === false) {
      verdicts.push({
        ...base,
        severity: 'high',
        reason: '给出的命令在所述系统中不存在或语法错误，读者照做会直接失败。',
        correction: entry.note?.trim() ?? '',
        suggestion: '替换为目标系统中真实存在且能达到目的的命令。',
      });
    } else if (entry.destructive === true && entry.risk_warned === false) {
      verdicts.push({
        ...base,
        severity: 'high',
        reason: '该操作具有不可逆破坏性，但文本未给出任何风险提示、前提条件或更安全的替代方案。',
        correction: entry.note?.trim()
          || '应在给出该命令前说明其不可逆后果与影响范围，并提供更安全的替代做法（如先备份、限定范围或使用可回收方式）。',
        suggestion: '为该操作补充风险提示与更安全的替代方案。',
      });
    } else if (entry.achieves_goal === false) {
      verdicts.push({
        ...base,
        severity: 'medium',
        reason: '该命令可执行，但达不到用户所述目的。',
        correction: entry.note?.trim() ?? '',
        suggestion: '改用能达到所述目的的命令或步骤。',
      });
    }
  }
  return verdicts;
}

/** 相对容差比较，避免浮点误差把 0.1+0.2 判成错。 */
function numbersMatch(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

function computeStep(left: number, op: RigorCalcOp, right: number): number | null {
  switch (op) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    case '/': return right === 0 ? null : left / right;
    default: return null;
  }
}

/** 数字去尾零后转字符串，供 correction 展示（140 而非 140.00000）。 */
const fmtNum = (value: number): string => String(Number(value.toFixed(6)));

/** 算术核查 → 判据裁定：代码重算每一步，与文本转录的结果不符即为确定性 high。 */
function calculationVerdicts(audit: RigorCalculationAudit[]): AuditVerdict[] {
  const verdicts: AuditVerdict[] = [];
  for (const entry of audit) {
    const correct = computeStep(entry.left, entry.op, entry.right);
    if (correct === null) continue;
    // 代码算的结果与文本转录的 stated_result 一致 → 这一步没错
    if (numbersMatch(correct, entry.stated_result)) continue;
    const expr = `${fmtNum(entry.left)} ${entry.op} ${fmtNum(entry.right)}`;
    verdicts.push({
      quote: entry.quote,
      dimension: 'numerical_precision',
      severity: 'high',
      reason: `算术结果错误：${expr} 应为 ${fmtNum(correct)}，文本给出的是 ${fmtNum(entry.stated_result)}。`,
      correction: entry.note?.trim() || `${expr} = ${fmtNum(correct)}。`,
      suggestion: '按正确的计算结果修正该数值及依赖它的后续结论。',
      source: 'calculation_audit',
    });
  }
  return verdicts;
}

/** 单位核查 → 判据裁定：量纲与场景不匹配是确定性 high。 */
function unitVerdicts(audit: RigorUnitAudit[]): AuditVerdict[] {
  return audit
    .filter((entry) => entry.matches === false)
    .map((entry) => ({
      quote: entry.quote,
      dimension: 'numerical_precision' as const,
      severity: 'high' as const,
      reason: `单位与所述场景不匹配：文本在描述${entry.concept}（度量${entry.concept_measures}），`
        + `却使用了单位「${entry.unit}」（度量${entry.unit_measures}），读者无法据此作出正确判断。`,
      correction: entry.note?.trim() || `应改用与${entry.concept_measures}匹配的单位表述${entry.concept}。`,
      suggestion: `将「${entry.unit}」替换为与${entry.concept}匹配的正确单位，并复核依赖该数值的结论。`,
      source: 'unit_audit',
    }));
}

// ── 高风险断言回填：与权威共识冲突却没出 finding 时，由代码落成事实错误 ─────────

const CLAIM_DOMAIN_LABEL: Record<RigorClaimDomain, string> = {
  health: '健康/医疗',
  safety: '安全',
  legal: '法律',
  finance: '资金',
};

/**
 * 推理连接词：断言所在句子含这些词，说明结论是由文本内前提推出的，
 * 按「维度归属规则」错误归 logical_correctness（封顶 30）而非 factual_accuracy（封顶 40）。
 */
const INFERENCE_CONNECTIVES = ['因此', '所以', '由此可见', '这说明', '故而', '可见'] as const;

/** 可参与断言归属改判/去重的维度；数值维度（单位/算术审计负责）不在其内。 */
const CLAIM_ATTRIBUTABLE_DIMENSIONS: ReadonlySet<ContentRigorDimension> = new Set([
  'factual_accuracy',
  'logical_correctness',
  'misleading_statements',
  'operational_correctness',
]);

interface ReclassifiedFinding extends RigorFinding {
  originalDimension: ContentRigorDimension;
  originalSeverity: ContentRigorSeverity;
  reclassifyReason: string;
}

/** 取实际输出中包含该引文的句子，供推理连接词判定与同句去重；找不到时返回 null。 */
function claimSentence(actualOutput: string, needle: string): string | null {
  return actualOutput
    .split(/(?<=[。！？!?\n])/)
    .find((sentence) => {
      const compacted = compact(sentence);
      return compacted.length > 0 && (compacted.includes(needle) || needle.includes(compacted));
    }) ?? null;
}

function backfillFromClaimAudit(
  actualOutput: string,
  audit: RigorClaimAudit[],
  existing: RigorFinding[],
  commandAudit: RigorCommandAudit[],
): {
  added: RigorFinding[];
  backfilled: BackfilledFinding[];
  removed: RigorFinding[];
  reclassified: ReclassifiedFinding[];
  deduped: DedupedFinding[];
  upgrades: SeverityFloorUpgrade[];
} {
  const haystack = compact(actualOutput);
  const added: RigorFinding[] = [];
  const backfilled: BackfilledFinding[] = [];
  const removed: RigorFinding[] = [];
  const reclassified: ReclassifiedFinding[] = [];
  const deduped: DedupedFinding[] = [];
  const upgrades: SeverityFloorUpgrade[] = [];

  // 命令核查背书的操作 finding 是另一处独立问题（命令层面），不参与断言的归属改判与去重
  const commandNeedles = commandAudit
    .map((entry) => compact(entry.command))
    .filter((needle) => needle.length > 0);
  const isCommandBacked = (finding: RigorFinding): boolean =>
    finding.dimension === 'operational_correctness'
    && commandNeedles.some((needle) => overlapsQuote(finding, needle));

  const seenSentences = new Set<string>();

  for (const entry of audit) {
    const needle = compact(entry.quote);
    // quote 必须真实出现在输出中，否则该核查条目不可信，忽略
    if (!needle || !haystack.includes(needle)) continue;
    if (entry.text_agrees_with_consensus !== false) continue;

    // 带相对限定语的表述按「不扣分边界」不作绝对断言处理：既不回填、不升档、不改判，
    // 模型基于同一处引文记的事实/误导 finding 也一并豁免（这类"地位型"断言的争议不算错误）
    const sentenceForLimiter = claimSentence(actualOutput, needle);
    if (hasRelativeLimiter(`${entry.quote}${sentenceForLimiter ?? ''}`)) {
      for (const exempt of [...existing, ...added].filter(
        (finding) =>
          (finding.dimension === 'factual_accuracy' || finding.dimension === 'misleading_statements')
          && !removed.includes(finding)
          && overlapsQuote(finding, needle),
      )) {
        removed.push(exempt);
        deduped.push({
          ...exempt,
          dedupReason: '该表述使用相对限定语，按「不扣分边界」不作绝对断言处理，不记为问题。',
        });
      }
      continue;
    }

    // 断言本身就是一条命令的推荐（引文与 command_audit 的命令重叠）→ 该问题属于命令层面，
    // 已由命令核查负责，claim 侧不再另记，避免同一处双重扣分
    if (commandNeedles.some((commandNeedle) => needle.includes(commandNeedle) || commandNeedle.includes(needle))) {
      continue;
    }

    // 同一句子里的多条 claim_audit 视为同一断言，只处理一条——
    // 否则模型把一句话拆成两条断言就会翻倍扣分（同一处错误只计一次）
    const sentence = claimSentence(actualOutput, needle);
    const sentenceKey = sentence ? compact(sentence) : needle;
    if (seenSentences.has(sentenceKey)) continue;
    seenSentences.add(sentenceKey);

    // 维度归属由代码按文本内的确定性信号裁定，不留给模型自由发挥
    const context = `${entry.quote}${sentence ?? ''}`;
    const inferential = INFERENCE_CONNECTIVES.some((connective) => context.includes(connective));
    const target: ContentRigorDimension = inferential ? 'logical_correctness' : 'factual_accuracy';
    // 带限定语的表述按「不扣分边界」不作绝对断言处理，降一档
    const floor: ContentRigorSeverity = entry.hedged === true ? 'medium' : 'high';
    const reasonText = inferential
      ? `断言由文本内的前提经推理得出且推理不成立，其结论亦与权威共识不符：${entry.consensus.trim()}`
      : `${CLAIM_DOMAIN_LABEL[entry.domain]}领域的断言与权威共识不符：${entry.consensus.trim()}`;
    const correction = entry.note?.trim() || entry.consensus.trim();

    const pool = [...existing, ...added].filter((finding) => !removed.includes(finding));

    // 单位/算术错误已由数值维度就同一处计分 → 该处不再按断言回填，避免同一错误双重扣分
    if (pool.some(
      (finding) => finding.dimension === 'numerical_precision' && overlapsQuote(finding, needle),
    )) {
      continue;
    }

    const overlapping = pool.filter(
      (finding) =>
        CLAIM_ATTRIBUTABLE_DIMENSIONS.has(finding.dimension)
        && !isCommandBacked(finding)
        && overlapsQuote(finding, needle),
    );
    const targetHit = overlapping.find((finding) => finding.dimension === target);
    const others = overlapping.filter((finding) => finding !== targetHit);

    if (targetHit) {
      // 模型已按正确维度记过：只补严重度地板，其余同处重复 finding 去重
      if (SEVERITY_RANK[targetHit.severity] < SEVERITY_RANK[floor]) {
        upgrades.push({
          target: targetHit,
          severity: floor,
          correction,
          upgradeReason: entry.hedged === true
            ? 'claim_audit 判定断言与共识冲突（带限定语），按判据应为 medium，由代码升档。'
            : 'claim_audit 判定断言与共识冲突且无限定语，按判据应为 high，由代码升档。',
        });
      }
      for (const duplicate of others) {
        removed.push(duplicate);
        deduped.push({
          ...duplicate,
          dedupReason: `与同一断言的${labelOf(target)} finding 指向同一处错误，按「同一处错误只计一次」去重。`,
        });
      }
      continue;
    }

    if (others.length) {
      // 模型记进了别的维度：改判最严重的一条到目标维度，其余去重
      const primary = others.reduce(
        (worst, candidate) =>
          SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[worst.severity] ? candidate : worst,
      );
      removed.push(primary);
      const finding: RigorFinding = {
        dimension: target,
        severity: floor,
        quote: primary.quote,
        reason: reasonText,
        correction,
        suggestion: '按权威共识改写该断言，并补充必要的适用条件与限定语。',
      };
      added.push(finding);
      reclassified.push({
        ...finding,
        originalDimension: primary.dimension,
        originalSeverity: primary.severity,
        reclassifyReason:
          `按「维度归属规则」该断言应记为${labelOf(target)}${inferential ? '（结论由文本内前提推出）' : ''}，`
          + `原判为${labelOf(primary.dimension)}。`,
      });
      for (const duplicate of others.filter((finding_) => finding_ !== primary)) {
        removed.push(duplicate);
        deduped.push({
          ...duplicate,
          dedupReason: `与同一断言的另一条 finding 指向同一处错误，按「同一处错误只计一次」去重。`,
        });
      }
      continue;
    }

    // 模型沉默 → 按目标维度回填
    const finding: RigorFinding = {
      dimension: target,
      severity: floor,
      quote: entry.quote,
      reason: reasonText,
      correction,
      suggestion: '按权威共识改写该断言，并补充必要的适用条件与限定语。',
    };
    added.push(finding);
    backfilled.push({
      ...finding,
      backfillReason: 'claim_audit 判定断言与权威共识冲突，但模型未输出对应 finding，由代码回填。',
    });
  }
  return { added, backfilled, removed, reclassified, deduped, upgrades };
}

// ── 计分与组装 ──────────────────────────────────────────────────────────────

const clampScore = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

function pointStatus(findings: RigorFinding[]): EvalPointStatus {
  if (!findings.length) return 'covered';
  return findings.some((finding) => finding.severity === 'high') ? 'missing' : 'partial';
}

function findingMd(finding: RigorFinding): string {
  const lines = [`- ${SEVERITY_LABEL[finding.severity]}：「${finding.quote}」—— ${finding.reason}`];
  if (finding.correction.trim()) lines.push(`  正确信息：${finding.correction.trim()}`);
  if (finding.suggestion.trim()) lines.push(`  建议：${finding.suggestion.trim()}`);
  return lines.join('\n');
}

// ── 明细旁路（测试 / 排障用，不进上报契约）──────────────────────────────────

/**
 * 代码侧裁决明细。以前整块塞在 evidence.json 里，结果被前端当作卡片证据渲染成一坨
 * 原始 JSON；现在改挂 WeakMap，卡片只看自然语言 md，明细也不再随结果落库。
 */
const detailByOutput = new WeakMap<EvaluatorOutput, Record<string, unknown>>();

/** 仅供测试与排障读取代码侧裁决明细；不进入上报契约，也不落库。 */
export function rigorDetailOf(output: EvaluatorOutput): Record<string, unknown> {
  return detailByOutput.get(output) ?? {};
}

/**
 * 把计分过程与代码侧裁决渲染成自然语言证据，替代原来的原始 JSON 转储。
 *
 * 三段固定顺序：计分说明（扣了多少、按维度拆、封顶是否生效）→ 核查范围（四张审计表
 * 各查了多少条）→ 代码侧裁决（模型原判被回填/升档/改判/降档/去重/丢弃/修复了什么）。
 * 首段刻意不与 summary 重复，否则会被 isEvidenceRedundant 整块判重藏掉。
 */
function buildEvidenceMd(d: {
  findings: RigorFinding[];
  deductionByDimension: Map<ContentRigorDimension, number>;
  totalDeduction: number;
  baseScore: number;
  score: number;
  appliedCap: { value: number; reason: string } | null;
  capEffective: boolean;
  judgment: RigorJudgeResult;
  discarded: DiscardedFinding[];
  downgraded: DowngradedFinding[];
  repaired: RepairedFinding[];
  upgraded: UpgradedFinding[];
  backfilled: BackfilledFinding[];
  reclassified: ReclassifiedFinding[];
  deduped: DedupedFinding[];
}): string {
  const sections: string[] = [];

  // 计分说明：标题 + 总述 / 扣分明细 / 封顶说明 / 最终分各自成段，避免 md 列表与正文粘连
  const scoring: string[] = ['**计分说明**'];
  if (!d.findings.length) {
    scoring.push('未记录任何严谨性问题，不扣分。');
  } else {
    const spread = (['high', 'medium', 'low'] as const)
      .map((severity) => ({ severity, count: d.findings.filter((f) => f.severity === severity).length }))
      .filter((item) => item.count > 0)
      .map((item) => `${SEVERITY_NAME[item.severity]} ${item.count} 处`)
      .join('、');
    scoring.push(
      `共记录 ${d.findings.length} 处问题（${spread}），累计扣 ${d.totalDeduction} 分，扣分后为 ${d.baseScore} 分。`,
    );
    const perDimension = CONTENT_RIGOR_DIMENSIONS
      .map((dimension) => ({ label: dimension.label, value: d.deductionByDimension.get(dimension.key) ?? 0 }))
      .filter((item) => item.value > 0)
      .map((item) => `- ${item.label}：扣 ${item.value} 分`);
    if (perDimension.length) scoring.push(perDimension.join('\n'));
    if (d.appliedCap) {
      scoring.push(d.capEffective
        ? `${d.appliedCap.reason}总分由 ${d.baseScore} 分封顶为 ${d.appliedCap.value} 分。`
        : `触发了 ${d.appliedCap.value} 分封顶，但累计扣分后的 ${d.baseScore} 分已低于封顶值，封顶未生效。`);
    }
  }
  scoring.push(`最终总分 ${d.score} 分。`);
  sections.push(scoring.join('\n\n'));

  const scope = ([
    ['命令与操作', d.judgment.commandAudit?.length ?? 0, '条'],
    ['算术步骤', d.judgment.calculationAudit?.length ?? 0, '步'],
    ['带单位数值', d.judgment.unitAudit?.length ?? 0, '处'],
    ['高风险断言', d.judgment.claimAudit?.length ?? 0, '条'],
  ] as const).filter(([, count]) => count > 0).map(([name, count, unit]) => `${name} ${count} ${unit}`);
  sections.push(scope.length
    ? `**核查范围**\n本次逐项核查：${scope.join('、')}。`
    : '**核查范围**\n实际输出中未出现需要专项核查的命令、计算、单位或高风险断言。');

  const acts: string[] = [];
  for (const f of d.backfilled) {
    acts.push(`- **回填**：${f.backfillReason}补记「${f.quote}」，判为${labelOf(f.dimension)}${SEVERITY_NAME[f.severity]}问题。`);
  }
  for (const f of d.upgraded) {
    acts.push(`- **升档**：「${f.quote}」由${SEVERITY_NAME[f.originalSeverity]}升为${SEVERITY_NAME[f.severity]}——${f.upgradeReason}`);
  }
  for (const f of d.reclassified) {
    acts.push(`- **改判维度**：「${f.quote}」由${labelOf(f.originalDimension)}改判为${labelOf(f.dimension)}——${f.reclassifyReason}`);
  }
  for (const f of d.downgraded) {
    acts.push(`- **降档**：「${f.quote}」由${SEVERITY_NAME[f.originalSeverity]}降为${SEVERITY_NAME[f.severity]}——${f.downgradeReason}`);
  }
  for (const f of d.deduped) {
    acts.push(`- **去重**：「${f.quote}」——${f.dedupReason}`);
  }
  for (const f of d.discarded) {
    acts.push(`- **丢弃**：「${f.quote}」——${f.discardReason}`);
  }
  for (const f of d.repaired) {
    acts.push(`- **引用修复**：原引用「${f.originalQuote}」——${f.repairReason}`);
  }
  if (acts.length) {
    sections.push(`**代码侧裁决（共 ${acts.length} 项）**\n模型的原始判断经以下修正后才计入分数：\n${acts.join('\n')}`);
  }

  const judgeSummary = d.judgment.summary?.trim();
  if (judgeSummary) {
    sections.push(`**模型原始判断**\n${judgeSummary}（留档参考，最终结论以上述计分为准）`);
  }

  return sections.join('\n\n');
}

/** 纯函数计分入口：测试直接构造 judgment 断言分数，无需注入模型。 */
export function buildRigorEvaluatorOutput(input: {
  actualOutput: string;
  judgment: RigorJudgeResult;
}): EvaluatorOutput {
  const grounded = groundFindings(input.actualOutput, input.judgment.findings ?? []);
  // 三类审计的裁定一次性落地：同一处只会被落成一条 finding（先到先得，后到者只做升档）
  const audits = applyAuditVerdicts(
    input.actualOutput,
    [
      ...commandVerdicts(input.judgment.commandAudit ?? []),
      ...calculationVerdicts(input.judgment.calculationAudit ?? []),
      ...unitVerdicts(input.judgment.unitAudit ?? []),
    ],
    grounded.findings,
  );
  const claimAudit = backfillFromClaimAudit(
    input.actualOutput,
    input.judgment.claimAudit ?? [],
    [...grounded.findings, ...audits.added],
    input.judgment.commandAudit ?? [],
  );

  // 无命令背书的 operational finding 若与同一处引文上其他维度的 finding 重复 → 维度漂移去重。
  // operational 判的是命令/操作；command_audit 对命令是必填的，引文与任何被核查命令都不重叠、
  // 又与别的维度共用同一句引文，说明它只是同一个错误换了个维度再记一遍。
  const commandNeedlesForDrift = (input.judgment.commandAudit ?? [])
    .map((entry) => compact(entry.command))
    .filter((needle) => needle.length > 0);
  const driftDeduped: DedupedFinding[] = [];
  const driftRemoved: RigorFinding[] = [];
  for (const candidate of grounded.findings) {
    if (candidate.dimension !== 'operational_correctness') continue;
    if (claimAudit.removed.includes(candidate)) continue;
    const needle = compact(candidate.quote);
    const commandBacked = commandNeedlesForDrift.some(
      (commandNeedle) => needle.includes(commandNeedle) || commandNeedle.includes(needle),
    );
    if (commandBacked) continue;
    const twin = grounded.findings.find(
      (other) =>
        other !== candidate
        && !claimAudit.removed.includes(other)
        && !driftRemoved.includes(other)
        && other.dimension !== 'operational_correctness'
        && compact(other.quote) === needle,
    );
    if (!twin) continue;
    driftRemoved.push(candidate);
    driftDeduped.push({
      ...candidate,
      dedupReason: `引文未对应任何被核查的命令，且同一处引文已按${labelOf(twin.dimension)}记录，视为同一错误的维度漂移重复，去重。`,
    });
  }
  const backfilled = [...audits.backfilled, ...claimAudit.backfilled];
  // 回填 finding 同样走高严重度缺正确值降档（命令类回填已在原文中，算术类 correction 恒非空）
  const backfilledChecked = [...audits.added, ...claimAudit.added].map((finding) =>
    finding.severity === 'high' && !finding.correction.trim()
      ? { ...finding, severity: 'medium' as ContentRigorSeverity }
      : finding,
  );

  // 严重度地板：模型记了 finding 但档位低于审计判据时升档；correction 为空用审计条目补齐，
  // 保证升到 high 的 finding 仍满足“high 必须给出正确值”的契约
  const floorUpgrades = [...audits.upgrades, ...claimAudit.upgrades];
  const upgradeByTarget = new Map<RigorFinding, SeverityFloorUpgrade>();
  for (const upgrade of floorUpgrades) {
    const previous = upgradeByTarget.get(upgrade.target);
    if (!previous || SEVERITY_RANK[upgrade.severity] > SEVERITY_RANK[previous.severity]) {
      upgradeByTarget.set(upgrade.target, upgrade);
    }
  }
  const upgraded: UpgradedFinding[] = [];
  const groundedFinal = grounded.findings
    .filter((finding) => !claimAudit.removed.includes(finding) && !driftRemoved.includes(finding))
    .map((finding) => {
      const upgrade = upgradeByTarget.get(finding);
      if (!upgrade || SEVERITY_RANK[upgrade.severity] <= SEVERITY_RANK[finding.severity]) return finding;
      const next: RigorFinding = {
        ...finding,
        severity: upgrade.severity,
        correction: finding.correction.trim() ? finding.correction : upgrade.correction,
      };
      upgraded.push({ ...next, originalSeverity: finding.severity, upgradeReason: upgrade.upgradeReason });
      return next;
    });
  const findings = [...groundedFinal, ...backfilledChecked];

  const deductionByDimension = new Map<ContentRigorDimension, number>();
  let totalDeduction = 0;
  for (const finding of findings) {
    const value = DEDUCTIONS[finding.dimension][finding.severity];
    deductionByDimension.set(finding.dimension, (deductionByDimension.get(finding.dimension) ?? 0) + value);
    totalDeduction += value;
  }

  // 封顶：各 high 维度的封顶值 + 多处 high 的整体封顶，取其中最小者
  const highFindings = findings.filter((finding) => finding.severity === 'high');
  const caps: Array<{ value: number; reason: string }> = highFindings.map((finding) => ({
    value: HIGH_SEVERITY_CAPS[finding.dimension],
    reason: `${labelOf(finding.dimension)}存在严重问题：${finding.reason}`,
  }));
  if (highFindings.length >= MULTI_HIGH_CAP.threshold) {
    caps.push({
      value: MULTI_HIGH_CAP.value,
      reason: `共 ${highFindings.length} 处严重问题叠加。`,
    });
  }
  const appliedCap = caps.length
    ? caps.reduce((lowest, current) => (current.value < lowest.value ? current : lowest))
    : null;

  const baseScore = clampScore(100 - totalDeduction);
  const score = appliedCap ? Math.min(baseScore, appliedCap.value) : baseScore;
  // 封顶只有在真的压低了分数时才“生效”；0 分被“封顶为 40”这种说明会让人以为公式错了
  const capEffective = appliedCap !== null && appliedCap.value < baseScore;

  const points: EvalPoint[] = CONTENT_RIGOR_DIMENSIONS.map((definition) => {
    const related = findings.filter((finding) => finding.dimension === definition.key);
    const md = related.length
      ? related.map(findingMd).join('\n')
      : '未发现该维度的严谨性问题。';
    return {
      label: definition.label,
      score: clampScore(100 - (deductionByDimension.get(definition.key) ?? 0)),
      status: pointStatus(related),
      evidence: { md },
      suggestion: related.find((finding) => finding.suggestion.trim())?.suggestion || undefined,
    };
  });
  if (appliedCap && capEffective) {
    points.push({
      label: '总分封顶说明',
      evidence: {
        md: `${appliedCap.reason}总分由累计扣分后的 ${baseScore} 分封顶为 ${appliedCap.value} 分。`,
      },
    });
  }

  // summary 与 verdict 只由存活 findings 推导，保证和 score 说的是同一件事
  const summary = buildSummary(findings, grounded.discarded.length);
  const verdict = findings.length === 0 ? 'pass' : appliedCap ? 'fail' : 'warn';

  const deduped = [...claimAudit.deduped, ...driftDeduped];

  const output = normalizeEvaluatorOutput({
    verdict,
    summary,
    score,
    points,
    // 卡片上的评估器级证据：自然语言，不再是原始 JSON 转储
    evidence: {
      md: buildEvidenceMd({
        findings,
        deductionByDimension,
        totalDeduction,
        baseScore,
        score,
        appliedCap,
        capEffective,
        judgment: input.judgment,
        discarded: grounded.discarded,
        downgraded: grounded.downgraded,
        repaired: grounded.repaired,
        upgraded,
        backfilled,
        reclassified: claimAudit.reclassified,
        deduped,
      }),
    },
  });

  // 明细走旁路：仅供测试与排障（rigorDetailOf），不进上报契约、不落库
  detailByOutput.set(output, {
    rubricVersion: RIGOR_RUBRIC_VERSION,
    totalDeduction,
    baseScore,
    deductionByDimension: Object.fromEntries(deductionByDimension),
    ...(appliedCap ? { appliedCap: { ...appliedCap, effective: capEffective } } : {}),
    // Judge 的原话只留档，不作结论
    judgeSummary: input.judgment.summary?.trim() || null,
    commandAudit: input.judgment.commandAudit ?? [],
    calculationAudit: input.judgment.calculationAudit ?? [],
    unitAudit: input.judgment.unitAudit ?? [],
    claimAudit: input.judgment.claimAudit ?? [],
    reclassifiedFindings: claimAudit.reclassified,
    dedupedFindings: deduped,
    upgradedFindings: upgraded,
    backfilledFindings: backfilled,
    findings,
    discardedFindings: grounded.discarded,
    downgradedFindings: grounded.downgraded,
    repairedFindings: grounded.repaired,
    suggestions: uniqueStrings(findings.map((finding) => finding.suggestion)),
  });
  return output;
}

function labelOf(dimension: ContentRigorDimension): string {
  return CONTENT_RIGOR_DIMENSIONS.find((item) => item.key === dimension)?.label ?? dimension;
}

const SUMMARY_MAX_CHARS = 80;
const SUMMARY_QUOTE_MAX_CHARS = 20;

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;

/**
 * 由存活 findings 生成卡片 summary（≤80 字）：没有就说没有，有就讲最严重那一条是哪句话、哪个维度、为什么错。
 * discardedCount 用于提示“模型判了但没通过原文校验”，避免把“丢弃”伪装成“没问题”。
 */
function buildSummary(findings: RigorFinding[], discardedCount: number): string {
  if (!findings.length) {
    return discardedCount > 0
      ? truncate(`未发现可核验的严谨性问题（模型提出的 ${discardedCount} 处疑点未通过原文与更正校验，未记入）。`, SUMMARY_MAX_CHARS)
      : '未发现事实、数值、逻辑或操作层面的错误表述。';
  }
  const worst = findings.find((finding) => finding.severity === 'high')
    ?? findings.find((finding) => finding.severity === 'medium')
    ?? findings[0];
  const quote = truncate(worst.quote.trim(), SUMMARY_QUOTE_MAX_CHARS);
  const prefix = findings.length > 1 ? `共 ${findings.length} 处问题，最严重的是` : '';
  const body = `${prefix}${labelOf(worst.dimension)}：「${quote}」${worst.reason.trim()}`;
  return truncate(body, SUMMARY_MAX_CHARS);
}

/** 空输出无从判定：不给分，只说明原因（用户未提供内容不是系统故障，不能抛错）。 */
function emptyOutputResult(): EvaluatorOutput {
  const output = normalizeEvaluatorOutput({
    summary: '实际输出为空，无法评估内容严谨性——不记分。',
    evidence: {
      md: '**计分说明**\n实际输出为空，没有可判定的陈述，本次不记分（不计入综合分与类目均分）。'
        + '\n\n**核查范围**\n无可核查内容，未执行命令、计算、单位与高风险断言的逐项核查。',
    },
  });
  detailByOutput.set(output, {
    rubricVersion: RIGOR_RUBRIC_VERSION,
    unscoredReason: '实际输出为空，没有可判定的陈述。',
    findings: [],
  });
  return output;
}

/**
 * 技术量纲单位词表：出现这些单位就必然存在“数值 + 单位”，unit_audit 不得为空数组。
 * 只收录量纲明确、易被混用的技术单位；货币、时间等日常单位不列入，避免无谓重试。
 */
const TECHNICAL_UNIT_PATTERN =
  /\d+\s*(?:[KMGTP]?B\b|[KMGTP]?bps\b|[KMGT]?Hz\b|[kKMG]?W\b|[kKMG]?Wh\b|mAh\b|[kKM]?m\/s\b|瓦|千瓦|伏|安|焦耳)/i;

/** 判定 quote 是否跨句：去掉结尾句读后仍含句界，说明把多个句子合并进了一条引用。 */
const hasInternalSentenceBoundary = (quote: string): boolean =>
  /[。！？!?]/.test(quote.trim().replace(/[。！？!?\s]+$/u, ''));

/** 提示词把审计表与最小引用写成必填契约；违约交给重试而不是静默少扣分 / 给满分。 */
function assertJudgeContracts(
  actualOutput: string,
  parsed: { unit_audit?: unknown[]; findings?: Array<{ dimension?: string; quote?: string }> },
): void {
  if (TECHNICAL_UNIT_PATTERN.test(actualOutput) && (parsed.unit_audit ?? []).length === 0) {
    throw new JudgeOutputParseError(
      '实际输出包含带技术单位的数值，但 unit_audit 为空数组，违反“审计表必填”契约。',
      JSON.stringify({ unit_audit: parsed.unit_audit ?? [] }),
    );
  }
  for (const finding of parsed.findings ?? []) {
    if (
      (finding.dimension === 'factual_accuracy' || finding.dimension === 'numerical_precision')
      && typeof finding.quote === 'string'
      && hasInternalSentenceBoundary(finding.quote)
    ) {
      throw new JudgeOutputParseError(
        '事实/数值类 finding 的 quote 跨越了多个句子，疑似把多处错误合并成一条（会导致扣分不足），违反“一条 finding 只覆盖一个错误、引用最小片段”契约。',
        JSON.stringify(finding),
      );
    }
  }
}

export async function runRigorPreset(
  user: string,
  ctx: FaithfulPresetContext,
): Promise<EvaluatorOutput> {
  if (!ctx.actualOutput?.trim()) return emptyOutputResult();
  // referenceOutput 是需求里那份“可选的事实依据”：有则作权威依据，无则依据模型知识。
  // 故 requires 保持为空，不做 ④ 步门控——本评估器的主场景恰恰是没有参考答案。
  const parsed = await invokeSpecializedJudge(
    user,
    generateContentRigorPrompt({
      query: ctx.caseInput,
      actualOutput: ctx.actualOutput,
      referenceFacts: ctx.referenceOutput,
    }),
    rigorJudgeSchema,
  );
  assertJudgeContracts(ctx.actualOutput, parsed);
  const judgment: RigorJudgeResult = {
    summary: parsed.summary,
    commandAudit: parsed.command_audit ?? [],
    calculationAudit: parsed.calculation_audit ?? [],
    unitAudit: parsed.unit_audit ?? [],
    claimAudit: parsed.claim_audit ?? [],
    findings: parsed.findings ?? [],
  };
  return buildRigorEvaluatorOutput({ actualOutput: ctx.actualOutput, judgment });
}

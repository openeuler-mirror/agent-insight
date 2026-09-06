/**
 * Skill 改进建议 agent —— 轨迹评测的「建议流」。
 *
 * 与「计分流」（opencode-trajectory-evaluator 的关键动作覆盖判定）解耦：
 *   - 计分流：逐个关键动作判 covered/partial/missing，喂 completeness 分。便宜、全量。
 *   - 建议流（本模块）：读**完整 trace 资料包**（含 thinking、工具入参出参）整体反思，
 *     按根因产出 skill 改进建议。贵、只对「有信号」的 case 跑（见 shouldRunSuggestionAgent）。
 *
 * 对齐旧版 opencode 评测器：ensureTraceBundle 落盘 + ephemeral opencode
 * createSession/tag/chat/recordEvaluatorExecution。skill 内容**不旁路注入**——agent 直接从
 * trace 里读运行期实际 load 进去的 SKILL.md（load_skill 节点），评的就是"真实跑过的那版 skill"。
 *
 * 输出固定 5 字段，直接对接 derive-skill-opt-points → SkillIssue 表。
 */
import { jsonrepair } from 'jsonrepair';
import {
  AgentInsight,
  type ChatHandlers,
  type SendPromptPayload,
} from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client';
import { runWithEphemeralOpencodeServer } from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager';
import { ensureSessionWorkspace, buildPermissionsForWorkspace } from '@/lib/engine/general-agent';
import { withBackgroundOpencodeSlot } from '@/lib/engine/general-agent/concurrency-limiter';
import { loadServerModelForUser } from '@/lib/engine/general-agent/server-model-config';
import { ensureTraceBundle } from '@/lib/engine/observability/trace-bundle';
import { tagOpencodeSession } from '@/lib/internal-agent-tag';
import { findSystemAgentDefinition, getSystemAgentId } from '@/lib/system-agents';
import { recordEvaluatorExecution } from './evaluator-execution-recorder';
import type { KeyActionTraceAnalysisResult, TrajectoryDimensionScores } from './trajectory-evaluator';

/** 改进建议分类——映射到 SkillIssue.category（前端按它分组展示）。 */
export const SKILL_SUGGESTION_CATEGORIES = [
  '指令缺失',
  '指令模糊',
  '缺少护栏',
  '过度约束',
  '顺序不当',
  '缺少示例',
  '其他',
] as const;
export type SkillSuggestionCategory = (typeof SKILL_SUGGESTION_CATEGORIES)[number];

const SUGGESTION_AGENT_NAME = 'skill-suggestion-advisor';

/** 建议 agent 的产物——一条 skill 归因 ↔ 一条改进建议（+ trace 证据）。 */
export interface SkillSuggestion {
  /** 问题分类 → SkillIssue.category */
  category: SkillSuggestionCategory;
  /** high | medium | low → SkillIssue.severity */
  severity: 'high' | 'medium' | 'low';
  /** 归因：skill 哪里不足（一句话结论）→ SkillIssue.summary */
  summary: string;
  /** trace 凭据：用「trace 中……」自然语言描述现象，≤200字、无节点编号 → SkillIssue.evidence */
  evidence: string;
  /** 改进建议：改 SKILL.md 哪里、补/改什么 → SkillIssue.suggestedFix */
  improvementSuggestion: string;
}

/**
 * 门控（改进二）：只对「有信号」的 case 跑贵的建议 agent。
 *  - 失败 case
 *  - 有关键动作 partial / missing（覆盖不全）
 *  - completeness 偏低
 * 全覆盖且通过 → 跳过，省掉这次深读。
 */
const COMPLETENESS_GATE = 0.999;

export function shouldRunSuggestionAgent(args: {
  keyActionResults?: KeyActionTraceAnalysisResult[] | null;
  completeness?: TrajectoryDimensionScores['completeness'];
  failed?: boolean;
}): boolean {
  const kar = Array.isArray(args.keyActionResults) ? args.keyActionResults : [];
  // 没有关键动作 = 没有 skill 可对照（trace_only / 无 skill），无从给 skill 建议。
  if (kar.length === 0) return false;
  if (args.failed) return true;
  const hasUncovered = kar.some((k) => k.coverage === 'partial' || k.coverage === 'missing');
  if (hasUncovered) return true;
  const c = args.completeness;
  if (typeof c === 'number' && c < COMPLETENESS_GATE) return true;
  return false;
}

const SUGGESTION_SYSTEM_PROMPT = `你是 Skill 优化审阅者，运行在基于 OpenCode 的通用 Agent 框架中。

你会拿到一次「真实执行」的完整 trace 资料包（含模型 thinking、工具入参/出参、子任务调用）。
你的任务不是评判执行对错，而是回答一个问题：这次执行暴露出 SKILL 本身哪些可以改进的地方。

# skill 内容从 trace 里读（重要）
不要凭空假设 skill 内容。这次执行用的 SKILL.md 已经在 trace 里——opencode 激活 skill 时
通过 load_skill 把 SKILL.md 正文（以及运行期按需加载的 reference）载入了上下文。
请先在 trace 资料包里定位 skill 激活 / load_skill 相关节点，读出**实际加载并执行的 skill 内容**，
再据此判断。判断对象是"trace 里真实跑的这版 skill"。

# 关于 skill 的资源加载（不要误报）
SKILL.md 引用的脚本（如 scripts/*.sh）和参考文档（references/*.md）由 opencode 在 skill 激活时
按需渐进加载，执行期对 agent 都是可用的。因此【不要】把"文件未部署""缺少 scripts / references 目录"
"脚本不存在"这类问题当作 skill 缺陷——那是 opencode 的资源加载机制，不是 SKILL.md 的内容问题。
你的关注点是 SKILL.md 指令本身的清晰度、完整性、顺序、约束与示例是否到位。

# 你不是执行者
跑这次任务的不是你。你是事后读 trace 的审阅者，一切基于证据，不要脑补、不要假设 trace 里没有的内容。

# 任务
通读完整 trace，找出执行中「卡顿 / 走错 / 反复重试 / 低效 / 或反过来异常顺畅」之处，
判断其中哪些能归因到 SKILL，并给出可直接落地到 SKILL.md 的改进建议。
问题类型不限于：指令缺失、指令模糊、缺少护栏、过度约束、顺序不当、缺少示例。

# 三类归因（决定要不要产建议）
1. skill 有缺陷 → 出建议。
2. 偏离了 skill 但偏离是对的 → 说明 skill 该放宽/修正 → 出建议（方向是改 skill 去贴合正确做法）。
3. 模型能力或环境/任务本身问题，改 skill 无效 → 不出建议（直接不产，别硬凑）。

# 关键动作覆盖线索
输入里会给「关键动作覆盖结果」中 partial/missing 的部分，仅作排查起点参考，不要被它框住——
真正的改进点可能跟任何关键动作都不对应；多个未覆盖动作如果同源，请合并成一条根因建议。

# 读取规则（trace 资料包）
1. 先读 manifest.json 和 trace-index.json，建立整体链路认知。
2. 需要定位某节点时，按 index 里的 nodeFile 读对应 nodes/*.json（skill 内容通常在 load_skill 结果或系统约束节点里）。
3. node 的 input/output 若带 artifactPath，仅在需要原文证据时再读 artifacts/*.txt。
4. 不要一次性把所有 artifact 都读进来。

# 硬性约束
- 一个根因合并成一条，不要按关键动作逐条复述。
- evidence 用「trace 中……」这样的自然语言描述实际发生了什么（≤200字、front-load 关键信息）；
  禁止出现 @[nodeId]、节点编号、trace-index 的 id 等用户看不懂的引用。
- 宁缺毋滥：只产出有证据、能落地的建议；没有可改进点就返回空数组。
- improvementSuggestion 写清「改 SKILL.md 哪一块流程/约束，补/删/改成什么」，可直接落库。
- 默认中文。

# 输出格式（重要）
你的【最后一条消息】必须且只能是下面这个 JSON 对象本身——不要 markdown 代码围栏、
不要在 JSON 前后写任何分析或叙述文字（分析放在前面的步骤里，最后一条消息只留 JSON）。
字符串值内若需引用，请用中文「」或单引号，禁止出现未转义的英文双引号（否则 JSON 非法）：
{
  "suggestions": [
    {
      "category": "指令缺失|指令模糊|缺少护栏|过度约束|顺序不当|缺少示例|其他",
      "severity": "high|medium|low",
      "summary": "归因：skill 哪里不足（一句话结论）",
      "evidence": "trace 中……（一句话现象，≤200字，无节点编号）",
      "improvementSuggestion": "改 SKILL.md 哪里、补/改什么"
    }
  ]
}
没有可改进点时输出 {"suggestions": []}。`;

function buildCoverageHints(keyActionResults?: KeyActionTraceAnalysisResult[] | null): string {
  const kar = Array.isArray(keyActionResults) ? keyActionResults : [];
  const uncovered = kar.filter((k) => k.coverage === 'partial' || k.coverage === 'missing');
  if (uncovered.length === 0) return '（覆盖结果显示关键动作均已覆盖，仅供参考；请独立从完整 trace 找改进点。）';
  return uncovered
    .map((k, i) => `${i + 1}. [${k.coverage}] ${String(k.actionContent || k.actionId || '').slice(0, 200)}`)
    .join('\n');
}

function clampSeverity(v: unknown): SkillSuggestion['severity'] {
  const s = String(v || '').toLowerCase().trim();
  return s === 'high' || s === 'medium' || s === 'low' ? s : 'medium';
}

function clampCategory(v: unknown): SkillSuggestionCategory {
  const s = String(v || '').trim();
  return (SKILL_SUGGESTION_CATEGORIES as readonly string[]).includes(s)
    ? (s as SkillSuggestionCategory)
    : '其他';
}

/** 从 start 处按花括号配平抠出一个完整 JSON 对象（忽略字符串内的括号）。 */
function sliceBalancedObject(s: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 收集候选 JSON 串，按"最可能是最终答案"的顺序：
 * 代码块（后出现的优先）→ 围绕最后一个 "suggestions" 的配平对象 → 整段 → 首尾大括号兜底。
 * 兼容 'plan' agent 边读边叙述、最后才吐 JSON（叙述里可能含括号/代码块）的情况。
 */
function collectJsonCandidates(raw: string): string[] {
  const out: string[] = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  const fences: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(raw)) !== null) fences.push(m[1].trim());
  for (let i = fences.length - 1; i >= 0; i--) out.push(fences[i]);
  const key = raw.lastIndexOf('"suggestions"');
  if (key >= 0) {
    let open = raw.lastIndexOf('{', key);
    while (open >= 0) {
      const obj = sliceBalancedObject(raw, open);
      if (obj && obj.includes('"suggestions"')) { out.push(obj); break; }
      open = raw.lastIndexOf('{', open - 1);
    }
  }
  out.push(raw);
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a >= 0 && b > a) out.push(raw.slice(a, b + 1));
  return out;
}

/** 从 agent 自由文本里抠出 JSON 并解析出 suggestions[]，做字段归一与校验。 */
export function parseSkillSuggestions(text: string): SkillSuggestion[] {
  const raw = String(text || '').trim();
  if (!raw) return [];
  let list: unknown[] | null = null;
  for (const cand of collectJsonCandidates(raw)) {
    // 先按原文 parse；失败再用 jsonrepair 修一遍——模型常在中文里写未转义的英文双引号、
    // 尾逗号等非法 JSON，jsonrepair 能把这类修成合法 JSON。
    let repaired: string | null = null;
    try { repaired = jsonrepair(cand); } catch { repaired = null; }
    const texts = repaired && repaired !== cand ? [cand, repaired] : [cand];
    for (const text of texts) {
      try {
        const parsed = JSON.parse(text);
        const arr = Array.isArray(parsed)
          ? parsed
          : Array.isArray((parsed as { suggestions?: unknown })?.suggestions)
            ? (parsed as { suggestions: unknown[] }).suggestions
            : null;
        if (arr) { list = arr; break; }
      } catch {
        /* 试下一个 */
      }
    }
    if (list) break;
  }
  if (!list) return [];
  const out: SkillSuggestion[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    const summary = String(it.summary ?? '').trim();
    const improvementSuggestion = String(it.improvementSuggestion ?? it.improvement_suggestion ?? '').trim();
    // summary 与 improvementSuggestion 是 skill 优化点的核心，缺任一条不入库。
    if (!summary || !improvementSuggestion) continue;
    out.push({
      category: clampCategory(it.category),
      severity: clampSeverity(it.severity),
      summary,
      evidence: String(it.evidence ?? '').trim(),
      improvementSuggestion,
    });
  }
  return out;
}

export interface RunSkillSuggestionAgentArgs {
  user: string;
  skillName: string;
  skillVersion?: number | null;
  executionId: string;
  interactions: unknown[];
  /** 计分流算出的关键动作覆盖结果，作线索喂入。 */
  keyActionResults?: KeyActionTraceAnalysisResult[] | null;
  /** 单次建议生成的流式响应超时；调用方不传时保持原 5 分钟。 */
  attemptTimeoutMs?: number;
  /** 最大尝试次数（含首次）；调用方不传时保持原 3 次。 */
  maxAttempts?: number;
}

async function runSuggestionViaOpencode(args: {
  user: string;
  query: string;
  workspaceDir: string;
  executionId: string;
  attemptTimeoutMs: number;
}): Promise<string> {
  const model = await loadServerModelForUser(args.user);
  if (!model) {
    throw new Error('未配置评测模型，请先在「模型配置」中激活一个模型。');
  }

  return runWithEphemeralOpencodeServer(
    { user: args.user || undefined, verbose: false, isolateHome: true, telemetryEnabled: false },
    async (serverUrl) => {
      const insight = new AgentInsight({
        baseURL: serverUrl,
        timeout: 180_000,
        maxRetries: 2,
        logLevel: 'warn',
      });
      const permissions = buildPermissionsForWorkspace(args.workspaceDir);
      const sessionResp = await insight.createSession({
        title: `${SUGGESTION_AGENT_NAME}-${args.executionId}-${Date.now()}`,
        permission: permissions,
        directory: args.workspaceDir,
      });
      const sessionId = String(
        (sessionResp as Record<string, unknown>)?.id
          ?? (sessionResp as Record<string, unknown>)?.ID
          ?? '',
      );
      if (!sessionId) {
        throw new Error('Failed to create opencode session for skill suggestion');
      }

      const agentId = await getSystemAgentId('opencode', SUGGESTION_AGENT_NAME);
      const def = findSystemAgentDefinition('opencode', SUGGESTION_AGENT_NAME);
      tagOpencodeSession(sessionId, {
        agentName: SUGGESTION_AGENT_NAME,
        agentId,
        skill: def?.traceSkill,
        displayQuery: args.query,
        user: args.user || undefined,
      });

      let fullText = '';
      let runtimeError: Error | null = null;
      const handlers: ChatHandlers = {
        onText: (e) => {
          fullText += e.delta;
        },
        onError: (e) => {
          runtimeError = e;
        },
        onTool: (e) => {
          console.log(`[skill-suggestion-agent] tool ${e.name}: phase=${e.phase}`);
        },
      };

      const payload: SendPromptPayload = {
        text: args.query,
        agent: 'plan',
        model,
        modelOptions: { temperature: 0.2, maxTokens: 6000 },
        system: SUGGESTION_SYSTEM_PROMPT,
        permission: permissions,
        directory: args.workspaceDir,
      };

      let agentText = '';
      let attemptTimedOut = false;
      const attemptAbort = new AbortController();
      const attemptTimer = setTimeout(() => {
        attemptTimedOut = true;
        attemptAbort.abort();
      }, args.attemptTimeoutMs);
      try {
        const result = await insight.chat(sessionId, payload, handlers, {
          streamTimeoutMs: args.attemptTimeoutMs,
          idleTimeoutMs: 60_000,
          signal: attemptAbort.signal,
        });
        agentText = result.transcriptText || result.text || fullText;
        if (attemptTimedOut) {
          throw new Error(`Skill suggestion attempt timeout（${args.attemptTimeoutMs}ms）`);
        }
        if (runtimeError) throw runtimeError;
        return agentText;
      } finally {
        clearTimeout(attemptTimer);
        try {
          await recordEvaluatorExecution(insight, {
            taskId: sessionId,
            agentName: SUGGESTION_AGENT_NAME,
            user: args.user,
            query: args.query,
            fallbackOutput: agentText || fullText,
          });
        } catch (persistError) {
          console.warn(
            '[skill-suggestion-agent] failed to persist suggestion execution:',
            (persistError as Error)?.message || persistError,
          );
        }
      }
    },
  );
}

/**
 * 跑建议 agent：落盘 trace 资料包 → agent 从 trace 读实际加载的 skill 并整体反思 → 返回 5 字段建议[]。
 * 失败时返回 []（不影响评测主流程）。门控由 caller 用 shouldRunSuggestionAgent 决定。
 * 注意：skill 内容不旁路注入，agent 从 trace 的 load_skill 节点读取实际执行的那版 skill。
 */
export async function runSkillSuggestionAgent(args: RunSkillSuggestionAgentArgs): Promise<SkillSuggestion[]> {
  const user = String(args.user || '').trim();
  const skillName = String(args.skillName || '').trim();
  const executionId = String(args.executionId || '').trim();
  if (!user || !skillName || !executionId) return [];
  const interactions = Array.isArray(args.interactions) ? args.interactions : [];
  if (interactions.length === 0) return [];

  const workspaceTag = `skill-suggestion-${executionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}`;
  const workspaceDir = ensureSessionWorkspace(user, workspaceTag);
  const traceBundle = ensureTraceBundle({ workspaceDir, executionId, interactions });

  const skillLabel = `${skillName}${args.skillVersion != null ? `@v${args.skillVersion}` : ''}`;
  const query = [
    `请基于这次真实执行的完整 trace 资料包，给出 skill「${skillLabel}」的改进建议。`,
    'skill 的实际内容（SKILL.md 正文及运行期加载的 reference）就在 trace 里——先从 load_skill / skill 激活节点读出实际加载并执行的 skill，再判断。',
    '',
    '## 关键动作覆盖线索（仅作排查起点，未覆盖部分）',
    buildCoverageHints(args.keyActionResults),
    '',
    '## Trace 资料包',
    [
      `资料包目录：${traceBundle.bundleRelDir}/`,
      `manifest：${traceBundle.manifestRelPath}`,
      `index：${traceBundle.indexRelPath}`,
      `节点数：${traceBundle.nodeCount}`,
      `长文本 artifact 数：${traceBundle.artifactCount}`,
      '',
      '读取规则：先读 manifest.json 与 trace-index.json；按需读 nodes/*.json（skill 内容通常在 load_skill 结果或系统约束节点里）；正文长再读 artifacts/*.txt；不要一次性读全部 artifact。',
    ].join('\n'),
    '',
    '## 输出',
    '只输出 {"suggestions":[...]} 形式的 JSON，5 字段：category/severity/summary/evidence/improvementSuggestion；evidence 用「trace 中……」自然语言、无节点编号；没有可改进点输出 {"suggestions":[]}。',
  ].join('\n');

  const attemptTimeoutMs = Number.isFinite(args.attemptTimeoutMs) && Number(args.attemptTimeoutMs) > 0
    ? Number(args.attemptTimeoutMs)
    : 5 * 60 * 1000;
  const maxAttempts = Number.isInteger(args.maxAttempts) && Number(args.maxAttempts) > 0
    ? Number(args.maxAttempts)
    : 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const agentText = await withBackgroundOpencodeSlot(
        () => runSuggestionViaOpencode({
          user,
          query,
          workspaceDir,
          executionId,
          attemptTimeoutMs,
        }),
        {
          taskType: 'skill-suggestion',
          user,
          skill: skillName,
          skillVersion: args.skillVersion ?? undefined,
          label: `skill-suggestion · ${executionId}`,
        },
      );
      const suggestions = parseSkillSuggestions(agentText);
      if (suggestions.length === 0) {
        // 跑完但没解析出建议：打印原始输出预览，便于区分"解析问题"还是"真没建议"。
        const preview = String(agentText || '').slice(0, 800);
        console.warn(`[skill-suggestion-agent] empty parse for ${executionId} (attempt ${attempt}); raw output preview:\n${preview}`);
      }
      // 成功跑完（无论是否空）不再重试——重试只针对错误。
      return suggestions;
    } catch (e) {
      const msg = (e as Error).message || String(e);
      const transient = /fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|network|timeout|socket hang|aborted/i.test(msg);
      console.warn(`[skill-suggestion-agent] attempt ${attempt}/${maxAttempts} failed for ${executionId}: ${msg}`);
      if (!transient || attempt === maxAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  return [];
}

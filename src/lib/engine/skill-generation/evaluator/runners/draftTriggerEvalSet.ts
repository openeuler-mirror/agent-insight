/**
 * LLM 起草触发评价集草稿。
 *
 * 输入：skillName + user（从 DB 拉 active SKILL.md 内容）。
 * 输出：~18 条 TriggerItem 草稿（9 正例 + 9 反例 near-miss），落给上游写入 DB。
 *
 * Prompt 模板：docs/designs/agents/skill-eval-datasets/assets/trigger-draft-prompt-template.md。
 * 实证参考：assets/sample-trigger-draft-skill-generator.json。
 *
 * 重点：
 * 1. 反例必须是 near-miss（共享关键词或主题），不接受"写斐波那契函数"型废反例
 * 2. query 写成真实用户口吻（含路径、URL、口语、错别字）
 * 3. 输出严格 JSON，附 rationale 字段方便后续审阅
 */
import { createHash } from 'crypto';
import { randomUUID } from 'crypto';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import matter from 'gray-matter';
import { createModel } from '@/lib/engine/skill-generation/shared/model';
import { createLogger } from '@/lib/logger';
import { prismaRaw } from '@/lib/storage/prisma';
import { findTriggerEvalSet, type TriggerItem } from '@/server/skill_trigger_eval_storage';
import { getActiveConfig, getUserSettings, type ModelConfig } from '@/lib/storage/server-config';

const logger = createLogger('skill-generation:draft-trigger-eval-set');

const SYSTEM_PROMPT = `你正在为一个 Skill 评测系统起草「触发评价集」。
该评测集用于检验 Skill 的 description 是否能让 Agent 正确判定"该不该触发"。

输出严格 JSON，不要任何解释、Markdown 代码块标记或前后缀文本。`;

const USER_PROMPT_TEMPLATE = (skillName: string, skillDescription: string, skillMdBody: string) =>
  `这是被评测的 Skill：

<skill_name>${skillName}</skill_name>
<skill_description>${skillDescription}</skill_description>
<skill_md_body_excerpt>
${skillMdBody.slice(0, 4000)}
</skill_md_body_excerpt>

请起草 18 条评测 query：
- 9 条 shouldTrigger=true：真实用户口吻，覆盖**不同表达方式**（正式 / 口语 / 含文件路径 / 含 URL / 含个人背景 / 中英混合 / 错别字）
- 9 条 shouldTrigger=false：必须是 **near-miss**——共享关键词、主题或动词，但实际意图不同。
  比如对一个"生成 skill"的 skill，"查看现有 skill 怎么写的"或"优化已有 skill 的 description"都是好反例；
  "写一个排序算法"是无效反例（太显眼、不测什么）。

写 query 时按真实用户在 Claude Code / Cursor 里随手输入的口吻：
- 含具体细节（文件路径、列名、公司/库名、URL、错误码）
- 长短混合，有的正式有的口语
- 允许缩写、错别字、IME 残留
- 不要让 query 显得"为了测试而写"

输出严格 JSON 数组，每条形如：
{
  "query": "<真实用户口吻的完整输入>",
  "shouldTrigger": true | false,
  "rationale": "<这条用于检验的具体维度，1-2 行>"
}

仅输出 JSON 数组，无任何其他文本。数组**恰好** 18 条。`;

/** 从 LLM 文本里捞 JSON 数组（容忍前后噪声 + markdown fence）。 */
function extractJsonArray(text: string): unknown[] | null {
  // 先剥 markdown fence
  const stripped = text
    .replace(/^```(?:json|JSON)?\s*\n?/m, '')
    .replace(/\n?```\s*$/m, '')
    .trim();
  // 找第一个 '[' 到最后一个 ']'
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
  if (start < 0 || end < 0 || end <= start) return null;
  const slice = stripped.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface DraftItemRaw {
  query?: unknown;
  shouldTrigger?: unknown;
  rationale?: unknown;
}

function rawToTriggerItem(raw: DraftItemRaw): TriggerItem | null {
  const query = typeof raw.query === 'string' ? raw.query.trim() : '';
  if (!query) return null;
  return {
    id: randomUUID(),
    query,
    shouldTrigger: Boolean(raw.shouldTrigger),
    rationale: typeof raw.rationale === 'string' && raw.rationale.trim() ? raw.rationale.trim() : undefined,
    source: 'llm-draft',
  };
}

/**
 * 从 DB 拿 skill 的 active SKILL.md 全文 + description。
 */
async function loadSkillContent(
  user: string,
  skillName: string,
): Promise<{ description: string; body: string; contentHash: string }> {
  const skill = await prismaRaw.skill.findFirst({
    where: { user, name: skillName },
    include: {
      versions: {
        orderBy: { version: 'desc' },
        take: 1,
      },
    },
  });
  if (!skill || !skill.versions[0]) {
    throw new Error(`skill not found or no version: ${user}/${skillName}`);
  }
  const content = skill.versions[0].content || '';
  // 解析 frontmatter
  let description = skill.description || '';
  let body = content;
  try {
    const parsed = matter(content);
    if (typeof parsed.data?.description === 'string' && parsed.data.description.trim()) {
      description = parsed.data.description.trim();
    }
    body = parsed.content || content;
  } catch {
    // 退回用 skill.description + 整段 content
  }
  const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return { description, body, contentHash };
}

export interface DraftTriggerEvalSetArgs {
  user: string;
  skillName: string;
  /**
   * 用户已注册模型配置的 id（来自 /modelconfig 页注册的 ModelConfig.id）。
   * 不传 → 用该 user 的 active config（getActiveConfig）。
   * 都没有 → 退回环境变量兜底（dev / 没注册过模型的场景）。
   */
  modelConfigId?: string;
  /**
   * true = 抹掉所有现有 item（包括用户编辑过的），全套重起。
   * false（默认）= 保留 source !== 'llm-draft' 的条目，只覆盖 llm-draft 部分。
   */
  replaceUserEdited?: boolean;
}

/**
 * 解析用户当前应该用哪个注册模型；返回 createModel 需要的字段 + 该模型的人类可读 name。
 *
 * 优先级：
 *   1. 显式指定的 modelConfigId（来自 UI 选择器） → 在该 user 的 configs 里查
 *   2. 该 user 的 active config（getActiveConfig）
 *   3. 环境变量兜底（process.env.MODEL_ID / API_KEY 等；最后才用，dev 才会到这里）
 *
 * 第 1/2 步用注册模型时，`createModel` 拿到的是 user 注册时填的 apiKey/baseUrl，
 * **不再**只允许 anthropic env var——这是这次修法的核心。
 */
async function resolveDraftModelConfig(
  user: string,
  modelConfigId?: string,
): Promise<{
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  provider?: string;
  source: 'explicit' | 'active' | 'env';
}> {
  // Step 1: 显式 id
  if (modelConfigId) {
    const settings = await getUserSettings(user);
    const cfg: ModelConfig | undefined = settings.configs.find(c => c.id === modelConfigId);
    if (cfg && cfg.apiKey) {
      return {
        modelId: cfg.model || 'deepseek-chat',
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        provider: cfg.provider,
        source: 'explicit',
      };
    }
    logger.warn('Requested modelConfigId not found or missing apiKey, falling back to active', {
      user,
      modelConfigId,
    });
  }

  // Step 2: active config
  const active = await getActiveConfig(user);
  if (active && active.apiKey) {
    return {
      modelId: active.model || 'deepseek-chat',
      apiKey: active.apiKey,
      baseUrl: active.baseUrl,
      provider: active.provider,
      source: 'active',
    };
  }

  // Step 3: env 兜底
  const envApiKey =
    process.env.API_KEY ??
    process.env.DEEPSEEK_API_KEY ??
    process.env.ANTHROPIC_API_KEY;
  if (!envApiKey) {
    throw new Error(
      '起草触发评价集需要 LLM 配置：请去 /modelconfig 页注册一个模型并设为 active（或在 env 配 API_KEY）',
    );
  }
  return {
    modelId: process.env.MODEL_ID ?? 'claude-3-5-sonnet-20241022',
    apiKey: envApiKey,
    baseUrl: process.env.BASE_URL,
    provider: process.env.PROVIDER,
    source: 'env',
  };
}

export interface DraftTriggerEvalSetResult {
  items: TriggerItem[];
  /** 起草基于的 SKILL.md 内容 hash（短）；后续 SKILL.md 改了之后可对比来建议"重新起草"。 */
  draftedFromSkillHash: string;
  /** 起草时拿到的 skill description，落到 Set 上以便 UI 展示。 */
  skillDescription: string;
}

/**
 * 起草触发评价集。同步返回——典型耗时 5-15s（一次 LLM 调用）。
 */
export async function draftTriggerEvalSet(args: DraftTriggerEvalSetArgs): Promise<DraftTriggerEvalSetResult> {
  const { user, skillName } = args;
  logger.log('Starting trigger eval set draft', { user, skillName, modelConfigId: args.modelConfigId });

  // 1. 拿 skill 当前状态
  const { description, body, contentHash } = await loadSkillContent(user, skillName);

  // 2. 解析用 哪个 模型起草（优先 UI 显式选 → user active config → env 兜底）
  const resolved = await resolveDraftModelConfig(user, args.modelConfigId);
  logger.log('Resolved draft model', {
    source: resolved.source,
    modelId: resolved.modelId,
    baseUrl: resolved.baseUrl ?? null,
    provider: resolved.provider ?? null,
  });
  const model = createModel({
    modelId: resolved.modelId,
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    provider: resolved.provider,
  });
  const response = await model.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(USER_PROMPT_TEMPLATE(skillName, description, body)),
  ]);
  const text = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
  logger.debug('LLM draft response', { length: text.length });

  // 3. 解析
  const rawArr = extractJsonArray(text);
  if (!rawArr) {
    logger.warn('Failed to parse LLM draft output as JSON array', { textHead: text.slice(0, 200) });
    throw new Error('LLM 起草输出无法解析为 JSON 数组；查看 server 日志');
  }
  const draftItems: TriggerItem[] = [];
  for (const raw of rawArr) {
    const item = rawToTriggerItem(raw as DraftItemRaw);
    if (item) draftItems.push(item);
  }
  if (draftItems.length === 0) {
    throw new Error('LLM 起草后没有解析出任何 valid 条目');
  }
  logger.log('Drafted trigger items', {
    skillName,
    totalDrafted: draftItems.length,
    triggerCount: draftItems.filter(i => i.shouldTrigger).length,
    nonTriggerCount: draftItems.filter(i => !i.shouldTrigger).length,
  });

  // 4. 合并（默认保留用户编辑过的条目）
  let finalItems = draftItems;
  if (!args.replaceUserEdited) {
    const existing = await findTriggerEvalSet(user, skillName);
    if (existing) {
      const userEdited = existing.items.filter(i => i.source !== 'llm-draft');
      finalItems = [...userEdited, ...draftItems];
    }
  }

  return {
    items: finalItems,
    draftedFromSkillHash: contentHash,
    skillDescription: description,
  };
}

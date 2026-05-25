/**
 * 触发评测 runner（opencode-live 路线）。
 *
 * 设计来源：docs/designs/agents/skill-eval-datasets/design.md。
 * 灵感：anthropic skill-creator `scripts/run_eval.py`——spawn 真实 agent runtime，
 *      流式抓 tool_use 事件，命中即 abort 节省 token。
 *
 * 跟旧实现的根本差异：
 *   旧：单次 LLM-as-judge 问 YES/NO（保真度低、纯模拟）
 *   新：每条 query 起一个 opencode session，跑真实路由判断，看它实际是不是调了被测 skill
 *
 * 注意：旧 `runTriggerEval(skillPath, spec, modelOptions)` 函数签名**保留**——它仍被
 *      skill 生成 pipeline 调用。这次我们**新加** `runTriggerEvalLive` 一个独立入口，
 *      给"用户在分析页点复测"场景用；旧路径维持不变避免破坏 supervisor 流水线。
 *      v2 把生成 pipeline 也切到 live 模式时再统一。
 */
import { readFileSync, existsSync, mkdirSync, lstatSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { createModel, type ModelOptions } from '@/lib/engine/skill-generation/shared/model';
import type { SkillSpec } from '@/lib/engine/skill-generation/types';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createLogger } from '@/lib/logger';
import { AgentInsight, type ToolCallEvent } from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client';
import { ensureOpencodeServer } from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager';
import {
  loadServerModelForUser,
  inferProviderFromBaseUrl,
  normalizeProviderID,
} from '@/lib/engine/general-agent/server-model-config';
import { getUserSettings } from '@/lib/storage/server-config';
import { prismaRaw } from '@/lib/storage/prisma';
import { tagOpencodeSession } from '@/lib/internal-agent-tag';
import { getSystemAgentId } from '@/lib/system-agents';

/**
 * 触发评测专属 agent name。与用户 trace（默认 build）分流，避免触发分析批量产生的 trace
 * 灌进「发起新评测」列表把用例 trace 淹没。配合 SYSTEM_AGENTS 里的同名条目，启动时自动 upsert。
 */
const TRIGGER_AGENT_NAME = 'skill-trigger-analyzer';
import type {
  SkillTriggerEvalSetRecord,
  TriggerRunResultItem,
} from '@/server/skill_trigger_eval_storage';

const logger = createLogger('skill-generation:trigger-eval');

// =========================================================================
// 旧路径（保留）：供 skill 生成 supervisor 调用，输入 spec.triggerScenarios
// =========================================================================

export async function runTriggerEval(skillPath: string, spec: SkillSpec, modelOptions: ModelOptions) {
  logger.log('Starting trigger evaluation (legacy LLM-judge mode)', {
    skillPath,
    skillName: spec.name,
    triggerCount: spec.triggerScenarios.length,
  });
  const skillMdPath = join(skillPath, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    logger.warn('Cannot run trigger evaluation because SKILL.md is missing', { skillMdPath });
    return {
      passRate: 0,
      falsePositiveRate: 0,
      falseNegativeRate: 1,
      failedQueries: spec.triggerScenarios.map(q => ({ query: q, expected: true, actual: false })),
      error: 'SKILL.md is missing',
    };
  }
  const content = readFileSync(skillMdPath, 'utf-8');
  const { data } = matter(content);
  const description = data.description || '';
  const model = createModel(modelOptions);
  const queries = [
    ...spec.triggerScenarios.map(q => ({ query: q, expected: true })),
    { query: 'How is the weather today?', expected: false },
    { query: 'Tell me a joke.', expected: false },
  ];
  const failedQueries: Array<{ query: string; expected: boolean; actual: boolean }> = [];
  let passedCount = 0;
  for (const { query, expected } of queries) {
    const prompt = `
技能描述: ${description}
用户查询: ${query}

针对此查询，是否应该触发该技能？
仅回复 "YES" 或 "NO"。
`;
    const response = await model.invoke([
      new SystemMessage('你是一名路由评估专家。'),
      new HumanMessage(prompt),
    ]);
    const actual = (response.content as string).trim().toUpperCase().includes('YES');
    if (actual === expected) {
      passedCount++;
    } else {
      failedQueries.push({ query, expected, actual });
    }
  }
  const passRate = passedCount / queries.length;
  return {
    passRate,
    falsePositiveRate: failedQueries.filter(f => !f.expected && f.actual).length / queries.length,
    falseNegativeRate: failedQueries.filter(f => f.expected && !f.actual).length / queries.length,
    failedQueries,
  };
}

// =========================================================================
// 新路径：opencode-live runner
// =========================================================================

export interface RunTriggerEvalLiveArgs {
  triggerSet: SkillTriggerEvalSetRecord;
  skillName: string;
  workspaceRoot: string;
  /** opencode session 跑在哪个 user 的 server 实例下。**必填**——决定 baseURL + 模型来源。 */
  user: string;
  /**
   * 显式指定用哪个注册模型（/modelconfig 里的 ModelConfig.id）。
   * 不传 → 用该 user 的 active config；都没有 → 退回环境变量兜底。
   */
  modelConfigId?: string;
  /**
   * 被测 skill 用哪个版本的 SKILL.md。不传 → 该 skill 的最新版本。
   * 为什么需要这个：分析页可能在 v2 上点"立即评测"，但 latest 是 v3——
   * 这时必须用 v2 的 content 去物化到 .opencode/skills/，否则测的是 v3。
   * sibling skill **不**受这个影响（保留各自 latest）——评测的是
   * 「在用户当下真实的 opencode 环境里，v2 SKILL.md 会不会被路由命中」。
   */
  skillVersion?: number;
  runsPerQuery?: number;
  /** runsPerQuery 多次跑里多少比例算"触发"。 */
  triggerThreshold?: number;
  /** 单条 query 超时。 */
  timeoutMs?: number;
  /** 并发跑几条 query。 */
  concurrency?: number;
}

export interface RunTriggerEvalLiveResult {
  items: TriggerRunResultItem[];
  passRate: number;
  truePositiveRate: number;
  falsePositiveRate: number;
}

interface SingleRunOutcome {
  triggered: boolean;
  /** opencode session.error 文本；非空表示这次 run 实际没跑成（不是"没命中"，是根本没问到模型）。 */
  sessionError?: string;
  competingSkill?: string;
  latencyMs: number;
}

/**
 * 判定一次 tool 调用是否命中被测 skill。双路兜底：
 *   - 通用 read 工具读了被测 SKILL.md
 *   - opencode 若有专门 "skill" 类工具且 input 命中 skill name（未来兼容）
 *
 * 如果命中了**别的** skill（path 形如 skills/<other>/SKILL.md），返回那个 skill 名做诊断。
 */
function classifyToolHit(
  evt: ToolCallEvent,
  targetSkillName: string,
): { hitTarget: boolean; competingSkill?: string } {
  const toolName = (evt.name || '').toLowerCase();
  const input = evt.input as Record<string, unknown> | undefined;

  // Path 1: dedicated skill 工具
  if (toolName === 'skill' || toolName === 'load_skill') {
    const skill = (input?.skill ?? input?.name ?? '') as string;
    if (typeof skill === 'string' && skill.trim()) {
      if (skill.trim() === targetSkillName) return { hitTarget: true };
      return { hitTarget: false, competingSkill: skill.trim() };
    }
  }

  // Path 2: read 工具 + path 包含 SKILL.md
  if (toolName === 'read' || toolName === 'read_file') {
    const path = (input?.path ?? input?.filePath ?? '') as string;
    if (typeof path === 'string' && path.includes('SKILL.md')) {
      // 提取 skills/<name>/SKILL.md 里的 name
      const m = path.match(/skills\/([^/]+)\/SKILL\.md/);
      if (m) {
        const matched = m[1];
        if (matched === targetSkillName) return { hitTarget: true };
        return { hitTarget: false, competingSkill: matched };
      }
      // 没匹配到 skills/X/SKILL.md 格式但路径含 SKILL.md——保守不算命中
    }
  }

  return { hitTarget: false };
}

/**
 * 跑一条 query × 一次 run。出错时返回 triggered=false 但不抛——上层聚合时按 false 算。
 */
async function evalOne(
  client: AgentInsight,
  args: {
    query: string;
    targetSkillName: string;
    modelConfig: { providerID: string; modelID: string; apiKey: string; baseURL?: string };
    workspaceRoot: string;
    timeoutMs: number;
    sessionTitle: string;
    user: string;
    agentId: string | null;
  },
): Promise<SingleRunOutcome> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), args.timeoutMs);
  const startedAt = Date.now();
  let triggered = false;
  let competingSkill: string | undefined;
  let sessionError: string | undefined;
  let sessionId: string | null = null;
  try {
    // 把 permission 白名单**在建 session 时**就装上——opencode 的 permission
    // 是 session 级别配置，必须在 createSession 时传，chat() 时再传会被忽略。
    // 之前传错位置导致 bash/edit 都没被 deny，触发评测时模型真的去 `sed -i` 改
    // 了开发机上的 server.log，是个直接的物理破坏。务必别再放回 chat() 那一层。
    const session = await client.createSession({
      title: args.sessionTitle,
      permission: READ_ONLY_TRIGGER_EVAL_PERMISSIONS,
    });
    const sid = (session as { id?: unknown })?.id;
    if (typeof sid !== 'string' || !sid) {
      throw new Error('opencode createSession returned no id');
    }
    sessionId = sid;
    // 给 session 打 internal-agent-tag：plugin 上报到 /api/ingest/upload 时按 task_id 命中，
    // 用 agentName=skill-trigger-analyzer 覆盖 plugin 默认的 build；displayQuery 用真实用户 query
    // 覆盖 plugin 误填的 "OpenCode Session ses_xxx" 系统串。
    tagOpencodeSession(sessionId, {
      agentName: TRIGGER_AGENT_NAME,
      agentId: args.agentId,
      displayQuery: args.query,
      user: args.user,
    });
    logger.log('chat() begin', { sessionId, modelID: args.modelConfig.modelID, query: args.query.slice(0, 60) });
    const chatResult = await client.chat(
      sessionId,
      {
        text: args.query,
        // 注意：这里**不要**传 agent: TRIGGER_AGENT_NAME。opencode server 的
        // payload.agent 必须是它内部认识的 agent（build/explore/general/plan），
        // 否则会立刻报 "Agent not found"，整个 session 失败，连模型都不调。
        // 我们的 `skill-trigger-analyzer` 是 trace 归属名，已经在上面通过
        // tagOpencodeSession 登记，/api/ingest/upload 时按 task_id 覆盖
        // agentName 即可；与 opencode 内部 agent 路由完全解耦。
        model: {
          providerID: args.modelConfig.providerID,
          modelID: args.modelConfig.modelID,
          apiKey: args.modelConfig.apiKey,
          baseURL: args.modelConfig.baseURL,
        },
        directory: args.workspaceRoot,
        // permission 已在上面 createSession 时传过；这里**不要**再传，会被 opencode 忽略
        // 而且只在 chat-level 传不会生效（参考 general-agent/runner.ts 的写法）。
      },
      {
        onTool(evt) {
          // 关键：opencode 的 tool 事件分 start/delta/end/error 四 phase。
          // start phase 时 input 还是空对象（流式传输刚开始），只能拿到 toolName。
          // 我们必须等 end phase 才能看到完整 input.path——这就是之前 inputPreview="{}"
          // 全是空的根因。命中判定在 end 做。
          if (evt.phase !== 'end' && evt.phase !== 'start') return;
          if (evt.phase === 'start') {
            logger.log('opencode tool start', { toolName: evt.name });
            return; // input 还没到，等 end
          }
          // phase === 'end'：input 完整可用
          logger.log('opencode tool end', {
            toolName: evt.name,
            inputPreview: JSON.stringify(evt.input).slice(0, 200),
          });
          const cls = classifyToolHit(evt, args.targetSkillName);
          if (cls.hitTarget) {
            triggered = true;
            ac.abort();
          } else if (cls.competingSkill && !competingSkill) {
            competingSkill = cls.competingSkill;
          }
        },
        // 捕获 session.error —— 这是 opencode 服务端报错（agent 名不认、provider 拒绝、
        // apiKey 失效等）。一旦命中说明本次 run 根本没问到模型，要把错误文本带出去，
        // 否则上层会把"没命中"误当成 shouldTrigger=false 的正确否定，把全是错误的评测
        // 算出一个看起来"正常"的 passRate=0.5。
        onSession(evt) {
          if (evt.phase === 'error') {
            const rawErr = (evt as { error?: unknown }).error;
            // opencode 错误结构通常是 { name, data: { message } }；优先抽 data.message
            let msg: string | undefined;
            if (rawErr && typeof rawErr === 'object') {
              const data = (rawErr as { data?: { message?: unknown } }).data;
              if (data && typeof data.message === 'string') msg = data.message;
            }
            if (!msg) msg = JSON.stringify(rawErr).slice(0, 500);
            sessionError = msg;
            logger.warn('opencode session.error', { sessionId: evt.sessionID, error: msg });
          }
        },
        onError(err) {
          logger.warn('chat onError', {
            err: (err as Error)?.message ?? String(err),
          });
        },
      },
      { signal: ac.signal, idleTimeoutMs: args.timeoutMs },
    );
    logger.log('chat() returned', {
      sessionId,
      textLen: chatResult?.text?.length ?? 0,
      textPreview: (chatResult?.text || '').slice(0, 120),
      stats: chatResult?.stats,
      triggered,
      competingSkill: competingSkill ?? null,
    });
  } catch (err) {
    // AbortError 是预期路径（命中后我们主动 abort）
    const errName = (err as Error)?.name ?? '';
    if (errName !== 'AbortError') {
      logger.warn('evalOne failed unexpectedly', {
        query: args.query.slice(0, 100),
        errName,
        err: (err as Error)?.message ?? String(err),
        stack: (err as Error)?.stack?.slice(0, 500),
      });
    } else {
      // 临时排查用 logger.log（要拿 reasoning + chat tool 行为；定位完调回 debug）
      logger.log('evalOne ended via AbortError', {
        query: args.query.slice(0, 60),
        triggeredBeforeAbort: triggered,
        competingBeforeAbort: competingSkill ?? null,
        elapsedMs: Date.now() - startedAt,
      });
    }
  } finally {
    clearTimeout(timer);
    // 不等 finish，直接 close session 释放资源
    if (sessionId) {
      client.deleteSession(sessionId).catch(() => {});
    }
  }
  return {
    triggered,
    competingSkill,
    sessionError,
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * 通用并发 pool：tasks 数组按 concurrency 路并发跑 worker 函数，返回所有结果。
 */
async function runPool<T, R>(
  tasks: T[],
  concurrency: number,
  worker: (task: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(tasks.length);
  let cursor = 0;
  const launch = async () => {
    while (true) {
      const i = cursor++;
      if (i >= tasks.length) return;
      try {
        results[i] = await worker(tasks[i], i);
      } catch (err) {
        // worker 已经 try/catch，这里不应该到；fallback 给空对象避免 hole
        results[i] = undefined as unknown as R;
      }
    }
  };
  const n = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: n }, () => launch()));
  return results;
}

/**
 * 解析 opencode 跑评测时用什么模型。返回的 4 个字段直接喂给 `SendPromptPayload.model`。
 *
 * 优先级（跟 draftTriggerEvalSet 同款）：
 *   1. 显式 modelConfigId → 在该 user 的 configs 里查（来自 /modelconfig 注册）
 *   2. 该 user 的 active config（getActiveConfig / loadServerModelForUser）
 *   3. 环境变量兜底（dev / 没注册模型场景；找不到 apiKey 时清晰抛错）
 *
 * Step 1/2 借 loadServerModelForUser 已有的 ModelConfig → opencode 字段映射 + provider 推断。
 */
async function resolveOpencodeModelForUser(
  user: string,
  modelConfigId?: string,
): Promise<{
  providerID: string;
  modelID: string;
  apiKey: string;
  baseURL?: string;
  source: 'explicit' | 'active' | 'env';
}> {
  // Step 1: 显式 id
  if (modelConfigId) {
    const settings = await getUserSettings(user);
    const cfg = settings.configs.find(c => c.id === modelConfigId);
    if (cfg && cfg.apiKey) {
      const explicitProvider = (cfg as { provider?: string }).provider;
      const providerID = normalizeProviderID(
        explicitProvider || inferProviderFromBaseUrl(cfg.baseUrl),
      );
      return {
        providerID,
        modelID: cfg.model || 'deepseek-chat',
        apiKey: cfg.apiKey,
        baseURL: cfg.baseUrl,
        source: 'explicit',
      };
    }
    logger.warn('Requested modelConfigId not found or missing apiKey, falling back to active', {
      user,
      modelConfigId,
    });
  }

  // Step 2: active config
  const active = await loadServerModelForUser(user);
  if (active && active.apiKey) {
    return {
      providerID: active.providerID,
      modelID: active.modelID,
      apiKey: active.apiKey,
      baseURL: active.baseURL,
      source: 'active',
    };
  }

  // Step 3: env 兜底
  const envApiKey =
    process.env.GENERAL_AGENT_API_KEY ||
    process.env.OPENCODE_API_KEY ||
    process.env.DEEPSEEK_API_KEY;
  if (!envApiKey) {
    throw new Error(
      '触发评测需要 LLM 配置：请去 /modelconfig 注册一个模型并设为 active（或在 env 配 OPENCODE_API_KEY / DEEPSEEK_API_KEY）',
    );
  }
  const providerID = normalizeProviderID(
    process.env.GENERAL_AGENT_PROVIDER_ID ||
      process.env.OPENCODE_PROVIDER_ID ||
      'deepseek-official',
  );
  return {
    providerID,
    modelID:
      process.env.GENERAL_AGENT_MODEL_ID ||
      process.env.OPENCODE_MODEL_ID ||
      'deepseek-chat',
    apiKey: envApiKey,
    baseURL:
      process.env.GENERAL_AGENT_PROVIDER_BASE_URL ||
      process.env.OPENCODE_PROVIDER_BASE_URL ||
      'https://api.deepseek.com',
    source: 'env',
  };
}

/**
 * 触发评测的 read-only permission 白名单。
 *
 * 触发评测的语义是：测"opencode 看到这条 query 会不会调本 skill"——**不是**测"它能不能
 * 把任务真跑完"。所以禁止所有可能产生副作用的工具：
 *
 *   - bash    : 可以跑任何命令，最危险（实测有一次评测改了 docs/PROJECT.md）
 *   - write   : 写新文件
 *   - edit    : 编辑现有文件
 *   - webfetch: 调外部 API，可能改远端状态
 *   - task    : spawn subagent，subagent 又能写文件，刹不住
 *   - question: agent 问用户问题需等 30s timeout，浪费时间且评测里没人回答
 *
 * 保留 allow（默认）的：read / glob / grep / skill —— 这些是"读 + 调 skill"路径的必需品。
 *
 * 模型被 deny 之后通常会改用 skill 工具（或直接给文本答复），不会让评测 hang。
 */
const READ_ONLY_TRIGGER_EVAL_PERMISSIONS: Array<{
  permission: string;
  pattern: string;
  action: 'allow' | 'deny' | 'ask';
}> = [
  { permission: 'bash', pattern: '*', action: 'deny' },
  { permission: 'write', pattern: '*', action: 'deny' },
  { permission: 'edit', pattern: '*', action: 'deny' },
  { permission: 'webfetch', pattern: '*', action: 'deny' },
  { permission: 'task', pattern: '*', action: 'deny' },
  { permission: 'question', pattern: '*', action: 'deny' },
];

// 短 uuid 给 session title——避免并发评测同名碰撞
function shortUuid(): string {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 8; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

/**
 * 把 user 在 DB 里的所有 skill 物化到 <workspaceRoot>/.opencode/skills/，让 opencode
 * 通过它的标准发现路径（.opencode/skills/<name>/SKILL.md）找到所有 user 注册的 skill。
 *
 * 背景：
 *   - opencode 的项目级 skill 发现路径：.opencode/skills/、.claude/skills/、.agents/skills/，
 *     不包括项目根 skills/（裸路径）。
 *   - 我们的 user 通过 UI 创建的 skill 只存 DB（Skill + SkillVersion 表），文件系统里没有
 *     对应 SKILL.md。所以哪怕 .opencode/skills/ symlink 到项目 skills/ 也找不到 user skill。
 *   - 修法：评测开始时把 user 的全部 skill 从 DB 物化为 .opencode/skills/<name>/SKILL.md。
 *
 * 设计点：
 *   - 物化的是**该 user 的所有 skill**（不只是被测的那个）——为了让"兄弟 skill 竞争"
 *     诊断生效。模型看到全部 skill 才能真正"选错触发别的 skill"。
 *   - 幂等：每次评测都重写一遍 active 版本的内容（user 在 UI 改过 description 也能反映）。
 *   - 旧的 symlink 路径：若 .opencode/skills 是 symlink，先 unlink 再建真目录。
 *   - .opencode/ 已 gitignored，所以这是纯本地 staging，不污染仓库。
 */
async function materializeUserSkillsToOpencode(
  user: string,
  workspaceRoot: string,
  /**
   * 目标 skill 钉到指定版本。其它 skill 仍走 latest。
   * 不传 → 全部走 latest（向后兼容）。
   */
  targetSkillPin?: { name: string; version: number },
): Promise<{ count: number; names: string[] }> {
  const opencodeDir = join(workspaceRoot, '.opencode');
  const skillsDir = join(opencodeDir, 'skills');
  try {
    mkdirSync(opencodeDir, { recursive: true });
  } catch {
    /* ignore */
  }
  // 处理旧 symlink：发现是 symlink 就 unlink，下面会 mkdir 真目录
  try {
    const stat = lstatSync(skillsDir);
    if (stat.isSymbolicLink()) {
      try {
        unlinkSync(skillsDir);
        logger.log('Removed old .opencode/skills symlink (replacing with materialized dir)');
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* doesn't exist, fine */
  }
  try {
    mkdirSync(skillsDir, { recursive: true });
  } catch {
    /* ignore */
  }

  // 拉 user 的全部 skill + 各自的 latest version。若 targetSkillPin 命中本 skill
  // 则在下面单独拉指定版本的 content 覆盖；其它 skill 仍走 latest。
  const skills = await prismaRaw.skill.findMany({
    where: { user },
    include: {
      versions: {
        orderBy: { version: 'desc' },
        take: 1,
      },
    },
  });

  // 目标 skill 的指定版本 content（仅当 pin 命中且 version != latest 时才查）
  let pinnedTargetContent: string | null = null;
  if (targetSkillPin) {
    const pinnedRow = await prismaRaw.skillVersion.findFirst({
      where: {
        version: targetSkillPin.version,
        // Prisma relation 字段在 schema 里叫 `Skill`（大写）——不是 `skill`
        Skill: { user, name: targetSkillPin.name },
      },
      select: { content: true },
    });
    if (pinnedRow?.content) {
      pinnedTargetContent = pinnedRow.content;
    } else {
      // 找不到指定版本——硬失败比偷偷退回 latest 安全：用户明明在 v2 上点，
      // 静默用 v3 测会让"分数对不上"的 bug 又以另一种形态回来。
      throw new Error(
        `materializeUserSkillsToOpencode: 找不到 ${targetSkillPin.name} v${targetSkillPin.version} 的 content`,
      );
    }
  }

  const writtenNames: string[] = [];
  for (const skill of skills) {
    const name = skill.name;
    if (!name || /[^\w\-.]/.test(name)) {
      // 防御性：skill name 不允许斜杠等不安全字符（避免 path traversal）
      logger.warn('Skipping skill with unsafe name', { name });
      continue;
    }
    const isPinnedTarget = targetSkillPin?.name === name && pinnedTargetContent != null;
    const content = isPinnedTarget
      ? (pinnedTargetContent as string)
      : skill.versions[0]?.content;
    if (!content) continue;
    const targetDir = join(skillsDir, name);
    try {
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, 'SKILL.md'), content, 'utf-8');
      writtenNames.push(name);
    } catch (err) {
      logger.warn('Failed to materialize skill', {
        name,
        err: (err as Error)?.message ?? String(err),
      });
    }
  }

  logger.log('Materialized user skills to .opencode/skills/', {
    user,
    count: writtenNames.length,
    names: writtenNames,
  });
  return { count: writtenNames.length, names: writtenNames };
}

/**
 * 跑一次 opencode-live 触发评测。
 *
 * 流程：
 *   1. 起 opencode server（复用 ensureOpencodeServer）
 *   2. 对每条 (item, runIdx) 起独立 session，sendPrompt，监听 onTool start 事件
 *   3. 命中本 skill → abort + triggered=true；否则等到 finish/timeout → triggered=false
 *   4. 按 runsPerQuery 聚合每条 item 的 triggerRate，与 shouldTrigger 比对算 pass
 *   5. 聚合全局 passRate / TPR / FPR
 */
export async function runTriggerEvalLive(
  args: RunTriggerEvalLiveArgs,
): Promise<RunTriggerEvalLiveResult> {
  const {
    triggerSet,
    skillName,
    workspaceRoot,
    user,
    modelConfigId,
    skillVersion,
    runsPerQuery = 1,
    triggerThreshold = 0.5,
    timeoutMs = 30_000,
    concurrency = 5,
  } = args;

  if (!user) {
    throw new Error('runTriggerEvalLive: user is required (从 /modelconfig 拉模型 + opencode 实例都要用)');
  }

  logger.log('Starting trigger eval (opencode-live)', {
    skillName,
    skillVersion: skillVersion ?? null,
    user,
    itemCount: triggerSet.items.length,
    runsPerQuery,
    concurrency,
    workspaceRoot,
    modelConfigId: modelConfigId ?? null,
  });

  if (triggerSet.items.length === 0) {
    return { items: [], passRate: 0, truePositiveRate: 0, falsePositiveRate: 0 };
  }

  // 0. 把 user 的全部 skill 从 DB 物化到 .opencode/skills/，让 opencode 能发现它们。
  //    目标 skill 钉到调用方指定版本（不传则各自 latest）——保证 v2 测的就是 v2 的 SKILL.md。
  await materializeUserSkillsToOpencode(
    user,
    workspaceRoot,
    skillVersion != null ? { name: skillName, version: skillVersion } : undefined,
  );

  // 1. 起 opencode server
  const baseURL = await ensureOpencodeServer({ user });
  const client = new AgentInsight({
    baseURL,
    timeout: Math.max(timeoutMs + 5000, 60_000),
    maxRetries: 1,
    logLevel: (process.env.OPENCODE_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | 'off' | undefined) || 'warn',
  });
  // 2. 解析模型：显式 id > active config > env 兜底（找不到 apiKey 抛错）
  const modelConfig = await resolveOpencodeModelForUser(user, modelConfigId);
  logger.log('Resolved opencode model', {
    source: modelConfig.source,
    providerID: modelConfig.providerID,
    modelID: modelConfig.modelID,
    baseURL: modelConfig.baseURL ?? null,
  });

  // 拿触发分析专属 agent 的 cuid（来自 SYSTEM_AGENTS 注册）。DB 不可用时拿到 null，
  // upload 路由仍会按 agentName 落 Execution，只是少一层 RegisteredAgent 外键。
  const triggerAgentId = await getSystemAgentId('opencode', TRIGGER_AGENT_NAME);

  // 2. 展开 (item, runIdx) 任务列表
  type Task = { itemIdx: number; runIdx: number };
  const tasks: Task[] = [];
  for (let i = 0; i < triggerSet.items.length; i++) {
    for (let r = 0; r < runsPerQuery; r++) tasks.push({ itemIdx: i, runIdx: r });
  }

  // 3. 跑！
  const outcomes: SingleRunOutcome[][] = triggerSet.items.map(() => []);
  const competingMap = new Map<number, Map<string, number>>();
  await runPool(tasks, concurrency, async task => {
    const item = triggerSet.items[task.itemIdx];
    const sessionTitle = `trigger-eval-${shortUuid()}-${item.id.slice(0, 4)}-r${task.runIdx}`;
    const outcome = await evalOne(client, {
      query: item.query,
      targetSkillName: skillName,
      modelConfig,
      workspaceRoot,
      timeoutMs,
      sessionTitle,
      user,
      agentId: triggerAgentId,
    });
    outcomes[task.itemIdx].push(outcome);
    if (outcome.competingSkill) {
      const m = competingMap.get(task.itemIdx) ?? new Map<string, number>();
      m.set(outcome.competingSkill, (m.get(outcome.competingSkill) ?? 0) + 1);
      competingMap.set(task.itemIdx, m);
    }
    return outcome;
  });

  // 3.5 systemic-error 早退：如果所有 run 都因为 opencode 报错根本没问到模型
  // （例如 agent 名拼错、apiKey 失效、provider 拒绝、模型不存在等），
  // 不能继续走"按 triggered=false 聚合"那条路——那会把全错算成
  // passRate=0.5（一半 shouldTrigger=false 项侥幸"对"），用户看到的结果
  // 是个看似正常的脏分数，没人会想到模型从来没被调用。
  // 这里抓最常见的错误文本抛出去，API 路由会把它落到 errorMessage 字段、
  // 返回 500，前端能看见。
  const allOutcomes = outcomes.flat();
  const errorCount = allOutcomes.filter(o => o.sessionError).length;
  if (allOutcomes.length > 0 && errorCount === allOutcomes.length) {
    // 取第一条错误信息——同一根因下 N 条 run 错误文本通常完全一致
    const firstErr = allOutcomes.find(o => o.sessionError)?.sessionError ?? 'unknown opencode error';
    throw new Error(`触发评测全部失败（opencode 没有任何成功 run）：${firstErr}`);
  }

  // 4. 聚合每条 item
  const items: TriggerRunResultItem[] = triggerSet.items.map((item, idx) => {
    const runs = outcomes[idx];
    const runsTotal = runs.length;
    const runsTriggered = runs.filter(r => r.triggered).length;
    const triggerRate = runsTotal > 0 ? runsTriggered / runsTotal : 0;
    const triggered = triggerRate >= triggerThreshold;
    const pass = triggered === item.shouldTrigger;
    const latencyMsAvg =
      runsTotal > 0 ? Math.round(runs.reduce((sum, r) => sum + r.latencyMs, 0) / runsTotal) : 0;
    // 多次跑里出现次数最多的 competing skill
    const compMap = competingMap.get(idx);
    let competingSkill: string | undefined;
    if (compMap && compMap.size > 0) {
      const sorted = [...compMap.entries()].sort((a, b) => b[1] - a[1]);
      competingSkill = sorted[0][0];
    }
    return {
      itemId: item.id,
      query: item.query,
      shouldTrigger: item.shouldTrigger,
      runsTriggered,
      runsTotal,
      triggerRate,
      pass,
      latencyMsAvg,
      competingSkill,
    };
  });

  // 5. 全局聚合
  const total = items.length;
  const passed = items.filter(r => r.pass).length;
  const positives = items.filter(r => r.shouldTrigger);
  const negatives = items.filter(r => !r.shouldTrigger);
  const truePositiveRate =
    positives.length > 0 ? positives.filter(r => r.triggerRate >= triggerThreshold).length / positives.length : 0;
  const falsePositiveRate =
    negatives.length > 0 ? negatives.filter(r => r.triggerRate >= triggerThreshold).length / negatives.length : 0;
  const passRate = total > 0 ? passed / total : 0;

  logger.log('Trigger eval done', {
    skillName,
    total,
    passed,
    passRate: Number(passRate.toFixed(3)),
    truePositiveRate: Number(truePositiveRate.toFixed(3)),
    falsePositiveRate: Number(falsePositiveRate.toFixed(3)),
  });

  return { items, passRate, truePositiveRate, falsePositiveRate };
}

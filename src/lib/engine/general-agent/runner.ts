import { randomUUID } from 'node:crypto';
import { Agent, setGlobalDispatcher } from 'undici';

import {
  AgentInsight,
  type ChatHandlers,
  type ChatOptions,
  type ModelConfig,
  type PermissionAskEvent,
  type QuestionAskEvent,
  type SendPromptPayload,
} from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client';
import { ensureOpencodeServer, runWithEphemeralOpencodeServer } from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager';

import { resolveSkill, skillToSystemPrompt } from './skill-resolver';
import { expandHomePathsInText } from './expand-home';
import { loadServerModelForUser } from './server-model-config';
import {
  buildPermissionsForWorkspace,
  ensureSessionWorkspace,
  ensureUserWorkspace,
} from './workspace';
import { deploySkillToWorkspace } from './skill-workspace-deployer';
import { tagOpencodeSession } from '@/lib/internal-agent-tag';
import { findSystemAgentDefinition, getSystemAgentId } from '@/lib/system-agents';
import { deriveOpencodeExecutionFields } from '@/lib/engine/observability/opencode-derived-metrics';

let dispatcherInited = false;
function ensureDispatcher() {
  if (dispatcherInited) return;
  dispatcherInited = true;
  // undici Agent 默认 headersTimeout/bodyTimeout 是 5min，对 R1 这种慢推理 +
  // opencode 多轮 LLM 调用容易撞上，导致 chat.sendPrompt.failed { fetch failed }。
  // 拉到 30min（agent 一次任务通常不会超过这个），生产可通过 GENERAL_AGENT_FETCH_TIMEOUT_MS 调整。
  const fetchTimeoutMs = Number(process.env.GENERAL_AGENT_FETCH_TIMEOUT_MS) || 30 * 60 * 1000;
  setGlobalDispatcher(new Agent({
    connections: 64,
    headersTimeout: fetchTimeoutMs,
    bodyTimeout: fetchTimeoutMs,
  }));
}

/**
 * 每个 user 一个 client（每个 user 一个 opencode-server 实例），baseURL 不同。
 * 用 Map 缓存避免每次重建。同一 user 的 baseURL 变了（例如该 user 的 opencode 实例被
 * 重启 / 因 apiKey 变更被 ensureOpencodeServer 主动重启）也会自动更新缓存。
 */
const cachedClients = new Map<string, { baseURL: string; client: AgentInsight }>();

async function getClient(user: string): Promise<AgentInsight> {
  ensureDispatcher();
  const baseURL = await ensureOpencodeServer({ user });
  const cached = cachedClients.get(user);
  if (cached && cached.baseURL === baseURL) return cached.client;
  const client = new AgentInsight({
    baseURL,
    timeout: 180_000,
    maxRetries: 2,
    logLevel: (process.env.OPENCODE_LOG_LEVEL as any) || 'warn',
  });
  cachedClients.set(user, { baseURL, client });
  return client;
}

/**
 * 解析默认 model 配置，优先级：
 *   1. 用户在服务端 settings 里选中的 active config（getActiveConfig）
 *   2. GENERAL_AGENT_* 环境变量（部署时配置的"全局兜底"）
 *   3. OPENCODE_* / DEEPSEEK_API_KEY 环境变量（兼容旧 CLI demo）
 *
 * 任意一项命中即返回；caller 仍可通过 input.model 部分覆盖最终字段。
 * 全部缺失时返回的 ModelConfig 缺 apiKey，由 caller 端检查并报错。
 */
async function buildDefaultModel(user: string): Promise<ModelConfig> {
  // 1. 优先用服务端配置
  const fromServer = await loadServerModelForUser(user).catch(err => {
    console.warn('[general-agent] loadServerModelForUser failed, falling back to env:', err?.message || err);
    return null;
  });
  if (fromServer) return fromServer;

  // 2/3. env 兜底（保留原 CLI demo 的兼容路径）
  const providerID =
    process.env.GENERAL_AGENT_PROVIDER_ID ||
    process.env.OPENCODE_PROVIDER_ID ||
    'deepseek-official';
  const isDeepseek = providerID === 'deepseek' || providerID === 'deepseek-official';
  return {
    providerID,
    modelID:
      process.env.GENERAL_AGENT_MODEL_ID ||
      process.env.OPENCODE_MODEL_ID ||
      'deepseek-chat',
    apiKey:
      process.env.GENERAL_AGENT_API_KEY ||
      process.env.OPENCODE_API_KEY ||
      process.env.DEEPSEEK_API_KEY,
    baseURL:
      process.env.GENERAL_AGENT_PROVIDER_BASE_URL ||
      process.env.OPENCODE_PROVIDER_BASE_URL ||
      (isDeepseek ? 'https://api.deepseek.com' : undefined),
    headers: process.env.OPENCODE_PROVIDER_HEADERS
      ? JSON.parse(process.env.OPENCODE_PROVIDER_HEADERS)
      : undefined,
  };
}

/**
 * 用户交互策略：决定"权限请求 / agent 提问"事件的默认应答方式。
 *
 *  - 'auto-allow' : 权限 once；问题 reject。HTTP 同步 API 默认。
 *                   workspace 已限定可写目录到任务子目录 + /tmp/*；但 shell / 网络
 *                   等非目录类权限也会被一并放行，对此敏感请改 'auto-deny' 或 'manual'。
 *  - 'auto-deny'  : 权限 reject；问题 reject。最保守，适合纯生成、无副作用任务。
 *  - 'manual'     : 必须由 caller 自己传 handlers.onPermission / handlers.onQuestion，
 *                   否则会抛错。适合 UI / 流式交互场景。
 */
export type InteractionPolicy = 'auto-allow' | 'auto-deny' | 'manual';

/** 一条交互事件（任务结束后随结果一并返回，便于审计与下游展示）。 */
export interface InteractionRecord {
  kind: 'permission' | 'question';
  id: string;
  reply: 'once' | 'always' | 'reject' | any[] | null;
  meta: Record<string, unknown>;
  ts: number;
}

export interface RunGeneralAgentInput {
  user: string;
  query: string;
  skill?: string;
  skillVersion?: number;
  /**
   * 纯 trace 归属标签——agent **不会**真去加载这个 skill (区别于 input.skill: 后者
   * 会触发 deploySkillToWorkspace 部署 SKILL.md)。仅写入 internal-agent-tag.skill +
   * recordEvaluatorExecution 时填入 Execution.skill, 让"从 Trace"按 skill 过滤
   * 能搜到这条 trace。
   *
   * 典型场景: A/B 灰度的 baseline 侧 (grayscale-baseline-agent) 故意不加载 skill,
   * 但 trace 在逻辑上跟 B 侧被测 skill 配对, 应该归属到那个 skill。
   * 用例分析卡的 mode='batch' 也可以传, 但通常用户已经选了 input.skill, 不需要 tagSkill。
   *
   * 优先级 (写入 internal-agent-tag.skill 时):
   *   def?.traceSkill (SYSTEM_AGENTS 静态绑定) > input.skill > input.tagSkill
   */
  tagSkill?: string;
  system?: string;
  sessionId?: string;
  /**
   * 工作目录的稳定标签。不传则按以下规则推：sessionId（如果有） → 随机 task-<ts>-<rand>。
   *
   * 用于多轮对话场景：caller 想让多次调用共享同一个 workspace 目录但 opencode session 是独立的
   * 时（例如 skill-generator 里 threadId 稳定但首次调用还没 opencode sessionId），必须显式传一个
   * 稳定值（如 threadId），否则两次调用的 workspaceDir 会不一致，前一轮生成的文件会"消失"。
   */
  workspaceTag?: string;
  sessionTitle?: string;
  agent?: string;
  model?: Partial<ModelConfig>;
  modelOptions?: Record<string, unknown>;
  /**
   * 用户交互策略，默认 'auto-allow'。详见 InteractionPolicy。
   * 若 caller 在 handlers 里显式传了 onPermission/onQuestion，会覆盖此策略对应分支。
   */
  interactionPolicy?: InteractionPolicy;
  /**
   * 内部 agent 的"系统 Agent 名"。传了之后会做两件事：
   *   1. 在 internal-agent-tag 里登记一条 (opencodeSessionId → {agentName, agentId, skill}),
   *      用户机器上的 plugin 把这次 session 上报到 /api/ingest/upload 时，路由会用这条 tag
   *      覆盖 plugin 误填的 agentName/skill/query 字段，让 trace 正确归属到我们的系统 Agent。
   *   2. agentId 通过 getSystemAgentId 解析；前提是该 name 在 SYSTEM_AGENTS 里有定义且
   *      已注册（instrumentation 启动时自动跑）。
   *
   * 不传时不打 tag——caller 是用户自己的代码 / 评测脚本之类，trace 走 plugin 默认归属。
   */
  systemAgentName?: string;
  handlers?: ChatHandlers;
  chatOptions?: ChatOptions;
  timeoutMs?: number;
  /**
   * true: 这次调用起一个**独立** opencode 进程,跑完立刻杀 (per-task ephemeral)。
   *   避免跨任务 server 内存级软污染 (plugin 全局缓存 / provider runtime cache /
   *   server 启动时凝固的 skill / 自定义 agent 等)。代价:每次冷启 ~5-10s。
   * false / 默认: per-user 复用长驻 server (cachedClients + ensureOpencodeServer)。
   *   响应快,适合用户实时对话 (skill-generator-bridge 等)。
   *
   * 后台批量任务 (评测 / A·B 灰度) 都该传 true,保证每次都拿最新 skill;
   * 用户实时对话保持默认,避免冷启延迟拖累交互体验。
   */
  ephemeralServer?: boolean;
  /**
   * 传了之后, agent run 完成后内部立刻把这次 opencode session 的真实 messages
   * (client.listMessages) 规范化后写一行 Execution 到 DB (走 saveExecutionRecord)。
   * agentName 字段就是这里传的字符串。
   *
   * 解决的问题: 之前 grayscale A/B 等后台任务依赖 opencode 子进程的 OTEL exporter
   * 上报到 /api/ingest/otel/v1/traces 才产生 Execution 行。但 spawn 时没注入
   * OTEL env, exporter silent drop, 永远没 Execution 行——modal 里点 session id
   * 跳 /trace?taskId=X, trace page 查 DB 空数组, fallback 渲染 list 主页, 体验上
   * 像"跳转挂了"。
   *
   * 不传时跳过, 沿用旧行为 (依赖 plugin / OTEL 上报)。caller 是 user 实时对话
   * (skill-generator 等) 时不需要主动写 Execution——plugin 会处理。
   *
   * 复用同事 821236e 引入的 recordEvaluatorExecution 模式 (拿 client.listMessages
   * 的真实 messages, 不是只填顶层字段), trace 详情页能看到完整 trajectory + tool calls。
   */
  recordTraceAs?: string;
}

export interface RunGeneralAgentResult {
  sessionId: string;
  workspaceDir: string;
  skillResolved: boolean;
  skillMeta: { name: string; version: number | null; semanticVersion: string | null; source: string } | null;
  /** 最后一条 assistant 消息（交互/展示用）。 */
  output: string;
  /** 本轮**所有** assistant 文本按时序拼接——多轮 agent 把分析写在前几轮、最后只说"见上"时，
   * output 会丢内容、judge 评 0。**评测/打分应用 fullOutput**。 */
  fullOutput: string;
  /** 本次执行中所有触发的权限/问题事件及其应答，便于审计。 */
  interactions: InteractionRecord[];
  stats: {
    eventCount: number;
    textDeltaCount: number;
    toolCallCount: number;
    subagentCount: number;
    eventTypeCounter: Record<string, number>;
    /** 本轮真实 token 总量（与落库 Execution.tokens 同口径）。无 token 信息时为 0。
     * 供 DebugJobResult.tokenUsage / 灰度 run.tokenUsage 等成本统计使用。 */
    totalTokens: number;
    /** token 明细，按 assistant/subagent message 累加。 */
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
  };
}

/**
 * 通用 Agent 执行入口。其他模块只需 import 这个函数。
 *
 *   await runGeneralAgent({
 *     user: 'alice',
 *     query: '帮我把 README 翻译成英文',
 *     skill: 'translation-agent',
 *   })
 *
 * 多用户隔离：
 *   - 每个 user 有独立 workspace（~/.agent_insight/agent_workspaces/<user-slug>/）
 *   - 每次任务再切一层 session 子目录，避免文件互相污染
 *   - opencode 的 permission 限制只能读写本任务的 workspace 与 /tmp/*
 *   - opencode session 由 sessionID 隔离，不同用户互不可见
 */
export async function runGeneralAgent(
  input: RunGeneralAgentInput,
): Promise<RunGeneralAgentResult> {
  const user = String(input.user || '').trim();
  if (!user) throw new Error('user is required');
  // 把 query 里的 `~/` 展开成执行机绝对 HOME, 再交给 agent —— `~` 是 shell 语法糖, agent 用
  // 文件读取工具/加引号/Node 读时拿到字面量 `~` 会 "No such file" 直接结束(详见 expand-home.ts)。
  const query = expandHomePathsInText(String(input.query || '').trim());
  if (!query) throw new Error('query is required');

  // ephemeral 模式: 起独立 opencode 进程,跑完自动杀。后台批量任务用这条路保证拿最新 skill。
  // 不能复用 cachedClients (会污染下次 shared 模式), 直接 new AgentInsight 用临时 baseURL。
  // 默认开 isolateHome: 后台任务都不该看 user HOME 下的 skill (避免污染);
  // 被测的 skill 通过 workspace 的 .opencode/skills/ 由 deploySkillToWorkspace 注入。
  if (input.ephemeralServer) {
    ensureDispatcher();
    return runWithEphemeralOpencodeServer({ user, verbose: false, isolateHome: true }, async (baseURL) => {
      const ephemeralClient = new AgentInsight({
        baseURL,
        timeout: 180_000,
        maxRetries: 2,
        logLevel: (process.env.OPENCODE_LOG_LEVEL as any) || 'warn',
      });
      return runGeneralAgentWithClient(input, user, query, ephemeralClient);
    });
  }

  // 默认/shared 模式: Per-user 复用长驻 opencode-server (apiKey 隔离)。
  // 单机 dev 单 user 等同 singleton；多 user 同时跑评估/skill-generator 各起一份。
  const client = await getClient(user);
  return runGeneralAgentWithClient(input, user, query, client);
}

async function runGeneralAgentWithClient(
  input: RunGeneralAgentInput,
  user: string,
  query: string,
  client: AgentInsight,
): Promise<RunGeneralAgentResult> {

  // ── Workspace 先行确定（skill 部署依赖 workspaceDir，需要在 skill 处理前就 ensure）──
  ensureUserWorkspace(user);
  const sessionTag =
    input.workspaceTag || input.sessionId || `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const workspaceDir = ensureSessionWorkspace(user, sessionTag);

  // 系统提示词基础部分（来自 caller 传入的额外指令，如灰度测评的自动化约束）
  const baseSystemInstruction: string | undefined = input.system?.trim() || undefined;
  let systemPrompt: string | undefined = baseSystemInstruction;
  let skillMeta: RunGeneralAgentResult['skillMeta'] = null;

  if (input.skill) {
    const skill = await resolveSkill(input.skill, user, input.skillVersion);
    if (!skill) {
      throw new Error(`skill not found: ${input.skill}`);
    }

    // 将 SKILL.md 及附属资源部署到 workspace 的 .opencode/skills/<name>/ 目录，
    // 使 opencode agent 通过原生 load_skill 工具加载（而非把内容塞进 system prompt）。
    const deployResult = deploySkillToWorkspace(skill, workspaceDir);
    console.log(
      `[general-agent] skill deployed: ${skill.name}@v${skill.version} → ${deployResult.targetDir}` +
      ` (deployed=${deployResult.deployed})`,
    );

    // 构造强约束系统提示词：要求 agent 必须且只能通过 load_skill 工具调用来加载指定 skill。
    systemPrompt = buildSkillLoadConstraint(skill.name, skill.version, baseSystemInstruction);

    skillMeta = {
      name: skill.name,
      version: skill.version,
      semanticVersion: skill.semanticVersion,
      source: skill.source,
    };
  }
  const permissions = buildPermissionsForWorkspace(workspaceDir);

  let sessionId = String(input.sessionId || '').trim();
  if (!sessionId) {
    const created = await client.createSession({
      title: input.sessionTitle || `general-agent · ${user} · ${sessionTag}`,
      permission: permissions,
      // 关键: 把 session 的 cwd 锁到 workspaceDir。否则 opencode 把 session.directory
      // 默认成自己 spawn 时的 cwd(/root), agent 把 SKILL.md 里的相对路径(如
      // "references/skill-template.md")解析到 /root 下面去找,而文件其实 mount 在
      // workspaceDir/.skill-generator/references/ 里 -> read 失败 -> opencode 1.14.x
      // 的 read tool 不抛 ENOENT 而是永远卡在 running -> 工具调用死锁。
      directory: workspaceDir,
    });
    sessionId = String((created as Record<string, unknown>)?.id ?? '');
    if (!sessionId) throw new Error('failed to create opencode session');
  }

  // 给这条 opencode session 打"我们是哪个内部系统 Agent"的标签，让用户机器上的 plugin
  // 把会话上报到 /api/ingest/upload 时，路由能识别并填正确的 agentName/agentId/skill。
  if (input.systemAgentName) {
    const agentId = await getSystemAgentId('opencode', input.systemAgentName);
    const def = findSystemAgentDefinition('opencode', input.systemAgentName);
    tagOpencodeSession(sessionId, {
      agentName: input.systemAgentName,
      agentId,
      // skill 标签优先级:
      //   1. def?.traceSkill — SYSTEM_AGENTS 静态绑定的内置 skill (skill-generator-agent
      //      → 'skill-generator' 等); 跟 file-based system prompt 配对, 最权威。
      //   2. input.skill — 运行时实际加载部署的用户 skill (A/B grayscale-skill-agent / 用例分析
      //      mode='batch' 等场景), 让"从 Trace"按 skill 过滤能搜到这条 trace。
      //   3. input.tagSkill — 纯标签兜底, 给 baseline (不加载 skill 但归属某 skill 对照) 用。
      skill: def?.traceSkill || input.skill || input.tagSkill,
      displayQuery: query,
      user,
    });
  }

  const baseModel = await buildDefaultModel(user);
  const model: ModelConfig = {
    ...baseModel,
    ...(input.model || {}),
  } as ModelConfig;
  console.log('[general-agent] final model config:', {
    providerID: model.providerID,
    modelID: model.modelID,
    baseURL: model.baseURL,
    hasApiKey: !!model.apiKey,
    apiKeyPrefix: model.apiKey ? model.apiKey.slice(0, 8) + '...' : '(none)',
  });
  if (!model.apiKey) {
    throw new Error(
      'model.apiKey missing: configure an active model in your user settings, ' +
        'or set GENERAL_AGENT_API_KEY / OPENCODE_API_KEY / DEEPSEEK_API_KEY env, ' +
        'or pass model.apiKey explicitly',
    );
  }

  const payload: SendPromptPayload = {
    text: query,
    agent: input.agent || process.env.OPENCODE_AGENT || 'build',
    model,
    modelOptions: input.modelOptions || { temperature: 0.7, maxTokens: 2048 },
    permission: permissions,
    directory: workspaceDir,
    ...(systemPrompt ? { system: systemPrompt } : {}),
  };

  // ── 交互策略 ──────────────────────────────────────────────────────
  // 根据 interactionPolicy 给出默认 onPermission / onQuestion；caller 显式传的同名 handler 会覆盖默认。
  const policy: InteractionPolicy = input.interactionPolicy || 'auto-allow';
  const interactions: InteractionRecord[] = [];

  let defaultOnPermission: ChatHandlers['onPermission'];
  let defaultOnQuestion: ChatHandlers['onQuestion'];

  if (policy === 'manual') {
    if (!input.handlers?.onPermission || !input.handlers?.onQuestion) {
      throw new Error(
        "interactionPolicy='manual' requires both handlers.onPermission and handlers.onQuestion",
      );
    }
  } else {
    const permissionDecision: 'once' | 'reject' = policy === 'auto-allow' ? 'once' : 'reject';
    defaultOnPermission = (e: PermissionAskEvent) => {
      interactions.push({
        kind: 'permission',
        id: e.id,
        reply: permissionDecision,
        meta: { title: e.title, type: e.type, pattern: e.pattern, callID: e.callID },
        ts: Date.now(),
      });
      return permissionDecision;
    };
    defaultOnQuestion = (e: QuestionAskEvent) => {
      interactions.push({
        kind: 'question',
        id: e.id,
        reply: null,
        meta: { questions: e.questions, messageID: e.messageID },
        ts: Date.now(),
      });
      return null;
    };
  }

  // caller 传的 handler 优先；同时包一层做审计，不破坏 caller 的语义。
  const callerHandlers = input.handlers || {};
  const wrapPermission = callerHandlers.onPermission
    ? async (e: PermissionAskEvent) => {
        const reply = await callerHandlers.onPermission!(e);
        interactions.push({
          kind: 'permission',
          id: e.id,
          reply: reply as InteractionRecord['reply'],
          meta: { title: e.title, type: e.type, pattern: e.pattern, callID: e.callID, fromCaller: true },
          ts: Date.now(),
        });
        return reply;
      }
    : defaultOnPermission;

  const wrapQuestion = callerHandlers.onQuestion
    ? async (e: QuestionAskEvent) => {
        const reply = await callerHandlers.onQuestion!(e);
        interactions.push({
          kind: 'question',
          id: e.id,
          reply: (reply ?? null) as InteractionRecord['reply'],
          meta: { questions: e.questions, messageID: e.messageID, fromCaller: true },
          ts: Date.now(),
        });
        return reply;
      }
    : defaultOnQuestion;

  const mergedHandlers: ChatHandlers = {
    ...callerHandlers,
    onPermission: wrapPermission,
    onQuestion: wrapQuestion,
  };

  const chatOptions: ChatOptions = {
    streamTimeoutMs: input.timeoutMs ?? 5 * 60 * 1000,
    idleTimeoutMs: 60_000,
    ...(input.chatOptions || {}),
  };

  console.log('[general-agent] calling client.chat, sessionId:', sessionId);
  const result = await client.chat(sessionId, payload, mergedHandlers, chatOptions);
  console.log('[general-agent] client.chat done:', {
    textLen: result.text.length,
    stats: result.stats,
  });

  // 可选: 主动把这次 session 写一行 Execution——给 grayscale 等 caller 用
  // (它们不依赖 plugin/OTEL 上报)。复用同事 recordEvaluatorExecution helper
  // (会拉 client.listMessages 拿真实 messages, 写完整 trajectory 而非顶层片段)。
  if (input.recordTraceAs) {
    try {
      const { recordEvaluatorExecution } = await import('@/lib/engine/evaluation/evaluator-execution-recorder');
      await recordEvaluatorExecution(client, {
        taskId: sessionId,
        agentName: input.recordTraceAs,
        user: input.user,
        query: input.query,
        // 跟 tagOpencodeSession 同一份 skill 解析逻辑, 让 plugin 上报路径和
        // 主动写库路径填出来的 skill 字段一致——baseline 那侧也能归到对照 skill 下,
        // 从 Trace 视图按 skill 过滤能搜到。
        skill: skillMeta?.name ?? input.skill ?? input.tagSkill,
        skillVersion: skillMeta?.version ?? input.skillVersion,
        fallbackOutput: result.text,
      });
    } catch (err) {
      console.warn(`[general-agent] recordTraceAs failed for session ${sessionId}:`, (err as Error)?.message || err);
    }
  }

  // 本轮真实 token 用量：复用与落库 Execution.tokens **完全同源**的链路
  // (client.listMessages → normalizeEvaluatorExecutionInteractions → deriveOpencodeExecutionFields)，
  // 不另起平行统计、不会有口径漂移。chat() 的事件流 stats 不含 token，这里补上，使
  // DebugJobResult.tokenUsage / 灰度 run.tokenUsage 等成本统计不再恒为 0
  // (ephemeralServer 路径在 server 仍存活的窗口内完成本次拉取，同样生效)。
  // normalize 与 recordEvaluatorExecution 同住一个会牵连 prisma 的模块，沿用 recordTraceAs
  // 的动态 import 规避静态依赖；失败兜底为 0，不影响主流程返回。
  let tokenStats: Pick<RunGeneralAgentResult['stats'], 'totalTokens' | 'tokens'> = {
    totalTokens: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  try {
    const { normalizeEvaluatorExecutionInteractions } = await import('@/lib/engine/evaluation/evaluator-execution-recorder');
    const rawMessages = await client.listMessages(sessionId);
    const derived = deriveOpencodeExecutionFields(
      normalizeEvaluatorExecutionInteractions(Array.isArray(rawMessages) ? rawMessages : []),
    );
    tokenStats = {
      totalTokens: derived.tokens,
      tokens: {
        input: derived.input_tokens,
        output: derived.output_tokens,
        reasoning: derived.reasoning_tokens,
        cache: { read: derived.cache_read_input_tokens, write: derived.cache_creation_input_tokens },
      },
    };
  } catch (err) {
    console.warn(`[general-agent] token usage derivation failed for session ${sessionId}:`, (err as Error)?.message || err);
  }

  return {
    sessionId,
    workspaceDir,
    skillResolved: skillMeta !== null,
    skillMeta,
    output: result.text,
    fullOutput: result.transcriptText || result.text,
    interactions,
    stats: { ...result.stats, ...tokenStats },
  };
}
/**
 * 构造强约束系统提示词：要求 agent 在回答任何问题前，必须且只能通过 load_skill 工具
 * 加载指定的 skill，不得使用任何其它 skill，不得跳过 skill 加载步骤。
 *
 * 这是灰度测评的核心一致性保证：确保 A/B 两侧分别严格使用配置的 skill 版本，
 * 并在 trace 里留下可审计的 load_skill 工具调用记录。
 */
function buildSkillLoadConstraint(
  skillName: string,
  skillVersion: number | null,
  extraInstruction?: string,
): string {
  const versionNote = skillVersion !== null ? `（版本 v${skillVersion}）` : '';
  const constraint =
    `[SKILL 加载约束 - 强制执行]\n` +
    `你当前的运行环境已预置了技能（Skill）文件。在处理任何用户请求之前，你必须遵守以下规则：\n\n` +
    `1. **必须**首先调用 load_skill 工具，加载技能名称为 "${skillName}" 的 Skill${versionNote}。\n` +
    `2. **禁止**加载任何其他名称的 Skill。\n` +
    `3. 加载成功后，严格按照该 Skill 定义的流程和规范执行任务。\n` +
    `4. 若 load_skill 工具调用失败，停止执行并报告错误，不得绕过。\n` +
    `5. 严禁将 Skill 加载步骤省略或内化——必须通过显式的工具调用来完成。\n\n` +
    `当前配置的 Skill：**${skillName}**${versionNote}\n`;

  if (extraInstruction) {
    return `${constraint}\n[附加指令]\n${extraInstruction}`;
  }
  return constraint;
}

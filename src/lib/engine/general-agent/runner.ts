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
import { loadServerModelForUser } from './server-model-config';
import {
  buildPermissionsForWorkspace,
  ensureSessionWorkspace,
  ensureUserWorkspace,
} from './workspace';
import { deploySkillToWorkspace } from './skill-workspace-deployer';
import { tagOpencodeSession } from '@/lib/internal-agent-tag';
import { findSystemAgentDefinition, getSystemAgentId } from '@/lib/system-agents';

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
}

export interface RunGeneralAgentResult {
  sessionId: string;
  workspaceDir: string;
  skillResolved: boolean;
  skillMeta: { name: string; version: number | null; semanticVersion: string | null; source: string } | null;
  output: string;
  /** 本次执行中所有触发的权限/问题事件及其应答，便于审计。 */
  interactions: InteractionRecord[];
  stats: {
    eventCount: number;
    textDeltaCount: number;
    toolCallCount: number;
    subagentCount: number;
    eventTypeCounter: Record<string, number>;
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
  const query = String(input.query || '').trim();
  if (!query) throw new Error('query is required');

  // ephemeral 模式: 起独立 opencode 进程,跑完自动杀。后台批量任务用这条路保证拿最新 skill。
  // 不能复用 cachedClients (会污染下次 shared 模式), 直接 new AgentInsight 用临时 baseURL。
  if (input.ephemeralServer) {
    ensureDispatcher();
    return runWithEphemeralOpencodeServer({ user, verbose: false }, async (baseURL) => {
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
      // skill 标签来自 SYSTEM_AGENTS 中的 traceSkill 声明（不是运行时 input.skill，
      // 后者是 DB-loaded skill 的语义，可能与文件式 system prompt 不一致）。
      skill: def?.traceSkill,
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

  return {
    sessionId,
    workspaceDir,
    skillResolved: skillMeta !== null,
    skillMeta,
    output: result.text,
    interactions,
    stats: result.stats,
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

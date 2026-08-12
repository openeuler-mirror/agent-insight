/**
 * 实验引擎的 LLM Judge 薄封装：发一段 system+user prompt，拿回完整文本。
 *
 * 对齐任务完成度 / 轨迹评估器（opencode-*-evaluator）的现行传输层：
 * - 默认直连 ChatOpenAI（无 ephemeral opencode 进程）
 * - EVAL_FORCE_OPENCODE_TRANSPORT=1 强制走旧 ephemeral opencode
 * - 直连失败时回退 opencode（与 task-completion 一致）
 * - 测试可 setJudgeLlmCallerForTest 注入
 */

import { isModelConnectionReady } from '@/lib/shared/model-connection';

export interface JudgeLlmRequest {
  system: string;
  user: string;
  timeoutMs?: number;
  /** session 标题（直连落库 / opencode 可观测性），缺省自动生成 */
  sessionTitle?: string;
}

export type JudgeLlmCaller = (username: string, req: JudgeLlmRequest) => Promise<string>;

const DEFAULT_TIMEOUT_MS = Number(process.env.EXPERIMENT_JUDGE_TIMEOUT_MS || 180_000);

let injectedCaller: JudgeLlmCaller | null = null;

/** 测试注入点：传 null 恢复默认实现。 */
export function setJudgeLlmCallerForTest(fn: JudgeLlmCaller | null): void {
  injectedCaller = fn;
}

/** 测试用：是否已注入 fake judge（跳过真实模型门禁）。 */
export function hasJudgeLlmTestInjection(): boolean {
  return injectedCaller != null;
}

/** 统一入口：引擎只认这一个函数，实现可被测试替换。 */
export async function callJudgeLlm(username: string, req: JudgeLlmRequest): Promise<string> {
  if (injectedCaller) return injectedCaller(username, req);

  const { shouldForceOpencodeEvalTransport } = await import(
    '@/lib/engine/evaluation/evaluator-execution-recorder'
  );

  if (shouldForceOpencodeEvalTransport()) {
    return opencodeJudgeCaller(username, req);
  }

  try {
    return await directJudgeCaller(username, req);
  } catch (directErr) {
    console.warn(
      '[experiment-judge] direct LLM path failed, falling back to opencode transport:',
      (directErr as Error)?.message || directErr,
    );
    return opencodeJudgeCaller(username, req);
  }
}

/** 现行主路径：ChatOpenAI 单轮 invoke（与 task-completion / trajectory 评估器一致）。 */
const directJudgeCaller: JudgeLlmCaller = async (username, req) => {
  const [
    { ChatOpenAI },
    { HumanMessage, SystemMessage },
    { getActiveConfig },
    { recordDirectEvaluatorExecution },
  ] = await Promise.all([
    import('@langchain/openai'),
    import('@langchain/core/messages'),
    import('@/lib/storage/server-config'),
    import('@/lib/engine/evaluation/evaluator-execution-recorder'),
  ]);

  const config = await getActiveConfig(username);
  if (!config || !isModelConnectionReady(config)) {
    throw new Error('未配置可用的评测模型，请到「模型注册」页完善连接信息');
  }

  const modelId = (config.model || 'deepseek-v4-flash').trim() || 'deepseek-v4-flash';
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = new ChatOpenAI({
    apiKey: config.apiKey || 'no-api-key',
    model: modelId,
    configuration: {
      baseURL: config.baseUrl || 'https://api.deepseek.com',
      defaultHeaders: config.headers,
    },
    temperature: 0,
    topP: 1,
    timeout: timeoutMs,
    maxRetries: 2,
    modelKwargs: { seed: 42 },
  });

  const startedAt = new Date();
  const response = await model.invoke([
    new SystemMessage(req.system),
    new HumanMessage(req.user),
  ]);
  const completedAt = new Date();
  const raw = typeof response.content === 'string'
    ? response.content
    : JSON.stringify(response.content);

  if (!String(raw).trim()) throw new Error('judge 未返回任何文本输出');

  const { randomUUID } = await import('crypto');
  // 与其它直连评估器一样合成评测 trace（isolate 业务 Agent Trace）；失败不阻断 Judge。
  void recordDirectEvaluatorExecution({
    taskId: `experiment-judge-${randomUUID()}`,
    agentName: 'experiment-judge',
    user: username,
    query: (req.sessionTitle || req.user).slice(0, 2000),
    systemPrompt: req.system,
    userMessage: req.user,
    assistantOutput: raw,
    modelID: modelId,
    startedAtISO: startedAt.toISOString(),
    completedAtISO: completedAt.toISOString(),
  }).catch((err) => {
    console.warn('[experiment-judge] failed to record direct evaluator trace:', (err as Error)?.message || err);
  });

  return String(raw);
};

/** 旧路径 / 强制回退：per-call 临时 opencode server。 */
const opencodeJudgeCaller: JudgeLlmCaller = async (username, req) => {
  const [
    { AgentInsight },
    { runWithEphemeralOpencodeServer },
    { withBackgroundOpencodeSlot },
    { buildEvaluatorPermissions },
    { getActiveConfig },
    { inferProviderFromBaseUrl, loadServerModelForUser, normalizeProviderID },
  ] = await Promise.all([
    import('@/lib/engine/skill-generation/opencode-agent-cli/opencode-client'),
    import('@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager'),
    import('@/lib/engine/general-agent/concurrency-limiter'),
    import('@/lib/engine/general-agent/workspace'),
    import('@/lib/storage/server-config'),
    import('@/lib/engine/general-agent/server-model-config'),
  ]);

  return withBackgroundOpencodeSlot(async () =>
    runWithEphemeralOpencodeServer({ user: username, verbose: false, isolateHome: true }, async (serverUrl: string) => {
      const config = await getActiveConfig(username);
      if (!config || !isModelConnectionReady(config)) {
        throw new Error('未配置可用的评测模型，请到「模型注册」页完善连接信息');
      }
      const activeModel = await loadServerModelForUser(username);
      const providerID =
        activeModel?.providerID
        || normalizeProviderID(config.provider || inferProviderFromBaseUrl(config.baseUrl));
      const modelID = activeModel?.modelID || config.model || 'deepseek-v4-flash';
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      let raw = '';
      let runtimeError: Error | null = null;

      const insight = new AgentInsight({ baseURL: serverUrl, logLevel: 'warn' });
      const sessionResp = await insight.createSession({
        title: req.sessionTitle ?? `experiment-judge-${Date.now()}`,
        directory: '/tmp',
      });
      const sessionId = String((sessionResp as any)?.id || (sessionResp as any)?.ID || '');
      if (!sessionId) throw new Error('Failed to create opencode session for experiment judge');

      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const result = await Promise.race([
          insight.chat(
            sessionId,
            {
              text: req.user,
              agent: 'build',
              model: {
                providerID,
                modelID,
                apiKey: config.apiKey,
                baseURL: config.baseUrl,
                headers: config.headers,
              },
              system: req.system,
              permission: buildEvaluatorPermissions(),
            },
            {
              onText: (e: { delta: string }) => { raw += e.delta; },
              onError: (e: Error) => { runtimeError = e; },
            },
            { streamTimeoutMs: timeoutMs, idleTimeoutMs: timeoutMs },
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`LLM 调用超时（${timeoutMs}ms）`)),
              timeoutMs,
            );
          }),
        ]);
        raw = (result as { text?: string }).text || raw;
      } finally {
        if (timer) clearTimeout(timer);
        try { await insight.deleteSession(sessionId); } catch { /* best-effort cleanup */ }
      }

      if (runtimeError) throw runtimeError;
      if (!raw.trim()) throw new Error('judge 未返回任何文本输出');
      return raw;
    }),
  {
    taskType: 'experiment-judge',
    user: username,
    label: `experiment-judge: ${req.sessionTitle ?? ''}`.trim(),
    silent: true,
  });
};

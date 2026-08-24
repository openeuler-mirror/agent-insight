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
  /** 可选模型采样参数；不传时保持现有评估器行为。 */
  modelOptions?: Record<string, unknown>;
  /** opencode session 标题（可观测性用），缺省自动生成 */
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

/** 现行主路径：ChatOpenAI 单轮 invoke；只返回文本，不合成观测 Trace。 */
const directJudgeCaller: JudgeLlmCaller = async (username, req) => {
  const [
    { ChatOpenAI },
    { HumanMessage, SystemMessage },
    { getActiveConfig },
  ] = await Promise.all([
    import('@langchain/openai'),
    import('@langchain/core/messages'),
    import('@/lib/storage/server-config'),
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

  const response = await model.invoke([
    new SystemMessage(req.system),
    new HumanMessage(req.user),
  ]);
  const raw = typeof response.content === 'string'
    ? response.content
    : JSON.stringify(response.content);

  if (!String(raw).trim()) throw new Error('judge 未返回任何文本输出');
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
      const session = sessionResp as { id?: unknown; ID?: unknown } | null | undefined;
      const sessionId = String(session?.id || session?.ID || '');
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
              ...(req.modelOptions ? { modelOptions: req.modelOptions } : {}),
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
